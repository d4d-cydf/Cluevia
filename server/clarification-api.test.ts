import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { ClarificationResult } from '../src/types/clarification.ts';
import { createProductBackend } from './product-api.ts';
import type { CodexRunner } from './jobs.ts';

const token = 'clarification-api-test-token';
const input = { question: '이 기업 자료의 관계를 분석해 주세요.', sources: [{ id: 'sample-1', name: 'companies.csv', size: 900000000, excerpt: 'company,parent\nExample,Parent' }], answers: [], round: 0 };
const brief = { objective: input.question, scope: '제공된 기업 자료', output: '관계 그래프와 근거', answers: [] };
const response = { status: 'questions', introduction: '관계 범위를 선택해 주세요.', brief, questions: [{ id: 'focus', question: '어떤 관계를 확인할까요?', reason: '필요한 범위에 집중합니다.', options: [
  { id: 'ownership', label: '소유 관계', description: '자료에 명시된 소유 관계를 확인합니다.' },
  { id: 'all', label: '전체 관계', description: '자료에 명시된 전체 관계를 확인합니다.' },
] }] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function setup(t: TestContext, runner: CodexRunner) {
  const directory = await mkdtemp(join(tmpdir(), 'cluevia-clarification-api-'));
  let probes = 0;
  const backend = await createProductBackend({ root: process.cwd(), dataDir: directory, accessToken: token, codex: { timeoutMs: 2000 }, seedExample: false }, {
    run: runner,
    probe: async () => { probes++; return { available: true, authenticated: true, message: 'Test provider.' }; },
  });
  const server = createServer((request, result) => backend.middleware(request, result, () => { result.writeHead(404); result.end(); }));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await backend.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  async function call(path: string, body: unknown = input, options: { authenticated?: boolean; signal?: AbortSignal } = {}) {
    const result = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(options.authenticated === false ? {} : { Authorization: `Bearer ${token}` }) }, body: JSON.stringify(body), signal: options.signal ?? AbortSignal.timeout(5000) });
    return { status: result.status, data: await result.json() as Record<string, unknown> };
  }
  function assertNoAnalysis() {
    assert.deepEqual(backend.jobs.list(), []);
    assert.equal(backend.store.summary().graphs, 0);
    assert.equal(backend.store.summary().documents, 0);
    assert.equal(backend.store.summary().entities, 0);
    assert.equal(Number(backend.store.db.prepare('SELECT count(*) n FROM evidence_uploads').get()!.n), 0);
    assert.equal(Number(backend.store.db.prepare('SELECT count(*) n FROM evidence_upload_chunks').get()!.n), 0);
  }
  return { backend, server, base, call, assertNoAnalysis, probes: () => probes };
}

test('authenticated clarification reads only supplied samples and creates no uploads, jobs or graphs', { timeout: 10000 }, async t => {
  let calls = 0;
  const session = await setup(t, async candidate => {
    calls++;
    assert.equal(candidate.purpose, 'clarification');
    assert.deepEqual(candidate.documents, []);
    assert.deepEqual(JSON.parse(candidate.context!).sourceSamples, input.sources);
    return calls === 1 ? response : { ...response, status: 'ready', questions: [] };
  });
  const denied = await session.call('/api/analysis/clarify', input, { authenticated: false });
  assert.equal(denied.status, 401);
  assert.equal(calls, 0);
  const asked = await session.call('/api/analysis/clarify');
  assert.equal(asked.status, 200);
  assert.equal((asked.data as unknown as ClarificationResult).status, 'questions');
  assert.equal(asked.data.source, 'codex');
  session.assertNoAnalysis();
  const ready = await session.call('/api/analysis/clarify', { ...input, round: 1, answers: [{ question: response.questions[0].question, answer: '전체 관계' }] });
  assert.equal(ready.status, 200);
  assert.equal(ready.data.status, 'ready');
  assert.equal(calls, 2);
  assert.equal(session.probes(), 0);
  session.assertNoAnalysis();
});

test('oversized clarification and invalid confirmed briefs fail before provider calls or job creation', { timeout: 10000 }, async t => {
  let calls = 0;
  const session = await setup(t, async () => { calls++; return response; });
  const invalidInputs = [
    { ...input, sources: [{ ...input.sources[0], excerpt: 'a'.repeat(12001) }] },
    { ...input, sources: Array.from({ length: 11 }, (_, index) => ({ ...input.sources[0], id: `file-${index}` })) },
    { ...input, question: 'a'.repeat(2001) },
    { ...input, answers: [{ question: '기간?', answer: 'a'.repeat(1501) }] },
    { ...input, round: 3 },
  ];
  for (const body of invalidInputs) assert.equal((await session.call('/api/analysis/clarify', body)).status, 400);
  for (const analysisBrief of [{ ...brief, scope: '' }, { ...brief, unsupportedFact: 'made-up' }, { ...brief, answers: [{ question: '범위?', answer: 'a'.repeat(1501) }] }]) {
    assert.equal((await session.call('/api/jobs', { question: input.question, documents: [], analysisBrief })).status, 400);
  }
  assert.equal(calls, 0);
  assert.equal(session.probes(), 0);
  session.assertNoAnalysis();
});

test('clarification allows two active model calls and releases capacity when a call finishes', { timeout: 10000 }, async t => {
  const waiting: ReturnType<typeof deferred<unknown>>[] = [];
  const firstStarted = deferred<void>();
  const firstTwo = deferred<void>();
  const third = deferred<void>();
  const session = await setup(t, async (_candidate, _config, options) => {
    const pending = deferred<unknown>(); waiting.push(pending);
    const abort = () => pending.reject(options?.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    options?.signal?.addEventListener('abort', abort, { once: true });
    if (waiting.length === 1) firstStarted.resolve();
    if (waiting.length === 2) firstTwo.resolve();
    if (waiting.length === 3) third.resolve();
    try { return await pending.promise; } finally { options?.signal?.removeEventListener('abort', abort); }
  });
  const first = session.call('/api/analysis/clarify');
  await firstStarted.promise;
  const second = session.call('/api/analysis/clarify');
  await firstTwo.promise;
  assert.equal((await session.call('/api/analysis/clarify')).status, 429);
  assert.equal(waiting.length, 2);
  waiting[0].resolve(response);
  assert.equal((await first).status, 200);
  const next = session.call('/api/analysis/clarify');
  await third.promise;
  waiting[1].resolve(response); waiting[2].resolve(response);
  assert.equal((await second).status, 200);
  assert.equal((await next).status, 200);
  session.assertNoAnalysis();
});

test('disconnecting the browser aborts clarification without saving analysis state', { timeout: 10000 }, async t => {
  const started = deferred<void>(); const aborted = deferred<void>(); let calls = 0;
  const session = await setup(t, async (_candidate, _config, options) => {
    calls++;
    if (calls > 1) return response;
    return new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => { aborted.resolve(); reject(options.signal!.reason); }, { once: true });
      started.resolve();
    });
  });
  const controller = new AbortController();
  const pending = session.call('/api/analysis/clarify', input, { signal: controller.signal }).then(() => null, error => error as Error);
  await started.promise;
  controller.abort();
  const error = await pending;
  assert.equal(error?.name, 'AbortError');
  await aborted.promise;
  assert.equal((await session.call('/api/analysis/clarify')).status, 200);
  assert.equal(calls, 2);
  session.assertNoAnalysis();
});

test('backend shutdown waits for active clarification cancellation and refuses subsequent requests', { timeout: 10000 }, async t => {
  const started = deferred<void>(); let aborted = false;
  const session = await setup(t, async (_candidate, _config, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => { aborted = true; reject(options.signal!.reason); }, { once: true });
    started.resolve();
  }));
  const pending = session.call('/api/analysis/clarify');
  await started.promise;
  session.assertNoAnalysis();
  await session.backend.close();
  assert.equal(aborted, true);
  assert.ok((await pending).status >= 400);
  assert.equal((await session.call('/api/analysis/clarify')).status, 503);
});

test('shutdown during a slow request body cannot launch a new clarification afterwards', { timeout: 10000 }, async t => {
  let calls = 0;
  const session = await setup(t, async () => { calls++; return response; });
  const body = JSON.stringify(input);
  const received = new Promise<void>(resolve => session.server.once('request', () => resolve()));
  const result = deferred<number>();
  const request = httpRequest(session.base + '/api/analysis/clarify', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${token}` } }, incoming => {
    incoming.resume(); incoming.once('end', () => result.resolve(incoming.statusCode!));
  });
  request.once('error', result.reject);
  request.write(body.slice(0, 10));
  await received;
  await session.backend.close();
  request.end(body.slice(10));
  assert.equal(await result.promise, 503);
  assert.equal(calls, 0);
});
