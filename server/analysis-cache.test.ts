import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { AnalysisPipeline } from './analysis-pipeline.ts';
import type { AnalysisMetrics, AnalysisPart } from './analysis-pipeline.ts';
import { readJevConfig } from './jev.ts';
import type { JevUsage } from './jev.ts';
import { JobManager } from './jobs.ts';
import type { GenerationJob } from './jobs.ts';
import { OntologyStore } from './ontology-store.ts';
import type { GraphGenerationInput } from '../src/types/graph.ts';
import type { OntologyExtraction } from '../src/types/ontology.ts';

const config = readJevConfig({ TYPESAFE_API_KEY: 'mock-key' });
const part: AnalysisPart = { records: 0, documents: [{ id: 'first-source', name: 'first.txt', text: 'Ocean Star is operated by Acme Shipping.' }] };
function extraction(input: GraphGenerationInput): OntologyExtraction {
  return { title: '원문 분석', summary: '자료에서 확인한 선박입니다.', entities: [{ id: 'vessel-1', label: 'Ocean Star', type: 'vessel', description: '', identifiers: [], properties: [], evidence: [{ documentId: input.documents[0].id, quote: input.documents[0].text.slice(0, 1600) }] }], relationships: [], events: [], findings: [], limitations: [] };
}
async function terminal(manager: JobManager, id: string): Promise<GenerationJob> {
  for (let index = 0; index < 400; index++) { const job = manager.get(id)!; if (['completed', 'failed'].includes(job.status)) return job; await delay(5); }
  throw new Error('작업이 완료되지 않았습니다.');
}
function storeFor(t: TestContext): OntologyStore { const store = new OntologyStore(':memory:'); t.after(() => store.close()); return store; }

test('identical source reuse survives changed questions and source IDs with current provenance', async t => {
  const store = storeFor(t); let calls = 0; const questions: string[] = [];
  const pipeline = new AnalysisPipeline(store.db, {}, async () => { throw new Error('unexpected Codex'); }, undefined, { jev: config, runJev: async input => {
    calls++; questions.push(input.question); return { extraction: extraction(input), needsFallback: false };
  } });
  const metrics: Partial<AnalysisMetrics>[] = [];
  const first = await pipeline.process(part, '첫 번째 질문', new AbortController().signal, delta => metrics.push(delta), () => {});
  const secondPart = { ...part, documents: [{ ...part.documents[0], id: 'another-source', name: 'renamed.txt' }] };
  const second = await pipeline.process(secondPart, '완전히 다른 질문', new AbortController().signal, delta => metrics.push(delta), () => {});
  assert.equal(calls, 1); assert.match(questions[0], /모든 자료/);
  assert.equal(first.extraction.entities[0].evidence[0].documentId, 'first-source');
  assert.equal(second.extraction.entities[0].evidence[0].documentId, 'another-source');
  assert.equal(metrics.reduce((sum, delta) => sum + (delta.cacheHits ?? 0), 0), 1);
});

test('Codex fallback uses canonical all-facts ingestion and shares its cache across questions', async t => {
  const store = storeFor(t); let codexCalls = 0; let jevCalls = 0; let question = '';
  const pipeline = new AnalysisPipeline(store.db, {}, async input => { codexCalls++; question = input.question; return extraction(input); }, undefined, { jev: config, runJev: async input => {
    jevCalls++; return { extraction: extraction(input), needsFallback: true };
  } });
  const signal = new AbortController().signal;
  await pipeline.process(part, '누가 소유하나요?', signal, () => {}, () => {});
  const result = await pipeline.process(part, '어떤 회사인가요?', signal, () => {}, () => {});
  assert.equal(codexCalls, 1); assert.equal(jevCalls, 1); assert.equal(result.origin, 'codex');
  assert.match(question, /특정 사용자 질문에 맞춰 사실을 제외하지/);
});

test('failed shared requests do not count as successful cache reuse', async t => {
  const store = storeFor(t); let reject!: (error: Error) => void; let calls = 0;
  const failure = new Promise<never>((_resolve, rejectPromise) => { reject = rejectPromise; });
  const pipeline = new AnalysisPipeline(store.db, {}, async () => { throw new Error('unexpected Codex'); }, undefined, { jev: config, runJev: async () => { calls++; return failure; } });
  let hits = 0; const usage = (delta: Partial<AnalysisMetrics>) => { hits += delta.cacheHits ?? 0; };
  const first = pipeline.process(part, 'first', new AbortController().signal, usage, () => {});
  const second = pipeline.process(part, 'second', new AbortController().signal, usage, () => {});
  reject(new Error('provider failed'));
  const results = await Promise.allSettled([first, second]);
  assert.equal(calls, 1); assert.equal(hits, 0); assert.ok(results.every(result => result.status === 'rejected'));
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM extraction_cache').get()!.count, 0);
});

test('hybrid checkpoints store ordered graph membership once and keep status payload bounded', async t => {
  const store = new OntologyStore(':memory:');
  const manager = new JobManager(store, {}, async () => { throw new Error('CSV must not use Codex'); }, undefined, {});
  t.after(async () => { await manager.close(); store.close(); });
  store.db.exec("CREATE TEMP TRIGGER bounded_hybrid_payload BEFORE UPDATE ON generation_jobs WHEN json_extract(NEW.payload,'$.processingMode')='hybrid' AND json_type(NEW.payload,'$.graphIds') IS NOT NULL BEGIN SELECT RAISE(ABORT,'growing graph array persisted'); END");
  const text = 'vessel_name,imo\n' + Array.from({ length: 310 }, (_, index) => `Ocean Star ${index},9074729\n`).join('');
  const job = await terminal(manager, manager.create({ question: '선박을 정리해주세요.', documents: [{ id: 'csv-source', name: 'ships.csv', text }] }).id);
  assert.equal(job.status, 'completed', job.error); assert.equal(job.graphIds.length, 3); assert.equal(job.graphCount, 3);
  const payload = JSON.parse(String(store.db.prepare('SELECT payload FROM generation_jobs WHERE id=?').get(job.id)!.payload));
  assert.equal(payload.graphIds, undefined); assert.equal(payload.graphCount, 3); assert.equal(payload.graphId, job.graphIds[0]);
  assert.deepEqual(store.db.prepare('SELECT graph_id FROM analysis_parts WHERE job_id=? ORDER BY part_index').all(job.id).map(row => row.graph_id), job.graphIds);
  assert.ok(store.db.prepare('SELECT payload FROM analysis_parts WHERE job_id=?').all(job.id).every(row => row.payload === null));
  assert.deepEqual(manager.list()[0].graphIds, job.graphIds);
});

test('graph membership, graph save and hybrid checkpoint roll back together', async t => {
  const store = new OntologyStore(':memory:');
  const manager = new JobManager(store, {}, async input => extraction(input), undefined, {});
  t.after(async () => { await manager.close(); store.close(); });
  store.db.exec("CREATE TEMP TRIGGER reject_hybrid_checkpoint BEFORE UPDATE ON generation_jobs WHEN json_extract(NEW.payload,'$.completedChunks')=1 BEGIN SELECT RAISE(ABORT,'checkpoint failure'); END");
  const job = await terminal(manager, manager.create({ question: '전체 자료', documents: part.documents }).id);
  assert.equal(job.status, 'failed'); assert.equal(job.graphCount, 0); assert.equal(job.graphIds.length, 0); assert.equal(store.summary().graphs, 0);
  const row = store.db.prepare('SELECT graph_id,payload FROM analysis_parts WHERE job_id=?').get(job.id)!;
  assert.equal(row.graph_id, null); assert.equal(typeof row.payload, 'string'); assert.equal(job.resumable, true);
});

test('reported late usage survives cancel and immediate resume while stale callbacks cannot overwrite it', async t => {
  const store = new OntologyStore(':memory:'); let calls = 0; let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  let oldUsage: ((usage: JevUsage) => void) | undefined;
  const manager = new JobManager(store, {}, async () => { throw new Error('unexpected Codex'); }, undefined, { jev: config, runJev: async (input, _config, options) => {
    calls++; options?.onUsage?.({ requests: 1, inputTokens: 0 });
    if (calls === 1) {
      oldUsage = options?.onUsage; started();
      await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      await delay(5); options?.onUsage?.({ requests: 0, inputTokens: 321 });
      throw new Error('cancelled provider');
    }
    options?.onUsage?.({ requests: 0, inputTokens: 10 });
    return { extraction: extraction(input), needsFallback: false };
  } });
  t.after(async () => { await manager.close(); store.close(); });
  const initial = manager.create({ question: '전체 자료', documents: part.documents });
  await began; manager.cancel(initial.id); const queued = manager.resume(initial.id);
  assert.equal(queued.status, 'queued');
  const job = await terminal(manager, initial.id);
  assert.equal(job.status, 'completed', job.error); assert.equal(job.metrics!.jevInputTokens, 331); assert.equal(job.metrics!.jevRequests, 2);
  assert.equal(job.graphIds.length, 1);
  oldUsage?.({ requests: 0, inputTokens: 1000 });
  assert.equal(manager.get(job.id)!.metrics!.jevInputTokens, 331);
});

test('existing hybrid graph arrays migrate once and keep order on restart', async t => {
  const store = new OntologyStore(':memory:');
  const manager = new JobManager(store, {}, async input => extraction(input), undefined, {});
  const finished = await terminal(manager, manager.create({ question: '전체 자료', documents: [{ ...part.documents[0], text: part.documents[0].text.repeat(1200) }] }).id);
  assert.equal(finished.status, 'completed', finished.error); await manager.close();
  store.db.prepare('UPDATE generation_jobs SET payload=? WHERE id=?').run(JSON.stringify({ ...finished, graphCount: undefined }), finished.id);
  store.db.prepare('UPDATE analysis_parts SET graph_id=NULL WHERE job_id=?').run(finished.id);
  const restarted = new JobManager(store, {}, async () => { throw new Error('no replay'); }, undefined, {});
  t.after(async () => { await restarted.close(); store.close(); });
  assert.deepEqual(restarted.get(finished.id)!.graphIds, finished.graphIds);
  assert.equal(restarted.get(finished.id)!.graphCount, finished.graphIds.length);
  const raw = JSON.parse(String(store.db.prepare('SELECT payload FROM generation_jobs WHERE id=?').get(finished.id)!.payload));
  assert.equal(raw.graphIds, undefined);
});

test('timeout repartition preserves committed prefix, original text and stable suffix across restart', async t => {
  const store = storeFor(t);
  const runner = async () => { throw new Error('planning must not invoke a model'); };
  const pipeline = new AnalysisPipeline(store.db, {}, runner, undefined, {});
  const longText = Array.from({ length: 80 }, (_, i) => `record ${i}: ${'😀'.repeat(30)}\n`).join('');
  const input = { question: '전체 자료', documents: [
    { id: 'one', name: 'one.txt', text: 'Already committed first document.' },
    { id: 'two', name: 'two.txt', text: longText },
    { id: 'three', name: 'three.txt', text: 'Pending third document.' },
  ] };
  assert.equal(await pipeline.prepare('split', input, new AbortController().signal, () => {}), 3);
  pipeline.releasePart('split', 1, 'saved-first');
  const before = pipeline.getPart('split', 2);
  let callbackTotal = 0;
  assert.deepEqual(pipeline.splitTimedOutPart('split', 2, result => { callbackTotal = result.total; }), { total: 4, parts: 2 });
  assert.equal(callbackTotal, 4);
  const left = pipeline.getPart('split', 2); const right = pipeline.getPart('split', 3);
  assert.equal(left.documents[0].identityScope, before.documents[0].identityScope);
  assert.equal(right.documents[0].identityScope, before.documents[0].identityScope);
  const rightStart = longText.indexOf(right.documents[0].text);
  assert.ok(rightStart >= 0 && rightStart < left.documents[0].text.length);
  assert.equal(left.documents[0].text.slice(0, rightStart) + right.documents[0].text, longText);
  for (const child of [left, right]) assert.equal(Buffer.from(child.documents[0].text, 'utf8').toString('utf8'), child.documents[0].text);
  assert.equal(store.db.prepare('SELECT graph_id,payload FROM analysis_parts WHERE job_id=? AND part_index=1').get('split')!.graph_id, 'saved-first');
  assert.equal(pipeline.getPart('split', 4).documents[0].id, 'three');
  const restarted = new AnalysisPipeline(store.db, {}, runner, undefined, {});
  assert.equal(await restarted.prepare('split', input, new AbortController().signal, () => {}), 4);
  assert.deepEqual(restarted.getPart('split', 2), left);
  assert.equal(restarted.splitTimedOutPart('split', 1), undefined);
});

test('timeout repartition rolls back with its checkpoint and has a persistent depth limit', async t => {
  const store = storeFor(t);
  const pipeline = new AnalysisPipeline(store.db, {}, async () => { throw new Error('unexpected model'); }, undefined, {});
  const input = { question: '전체 자료', documents: [{ id: 'large', name: 'large.txt', text: '0123456789 '.repeat(2000) }] };
  await pipeline.prepare('bounded', input, new AbortController().signal, () => {});
  const original = pipeline.getPart('bounded', 1);
  assert.throws(() => pipeline.splitTimedOutPart('bounded', 1, () => { throw new Error('checkpoint rejected'); }), /checkpoint rejected/);
  assert.equal(store.db.prepare('SELECT total FROM analysis_plans WHERE job_id=?').get('bounded')!.total, 1);
  assert.deepEqual(pipeline.getPart('bounded', 1), original);
  assert.equal(pipeline.splitTimedOutPart('bounded', 1)?.total, 2);
  assert.equal(pipeline.splitTimedOutPart('bounded', 1)?.total, 3);
  assert.equal(pipeline.getPart('bounded', 1).splitDepth, 2);
  assert.equal(pipeline.splitTimedOutPart('bounded', 1), undefined);
});
