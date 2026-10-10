import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OntologyStore } from './ontology-store.ts';
import { EvidenceUploads } from './evidence-uploads.ts';
import { JobManager } from './jobs.ts';
import type { GenerationJob, CodexRunner } from './jobs.ts';
import { readJevConfig } from './jev.ts';
import type { runJevExtraction } from './jev.ts';
import { createProductBackend } from './product-api.ts';
import { readProductConfig } from './product-config.ts';
import { getAnalysisRecord } from './analysis-case.ts';
import type { GraphGenerationInput } from '../src/types/graph.ts';
import type { OntologyExtraction } from '../src/types/ontology.ts';

const config = () => readJevConfig({ TYPESAFE_API_KEY: 'test-key-never-sent', TYPESAFE_CONCURRENCY: '3' });
function extracted(input: GraphGenerationInput): OntologyExtraction {
  return { title: '자료의 선박', summary: '제공된 문서에서 추출한 선박.',
    entities: input.documents.map((doc, i) => ({ id: `entity-${i}`, label: 'Ocean Star', type: 'vessel', description: '자료에 등장하는 선박.', identifiers: [], properties: [], evidence: [{ documentId: doc.id, quote: doc.text.slice(0, 70) }] })),
    relationships: [], events: [], findings: [], limitations: [] };
}
const mustNotCall: CodexRunner = async () => { throw new Error('Unexpected heavyweight model call.'); };
const successfulJev: typeof runJevExtraction = async (input, _config, options) => {
  options?.onUsage?.({ requests: 1, inputTokens: 100 });
  return { extraction: extracted(input), needsFallback: false };
};
async function finish(manager: JobManager, id: string): Promise<GenerationJob> {
  for (let count = 0; count < 2000; count++) {
    const job = manager.get(id)!;
    if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
    await delay(5);
  }
  throw new Error('Analysis did not finish.');
}
function setup(t: TestContext, runJev = successfulJev, codex = mustNotCall, settings = config()) {
  const store = new OntologyStore(':memory:'); const uploads = new EvidenceUploads(store.db);
  const manager = new JobManager(store, {}, codex, uploads, { jev: settings, runJev });
  t.after(async () => { await manager.close(); store.close(); });
  return { store, uploads, manager };
}
const document = (id: string) => ({ id, name: `${id}.txt`, text: `Ocean Star is mentioned in this source document with record identifier ${id}.` });

test('uploaded CSV removes overlap exactly and saves every row without either model', async t => {
  let calls = 0;
  const { manager, uploads, store } = setup(t, async () => { calls++; throw new Error('No Jev call expected.'); }, async () => { calls++; throw new Error('No Codex call expected.'); });
  const count = 1200;
  const text = 'vessel_name,operator_company,note\r\n' + Array.from({ length: count }, (_, i) => `Ship ${i},Company ${i},"multiline row ${i}\r\n${'x'.repeat(80)}"\r\n`).join('');
  const uploaded = await uploads.receive('large.csv', (async function* () { yield Buffer.from(text); })());
  assert.ok(uploaded.chunkCount > 3);
  const job = await finish(manager, manager.create({ question: '전체 데이터를 그래프로 변환해주세요.', documents: [], uploadIds: [uploaded.id] }).id);
  assert.equal(job.status, 'completed', job.error);
  assert.equal(job.metrics!.structuredRecords, count); assert.equal(calls, 0);
  assert.equal(job.metrics!.codexCalls, 0); assert.equal(job.metrics!.jevRequests, 0);
  assert.equal(job.metrics!.deterministicParts, job.totalChunks);
  const ids = new Set<string>();
  for (const id of job.graphIds) {
    const graph = store.getGraph(id)!; assert.equal(graph.origin, 'structured');
    for (const node of graph.nodes) if (node.properties['원본 레코드 번호']) ids.add(node.properties['원본 레코드 번호']);
  }
  assert.equal(ids.size, count); assert.ok(ids.has(String(count)));
  assert.equal(store.summary().relationships, count);
  assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM analysis_record_archive WHERE job_id=?').get(job.id)!.n), job.totalChunks);
  assert.ok(getAnalysisRecord(store.db, job, job.totalChunks!)!.documents[0].totalChars > 0);
});

test('a single multi-megabyte JSON field survives graph persistence without model input limits', async t => {
  const { manager, uploads, store } = setup(t);
  const data = JSON.stringify([{ id: 1, detail: '한'.repeat(800_000) }]);
  const uploaded = await uploads.receive('oversized-cell.json', (async function* () { yield Buffer.from(data); })());
  assert.ok(uploaded.bytes > 2_000_000);
  const job = await finish(manager, manager.create({ question: '전체 레코드를 보존해주세요.', documents: [], uploadIds: [uploaded.id] }).id);
  assert.equal(job.status, 'completed', job.error); assert.equal(job.metrics!.structuredRecords, 1);
  const row = store.db.prepare('SELECT text FROM documents').get();
  assert.ok(String(row!.text).includes('한'.repeat(800_000)));
  assert.match(store.getGraph(job.graphId!)!.nodes[0].properties.detail, /생략/);
});

test('permanent deletion removes hybrid archives and exclusive uploads but preserves shared evidence until its last case is deleted', async t => {
  const { manager, uploads, store } = setup(t);
  const text = 'vessel_name,operator_company\nOcean Star,Harbor Company\n';
  const uploaded = await uploads.receive('shared.csv', (async function* () { yield Buffer.from(text); })());
  const first = await finish(manager, manager.create({ question: '첫 번째 분석', documents: [], uploadIds: [uploaded.id] }).id);
  const second = await finish(manager, manager.create({ question: '두 번째 분석', documents: [], uploadIds: [uploaded.id] }).id);
  assert.equal(first.status, 'completed', first.error); assert.equal(second.status, 'completed', second.error);
  await manager.remove(first.id);
  assert.equal(manager.get(first.id), null); assert.ok(uploads.get(uploaded.id));
  assert.ok(store.getGraph(second.graphIds[0]));
  assert.equal(Number(store.db.prepare('SELECT count(*) n FROM analysis_record_archive WHERE job_id=?').get(first.id)!.n), 0);
  assert.equal(Number(store.db.prepare('SELECT count(*) n FROM analysis_parts WHERE job_id=?').get(first.id)!.n), 0);
  await manager.remove(second.id);
  assert.equal(uploads.get(uploaded.id), undefined);
  assert.deepEqual([store.summary().graphs, store.summary().entities, store.summary().relationships, store.summary().documents], [0, 0, 0, 0]);
});

test('Jev executes a bounded parallel window but commits graphs in source order', async t => {
  let active = 0; let maximum = 0; let calls = 0;
  const { manager, store } = setup(t, async (input, settings, options) => {
    active++; maximum = Math.max(maximum, active); calls++;
    await delay(input.documents[0].text.includes('one') ? 45 : 5);
    active--; return successfulJev(input, settings, options);
  });
  const docs = ['one', 'two', 'three', 'four', 'five'].map(document);
  const job = await finish(manager, manager.create({ question: '전체 자료를 분석해주세요.', documents: docs }).id);
  assert.equal(job.status, 'completed', job.error); assert.equal(calls, 5);
  assert.equal(maximum, 3); assert.equal(job.metrics!.jevRequests, 5);
  assert.equal(job.metrics!.jevInputTokens, 500);
  assert.deepEqual(job.graphIds.map(id => store.getGraph(id)!.sources[0].id), docs.map(doc => doc.id));
});

test('cached extraction is rebound to a re-upload and reused for a different question', async t => {
  let calls = 0;
  const { manager, store } = setup(t, async (...args) => { calls++; return successfulJev(...args); });
  const text = 'Ocean Star is operated by the named organization in this supplied document.';
  const first = await finish(manager, manager.create({ question: '선박을 찾아주세요.', documents: [{ id: 'old', name: 'old.txt', text }] }).id);
  const second = await finish(manager, manager.create({ question: '어떤 객체가 있는지 보여주세요.', documents: [{ id: 'new', name: 'new.txt', text }] }).id);
  assert.equal(first.status, 'completed', first.error); assert.equal(second.status, 'completed', second.error);
  assert.equal(calls, 1); assert.equal(second.metrics!.cacheHits, 1); assert.equal(second.metrics!.jevRequests, 0);
  const graph = store.getGraph(second.graphId!)!;
  assert.deepEqual(graph.sources.map(source => source.id), ['new']);
  assert.deepEqual(graph.nodes[0].sourceIds, ['new']);
  assert.equal(graph.question, '어떤 객체가 있는지 보여주세요.');
});

test('uncertain Jev work falls back with one Codex process at a time', async t => {
  let active = 0; let maximum = 0;
  const { manager, store } = setup(t, async (input, settings, options) => ({ ...await successfulJev(input, settings, options), needsFallback: true, reason: 'Ambiguous identity.' }), async input => {
    active++; maximum = Math.max(maximum, active); await delay(5); active--;
    return extracted(input);
  });
  const job = await finish(manager, manager.create({ question: '자료를 분석해주세요.', documents: ['one', 'two', 'three'].map(document) }).id);
  assert.equal(job.status, 'completed', job.error); assert.equal(maximum, 1);
  assert.equal(job.metrics!.codexCalls, 3); assert.equal(job.metrics!.reviewParts, 3);
  assert.ok(job.graphIds.every(id => store.getGraph(id)!.origin === 'codex'));
});

test('disabled fallback preserves grounded subset with explicit review limitation', async t => {
  const settings = { ...config(), fallback: false };
  const { manager, store } = setup(t, async (input, settings, options) => ({ ...await successfulJev(input, settings, options), needsFallback: true }), mustNotCall, settings);
  const job = await finish(manager, manager.create({ question: '자료를 분석해주세요.', documents: [document('one')] }).id);
  assert.equal(job.status, 'completed', job.error); assert.equal(job.metrics!.reviewParts, 1); assert.equal(job.metrics!.codexCalls, 0);
  assert.ok(store.getGraph(job.graphId!)!.limitations.some(value => value.includes('누락될 수')));
});

test('provider failure is resumable and never triggers heavyweight transport-error fallback', async t => {
  let fail = true; let calls = 0;
  const { manager, store } = setup(t, async (input, settings, options) => {
    calls++;
    if (input.documents[0].text.includes('two') && fail) throw new Error('Jev temporarily unavailable.');
    return successfulJev(input, settings, options);
  });
  const created = manager.create({ question: '모든 자료를 분석해주세요.', documents: ['one', 'two', 'three'].map(document) });
  const failed = await finish(manager, created.id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.completedChunks, 1); assert.equal(failed.resumable, true);
  assert.equal(failed.metrics!.codexCalls, 0); const firstGraph = failed.graphId;
  fail = false;
  manager.resume(created.id);
  const completed = await finish(manager, created.id);
  assert.equal(completed.status, 'completed', completed.error); assert.equal(completed.graphId, firstGraph);
  assert.equal(completed.graphIds.length, 3); assert.equal(store.summary().graphs, 3);
  assert.ok(calls >= 4 && calls <= 5);
});

test('cancel aborts parallel Jev requests and resume saves no cancelled results', async t => {
  let started!: () => void; const began = new Promise<void>(resolve => { started = resolve; }); let blocking = true;
  const { manager, store } = setup(t, async (input, settings, options) => {
    if (blocking) {
      started();
      await delay(10_000, undefined, { signal: options?.signal });
    }
    return successfulJev(input, settings, options);
  });
  const created = manager.create({ question: '자료 전체를 분석해주세요.', documents: ['one', 'two', 'three'].map(document) });
  await began;
  manager.cancel(created.id); blocking = false; manager.resume(created.id);
  const job = await finish(manager, created.id);
  assert.equal(job.status, 'completed', job.error); assert.equal(job.graphIds.length, 3); assert.equal(store.summary().graphs, 3);
});

test('malformed CSV fails without dropping a row or invoking models', async t => {
  const { manager } = setup(t);
  const job = await finish(manager, manager.create({ question: '전체 표를 분석해주세요.', documents: [{ id: 'bad', name: 'bad.csv', text: 'name,value\nOcean Star,1\nmissing-column\n' }] }).id);
  assert.equal(job.status, 'failed'); assert.match(job.error!, /CSV/);
  assert.equal(job.graphIds.length, 0); assert.equal(job.metrics!.jevRequests, 0); assert.equal(job.metrics!.codexCalls, 0);
});

test('legacy HTTP structured import remains available without model login; collection and settings stay truthful', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cluevia-hybrid-'));
  const settings = readProductConfig(process.cwd(), { CLUEVIA_DATA_DIR: directory, CLUEVIA_SEED_EXAMPLE: 'false', TYPESAFE_API_KEY: 'hidden-test-api-key' });
  settings.ontologyPlanning = false; // Preserve coverage for resumed legacy work; new jobs design schemas first.
  const backend = await createProductBackend(settings, { run: mustNotCall, runJev: async () => { throw new Error('No Jev call expected.'); }, probe: async () => ({ available: false, authenticated: false, message: 'No Codex installed.' }) });
  const server = createServer((request, response) => backend.middleware(request, response, () => { response.statusCode = 404; response.end(); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await backend.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  const status = await (await fetch(`${base}/api/system/status`)).json() as { provider: { kind: string; available: boolean; jev: { configured: boolean } } };
  assert.equal(status.provider.kind, 'hybrid'); assert.equal(status.provider.available, true); assert.equal(status.provider.jev.configured, true);
  assert.ok(!JSON.stringify(status).includes('hidden-test-api-key'));
  const content = 'vessel_name,operator_company\n' + Array.from({ length: 200 }, (_, i) => `Ship ${i},Company ${i}\n`).join('');
  const upload = await fetch(`${base}/api/documents/upload`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'ships.csv' }, body: content });
  assert.equal(upload.status, 201);
  const body = await upload.json() as { document: { id: string } };
  const response = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: '전체 선박 자료를 정리해주세요.', documents: [], uploadIds: [body.document.id] }) });
  assert.equal(response.status, 202);
  const created = await response.json() as { job: GenerationJob };
  const done = await finish(backend.jobs, created.job.id);
  assert.equal(done.status, 'completed', done.error); assert.ok(done.graphIds.length > 1);
  for (const id of [done.graphIds[0], done.graphIds.at(-1)!]) {
    const result = await fetch(`${base}/api/graphs/${id}/collection`); assert.equal(result.status, 200);
    const collection = await result.json() as { jobId: string; total: number; graphs: { id: string }[] };
    assert.equal(collection.jobId, done.id); assert.equal(collection.total, done.graphIds.length);
    assert.deepEqual(collection.graphs.map(graph => graph.id), done.graphIds);
  }
});
