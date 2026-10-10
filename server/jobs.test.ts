import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { EvidenceDocument } from '../src/types/graph.ts';
import type { OntologyExtraction } from '../src/types/ontology.ts';
import type { CodexInput } from './codex.ts';
import { JobManager } from './jobs.ts';
import type { CodexRunner, GenerationJob } from './jobs.ts';
import { OntologyStore } from './ontology-store.ts';
import { EVIDENCE_CHUNK_CHARS, splitEvidenceText } from './evidence-uploads.ts';

function extraction(input: CodexInput): OntologyExtraction {
  return {
    title: 'Verified source records', summary: '자료의 객체를 확인했습니다.',
    entities: input.documents.map((document, index) => ({ id: `record-${index}`, label: 'Ocean Star', type: 'vessel', description: '자료에 등장하는 선박.', identifiers: [], properties: [], evidence: [{ documentId: document.id, quote: document.text.slice(0, 40) }] })),
    relationships: [], events: [], findings: [], limitations: [],
  };
}
function empty(): OntologyExtraction {
  return { title: 'Insufficient evidence', summary: '자료에 관련 근거가 없습니다.', entities: [], relationships: [], events: [], findings: [], limitations: ['추출할 관련 정보 없음.'] };
}
function setup(t: TestContext, runner: CodexRunner, uploads?: ConstructorParameters<typeof JobManager>[3]) {
  const store = new OntologyStore(':memory:');
  const manager = new JobManager(store, {}, runner, uploads);
  t.after(async () => { await manager.close(); store.close(); });
  return { store, manager };
}
async function terminal(manager: JobManager, id: string): Promise<GenerationJob> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const job = manager.get(id)!;
    if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
    await delay(5);
  }
  throw new Error('Job did not finish.');
}
const longText = 'Ocean Star is described in this synthetic test source.\n'.repeat(1400);
const longSource = { id: 'long-source', name: 'Full source.txt', text: longText };
const longRequest = { question: 'Ocean Star에 관한 자료를 전체 분석해주세요.', documents: [longSource] };

test('all inline chunks are analyzed in order and each graph remains separately available', async t => {
  const calls: CodexInput[] = [];
  const { manager, store } = setup(t, async input => { calls.push(input); return extraction(input); });
  const job = await terminal(manager, manager.create(longRequest).id);
  const expected = [...splitEvidenceText(longText)];
  assert.equal(job.status, 'completed', job.error);
  assert.equal(job.completedChunks, expected.length);
  assert.equal(job.totalChunks, expected.length);
  assert.equal(job.graphIds.length, expected.length);
  assert.equal(job.graphId, job.graphIds[0]);
  assert.equal(job.resumable, false);
  assert.deepEqual(calls.map(call => call.documents[0].text), expected.map(part => part.text));
  assert.ok(calls.every(call => call.documents.reduce((sum, doc) => sum + doc.text.length, 0) <= EVIDENCE_CHUNK_CHARS));
  const scopes = calls.map(call => (call.documents[0] as EvidenceDocument).identityScope);
  assert.ok(scopes[0]?.startsWith('inline-')); assert.equal(new Set(scopes).size, 1);
  for (let index = 0; index < job.graphIds.length; index++) {
    const graph = store.getGraph(job.graphIds[index])!;
    assert.ok(graph.title.endsWith(`part ${index + 1}/${expected.length}`));
    assert.match(graph.limitations.at(-1)!, /구간별로 분석/);
  }
  assert.equal(store.summary().graphs, expected.length);
});

test('small inline sources preserve their original ids and fit together in one bounded batch', async t => {
  const documents = [{ id: 'first', name: 'first.txt', text: 'Ocean Star appears in the first source document.' }, { id: 'second', name: 'second.txt', text: 'Ocean Star appears in the second source document.' }];
  const calls: CodexInput[] = [];
  const { manager, store } = setup(t, async input => { calls.push(input); return extraction(input); });
  const job = await terminal(manager, manager.create({ question: '자료를 정리해주세요.', documents }).id);
  assert.equal(job.status, 'completed', job.error);
  assert.deepEqual(calls[0].documents, documents);
  assert.equal(calls.length, 1);
  assert.equal(job.totalChunks, 1);
  assert.equal(store.getGraph(job.graphId!)!.title, 'Verified source records');
});

test('uploaded content is read lazily and whitespace/insufficient-evidence chunks do not stop later parts', async t => {
  const read: number[] = [];
  const texts = ['Ocean Star appears in the first uploaded part.', ' \n '.repeat(20), 'This part has no relevant maritime evidence.', 'Ocean Star appears in the last uploaded part.'];
  const uploads = {
    get: (id: string) => ({ id, name: 'Uploaded.txt', bytes: 1000, characters: 1000, chunkCount: texts.length, createdAt: new Date().toISOString() }),
    getChunk: (id: string, index: number) => { read.push(index); return { id: `${id}-part-${index + 1}`, name: `Uploaded.txt · part ${index + 1}`, text: texts[index], identityScope: id }; },
  };
  let calls = 0;
  const { manager, store } = setup(t, async input => {
    calls++;
    const part = Number(input.documents[0].id.split('-').at(-1));
    assert.equal(read.length, part, 'future upload chunks must not be prefetched');
    return part === 3 ? empty() : extraction(input);
  }, uploads);
  const job = await terminal(manager, manager.create({ question: '전체 자료를 분석해주세요.', documents: [], uploadIds: ['upload-example'] }).id);
  assert.equal(job.status, 'completed', job.error);
  assert.deepEqual(read, [0, 1, 2, 3]);
  assert.equal(calls, 3); assert.equal(job.emptyChunks, 2); assert.equal(job.completedChunks, 4);
  assert.equal(job.graphIds.length, 2); assert.equal(store.summary().graphs, 2);
});

test('all-empty input completes coverage but fails honestly and cannot be resumed', async t => {
  let calls = 0;
  const { manager, store } = setup(t, async () => { calls++; return empty(); });
  const job = await terminal(manager, manager.create(longRequest).id);
  assert.equal(job.status, 'failed'); assert.match(job.error!, /근거를 찾지 못했습니다/);
  assert.equal(job.completedChunks, job.totalChunks);
  assert.equal(job.emptyChunks, job.totalChunks); assert.equal(calls, job.totalChunks);
  assert.equal(job.graphIds.length, 0); assert.equal(store.summary().graphs, 0);
  assert.equal(job.resumable, false); assert.throws(() => manager.resume(job.id));
});

test('a large sequence of blank chunks yields so cancellation stops further reads', async t => {
  let read = 0; let calls = 0;
  const uploads = {
    get: (id: string) => ({ id, name: 'Whitespace.txt', bytes: 30_000_000, characters: 30_000_000, chunkCount: 1000, createdAt: new Date().toISOString() }),
    getChunk: (id: string, index: number) => { read++; return { id: `${id}-part-${index + 1}`, name: 'Whitespace.txt', text: ' '.repeat(30_000) }; },
  };
  const { manager } = setup(t, async () => { calls++; return empty(); }, uploads);
  const job = manager.create({ question: '자료를 분석해주세요.', documents: [], uploadIds: ['blank-upload'] });
  await new Promise<void>(resolve => setImmediate(resolve));
  const cancelled = manager.cancel(job.id)!;
  assert.equal(cancelled.status, 'cancelled');
  await delay(5);
  assert.ok(read < 1000); assert.equal(calls, 0);
  assert.ok(manager.get(job.id)!.completedChunks < 1000);
});

test('failure preserves prior graphs and resume skips completed chunks with the same job id', async t => {
  const calls: string[] = []; let shouldFail = true;
  const { manager, store } = setup(t, async input => {
    calls.push(input.documents[0].id);
    if (calls.length === 2 && shouldFail) throw new Error('Temporary provider outage.');
    return extraction(input);
  });
  const failed = await terminal(manager, manager.create(longRequest).id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.completedChunks, 1); assert.equal(failed.graphIds.length, 1);
  assert.equal(failed.resumable, true); assert.match(failed.message, /남은 부분을 완료하지 못했습니다/);
  const originalGraph = failed.graphId;
  shouldFail = false;
  assert.equal(manager.resume(failed.id).id, failed.id);
  const completed = await terminal(manager, failed.id);
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(completed.graphId, originalGraph);
  assert.equal(calls.filter(id => id === calls[0]).length, 1);
  assert.equal(calls.length, completed.totalChunks + 1);
  assert.equal(store.summary().graphs, completed.totalChunks);
});

test('cancel and immediate resume retain the first graph without saving the cancelled result', async t => {
  let notify!: () => void;
  const secondStarted = new Promise<void>(resolve => { notify = resolve; });
  let calls = 0;
  const { manager, store } = setup(t, async (input, _config, options) => {
    calls++;
    if (calls === 2) {
      notify();
      await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('Aborted test call.')), { once: true }));
    }
    return extraction(input);
  });
  const created = manager.create(longRequest);
  await secondStarted;
  const cancelled = manager.cancel(created.id)!;
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.completedChunks, 1);
  assert.equal(cancelled.graphIds.length, 1); assert.equal(cancelled.resumable, true);
  manager.resume(created.id);
  const completed = await terminal(manager, created.id);
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(completed.graphIds[0], cancelled.graphIds[0]);
  assert.equal(calls, completed.totalChunks + 1);
  assert.equal(store.summary().graphs, completed.totalChunks);
});

test('one repair is allowed per invalid chunk and failure leaves only prior validated graphs', async t => {
  const calls: string[] = [];
  const { manager, store } = setup(t, async input => {
    calls.push(input.documents[0].id);
    const result = extraction(input);
    if (calls.length > 1) result.entities[0].evidence[0].quote = 'An invented quote absent from the original source.';
    return result;
  });
  const job = await terminal(manager, manager.create(longRequest).id);
  assert.equal(job.status, 'failed'); assert.match(job.error!, /인용문/);
  assert.equal(calls.length, 3); assert.equal(calls[1], calls[2]);
  assert.equal(job.completedChunks, 1); assert.equal(job.graphIds.length, 1);
  assert.equal(store.summary().graphs, 1);
});

test('graph persistence and completed-chunk checkpoint roll back atomically', async t => {
  const { manager, store } = setup(t, async input => extraction(input));
  store.db.exec("CREATE TEMP TRIGGER reject_checkpoint BEFORE UPDATE ON generation_jobs WHEN json_extract(NEW.payload,'$.completedChunks')=1 BEGIN SELECT RAISE(ABORT,'checkpoint failure'); END");
  const failed = await terminal(manager, manager.create(longRequest).id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.completedChunks, 0);
  assert.equal(failed.graphIds.length, 0); assert.equal(store.summary().graphs, 0);
  store.db.exec('DROP TRIGGER reject_checkpoint');
  manager.resume(failed.id);
  const completed = await terminal(manager, failed.id);
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(store.summary().graphs, completed.totalChunks);
});

test('source-free retrieval is frozen for resume even when stored search results change', async t => {
  const store = new OntologyStore(':memory:');
  let selected = longSource; const calledNames: string[] = []; let calls = 0;
  store.searchContext = () => ({ documents: [selected], entities: [] });
  const manager = new JobManager(store, {}, async input => {
    calls++; calledNames.push(input.documents[0].name);
    if (calls === 2) throw new Error('Provider interrupted.');
    return extraction(input);
  });
  t.after(async () => { await manager.close(); store.close(); });
  const failed = await terminal(manager, manager.create({ question: '기존 자료를 분석해주세요.', documents: [] }).id);
  selected = { id: 'different-source', name: 'Newly changed.txt', text: 'Unrelated changed evidence should not replace the original request.' };
  manager.resume(failed.id);
  const completed = await terminal(manager, failed.id);
  assert.equal(completed.status, 'completed', completed.error);
  assert.ok(calledNames.every(name => name.startsWith(longSource.name)));
  assert.equal(completed.totalChunks, failed.totalChunks);
});

test('restart marks interrupted jobs failed and preserves their resumable checkpoint', async t => {
  const store = new OntologyStore(':memory:');
  let calls = 0;
  const first = new JobManager(store, {}, async input => { if (++calls === 2) throw new Error('Interrupted provider.'); return extraction(input); });
  const failed = await terminal(first, first.create(longRequest).id);
  await first.close();
  // A terminated process leaves exactly its last persisted running payload.
  store.db.prepare('UPDATE generation_jobs SET payload=? WHERE id=?').run(JSON.stringify({ ...failed, status: 'running' }), failed.id);
  const second = new JobManager(store, {}, async input => extraction(input));
  t.after(async () => { await second.close(); store.close(); });
  const restarted = second.get(failed.id)!;
  assert.equal(restarted.status, 'failed'); assert.match(restarted.message, /재시작/);
  assert.deepEqual(restarted.graphIds, failed.graphIds); assert.equal(restarted.completedChunks, 1); assert.equal(restarted.resumable, true);
  second.resume(restarted.id);
  const completed = await terminal(second, restarted.id);
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(store.summary().graphs, completed.totalChunks);
});

test('restart after the final atomic checkpoint recovers completion without repeating model calls', async t => {
  const store = new OntologyStore(':memory:');
  const first = new JobManager(store, {}, async input => extraction(input));
  const finished = await terminal(first, first.create(longRequest).id);
  await first.close();
  store.db.prepare('UPDATE generation_jobs SET payload=? WHERE id=?').run(JSON.stringify({ ...finished, status: 'running' }), finished.id);
  let calls = 0;
  const second = new JobManager(store, {}, async input => { calls++; return extraction(input); });
  t.after(async () => { await second.close(); store.close(); });
  const recovered = second.get(finished.id)!;
  assert.equal(recovered.status, 'completed'); assert.equal(recovered.resumable, false); assert.equal(calls, 0);
  assert.deepEqual(recovered.graphIds, finished.graphIds); assert.equal(recovered.completedChunks, recovered.totalChunks);
});
