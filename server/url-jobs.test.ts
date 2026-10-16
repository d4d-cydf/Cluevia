import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { EvidenceDocument, GraphGenerationInput } from '../src/types/graph.ts';
import type { OntologyExtraction } from '../src/types/ontology.ts';
import type { CodexInput } from './codex.ts';
import { JobManager } from './jobs.ts';
import type { CodexRunner, GenerationJob } from './jobs.ts';
import { OntologyStore } from './ontology-store.ts';
import { parseOntologyDefinition } from './ontology-schema.ts';
import { getAnalysisRecord } from './analysis-case.ts';
import type { resolveUrlEvidence, UrlEvidenceRead } from './url-evidence.ts';

type Resolver = typeof resolveUrlEvidence;
const url = 'https://news.example.com/reports/employment';
const blockedUrl = 'https://news.example.com/reports/unavailable';
const body = 'Alice works for Acme. The report identifies Alice as an Acme employee.';
const input: GraphGenerationInput = {
  question: 'Alice는 어느 회사에서 일하나요?',
  documents: [{ id: 'pasted-source', name: 'Pasted source text', text: url }],
};
const article: EvidenceDocument = { id: 'url-article', name: 'Employment report', url, text: body };
const fetched: UrlEvidenceRead = { documentId: article.id, url, finalUrl: url, status: 'fetched', title: article.name, characters: body.length };
const failed: UrlEvidenceRead = { documentId: 'unavailable-article', url: blockedUrl, status: 'failed', reason: '원문을 읽지 못했습니다 (HTTP 403). 기사 본문을 붙여넣어 주세요.' };

function definition() {
  return parseOntologyDefinition({
    apiName: 'Employment', displayName: '고용 관계',
    objectTypes: ['Person', 'Company'].map(apiName => ({ apiName, primaryKey: 'name', titleProperty: 'name', properties: [{ apiName: 'name', baseType: 'string' }] })),
    linkTypes: [{ apiName: 'worksFor', sourceType: 'Person', targetType: 'Company', sourceCardinality: 'many', targetCardinality: 'one' }],
    processing: { textStrategy: 'codex', jevEligibleLinkTypes: [], rationale: 'Explicit employment statements in the original article.' },
  });
}
function extraction(input: CodexInput): OntologyExtraction {
  const evidence = [{ documentId: input.documents[0].id, quote: 'Alice works for Acme.' }];
  return {
    title: '고용 관계', summary: '원문은 Alice가 Acme에서 근무한다고 설명합니다.',
    entities: [
      { id: 'alice', type: 'Person', label: 'Alice', description: '', identifiers: [], properties: [{ key: 'name', value: 'Alice' }], evidence },
      { id: 'acme', type: 'Company', label: 'Acme', description: '', identifiers: [], properties: [{ key: 'name', value: 'Acme' }], evidence },
    ],
    relationships: [{ id: 'work', source: 'alice', target: 'acme', type: 'worksFor', label: '근무', description: '', status: 'reported', evidence }],
    events: [], findings: [], limitations: [],
  };
}
function setup(t: TestContext, runner: CodexRunner, resolver: Resolver) {
  const store = new OntologyStore(':memory:');
  const manager = new JobManager(store, {}, runner, undefined, { ontologyPlanning: true }, resolver);
  t.after(async () => { await manager.close(); store.close(); });
  return { store, manager };
}
async function terminal(manager: JobManager, id: string): Promise<GenerationJob> {
  for (let attempt = 0; attempt < 600; attempt++) {
    const job = manager.get(id)!;
    if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
    await delay(5);
  }
  throw new Error('Job did not finish.');
}

test('URL article bodies reach ontology planning and extraction with original source attribution', async t => {
  const calls: CodexInput[] = [];
  let reads = 0;
  const { manager, store } = setup(t, async input => {
    calls.push(input);
    assert.ok(input.documents.some(document => document.text.includes(body)), 'both stages must receive article text, not just its address');
    return input.purpose === 'ontology-design' ? definition() : extraction(input);
  }, async (documents, options) => {
    reads++;
    assert.deepEqual(documents, input.documents);
    assert.ok(options?.signal instanceof AbortSignal);
    return { documents: [article], results: [fetched] };
  });
  const job = await terminal(manager, manager.create(input).id);
  assert.equal(job.status, 'completed', job.error);
  assert.equal(reads, 1);
  assert.equal(calls.filter(call => call.purpose === 'ontology-design').length, 1);
  assert.equal(calls.filter(call => call.purpose !== 'ontology-design').length, 1);
  assert.deepEqual(job.urlReads, [fetched]);
  const graph = store.getGraph(job.graphId!)!;
  assert.ok(graph.sources.some(source => source.url === url && source.excerpt?.includes('Alice works for Acme.')));
});

test('resume after restart uses the persisted article snapshot without fetching a changed page again', async t => {
  const store = new OntologyStore(':memory:');
  const managers: JobManager[] = [];
  t.after(async () => { for (const manager of managers) await manager.close(); store.close(); });
  let reads = 0;
  const first = new JobManager(store, {}, async input => {
    if (input.purpose === 'ontology-design') return definition();
    throw new Error('Temporary provider outage after the article was read.');
  }, undefined, { ontologyPlanning: true }, async () => {
    reads++;
    return { documents: [article], results: [fetched] };
  });
  managers.push(first);
  const interrupted = await terminal(first, first.create(input).id);
  assert.equal(interrupted.status, 'failed');
  assert.equal(interrupted.resumable, true);
  const stored = JSON.parse(String(store.db.prepare('SELECT input_json FROM generation_jobs WHERE id=?').get(interrupted.id)!.input_json));
  assert.deepEqual(stored.documents, [article]);
  assert.deepEqual(stored.originalDocuments, input.documents);
  await first.close();
  let resumedCalls = 0;
  const second = new JobManager(store, {}, async input => {
    resumedCalls++;
    assert.notEqual(input.purpose, 'ontology-design', 'a frozen ontology is reused with the same evidence snapshot');
    assert.equal(input.documents[0].text, body);
    return extraction(input);
  }, undefined, { ontologyPlanning: true }, async () => {
    reads++;
    throw new Error('Resume must not read a new version of this page.');
  });
  managers.push(second);
  const completed = await terminal(second, second.resume(interrupted.id).id);
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(completed.ontologyId, interrupted.ontologyId);
  assert.equal(reads, 1); assert.equal(resumedCalls, 1);
  assert.deepEqual(completed.urlReads, [fetched]);
});

test('unreadable URL-only input fails before model calls and can retry the original URL', async t => {
  let reads = 0; let calls = 0;
  const rejected: UrlEvidenceRead = { ...failed, url };
  const { manager } = setup(t, async input => {
    calls++;
    return input.purpose === 'ontology-design' ? definition() : extraction(input);
  }, async documents => {
    reads++;
    assert.deepEqual(documents, input.documents, 'retry must retain the URL even when its first read produced no documents');
    return reads === 1 ? { documents: [], results: [rejected] } : { documents: [article], results: [fetched] };
  });
  const blocked = await terminal(manager, manager.create(input).id);
  assert.equal(blocked.status, 'failed');
  assert.equal(blocked.resumable, true);
  assert.equal(blocked.totalChunks, 0); assert.equal(blocked.completedChunks, 0);
  assert.equal(blocked.schemaOnly, undefined);
  assert.equal(calls, 0, 'unreadable input must not spend model calls on designing or analyzing URL strings');
  assert.match(blocked.error!, /URL|링크|웹|원문/u);
  assert.match(blocked.error!, /본문|붙여|첨부|다시/u);
  assert.deepEqual(blocked.urlReads, [rejected]);
  const completed = await terminal(manager, manager.resume(blocked.id).id);
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(reads, 2); assert.equal(calls, 2);
  assert.deepEqual(completed.urlReads, [fetched]);
});

test('a failed URL does not discard a readable article or disappear from the source-read audit', async t => {
  const request = { ...input, documents: [{ ...input.documents[0], text: `${url}\n${blockedUrl}` }] };
  const { manager, store } = setup(t, async input => {
    assert.equal(input.documents.length, 1);
    assert.ok(input.documents[0].text.includes(body));
    assert.ok(!input.documents[0].text.includes(blockedUrl));
    return input.purpose === 'ontology-design' ? definition() : extraction(input);
  }, async documents => {
    assert.deepEqual(documents, request.documents);
    return { documents: [article], results: [fetched, failed] };
  });
  const job = await terminal(manager, manager.create(request).id);
  assert.equal(job.status, 'completed', job.error);
  assert.equal(job.graphIds.length, 1);
  assert.deepEqual(job.urlReads, [fetched, failed]);
  const graph = store.getGraph(job.graphId!)!;
  assert.ok(graph.sources.some(source => source.url === url));
  assert.ok(graph.sources.every(source => source.url !== blockedUrl));
  assert.ok(graph.limitations.some(note => note.includes(blockedUrl) && note.includes('검증하지 않았습니다')));
  const record = getAnalysisRecord(store.db, job, 1)!;
  assert.ok(record.limitations.some(note => note.includes(blockedUrl) && note.includes('검증하지 않았습니다')));
  const saved = JSON.parse(String(store.db.prepare('SELECT payload FROM generation_jobs WHERE id=?').get(job.id)!.payload));
  assert.deepEqual(saved.urlReads, [fetched, failed]);
});

test('cancelling a pending URL read keeps a legacy job resumable before any result is available', { timeout: 5000 }, async t => {
  const store = new OntologyStore(':memory:');
  let reads = 0; let calls = 0;
  let notifyRead!: () => void;
  const reading = new Promise<void>(resolve => { notifyRead = resolve; });
  let cancelledSignal: AbortSignal | undefined;
  const manager = new JobManager(store, {}, async input => {
    calls++;
    assert.equal(input.documents[0].text, body);
    const result = extraction(input);
    return {
      ...result,
      entities: result.entities.map(entity => ({ ...entity, type: entity.type === 'Person' ? 'person' : 'organization' })),
      relationships: result.relationships.map(relationship => ({ ...relationship, type: 'part_of' })),
    };
  }, undefined, undefined, async (documents, options) => {
    reads++;
    assert.deepEqual(documents, input.documents);
    if (reads === 1) {
      const signal = options?.signal; assert.ok(signal);
      cancelledSignal = signal;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        notifyRead();
      });
      throw new Error('The cancelled reader must not produce a snapshot.');
    }
    return { documents: [article], results: [fetched] };
  });
  t.after(async () => { await manager.close(); store.close(); });
  const created = manager.create(input);
  await reading;
  assert.equal(calls, 0);
  const cancelled = manager.cancel(created.id)!;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.totalChunks, 0); assert.equal(cancelled.completedChunks, 0);
  assert.equal(cancelled.urlReads, undefined, 'cancellation occurred before the first URL result was saved');
  assert.equal(cancelled.resumable, true);
  assert.equal(cancelledSignal?.aborted, true);
  const resumed = manager.resume(created.id);
  assert.equal(resumed.id, created.id);
  const completed = await terminal(manager, resumed.id);
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(reads, 2); assert.equal(calls, 1);
  assert.deepEqual(completed.urlReads, [fetched]);
  assert.equal(completed.graphIds.length, 1);
});
