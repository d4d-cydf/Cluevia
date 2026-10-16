import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { AnalysisPipeline } from './analysis-pipeline.ts';
import { JobManager } from './jobs.ts';
import { OntologyStore } from './ontology-store.ts';
import { CodexError } from './codex.ts';
import type { GraphGenerationInput } from '../src/types/graph.ts';
import type { OntologyExtraction } from '../src/types/ontology.ts';

const input: GraphGenerationInput = { question: '두 기관이 협력했는지 관련 자료를 연결해줘', documents: [{ id: 'report', name: 'report.txt', text: 'Aster와 Boreal의 협력 가능성이 언급되었다. 실제 협력 여부는 확인되지 않았다.' }] };
function proposal(request: GraphGenerationInput): OntologyExtraction {
  const evidence = [{ documentId: request.documents[0].id, quote: request.documents[0].text }];
  return {
    title: '협력 관련 자료', summary: '원문에 없는 항목까지 포함한 미검증 초안',
    entities: ['Aster', 'Boreal'].map(label => ({ id: label, label, type: 'organization', description: '', properties: [], identifiers: [], evidence })),
    relationships: [
      { id: 'tentative', source: 'Aster', target: 'Boreal', type: 'associated_with', label: '협력 가능성 언급', description: '실제 협력 여부는 확인되지 않음', status: 'reported', evidence, claim: { stance: 'uncertain', attributedTo: null, validFrom: null, validTo: null, publishedAt: null, derivedFrom: null } },
      { id: 'unsupported', source: 'Aster', target: 'Boreal', type: 'owns', label: '소유', description: '', status: 'reported', evidence: [{ documentId: evidence[0].documentId, quote: 'Aster owns Boreal. This is fabricated.' }] },
    ], events: [], findings: [], limitations: [],
  };
}

test('after one repair, valid uncertain associations survive and cached recovery remains marked for review', async t => {
  const store = new OntologyStore(':memory:'); t.after(() => store.close());
  let calls = 0; let reviews = 0; let retries = 0;
  const pipeline = new AnalysisPipeline(store.db, {}, async request => { calls++; return proposal(request); }, undefined, {});
  const analyze = (id: string) => pipeline.process({ documents: [{ ...input.documents[0], id }], records: 0 }, input.question, new AbortController().signal,
    usage => { retries += usage.validationRetries ?? 0; }, () => { reviews++; });
  const first = await analyze('original');
  assert.equal(calls, 2); assert.equal(retries, 1); assert.equal(first.needsReview, true);
  assert.equal(first.extraction.entities.length, 2);
  assert.deepEqual(first.extraction.relationships.map(edge => edge.id), ['tentative']);
  assert.equal(first.extraction.relationships[0].claim?.stance, 'uncertain');
  assert.match(first.extraction.limitations[0], /관계 1개/);
  assert.doesNotMatch(first.extraction.summary, /미검증 초안/);
  const cached = await analyze('reuploaded');
  assert.equal(calls, 2); assert.equal(cached.needsReview, true); assert.ok(reviews >= 2);
  assert.equal(cached.extraction.relationships[0].evidence[0].documentId, 'reuploaded');
});

test('a partial valid graph persists through the normal job/store path instead of failing the whole document', async t => {
  const store = new OntologyStore(':memory:');
  const manager = new JobManager(store, {}, async request => proposal(request), undefined, { ontologyPlanning: false });
  t.after(async () => { await manager.close(); store.close(); });
  const job = manager.create(input);
  for (let index = 0; index < 200 && ['queued', 'running'].includes(manager.get(job.id)!.status); index++) await delay(10);
  const result = manager.get(job.id)!;
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.metrics?.reviewParts, 1);
  const graph = store.getGraph(result.graphId!)!;
  assert.equal(graph.nodes.length, 2); assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].claim?.stance, 'uncertain');
  assert.ok(graph.limitations.some(note => /검증을 통과하지 못한/.test(note)));
});

test('unsupported optional attribution keeps the grounded relation without another model call and flags review', async t => {
  const store = new OntologyStore(':memory:');
  let calls = 0;
  const manager = new JobManager(store, {}, async request => {
    calls++;
    const value = proposal(request);
    value.relationships = value.relationships.slice(0, 1);
    value.relationships[0].claim!.attributedTo = '인용문에 없는 재인용 매체';
    value.limitations = Array.from({ length: 20 }, (_, index) => `기존 제한 ${index + 1}`);
    return value;
  }, undefined, { ontologyPlanning: false });
  t.after(async () => { await manager.close(); store.close(); });
  const job = manager.create(input);
  for (let index = 0; index < 200 && ['queued', 'running'].includes(manager.get(job.id)!.status); index++) await delay(10);
  const result = manager.get(job.id)!;
  assert.equal(result.status, 'completed', result.error);
  assert.equal(calls, 1);
  assert.equal(result.metrics?.reviewParts, 1);
  assert.equal(result.metrics?.validationRetries, 0);
  const graph = store.getGraph(result.graphId!)!;
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].claim?.attributedTo, null);
  assert.equal(graph.edges[0].claim?.stance, 'uncertain');
  assert.ok(graph.limitations.some(note => /선택적 주장 주체/.test(note)));
});

test('provider errors and wholly unsupported extraction never become recovered success', async t => {
  const store = new OntologyStore(':memory:'); t.after(() => store.close());
  let calls = 0;
  const unavailable = new AnalysisPipeline(store.db, {}, async () => { calls++; throw new CodexError('CLAUDE_AUTH', '로그인이 필요합니다.'); }, undefined, {});
  await assert.rejects(unavailable.process({ documents: input.documents, records: 0 }, input.question, new AbortController().signal, () => {}, () => {}), { code: 'CLAUDE_AUTH' });
  assert.equal(calls, 1);
  const invalid = new AnalysisPipeline(store.db, {}, async request => {
    const value = proposal(request);
    for (const entity of value.entities) entity.evidence[0].quote = 'Fabricated quote absent from supplied material.';
    return value;
  }, undefined, {});
  await assert.rejects(invalid.process({ documents: input.documents, records: 0 }, input.question, new AbortController().signal, () => {}, () => {}), /인용문/);
});
