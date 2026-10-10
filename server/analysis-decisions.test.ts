import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { GraphGenerationInput } from '../src/types/graph.ts';
import type { OntologyExtraction } from '../src/types/ontology.ts';
import { AnalysisPipeline, emptyMetrics } from './analysis-pipeline.ts';
import type { AnalysisMetrics, AnalysisPart } from './analysis-pipeline.ts';
import { parseOntologyDefinition } from './ontology-schema.ts';
import { compileExtraction } from './ontology.ts';
import { OntologyStore } from './ontology-store.ts';
import { readJevConfig } from './jev.ts';
import type { JevDecisionResult } from './jev-decisions.ts';

const definition = parseOntologyDefinition({
  apiName: 'DocumentClaims', displayName: '문서와 주장',
  objectTypes: [
    { apiName: 'Report', primaryKey: 'docId', titleProperty: 'docId', properties: [{ apiName: 'docId', baseType: 'string' }] },
    { apiName: 'Claim', primaryKey: 'claimId', titleProperty: 'statement', properties: [{ apiName: 'claimId', baseType: 'string', valueSource: 'evidenceId' }, { apiName: 'statement', baseType: 'string' }] },
  ],
  processing: { textStrategy: 'codex', jevEligibleLinkTypes: [], rationale: '문서 주장은 Codex로 검증합니다.' },
  sourceMappings: [{ sourceName: 'reports.jsonl', format: 'jsonl', objectType: 'Report', columns: [{ column: 'doc_id', property: 'docId' }], identityColumns: ['doc_id'], semanticColumns: ['text'], relations: [] }],
}, { id: 'ontology-decision-integration' });
const keyConfig = readJevConfig({ TYPESAFE_API_KEY: 'mock-key', TYPESAFE_CONCURRENCY: '1' });
function storeFor(t: TestContext): OntologyStore { const store = new OntologyStore(':memory:'); t.after(() => store.close()); return store; }
function inputFor(texts: string[]): GraphGenerationInput {
  return { question: '전체 문서의 주장을 분석해줘', documents: [{ id: 'report-source', name: 'reports.jsonl', text: texts.map((text, index) => JSON.stringify({ doc_id: `D-${index + 1}`, text })).join('\n') }] };
}
function simpleRows(count: number): string[] { return Array.from({ length: count }, (_, index) => `Order O-${index + 1} was dispatched.`); }
function decision(route: JevDecisionResult['route'] = 'batch'): JevDecisionResult {
  return { route, reason: route === 'batch' ? '독립적으로 해석할 수 있는 명시적 서술' : '문맥 또는 불확실성 검토 필요', context: 'Advisory only. Verify every original record.', decisions: [
    { id: 'stance', selection: route === 'batch' ? 'direct_assertion' : 'mixed_or_uncertain', confidence: route === 'batch' ? 0.99 : 0.6, accepted: route === 'batch' },
    { id: 'complexity', selection: route === 'batch' ? 'self_contained' : 'uncertain', confidence: route === 'batch' ? 0.99 : 0.6, accepted: route === 'batch' },
  ] };
}
function partsFor(pipeline: AnalysisPipeline, jobId: string, count: number): AnalysisPart[] { return Array.from({ length: count }, (_, index) => pipeline.getPart(jobId, index + 1)); }
function addMetrics(metrics: AnalysisMetrics, delta: Partial<AnalysisMetrics>): void { for (const [key, value] of Object.entries(delta)) metrics[key as keyof AnalysisMetrics] += value ?? 0; }
function claims(input: GraphGenerationInput): OntologyExtraction {
  return {
    title: '문서 주장', summary: '각 문서에서 명시한 서술입니다.',
    entities: input.documents.map((document, index) => ({ id: `claim-${index + 1}`, type: 'Claim', label: `서술 ${index + 1}`, description: '', identifiers: [], properties: [{ key: 'statement', value: document.text.match(/"text":"([^"]+)"/)?.[1] ?? document.text }], evidence: [{ documentId: document.id, quote: document.text }] })),
    relationships: [], events: [], findings: [], limitations: [],
  };
}
function reviewed(input: GraphGenerationInput) {
  const extraction = claims(input);
  return input.documents.length === 1 ? extraction : { extraction, sourceReviews: input.documents.map(document => ({ documentId: document.id, status: 'extracted', reason: '문서의 명시적 서술을 추출했습니다.' })) };
}

test('Codex-policy narrative rows receive Jev decisions and retain all evidence in fewer Codex batches', async t => {
  const store = storeFor(t); const input = inputFor(simpleRows(8)); let decisions = 0; let calls = 0;
  const metrics = emptyMetrics(); const routing: string[] = [];
  const pipeline = new AnalysisPipeline(store.db, {}, async input => {
    calls++;
    const mapped = JSON.parse(input.context?.match(/Already mapped objects: (\[[^\n]+\])/)?.[1] ?? '[]') as { properties: { key: string; value: string }[]; evidence: { documentId: string }[] }[];
    for (const document of input.documents) {
      const docId = document.text.match(/"doc_id":"([^"]+)"/)?.[1];
      const original = mapped.find(entity => entity.properties.some(property => property.key === 'docId' && property.value === docId));
      assert.ok(original, 'every mapped row remains available for semantic review');
      assert.deepEqual(original.evidence.map(evidence => evidence.documentId), [document.id], 'mapped source context stays bound to its own batch document');
    }
    return reviewed(input);
  }, undefined, { jev: keyConfig, assessJevDecisions: async (input, _config, options) => {
    decisions++;
    assert.equal(input.definition.processing.textStrategy, 'codex');
    assert.deepEqual(input.definition.processing.jevEligibleLinkTypes, []);
    assert.deepEqual(input.source, { sourceName: 'reports.jsonl', semanticColumns: ['text'] });
    options?.onUsage?.({ requests: 1, inputTokens: 12 }); return decision();
  } });
  const signal = new AbortController().signal;
  const count = await pipeline.prepare('simple', input, signal, () => {}, definition, { usage: delta => addMetrics(metrics, delta), routing: message => routing.push(message) });
  const parts = partsFor(pipeline, 'simple', count); const direct = parts.filter(part => part.extraction); const semantic = parts.filter(part => part.semanticReview);
  assert.equal(decisions, 8); assert.equal(direct.reduce((sum, part) => sum + part.records, 0), 8);
  assert.deepEqual(semantic.map(part => part.documents.length), [4, 4]);
  assert.equal(semantic.flatMap(part => part.documents).length, 8);
  assert.equal(semantic.flatMap(part => part.semanticContexts ?? []).length, 8);
  assert.equal(semantic.flatMap(part => part.decisions ?? []).length, 8);
  const documents = semantic.flatMap(part => part.documents);
  for (const [index, text] of simpleRows(8).entries()) {
    assert.equal(documents.filter(document => document.text.includes(JSON.stringify({ doc_id: `D-${index + 1}`, text }))).length, 1, 'each complete original row occurs exactly once');
  }
  const output: OntologyExtraction[] = [];
  for (const part of semantic) output.push((await pipeline.process(part, input.question, signal, delta => addMetrics(metrics, delta), () => {}, definition)).extraction);
  assert.equal(calls, 2); assert.equal(metrics.codexCalls, 2); assert.equal(metrics.codexBatches, 2); assert.equal(metrics.jevRequests, 8);
  assert.equal(metrics.jevDecisions, 16); assert.equal(metrics.jevAssistedParts, 8); assert.equal(metrics.jevFallbackParts, 0);
  assert.equal(output.flatMap(result => result.entities).length, 8);
  assert.deepEqual(new Set(output.flatMap(result => result.entities.flatMap(entity => entity.evidence.map(evidence => evidence.documentId)))), new Set(documents.map(document => document.id)));
  assert.ok(routing.length > 0);
});

test('uncertain or complex judgments retain complete rows as individual Codex reviews', async t => {
  const store = storeFor(t);
  const texts = ['The report refutes the earlier statement about Order O-1.', 'Order O-2 was dispatched.', 'The earlier report used a conflicting customer identity.', 'The note cites two other reports and denies both claims.'];
  const input = inputFor(texts); let calls = 0;
  const pipeline = new AnalysisPipeline(store.db, {}, async input => { calls++; return reviewed(input); }, undefined, { jev: keyConfig, assessJevDecisions: async input => decision(input.documents[0].text.includes('O-2') ? 'batch' : 'individual') });
  const signal = new AbortController().signal;
  const count = await pipeline.prepare('complex', input, signal, () => {}, definition);
  const semantic = partsFor(pipeline, 'complex', count).filter(part => part.semanticReview);
  assert.equal(semantic.length, 4); assert.ok(semantic.every(part => part.documents.length === 1));
  assert.equal(semantic.filter(part => part.decisions?.[0].result.route === 'individual').length, 3);
  for (const [index, text] of texts.entries()) assert.ok(semantic[index].documents[0].text.includes(text));
  for (const part of semantic) await pipeline.process(part, input.question, signal, () => {}, () => {}, definition);
  assert.equal(calls, 4);
});

test('missing Jev credentials cause no calls and explain why narrative rows remain individual', async t => {
  const store = storeFor(t); let decisions = 0; const routing: string[] = [];
  const pipeline = new AnalysisPipeline(store.db, {}, async input => reviewed(input), undefined, { jev: readJevConfig({}), assessJevDecisions: async () => { decisions++; return decision(); } });
  const count = await pipeline.prepare('no-key', inputFor(simpleRows(3)), new AbortController().signal, () => {}, definition, { routing: message => routing.push(message) });
  assert.equal(decisions, 0);
  assert.equal(partsFor(pipeline, 'no-key', count).filter(part => part.semanticReview).length, 3);
  assert.match(routing.join('\n'), /키|key|설정/i);
});

test('cancelled preparation reuses completed decisions on resume and rebinds evidence on identical reupload', async t => {
  const store = storeFor(t); const input = inputFor(simpleRows(3)); const controller = new AbortController();
  const seen: string[] = []; let interrupted = false; let secondStarted!: () => void;
  const began = new Promise<void>(resolve => { secondStarted = resolve; });
  const pipeline = new AnalysisPipeline(store.db, {}, async input => reviewed(input), undefined, { jev: { ...keyConfig, concurrency: 1 }, assessJevDecisions: async (input, _config, options) => {
    seen.push(input.documents[0].text);
    if (seen.length === 2 && !interrupted) {
      interrupted = true; secondStarted();
      await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      options?.signal?.throwIfAborted();
    }
    return decision();
  } });
  const preparation = pipeline.prepare('interrupted', input, controller.signal, () => {}, definition);
  await began; controller.abort(); await assert.rejects(preparation, /abort/i);
  const signal = new AbortController().signal;
  const count = await pipeline.prepare('interrupted', input, signal, () => {}, definition);
  assert.equal(seen.length, 4, 'only the interrupted decision is repeated');
  assert.equal(seen.filter(text => text.includes('"doc_id":"D-1"')).length, 1);
  const completedParts = partsFor(pipeline, 'interrupted', count);
  assert.equal(completedParts.filter(part => part.semanticReview).flatMap(part => part.documents).length, 3);
  const repeated = { ...input, documents: [{ ...input.documents[0], id: 'reuploaded-source' }] };
  const reuploadedCount = await pipeline.prepare('reuploaded', repeated, signal, () => {}, definition);
  assert.equal(seen.length, 4, 'identical full rows reuse completed decisions under the same frozen ontology');
  const reuploaded = partsFor(pipeline, 'reuploaded', reuploadedCount).filter(part => part.semanticReview);
  assert.notDeepEqual(reuploaded.flatMap(part => part.documents.map(document => document.id)), completedParts.filter(part => part.semanticReview).flatMap(part => part.documents.map(document => document.id)));
  for (const part of reuploaded) assert.deepEqual(new Set(part.decisions?.map(item => item.documentId)), new Set(part.documents.map(document => document.id)));
});

test('batched extraction retries when any source review is missing instead of silently accepting partial coverage', async t => {
  const store = storeFor(t); const input = inputFor(simpleRows(3)); let calls = 0;
  const pipeline = new AnalysisPipeline(store.db, {}, async input => {
    calls++; const output = reviewed(input);
    assert.ok('sourceReviews' in output);
    return calls === 1 ? { ...output, sourceReviews: output.sourceReviews.slice(0, 2) } : output;
  }, undefined, { jev: keyConfig, assessJevDecisions: async () => decision() });
  const signal = new AbortController().signal;
  const count = await pipeline.prepare('coverage', input, signal, () => {}, definition);
  const part = partsFor(pipeline, 'coverage', count).find(part => part.semanticReview)!;
  assert.equal(part.documents.length, 3);
  const result = await pipeline.process(part, input.question, signal, () => {}, () => {}, definition);
  assert.equal(calls, 2); assert.equal(result.extraction.entities.length, 3);
});

test('shared source scopes reject duplicate evidence IDs during canonical validation and repair before saving', async t => {
  const store = storeFor(t); const common = 'The shipment was confirmed.';
  const input = inputFor([common, common, common, common]); let calls = 0;
  const scopes: (string | undefined)[][] = [];
  const pipeline = new AnalysisPipeline(store.db, {}, async input => {
    calls++; scopes.push(input.documents.map(document => document.identityScope));
    const extraction = claims(input);
    if (calls === 1) for (const entity of extraction.entities) entity.evidence = [{ documentId: entity.evidence[0].documentId, quote: common }];
    else assert.match(input.context ?? '', /Repair validation errors.*Primary Key/);
    return { extraction, sourceReviews: input.documents.map(document => ({ documentId: document.id, status: 'extracted', reason: '각 기록의 주장을 확인했습니다.' })) };
  }, undefined, { jev: keyConfig, assessJevDecisions: async () => decision() });
  const signal = new AbortController().signal;
  const count = await pipeline.prepare('source-scope-repair', input, signal, () => {}, definition);
  const part = partsFor(pipeline, 'source-scope-repair', count).find(part => part.semanticReview)!;
  assert.equal(part.documents.length, 4);
  assert.equal(new Set(part.documents.map(document => document.identityScope)).size, 1);
  const result = await pipeline.process(part, input.question, signal, () => {}, () => {}, definition);
  assert.equal(calls, 2, 'duplicate row identities must be repaired inside the model validation loop');
  assert.ok(scopes[0].every(Boolean)); assert.equal(new Set(scopes[0]).size, 1);
  assert.notEqual(scopes[0][0], part.documents[0].identityScope, 'canonical scope tokens keep source identifiers out of shared cache entries');
  const ids = result.extraction.entities.map(entity => entity.properties.find(property => property.key === 'claimId')?.value);
  assert.equal(new Set(ids).size, 4);
  for (const entity of result.extraction.entities) assert.match(entity.evidence[0].quote, /"doc_id":"D-[1-4]"/);
  store.saveDefinition(definition, 'source-scope-repair');
  const graphInput = { question: input.question, documents: part.documents };
  const graph = { ...compileExtraction(result.extraction, graphInput, definition), ontologyId: definition.id, ontologyVersion: definition.version };
  const saved = store.saveGraph(graph, part.documents, result.extraction);
  assert.equal(saved.nodes.length, 4); assert.equal(store.summary().entities, 4); assert.equal(store.summary().graphs, 1);
});

test('canonical scope groups enforce literal source keys while keeping unrelated same-name records separate', async t => {
  const store = storeFor(t);
  const names = parseOntologyDefinition({ apiName: 'ScopedNames', displayName: '자료별 이름', objectTypes: [{ apiName: 'Person', primaryKey: 'name', titleProperty: 'name', identityScope: 'source', properties: [{ apiName: 'name', baseType: 'string' }] }] });
  const documents = [
    { id: 'first', name: 'one.txt', text: 'Person Sam appears in source record ONE.', identityScope: 'same-original-file' },
    { id: 'second', name: 'two.txt', text: 'Person Sam appears in source record TWO.', identityScope: 'same-original-file' },
  ];
  let calls = 0; const groups: (string | undefined)[][] = [];
  const pipeline = new AnalysisPipeline(store.db, {}, async input => {
    calls++; groups.push(input.documents.map(document => document.identityScope));
    const extraction: OntologyExtraction = { title: '이름 관측', summary: '자료 범위에 따른 이름 기록.', entities: input.documents.map((document, index) => ({ id: `person-${index}`, type: 'Person', label: 'Sam', description: '', identifiers: [], properties: [{ key: 'name', value: 'Sam' }], evidence: [{ documentId: document.id, quote: document.text }] })), relationships: [], events: [], findings: [], limitations: [] };
    if (calls === 2) {
      assert.match(input.context ?? '', /Repair validation errors.*Primary Key/);
      extraction.entities[0].evidence.push(...extraction.entities[1].evidence); extraction.entities.pop();
    }
    return { extraction, sourceReviews: input.documents.map(document => ({ documentId: document.id, status: 'extracted', reason: '해당 자료의 이름 기록을 확인했습니다.' })) };
  }, undefined, { jev: readJevConfig({}) });
  const signal = new AbortController().signal;
  const same = await pipeline.process({ records: 0, semanticReview: true, documents }, '이름 분석', signal, () => {}, () => {}, names);
  assert.equal(calls, 2); assert.equal(same.extraction.entities.length, 1);
  assert.ok(groups[0].every(Boolean)); assert.equal(new Set(groups[0]).size, 1);
  const separate = await pipeline.process({ records: 0, semanticReview: true, documents: documents.map((document, index) => ({ ...document, identityScope: `independent-file-${index}` })) }, '이름 분석', signal, () => {}, () => {}, names);
  assert.equal(calls, 3, 'different scope equivalence groups cannot reuse the merged extraction cache');
  assert.equal(new Set(groups[2]).size, 2); assert.equal(separate.extraction.entities.length, 2);
  assert.deepEqual(separate.extraction.entities.map(entity => entity.evidence[0].documentId), documents.map(document => document.id));
});
