import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProductBackend } from './product-api.ts';
import { whyFixture } from './why-not-fixture.ts';
import { evaluateWhyNot } from './why-not-engine.ts';
import { analysisRevision } from './why-not-service.ts';
import type { CodexRunner, GenerationJob } from './jobs.ts';
import type { WhyRun } from '../src/types/why-not.ts';
import type { ReportList, ReportRun } from '../src/types/report.ts';

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cluevia-report-api-'));
  const calls: string[] = [];
  let cancellations = 0;
  const runner: CodexRunner = async (input, _config, options) => {
    calls.push(input.purpose ?? 'extraction');
    assert.equal(input.purpose, 'case-report');
    return new Promise((_resolve, reject) => {
      const cancel = () => { cancellations++; reject(new Error('Test report cancelled')); };
      if (options?.signal?.aborted) cancel();
      else options?.signal?.addEventListener('abort', cancel, { once: true });
    });
  };
  const backend = await createProductBackend({ root: process.cwd(), dataDir: directory, accessToken: '', seedExample: false, codex: { model: 'test-report-model', effort: 'high' } }, { run: runner });
  const server = createServer((request, response) => backend.middleware(request, response, () => { response.writeHead(404); response.end(); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await backend.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const at = new Date().toISOString();
  const snapshot = whyFixture(1);
  const job: GenerationJob = { id: 'report-api-job', question: snapshot.goal, status: 'completed', stage: 'saving', message: '완료', createdAt: at, updatedAt: at, completedChunks: 1, totalChunks: 1, emptyChunks: 0, graphIds: [], resumable: false };
  backend.store.db.prepare('INSERT INTO generation_jobs VALUES (?,?,?,?)').run(job.id, JSON.stringify(job), at, JSON.stringify({ question: job.question, documents: [] }));
  const result = evaluateWhyNot(snapshot);
  const why: WhyRun = { id: 'why-report-api', jobId: job.id, previousId: null, createdAt: at, updatedAt: at, status: 'completed', stage: '완료', phase: 'ready', graphReadyAt: at, analysisRevision: analysisRevision(job), snapshot, baseSnapshot: snapshot, result,
    preparation: { version: 'cluevia-preparation-1', ready: true, baselineScore: result.confidence.bayesian!.baselineScore! * 100, score: result.confidence.bayesian!.score * 100, grade: result.confidence.bayesian!.grade, preparedAt: at, animation: [], gapFill: [] } };
  function saveWhy() { backend.store.db.prepare('INSERT INTO why_not_runs VALUES (?,?,?,?)').run(why.id, job.id, at, JSON.stringify(why)); }
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function call<T>(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() as T };
  }
  return { backend, calls, job, saveWhy, call, cancelled: () => cancellations, endpoint: `/api/jobs/${job.id}/reports` };
}

test('report HTTP generation waits for diagnostics, validates requests, and does not write on GET', async t => {
  const s = await setup(t);
  assert.equal((await s.call('/api/jobs/missing/reports')).status, 404);
  const waiting = await s.call<ReportList>(s.endpoint);
  assert.equal(waiting.status, 200); assert.equal(waiting.body.canGenerate, false);
  assert.equal((await s.call(s.endpoint, 'POST', {})).status, 409);
  s.saveWhy();
  assert.equal((await s.call<ReportList>(s.endpoint)).body.canGenerate, true);
  for (const body of [{ force: 'yes' }, { snapshot: {} }, []]) assert.equal((await s.call(s.endpoint, 'POST', body)).status, 400);
  assert.equal((await s.call(s.endpoint, 'POST', {}, { Origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await s.call(s.endpoint, 'PUT', {})).status, 405);
  assert.equal(s.backend.store.db.prepare('SELECT count(*) AS n FROM case_reports').get()!.n, 0);
  assert.deepEqual(s.calls, []);
});

test('report HTTP polling and duplicate starts preserve one background run; cancel and case deletion stop it', async t => {
  const s = await setup(t); s.saveWhy();
  const started = await s.call<{ report: ReportRun }>(s.endpoint, 'POST', {});
  assert.equal(started.status, 202); assert.equal(started.body.report.status, 'running');
  const duplicate = await s.call<{ report: ReportRun }>(s.endpoint, 'POST', {});
  assert.equal(duplicate.body.report.id, started.body.report.id);
  await s.call(s.endpoint); await s.call(s.endpoint);
  assert.deepEqual(s.calls, ['case-report']);
  const cancelled = await s.call<{ report: ReportRun }>(`${s.endpoint}/cancel`, 'POST', {});
  assert.equal(cancelled.status, 200); assert.equal(cancelled.body.report.status, 'cancelled');
  assert.equal(s.cancelled(), 1);
  const next = await s.call<{ report: ReportRun }>(s.endpoint, 'POST', {});
  assert.equal(next.status, 202); assert.notEqual(next.body.report.id, started.body.report.id);
  const removed = await s.call(`/api/jobs/${s.job.id}`, 'DELETE');
  assert.equal(removed.status, 200); assert.equal(s.cancelled(), 2);
  assert.equal(s.backend.store.db.prepare('SELECT count(*) AS n FROM case_reports').get()!.n, 0);
  assert.equal((await s.call(s.endpoint)).status, 404);
});
