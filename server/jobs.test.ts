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
import { getAnalysisRecord } from './analysis-case.ts';
import { readJevConfig } from './jev.ts';

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

for (const uploaded of [false, true]) test(`input-ready hook provides durable ${uploaded ? 'uploaded first-chunk' : 'inline'} text before hybrid ontology generation`, async t => {
  const store = new OntologyStore(':memory:');
  const document = { id: uploaded ? 'upload-real-part-1' : 'original', name: '원문.txt', text: 'Ocean Star appears in the actual first source chunk.' };
  const reads: number[] = []; let designStarted = false; let observed: { job: GenerationJob; documents: EvidenceDocument[] } | undefined;
  const uploads = uploaded ? {
    get: (id: string) => ({ id, name: document.name, bytes: 100, characters: 100, chunkCount: 2, createdAt: new Date().toISOString() }),
    getChunk: (_id: string, index: number) => { reads.push(index); return { ...document, text: index ? 'Later chunk not needed for the initial graph.' : document.text }; },
    getChunkRange: (_id: string, index: number) => ({ start: index ? document.text.length : 0, end: index ? document.text.length + 'Later chunk not needed for the initial graph.'.length : document.text.length }),
  } : undefined;
  const manager = new JobManager(store, {}, async (input, _config, options) => {
    assert.equal(input.purpose, 'ontology-design'); assert.ok(observed, 'input hook must fire before the ontology provider starts'); designStarted = true;
    return await new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('test cancelled')), { once: true }));
  }, uploads, { ontologyPlanning: true });
  t.after(async () => { await manager.close(); store.close(); });
  manager.onInputsReady((job, documents) => { observed = { job, documents }; const input = JSON.parse(String(store.db.prepare('SELECT input_json FROM generation_jobs WHERE id=?').get(job.id)!.input_json)); assert.equal(input.urlEvidenceResolved, true); });
  const created = manager.create({ question: '자료를 정리해주세요.', documents: uploaded ? [] : [document], ...(uploaded ? { uploadIds: ['upload-real'] } : {}) });
  for (let i = 0; i < 100 && !designStarted; i++) await delay(5);
  assert.ok(designStarted, JSON.stringify(manager.get(created.id))); assert.ok(observed); assert.equal(observed.job.status, 'running'); assert.equal(observed.job.completedChunks, 0); assert.deepEqual(observed.job.graphIds, []);
  assert.equal(observed.documents[0].id, document.id); assert.equal(observed.documents[0].text, document.text);
  if (uploaded) assert.equal(reads[0], 0);
  await manager.cancel(created.id); assert.equal(manager.get(created.id)!.status, 'cancelled');
});

test('an unavailable background graph listener never prevents main extraction', async t => {
  const { manager } = setup(t, async input => extraction(input));
  manager.onInputsReady(() => { throw new Error('background preparation unavailable'); });
  const saved = await terminal(manager, manager.create({ question: '자료를 정리해주세요.', documents: [{ id: 'source', name: '원문', text: 'Ocean Star appears in this document.' }] }).id);
  assert.equal(saved.status, 'completed', saved.error); assert.equal(saved.graphIds.length, 1);
});

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

test('valid empty hybrid results complete with their explanation and original evidence preserved', async t => {
  const store = new OntologyStore(':memory:');
  let calls = 0;
  const manager = new JobManager(store, {}, async () => { calls++; return empty(); }, undefined, {});
  t.after(async () => { await manager.close(); store.close(); });
  const documents = [
    { id: 'first', name: 'First source.txt', text: 'This supplied report describes deployment, without evidence of combat.' },
    { id: 'second', name: 'Second source.txt', text: 'This second supplied report does not establish participation in combat.' },
  ];
  const job = await terminal(manager, manager.create({ question: '실제 전투 참여 근거가 있나요?', documents }).id);
  assert.equal(job.status, 'completed', job.error);
  assert.equal(job.error, undefined); assert.equal(job.errorCode, undefined);
  assert.match(job.message, /질문에 답할 근거가 충분하지 않습니다/);
  assert.equal(job.completedChunks, 2); assert.equal(job.emptyChunks, 2); assert.equal(calls, 2);
  assert.equal(job.graphCount, 0); assert.deepEqual(job.graphIds, []); assert.equal(store.summary().graphs, 0);
  assert.equal(job.resumable, false);
  for (let number = 1; number <= 2; number++) {
    const record = getAnalysisRecord(store.db, job, number)!;
    assert.equal(record.record.archived, true); assert.equal(record.record.status, 'empty');
    assert.equal(record.summary, empty().summary); assert.deepEqual(record.limitations, empty().limitations);
    assert.equal(record.documents[0].text, documents[number - 1].text);
  }
});

test('empty hybrid results requiring review remain failed instead of claiming a finished answer', async t => {
  const store = new OntologyStore(':memory:');
  const manager = new JobManager(store, {}, async () => { throw new Error('Unexpected Codex call.'); }, undefined, {
    jev: { ...readJevConfig({ TYPESAFE_API_KEY: 'test-key-never-sent' }), fallback: false },
    runJev: async () => ({ extraction: empty(), needsFallback: true }),
  });
  t.after(async () => { await manager.close(); store.close(); });
  const job = await terminal(manager, manager.create({ question: '관련 근거를 확인해주세요.', documents: [longSource] }).id);
  assert.equal(job.status, 'failed'); assert.match(job.error!, /검토가 필요한 부분/);
  assert.equal(job.completedChunks, job.totalChunks); assert.equal(job.emptyChunks, job.totalChunks);
  assert.ok(job.metrics!.reviewParts > 0); assert.equal(job.graphCount, 0);
});

test('empty hybrid finalization does not hide provider or extraction validation failures', async t => {
  for (const failure of ['provider', 'validation'] as const) await t.test(failure, async t => {
    const store = new OntologyStore(':memory:');
    let calls = 0;
    const manager = new JobManager(store, {}, async () => {
      calls++;
      if (failure === 'provider') throw new Error('Temporary provider outage.');
      return { ...empty(), summary: 123 };
    }, undefined, {});
    t.after(async () => { await manager.close(); store.close(); });
    const job = await terminal(manager, manager.create({ question: '자료를 분석해주세요.', documents: [longSource] }).id);
    assert.equal(job.status, 'failed'); assert.ok(job.error);
    assert.equal(job.completedChunks, 0); assert.equal(job.emptyChunks, 0); assert.equal(job.resumable, true);
    assert.equal(calls, failure === 'provider' ? 1 : 2);
    assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM analysis_record_archive WHERE job_id=?').get(job.id)!.n), 0);
  });
});

test('restart recovers an empty hybrid answer only when every completed result remains archived', async t => {
  for (const keepArchive of [true, false]) await t.test(keepArchive ? 'retained archive' : 'missing archive', async t => {
    const store = new OntologyStore(':memory:');
    const first = new JobManager(store, {}, async () => empty(), undefined, {});
    const finished = await terminal(first, first.create({ question: '관련 근거를 확인해주세요.', documents: [{ id: 'source', name: 'Source.txt', text: 'This report does not contain evidence relevant to the question.' }] }).id);
    assert.equal(finished.status, 'completed', finished.error);
    await first.close();
    store.db.prepare('UPDATE generation_jobs SET payload=? WHERE id=?').run(JSON.stringify({ ...finished, status: 'running', graphIds: undefined }), finished.id);
    if (!keepArchive) store.db.prepare('DELETE FROM analysis_record_archive WHERE job_id=?').run(finished.id);
    let calls = 0;
    const second = new JobManager(store, {}, async () => { calls++; return empty(); }, undefined, {});
    t.after(async () => { await second.close(); store.close(); });
    const recovered = second.get(finished.id)!;
    assert.equal(recovered.status, keepArchive ? 'completed' : 'failed');
    if (keepArchive) { assert.equal(recovered.error, undefined); assert.match(recovered.message, /판단 이유와 원문/); }
    assert.equal(recovered.resumable, false); assert.equal(calls, 0); assert.equal(recovered.graphCount, 0);
  });
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

test('independent cases overlap and cancelling one preserves the other case and its evidence', { timeout: 5000 }, async t => {
  const store = new OntologyStore(':memory:');
  const held = new Map<string, { signal: AbortSignal; release: () => void }>();
  let notifyBoth!: () => void;
  const bothStarted = new Promise<void>(resolve => { notifyBoth = resolve; });
  const manager = new JobManager(store, { jobConcurrency: 2, concurrency: 2 }, async (input, _config, options) => {
    const signal = options?.signal; assert.ok(signal);
    let abort!: () => void;
    try {
      await new Promise<void>((resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        held.set(input.documents[0].text, { signal, release: resolve });
        if (held.size === 2) notifyBoth();
      });
      return extraction(input);
    } finally { signal.removeEventListener('abort', abort); }
  }, undefined, {});
  t.after(async () => { await manager.close(); store.close(); });
  const firstDocument = { id: 'case-one-source', name: 'first-case.txt', text: 'Ocean Star appears in the first northern case record.' };
  const secondDocument = { id: 'case-two-source', name: 'second-case.txt', text: 'Ocean Star appears in the second southern case record.' };
  const first = manager.create({ question: '첫 번째 사건의 선박을 확인해주세요.', documents: [firstDocument] });
  const secondQuestion = '두 번째 사건의 선박을 확인해주세요.';
  const second = manager.create({ question: secondQuestion, documents: [secondDocument] });
  await bothStarted;
  assert.equal(manager.get(first.id)!.status, 'running');
  assert.equal(manager.get(second.id)!.status, 'running');
  assert.equal(store.summary().graphs, 0, 'both cases reach held model work before either completes');
  const firstCall = held.get(firstDocument.text)!; const secondCall = held.get(secondDocument.text)!;
  assert.notEqual(firstCall.signal, secondCall.signal);

  manager.cancel(first.id);
  assert.equal(firstCall.signal.aborted, true);
  assert.equal(secondCall.signal.aborted, false);
  assert.equal(manager.get(second.id)!.status, 'running');
  secondCall.release();
  const completed = await terminal(manager, second.id);
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(manager.get(first.id)!.status, 'cancelled');
  assert.deepEqual(manager.get(first.id)!.graphIds, []);
  assert.equal(completed.graphIds.length, 1); assert.equal(store.summary().graphs, 1);
  const graph = store.getGraph(completed.graphId!)!;
  assert.equal(graph.question, secondQuestion);
  assert.deepEqual(graph.sources.map(source => ({ id: source.id, title: source.title, excerpt: source.excerpt })), [{ id: secondDocument.id, title: secondDocument.name, excerpt: secondDocument.text }]);
  assert.ok(graph.nodes.every(node => node.sourceIds.every(id => id === secondDocument.id)));
  assert.equal(secondCall.signal.aborted, false);
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
