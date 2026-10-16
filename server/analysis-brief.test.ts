import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { AnalysisBrief } from '../src/types/clarification.ts';
import type { GraphGenerationInput } from '../src/types/graph.ts';
import type { OntologyExtraction } from '../src/types/ontology.ts';
import type { CodexInput } from './codex.ts';
import { AnalysisPipeline } from './analysis-pipeline.ts';
import { JobManager } from './jobs.ts';
import type { GenerationJob } from './jobs.ts';
import { OntologyStore } from './ontology-store.ts';
import { parseOntologyDefinition } from './ontology-schema.ts';
import { designOntology } from './ontology-planner.ts';
import { ontologyPlanningSchema } from './ontology-builder.ts';
import { readJevConfig } from './jev.ts';

const brief = (): AnalysisBrief => ({ objective: '고용 관계 확인', scope: '2026년의 Acme 소속 인물과 반증', output: '근거가 있는 관계 그래프', answers: [{ question: '대상 조직은?', answer: 'Acme' }] });
const definition = () => parseOntologyDefinition({ apiName: 'Employment', displayName: '고용 관계', objectTypes: ['Person', 'Company'].map(apiName => ({ apiName, primaryKey: 'name', titleProperty: 'name', properties: [{ apiName: 'name', baseType: 'string' }] })), linkTypes: [{ apiName: 'worksFor', sourceType: 'Person', targetType: 'Company', sourceCardinality: 'many', targetCardinality: 'one' }], processing: { textStrategy: 'jev-assisted', jevEligibleLinkTypes: ['worksFor'], rationale: 'Explicit names.' } });
const source = { id: 'original', name: 'report.txt', text: '"Alice" works for "Acme" in 2026.' };
function extraction(input: Pick<CodexInput, 'documents'>): OntologyExtraction {
  const evidence = [{ documentId: input.documents[0].id, quote: input.documents[0].text }];
  return { title: '고용 관계', summary: '자료에서 확인한 고용 관련 진술.', entities: [
    { id: 'alice', type: 'Person', label: 'Alice', description: '', identifiers: [], properties: [{ key: 'name', value: 'Alice' }], evidence },
    { id: 'acme', type: 'Company', label: 'Acme', description: '', identifiers: [], properties: [{ key: 'name', value: 'Acme' }], evidence },
  ], relationships: [{ id: 'works', source: 'alice', target: 'acme', type: 'worksFor', label: '소속', description: '', status: 'reported', evidence }], events: [], findings: [], limitations: [] };
}
function storeFor(t: TestContext) { const store = new OntologyStore(':memory:'); t.after(() => store.close()); return store; }
async function finish(manager: JobManager, id: string): Promise<GenerationJob> {
  for (let count = 0; count < 400; count++) {
    const job = manager.get(id)!;
    if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
    await delay(5);
  }
  throw new Error('Analysis did not finish');
}

test('confirmed scope reaches ontology design while the original question and source evidence remain intact', async () => {
  const input: GraphGenerationInput = { question: '이 자료를 분석해줘', documents: [source], analysisBrief: brief() };
  let calls = 0;
  const result = await designOntology(input, undefined, async candidate => {
    calls++; assert.equal(candidate.question, input.question);
    assert.match(candidate.context ?? '', /Confirmed analysis brief/);
    assert.ok(candidate.context?.includes(JSON.stringify(input.analysisBrief)));
    assert.match(candidate.context ?? '', /not factual evidence/);
    assert.match(candidate.context ?? '', /retaining every original source row/);
    assert.ok(candidate.documents[0].text.includes('Alice'));
    return definition();
  }, {}, { id: 'scoped-ontology', signal: new AbortController().signal, usage: () => {}, progress: () => {} });
  assert.equal(calls, 1); assert.equal(result.id, 'scoped-ontology');
  assert.deepEqual(input.documents, [source]);
});

test('confirmed advanced contracts select a capable blueprint schema even when the original request is generic', async () => {
  const advanced = {
    blueprintVersion: '1.0', apiName: 'NamedRecords', displayName: '이름 있는 기록',
    objectTypes: [{ apiName: 'Person', primaryKey: 'name', titleProperty: 'name', implementsInterfaces: ['Named'], properties: [{ apiName: 'name', baseType: 'string', sharedProperty: 'sharedName' }] }],
    extensions: { sharedProperties: [{ apiName: 'sharedName', baseType: 'string' }], interfaces: [{ apiName: 'Named', properties: [{ apiName: 'name', baseType: 'string', required: true }] }] },
  };
  const options = { id: 'advanced-brief', signal: new AbortController().signal, usage: () => {}, progress: () => {} };
  for (const field of ['objective', 'scope', 'output'] as const) {
    const confirmed = { ...brief(), [field]: '공유 속성과 인터페이스로 객체 유형의 공통 계약을 만들어줘.' };
    const result = await designOntology({ question: '자료에 맞는 구조를 설계해줘', documents: [], analysisBrief: confirmed }, undefined, async candidate => {
      assert.equal(candidate.question, '자료에 맞는 구조를 설계해줘');
      assert.equal(candidate.schema, ontologyPlanningSchema({ advanced: true, structured: false }), `${field} must be able to request advanced contracts`);
      assert.ok(candidate.context?.includes(JSON.stringify(confirmed)));
      return advanced;
    }, {}, options);
    assert.equal(result.sharedProperties[0].apiName, 'sharedName');
    assert.equal(result.interfaces[0].apiName, 'Named');
    assert.deepEqual(result.objectTypes[0].implementsInterfaces, ['Named']);
    assert.equal(result.status, 'draft');
  }
  await designOntology({ question: '자료에 맞는 구조를 설계해줘', documents: [], analysisBrief: brief() }, undefined, async candidate => {
    assert.equal(candidate.schema, ontologyPlanningSchema({ advanced: false, structured: false }), 'ordinary confirmed requests retain the smaller schema');
    return definition();
  }, {}, options);
});

test('scoped semantic extraction uses confirmed intent and isolates cache entries while old ingestion cache still shares questions', async t => {
  const store = storeFor(t); const calls: CodexInput[] = []; let cached = 0;
  const pipeline = new AnalysisPipeline(store.db, {}, async input => { calls.push(input); return extraction(input); }, undefined, { jev: readJevConfig({}) });
  const part = { documents: [source], records: 0 }; const signal = new AbortController().signal; const ontology = definition();
  const run = (question: string, scope?: AnalysisBrief) => pipeline.process(part, question, signal, delta => { cached += delta.cacheHits ?? 0; }, () => {}, ontology, scope);
  await run('넓은 요청', brief());
  assert.equal(calls[0].question, '넓은 요청'); assert.ok(calls[0].context?.includes(JSON.stringify(brief())));
  assert.doesNotMatch(calls[0].context ?? '', /Do not omit supported records because of the question|Extract all grounded facts/);
  assert.match(calls[0].context ?? '', /counterevidence|contradictions/);
  assert.deepEqual(calls[0].documents.map(document => document.text), [source.text]);
  await run('넓은 요청', brief()); assert.equal(calls.length, 1); assert.equal(cached, 1);
  await run('넓은 요청', { ...brief(), scope: '2025년의 Acme 고용 관계' }); assert.equal(calls.length, 2, 'changed scope cannot reuse earlier extraction');
  await run('범위가 없는 첫 질문'); assert.equal(calls.length, 3);
  await run('범위가 없는 다른 질문'); assert.equal(calls.length, 3, 'legacy all-fact ingestion remains question-independent');
  assert.match(calls[2].question, /특정 사용자 질문에 맞춰 사실을 제외하지/);
  assert.match(calls[2].context ?? '', /Do not omit supported records because of the question/);
});

test('confirmed scope does not use a final Jev extractor that lacks scope interpretation', async t => {
  const store = storeFor(t); let codex = 0; let jev = 0;
  const pipeline = new AnalysisPipeline(store.db, {}, async input => { codex++; assert.ok(input.context?.includes(brief().scope)); return extraction(input); }, undefined, {
    jev: readJevConfig({ TYPESAFE_API_KEY: 'never-sent' }), runOntologyJev: async () => { jev++; throw new Error('Scope must be interpreted before accepting final facts'); },
  });
  const result = await pipeline.process({ documents: [source], records: 0 }, '분석', new AbortController().signal, () => {}, () => {}, definition(), brief());
  assert.equal(jev, 0); assert.equal(codex, 1); assert.equal(result.origin, 'codex');
});

test('deterministic conversion retains every source row under a narrow confirmed scope', async t => {
  const store = storeFor(t); const pipeline = new AnalysisPipeline(store.db, {}, async () => { throw new Error('Mechanical data needs no model'); }, undefined, { jev: readJevConfig({}) });
  const ontology = parseOntologyDefinition({ apiName: 'Records', displayName: '기록', objectTypes: [{ apiName: 'Record', primaryKey: 'id', titleProperty: 'id', properties: [{ apiName: 'id', baseType: 'string' }, { apiName: 'year', baseType: 'integer' }] }], sourceMappings: [{ sourceName: 'records.csv', format: 'csv', objectType: 'Record', columns: [{ column: 'id', property: 'id' }, { column: 'year', property: 'year' }], identityColumns: ['id'], relations: [] }] });
  const document = { id: 'rows', name: 'records.csv', text: 'id,year\nR1,2025\nR2,2026\n' };
  const count = await pipeline.prepare('scoped-rows', { question: '2026년만 집중', documents: [document], analysisBrief: brief() }, new AbortController().signal, () => {}, ontology);
  const parts = Array.from({ length: count }, (_, index) => pipeline.getPart('scoped-rows', index + 1));
  assert.equal(parts.reduce((sum, part) => sum + part.records, 0), 2);
  assert.equal(parts.flatMap(part => part.extraction?.entities ?? []).length, 2);
  assert.ok(parts.flatMap(part => part.documents).some(document => document.text.includes('R1')));
});

test('job snapshots freeze the confirmed brief through failure, restart and resume', async t => {
  const store = storeFor(t); const input: GraphGenerationInput = { question: '넓은 원래 요청', documents: [source], analysisBrief: brief() }; let designCalls = 0;
  const first = new JobManager(store, {}, async candidate => {
    assert.ok(candidate.context?.includes(JSON.stringify(brief())));
    if (candidate.purpose === 'ontology-design') { designCalls++; return definition(); }
    throw new Error('Synthetic interruption');
  }, undefined, { ontologyPlanning: true, jev: readJevConfig({}) });
  t.after(() => first.close());
  const created = first.create(input); input.analysisBrief!.scope = '수정된 외부 객체';
  assert.deepEqual(created.analysisBrief, brief());
  const failed = await finish(first, created.id); assert.equal(failed.status, 'failed'); assert.ok(failed.resumable);
  assert.deepEqual(failed.analysisBrief, brief()); assert.equal(failed.question, '넓은 원래 요청');
  const snapshot = JSON.parse(String(store.db.prepare('SELECT input_json FROM generation_jobs WHERE id=?').get(created.id)?.input_json)) as GraphGenerationInput;
  assert.deepEqual(snapshot.analysisBrief, brief());
  await first.close();
  let resumedCalls = 0;
  const second = new JobManager(store, {}, async candidate => {
    resumedCalls++; assert.notEqual(candidate.purpose, 'ontology-design');
    assert.equal(candidate.question, '넓은 원래 요청'); assert.ok(candidate.context?.includes(JSON.stringify(brief())));
    return extraction(candidate);
  }, undefined, { ontologyPlanning: true, jev: readJevConfig({}) });
  t.after(() => second.close());
  const completed = await finish(second, second.resume(created.id).id);
  assert.equal(completed.status, 'completed', completed.error); assert.equal(designCalls, 1); assert.equal(resumedCalls, 1);
  assert.deepEqual(completed.analysisBrief, brief()); assert.equal(completed.question, '넓은 원래 요청');
  assert.equal(completed.graphIds.length, 1);
});

test('legacy Codex jobs receive the same confirmed scope and still require source evidence', async t => {
  const store = storeFor(t); let calls = 0;
  const manager = new JobManager(store, {}, async candidate => {
    calls++; assert.ok(candidate.context?.includes(JSON.stringify(brief()))); assert.equal(candidate.question, '넓은 원래 요청');
    return { title: '근거 객체', summary: '원문 근거 확인.', entities: [{ id: 'alice', type: 'person', label: 'Alice', description: '', identifiers: [], properties: [], evidence: [{ documentId: candidate.documents[0].id, quote: source.text }] }], relationships: [], events: [], findings: [], limitations: [] };
  });
  t.after(() => manager.close());
  const completed = await finish(manager, manager.create({ question: '넓은 원래 요청', documents: [source], analysisBrief: brief() }).id);
  assert.equal(completed.status, 'completed', completed.error); assert.equal(calls, 1); assert.deepEqual(completed.analysisBrief, brief());
});

test('a prompt-only confirmed brief creates a draft ontology without fabricating objects', async t => {
  const store = storeFor(t); let calls = 0;
  const manager = new JobManager(store, {}, async candidate => {
    calls++; assert.equal(candidate.purpose, 'ontology-design'); assert.equal(candidate.documents.length, 0);
    assert.ok(candidate.context?.includes(JSON.stringify(brief()))); return definition();
  }, undefined, { ontologyPlanning: true, jev: readJevConfig({}) });
  t.after(() => manager.close());
  const completed = await finish(manager, manager.create({ question: '고용 관계 그래프를 만들어줘', documents: [], analysisBrief: brief() }).id);
  assert.equal(completed.status, 'completed', completed.error); assert.equal(completed.schemaOnly, true); assert.equal(calls, 1);
  assert.equal(completed.graphIds.length, 0); assert.equal(store.summary().entities, 0);
  assert.equal(store.getDefinition(completed.ontologyId!)?.status, 'draft');
});
