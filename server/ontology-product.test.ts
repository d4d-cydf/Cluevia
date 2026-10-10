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
import type { CodexRunner, GenerationJob } from './jobs.ts';
import { readJevConfig } from './jev.ts';
import { parseOntologyDefinition } from './ontology-schema.ts';
import { compileExtraction } from './ontology.ts';
import { createProductBackend } from './product-api.ts';
import { readProductConfig } from './product-config.ts';
import { CodexError, effectiveCodexConfig } from './codex.ts';
import { designOntology } from './ontology-planner.ts';
import { compactPlanningDocument } from './planning-profile.ts';
import type { AnalysisOptions } from './analysis-pipeline.ts';
import type { GraphGenerationInput } from '../src/types/graph.ts';
import type { OntologyExtraction } from '../src/types/ontology.ts';

const commerce = () => parseOntologyDefinition({ apiName: 'Commerce', displayName: '고객과 주문',
  objectTypes: [
    { apiName: 'Customer', displayName: '고객', primaryKey: 'id', titleProperty: 'name', identityScope: 'ontology', properties: [{ apiName: 'id', baseType: 'string' }, { apiName: 'name', baseType: 'string' }, { apiName: 'active', baseType: 'boolean' }] },
    { apiName: 'Order', displayName: '주문', primaryKey: 'id', titleProperty: 'id', identityScope: 'ontology', properties: [{ apiName: 'id', baseType: 'string' }, { apiName: 'amount', baseType: 'double' }] },
  ], linkTypes: [{ apiName: 'placed', sourceType: 'Customer', targetType: 'Order', sourceCardinality: 'one', targetCardinality: 'many' }],
  processing: { textStrategy: 'codex', jevEligibleLinkTypes: [], rationale: 'Typed structured data.' },
  sourceMappings: [
    { sourceName: 'orders.csv', format: 'csv', objectType: 'Customer', columns: [{ column: 'customer_id', property: 'id' }, { column: 'name', property: 'name' }, { column: 'active', property: 'active' }], identityColumns: ['customer_id'], relations: [{ linkType: 'placed', targetType: 'Order', sourceColumn: 'order_id', targetProperty: 'id' }] },
    { sourceName: 'orders.csv', format: 'csv', objectType: 'Order', columns: [{ column: 'order_id', property: 'id' }, { column: 'amount', property: 'amount' }], identityColumns: ['order_id'], relations: [] },
  ],
});
const names = (jev = false) => parseOntologyDefinition({ apiName: 'Employment', displayName: '고용 관계',
  objectTypes: ['Person', 'Company'].map(apiName => ({ apiName, primaryKey: 'name', titleProperty: 'name', properties: [{ apiName: 'name', baseType: 'string' }] })),
  linkTypes: [{ apiName: 'worksFor', sourceType: 'Person', targetType: 'Company', sourceCardinality: 'many', targetCardinality: 'one' }],
  processing: { textStrategy: jev ? 'jev-assisted' : 'codex', jevEligibleLinkTypes: jev ? ['worksFor'] : [], rationale: 'Explicit short employment statements only.' },
});
const source = (id = 'doc') => ({ id, name: `${id}.txt`, text: '"Alice" works for "Acme".' });
function extracted(input: GraphGenerationInput): OntologyExtraction {
  const evidence = [{ documentId: input.documents[0].id, quote: input.documents[0].text }];
  return { title: '고용 관계', summary: '자료에 보고된 고용 관계.', entities: [
    { id: 'alice', type: 'Person', label: 'Alice', description: '', identifiers: [], properties: [{ key: 'name', value: 'Alice' }], evidence },
    { id: 'acme', type: 'Company', label: 'Acme', description: '', identifiers: [], properties: [{ key: 'name', value: 'Acme' }], evidence },
  ], relationships: [{ id: 'work', source: 'alice', target: 'acme', type: 'worksFor', label: '근무', description: '', status: 'reported', evidence }], events: [], findings: [], limitations: [] };
}
async function finish(manager: JobManager, id: string): Promise<GenerationJob> {
  for (let i = 0; i < 2000; i++) { const job = manager.get(id)!; if (['completed', 'failed', 'cancelled'].includes(job.status)) return job; await delay(5); }
  throw new Error('Job did not finish');
}
function setup(t: TestContext, runner: CodexRunner, options: AnalysisOptions = {}) {
  const store = new OntologyStore(':memory:'); const uploads = new EvidenceUploads(store.db);
  const manager = new JobManager(store, {}, runner, uploads, { jev: readJevConfig({ TYPESAFE_API_KEY: 'never-sent', CLUEVIA_JEV_FALLBACK: 'false' }), ...options, ontologyPlanning: true });
  t.after(async () => { await manager.close(); store.close(); }); return { store, uploads, manager };
}

test('Codex designs commerce schema once; all uploaded CSV rows become typed, scoped stored graphs', async t => {
  let calls = 0;
  const { store, uploads, manager } = setup(t, async input => {
    calls++; assert.equal(input.purpose, 'ontology-design');
    assert.equal(JSON.parse(input.documents[0].text).records, 420);
    return commerce();
  }, { runOntologyJev: async () => { throw new Error('Structured rows must not use Jev'); } });
  const csv = 'customer_id,name,active,order_id,amount\n' + Array.from({ length: 420 }, (_, i) => `C1,Alice,true,O${i},${i + 0.5}\n`).join('');
  const upload = await uploads.receive('orders.csv', (async function* () { yield Buffer.from(csv); })());
  const job = await finish(manager, manager.create({ question: '고객과 주문 관계를 만들어줘', documents: [], uploadIds: [upload.id] }).id);
  assert.equal(job.status, 'completed', job.error); assert.equal(calls, 1); assert.equal(job.metrics?.codexCalls, 1);
  assert.equal(job.metrics?.structuredRecords, 420); assert.equal(job.metrics?.jevRequests, 0);
  assert.ok(job.ontologyId); assert.equal(store.listDefinitions().length, 1);
  assert.equal(store.summary().entities, 421); assert.equal(store.summary().relationships, 420);
  const customers = store.listEntities('', 'Customer', job.ontologyId); assert.equal(customers.length, 1);
  const detail = store.getEntity(customers[0].id)!; assert.equal(detail.claims[0].typedProperties?.active, true);
  assert.equal(detail.claims[0].ontologyId, job.ontologyId);
  for (const graphId of job.graphIds) { const graph = store.getGraph(graphId)!; assert.equal(graph.origin, 'structured'); assert.equal(graph.ontologyId, job.ontologyId); assert.equal(graph.ontologyVersion, 1); }
});

test('prompt-only creates draft schema and no factual instances even when old context exists', async t => {
  const { store, manager } = setup(t, async input => { assert.equal(input.purpose, 'ontology-design'); assert.equal(input.documents.length, 0); return names(); });
  const job = await finish(manager, manager.create({ question: '병원·의사·예약을 위한 온톨로지 틀', documents: [] }).id);
  assert.equal(job.status, 'completed', job.error); assert.equal(job.schemaOnly, true); assert.equal(job.graphIds.length, 0);
  assert.equal(store.getDefinition(job.ontologyId!)?.status, 'draft'); assert.equal(store.summary().entities, 0);
});

test('default generic text uses Codex with dynamic contract; different jobs isolate identities but reuse validated cache', async t => {
  let extractionCalls = 0; let jevCalls = 0;
  const { store, manager } = setup(t, async input => {
    if (input.purpose === 'ontology-design') return names();
    extractionCalls++; assert.ok(input.context?.includes('worksFor')); assert.ok(input.context?.includes('Employment'));
    assert.equal(input.documents[0].name, 'doc.txt'); return extracted(input);
  }, { runOntologyJev: async () => { jevCalls++; throw new Error('Unexpected Jev'); } });
  const input = { question: '고용 관계 분석', documents: [source()] };
  const first = await finish(manager, manager.create(input).id); const second = await finish(manager, manager.create(input).id);
  assert.equal(first.status, 'completed', first.error); assert.equal(second.status, 'completed', second.error);
  assert.equal(extractionCalls, 1); assert.equal(jevCalls, 0); assert.equal(second.metrics?.cacheHits, 1);
  assert.notEqual(first.ontologyId, second.ontologyId); assert.equal(store.summary().entities, 4);
});

test('eligible but uncertain Jev always re-extracts original with Codex even if old fallback setting is false', async t => {
  let extractedCalls = 0;
  const { store, manager } = setup(t, async input => { if (input.purpose === 'ontology-design') return names(true); extractedCalls++; return extracted(input); }, {
    runOntologyJev: async (input, _definition, _settings, options) => { options?.onUsage?.({ requests: 1, inputTokens: 123 }); return { extraction: extracted(input), needsFallback: true, reason: 'Uncertain relation.' }; },
  });
  const job = await finish(manager, manager.create({ question: '고용 관계', documents: [source()] }).id);
  assert.equal(job.status, 'completed', job.error); assert.equal(extractedCalls, 1); assert.equal(job.metrics?.jevRequests, 1); assert.equal(job.metrics?.reviewParts, 1);
  assert.equal(store.getGraph(job.graphId!)?.origin, 'codex');
});

test('resuming an interrupted new job freezes its ontology and retains ordered committed graphs', async t => {
  let plans = 0; let fail = true;
  const { store, manager } = setup(t, async input => {
    if (input.purpose === 'ontology-design') { plans++; return names(); }
    if (input.documents[0].name === 'two.txt' && fail) throw new Error('Simulated interrupted model');
    return extracted(input);
  }, { jev: readJevConfig({}) });
  const first = await finish(manager, manager.create({ question: '고용 관계', documents: [source('one'), source('two')] }).id);
  assert.equal(first.status, 'failed'); assert.equal(first.completedChunks, 1); assert.equal(first.resumable, true);
  fail = false; const resumed = await finish(manager, manager.resume(first.id).id);
  assert.equal(resumed.status, 'completed', resumed.error); assert.equal(plans, 1); assert.equal(resumed.ontologyId, first.ontologyId); assert.equal(resumed.graphIds[0], first.graphIds[0]);
  // Name keys are local to each original source, not resolved across unrelated files.
  assert.equal(store.summary().entities, 4);
});

test('persisted cardinality conflict rolls back an entire graph without partial objects', () => {
  const store = new OntologyStore(':memory:');
  try {
    const definition = parseOntologyDefinition({ ...names(), id: 'ontology-test', objectTypes: names().objectTypes.map(type => ({ ...type, identityScope: 'ontology' })) });
    store.saveDefinition(definition, 'test-job');
    const input = { question: '고용 관계', documents: [source()] }; const first = extracted(input);
    const graph = { ...compileExtraction(first, input, definition), ontologyId: definition.id, ontologyVersion: 1 };
    store.saveGraph(graph, input.documents, first);
    const otherInput = { question: '고용 관계', documents: [{ ...source(), text: '"Alice" works for "Beta".' }] };
    const second = extracted(otherInput); second.entities[1].label = 'Beta'; second.entities[1].properties[0].value = 'Beta';
    const otherGraph = { ...compileExtraction(second, otherInput, definition), ontologyId: definition.id, ontologyVersion: 1 };
    assert.throws(() => store.saveGraph(otherGraph, otherInput.documents, second), /cardinality/);
    assert.equal(store.summary().graphs, 1); assert.equal(store.summary().entities, 2);
  } finally { store.close(); }
});

test('production config enables ontology design and HTTP exposes stored definitions and typed graph scope', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cluevia-ontology-api-')); const config = readProductConfig(process.cwd(), { CLUEVIA_DATA_DIR: directory, CLUEVIA_SEED_EXAMPLE: 'false' });
  assert.equal(config.ontologyPlanning, true);
  const backend = await createProductBackend(config, { run: async input => { assert.equal(input.purpose, 'ontology-design'); return names(); }, probe: async () => ({ available: true, authenticated: true, message: 'Ready' }) });
  const server = createServer((req, res) => backend.middleware(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await backend.close(); await rm(directory, { recursive: true, force: true }); });
  const status = await (await fetch(`${base}/api/system/status`)).json(); assert.equal(status.provider.ontologyPlanning, true);
  const created = await (await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: '직원 조직의 스키마', documents: [] }) })).json();
  assert.ok(created.job, JSON.stringify(created)); const job = await finish(backend.jobs, created.job.id); assert.equal(job.status, 'completed', job.error);
  const catalog = await (await fetch(`${base}/api/ontology`)).json(); assert.equal(catalog.definitions.length, 1);
  const detail = await (await fetch(`${base}/api/ontology/definitions/${job.ontologyId}`)).json(); assert.equal(detail.definition.apiName, 'Employment');
});


test('new analysis requires Codex availability and graph archives do not activate imported schemas', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cluevia-schema-gates-'));
  const config = readProductConfig(process.cwd(), { CLUEVIA_DATA_DIR: directory, CLUEVIA_SEED_EXAMPLE: 'false', TYPESAFE_API_KEY: 'not-sent' });
  const backend = await createProductBackend(config, { run: async () => { throw new Error('Unexpected model'); }, probe: async () => ({ available: false, authenticated: false, message: 'Codex connection required.' }) });
  const server = createServer((req, res) => backend.middleware(req, res, () => res.end()));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await backend.close(); await rm(directory, { recursive: true, force: true }); });
  const blocked = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: '구조 만들기', documents: [] }) });
  assert.equal(blocked.status, 503); assert.equal(backend.jobs.list().length, 0);
  const definition = names(); const input = { question: '고용 관계', documents: [source()] };
  const graph = { ...compileExtraction(extracted(input), input, definition), ontologyId: definition.id, ontologyVersion: definition.version };
  const response = await fetch(`${base}/api/graphs/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ graph }) });
  const body = await response.json(); assert.equal(response.status, 201, JSON.stringify(body));
  assert.equal(body.graph.ontologyId, undefined); assert.equal(body.graph.origin, 'imported');
  assert.equal((await (await fetch(`${base}/api/ontology`)).json()).definitions.length, 0);
});

const metadataDefinition = () => parseOntologyDefinition({ apiName: 'SourceDocuments', displayName: '출처와 추출 기록',
  objectTypes: [
    { apiName: 'SourceDocument', primaryKey: 'sourceId', titleProperty: 'name', properties: [{ apiName: 'sourceId', baseType: 'string', valueSource: 'documentId' }, { apiName: 'name', baseType: 'string', valueSource: 'documentName' }] },
    { apiName: 'Claim', primaryKey: 'claimId', titleProperty: 'claimId', properties: [{ apiName: 'claimId', baseType: 'string', valueSource: 'evidenceId' }] },
  ],
});
function metadataExtraction(input: GraphGenerationInput): OntologyExtraction {
  const evidence = [{ documentId: input.documents[0].id, quote: input.documents[0].text }];
  return { title: '출처와 기록', summary: '근거를 가진 추출 항목입니다.', entities: [
    { id: 'source', type: 'SourceDocument', label: '원본 자료', description: '', identifiers: [], properties: [], evidence },
    { id: 'claim', type: 'Claim', label: '추출 항목', description: '', identifiers: [], properties: [], evidence },
  ], relationships: [], events: [], findings: [], limitations: [] };
}

test('source metadata and derived claim keys survive canonical cache rebinding and typed persistence', async t => {
  let calls = 0;
  const { manager, store } = setup(t, async input => {
    if (input.purpose === 'ontology-design') return metadataDefinition();
    calls++; return metadataExtraction(input);
  });
  const first = await finish(manager, manager.create({ question: '출처 기록 분석', documents: [source('original')] }).id);
  const second = await finish(manager, manager.create({ question: '출처 기록 분석', documents: [{ ...source('reuploaded'), name: 'original.txt' }] }).id);
  assert.equal(first.status, 'completed', first.error); assert.equal(second.status, 'completed', second.error);
  assert.equal(calls, 1); assert.equal(second.metrics?.cacheHits, 1);
  for (const [job, expectedSource] of [[first, 'original'], [second, 'reuploaded']] as const) {
    const graph = store.getGraph(job.graphId!)!;
    assert.equal(graph.nodes.find(node => node.type === 'SourceDocument')?.properties.sourceId, expectedSource);
    assert.equal(graph.nodes.find(node => node.type === 'SourceDocument')?.properties.name, 'original.txt');
    assert.match(graph.nodes.find(node => node.type === 'Claim')!.properties.claimId, /^evidence-[a-f0-9]{32}$/);
    const records = store.listEntities('', 'SourceDocument', job.ontologyId);
    assert.equal(store.getEntity(records[0].id)?.claims[0].typedProperties?.sourceId, expectedSource);
  }
  assert.notEqual(store.getGraph(first.graphId!)!.nodes.find(node => node.type === 'Claim')!.properties.claimId, store.getGraph(second.graphId!)!.nodes.find(node => node.type === 'Claim')!.properties.claimId);
});

test('resume repairs a failed zero-progress business/source ID confusion with a new archived schema version', async t => {
  let plans = 0; let repaired = false;
  const oldDefinition = parseOntologyDefinition({ apiName: 'Reports', displayName: '기존 보고서', objectTypes: [{ apiName: 'Report', primaryKey: 'documentId', titleProperty: 'documentId', properties: [{ apiName: 'documentId', baseType: 'string' }] }] });
  const { manager, store } = setup(t, async input => {
    if (input.purpose === 'ontology-design') {
      plans++;
      if (plans === 1) return oldDefinition;
      assert.match(input.context!, /previous schema failed/i); repaired = true; return metadataDefinition();
    }
    if (repaired) return metadataExtraction(input);
    return { ...metadataExtraction(input), entities: [{ id: 'report:source-1', type: 'Report', label: '원본 자료', description: '', identifiers: [], properties: [{ key: 'documentId', value: input.documents[0].id }], evidence: [{ documentId: input.documents[0].id, quote: input.documents[0].text }] }] };
  }, { jev: readJevConfig({}) });
  const first = await finish(manager, manager.create({ question: '자료의 출처와 기록', documents: [source()] }).id);
  assert.equal(first.status, 'failed'); assert.match(first.error!, /Primary Key 값이 인용된 원문에 없습니다/);
  assert.equal(first.completedChunks, 0); assert.equal(first.resumable, true);
  const retried = await finish(manager, manager.resume(first.id).id);
  assert.equal(retried.status, 'completed', retried.error); assert.equal(plans, 2);
  assert.equal(retried.ontologyId, first.ontologyId); assert.equal(retried.ontologyVersion, 2);
  assert.equal(store.getGraph(retried.graphId!)!.ontologyVersion, 2);
  const archived = store.db.prepare('SELECT version,definition_json FROM ontology_definition_history WHERE id=?').get(first.ontologyId!)!;
  assert.equal(archived.version, 1); assert.equal(JSON.parse(String(archived.definition_json)).apiName, 'Reports');
  assert.throws(() => store.replaceUnusedDefinition({ ...store.getDefinition(retried.ontologyId!)!, version: 3 }, retried.id, () => {}), /저장된 그래프/);
});

const readingsDefinition = (mapped = true) => parseOntologyDefinition({ apiName: 'Readings', displayName: '센서 측정', objectTypes: [{
  apiName: 'Reading', primaryKey: 'recordId', titleProperty: 'station', properties: [
    { apiName: 'recordId', baseType: 'string', valueSource: 'evidenceId' },
    { apiName: 'station', baseType: 'string' }, { apiName: 'temperature', baseType: 'double' },
  ],
}], sourceMappings: mapped ? [{ sourceName: 'readings.csv', format: 'csv', objectType: 'Reading',
  columns: [{ column: 'station', property: 'station' }, { column: 'temperature', property: 'temperature' }], identityColumns: [], relations: [],
}] : [] });
const readingsInput = { question: '측정값을 모두 분석해줘', documents: [{ id: 'reading-source', name: 'readings.csv', text: 'station,temperature\nStation-A,21.5\n' }] };

test('planner repairs uncovered structured columns once and permits source-derived record IDs in mappings', async () => {
  let calls = 0; let usage = 0;
  const definition = await designOntology(readingsInput, undefined, async input => {
    calls++;
    assert.match(input.context!, /evidenceId primary keys/);
    if (calls === 1) return readingsDefinition(false);
    assert.match(input.context!, /leaves source columns uncovered/);
    assert.match(input.context!, /station/); assert.match(input.context!, /temperature/);
    return readingsDefinition();
  }, {}, { id: 'ontology-reading', signal: new AbortController().signal, usage: () => { usage++; }, progress: () => {} });
  assert.equal(calls, 2); assert.equal(usage, 2); assert.equal(definition.id, 'ontology-reading');
  assert.deepEqual(definition.sourceMappings[0].identityColumns, []);
  assert.equal(definition.objectTypes[0].properties[0].valueSource, 'evidenceId');
});

test('planner keeps complex unmapped fields for bounded source review after one coverage repair', async () => {
  let calls = 0; const progress: string[] = [];
  const definition = await designOntology(readingsInput, undefined, async () => { calls++; return readingsDefinition(false); }, {}, {
    id: 'ontology-irregular', signal: new AbortController().signal, usage: () => {}, progress: message => { progress.push(message); },
  });
  assert.equal(calls, 2); assert.equal(definition.sourceMappings.length, 0);
  assert.match(definition.processing.rationale, /2개 열.*원문을 보존/);
  assert.ok(progress.some(message => message.includes('작은 단위로 Codex 검토')));
});

test('planner counts a long narrative semantic column as covered without requiring an oversized property', async () => {
  const report = parseOntologyDefinition({ apiName: 'Reports', displayName: '보고서', objectTypes: [{ apiName: 'Report', primaryKey: 'reportId', titleProperty: 'reportId', properties: [{ apiName: 'reportId', baseType: 'string' }] }],
    sourceMappings: [{ sourceName: 'reports.jsonl', format: 'jsonl', objectType: 'Report', columns: [{ column: 'doc_id', property: 'reportId' }], identityColumns: ['doc_id'], semanticColumns: ['body'], relations: [] }],
  });
  let calls = 0;
  const definition = await designOntology({ question: '보고서 속의 사실 관계', documents: [{ id: 'report-source', name: 'reports.jsonl', text: JSON.stringify({ doc_id: 'R1', body: 'This reported statement requires semantic review. '.repeat(50) }) }] }, undefined, async () => { calls++; return report; }, {}, {
    id: 'ontology-narrative', signal: new AbortController().signal, usage: () => {}, progress: () => {},
  });
  assert.equal(calls, 1); assert.deepEqual(definition.sourceMappings[0].semanticColumns, ['body']);
  assert.equal(definition.objectTypes[0].properties.length, 1);
});

test('zero-progress structured timeout resume repairs mappings and stores generated-key rows without another extraction call', async t => {
  let plans = 0; let calls = 0; let repairing = false;
  const { manager, store } = setup(t, async input => {
    if (input.purpose === 'ontology-design') {
      plans++;
      if (!repairing) return readingsDefinition(false);
      assert.match(input.context!, /previous schema failed/); return readingsDefinition();
    }
    calls++;
    throw new CodexError('CODEX_TIMEOUT', 'Codex 응답 시간이 초과되었습니다. 자료를 줄이거나 CODEX_TIMEOUT_MS를 조정해 주세요.', 504);
  }, { jev: readJevConfig({}) });
  const failed = await finish(manager, manager.create(readingsInput).id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.errorCode, 'CODEX_TIMEOUT'); assert.equal(failed.completedChunks, 0);
  repairing = true;
  const repaired = await finish(manager, manager.resume(failed.id).id);
  assert.equal(repaired.status, 'completed', repaired.error); assert.equal(repaired.ontologyVersion, 2);
  assert.equal(plans, 3); assert.equal(calls, 1); assert.equal(repaired.metrics?.structuredRecords, 1);
  assert.equal(store.summary().entities, 1);
  const node = store.getGraph(repaired.graphId!)!.nodes[0];
  assert.equal(node.properties.station, 'Station-A'); assert.equal(node.properties.temperature, '21.5');
  assert.match(node.properties.recordId, /^evidence-/);
  const persisted = store.db.prepare('SELECT input_json FROM generation_jobs WHERE id=?').get(failed.id)!;
  assert.equal(JSON.parse(String(persisted.input_json)).timeoutMappingRepaired, true);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS total FROM ontology_definition_history WHERE id=?').get(repaired.ontologyId!)!.total, 1);
});

test('repeated tiny-source timeout does not repeatedly redesign an already repaired schema', async t => {
  let plans = 0;
  const { manager } = setup(t, async input => {
    if (input.purpose === 'ontology-design') { plans++; return readingsDefinition(false); }
    throw new CodexError('CODEX_TIMEOUT', 'Codex 응답 시간이 초과되었습니다.', 504);
  }, { jev: readJevConfig({}) });
  const first = await finish(manager, manager.create(readingsInput).id);
  assert.equal(first.status, 'failed'); assert.equal(plans, 2);
  const second = await finish(manager, manager.resume(first.id).id);
  assert.equal(second.status, 'failed'); assert.equal(second.ontologyVersion, 2); assert.equal(plans, 4);
  const third = await finish(manager, manager.resume(first.id).id);
  assert.equal(third.status, 'failed'); assert.equal(third.ontologyVersion, 2); assert.equal(plans, 4);
});

test('timeout recovery splits an unfinished text part and preserves the already committed graph prefix', async t => {
  let plans = 0; let timeouts = 0; let jobId = ''; let savedPrefix: string | undefined;
  const quote = '"Alice" works for "Acme".';
  const { manager, store } = setup(t, async input => {
    if (input.purpose === 'ontology-design') { plans++; return names(); }
    if (input.documents[0].text.length > 5000) {
      timeouts++;
      const checkpoint = manager.get(jobId)!;
      assert.ok(checkpoint.completedChunks >= 1); savedPrefix ??= checkpoint.graphIds[0];
      throw new CodexError('CODEX_TIMEOUT', 'Codex 응답 시간이 초과되었습니다.', 504);
    }
    const result = extracted(input);
    for (const entity of result.entities) entity.evidence = [{ documentId: input.documents[0].id, quote }];
    for (const relation of result.relationships) relation.evidence = [{ documentId: input.documents[0].id, quote }];
    return result;
  }, { jev: readJevConfig({}) });
  const large = `${quote} This line provides repeated source context only.\n`.repeat(140);
  const created = manager.create({ question: '고용 관계', documents: [source('first'), { id: 'large-source', name: 'large.txt', text: large }] });
  jobId = created.id;
  const completed = await finish(manager, jobId);
  assert.equal(completed.status, 'completed', completed.error); assert.ok(timeouts > 0); assert.equal(plans, 1);
  assert.equal(completed.completedChunks, completed.totalChunks); assert.equal(completed.graphIds[0], savedPrefix);
  assert.ok(completed.graphIds.length >= 4); assert.equal(completed.graphIds.length, store.summary().graphs);
  assert.equal(completed.ontologyVersion, 1, 'splitting input does not redesign an ontology already used by saved graphs');
  for (const graphId of completed.graphIds) assert.equal(store.getGraph(graphId)!.ontologyId, completed.ontologyId);
});

test('design timeout uses one smaller retry and still permits one validation repair', async () => {
  const original = { question: '고용 관계를 분석해주세요.', documents: [{ ...source(), text: source().text.repeat(700) }] };
  const snapshot = structuredClone(original);
  let calls = 0; let usages = 0; let firstChars = 0;
  const metrics: Record<string, number> = {};
  const result = await designOntology(original, undefined, async (input, config) => {
    calls++;
    assert.equal(config?.effort, 'high'); assert.equal(config?.timeoutMs, 300000);
    assert.equal(input.documents.length, 1); assert.equal(input.documents[0].name, original.documents[0].name);
    if (calls === 1) { firstChars = input.documents[0].text.length; throw new CodexError('CODEX_TIMEOUT', 'Simulated design timeout'); }
    assert.ok(input.documents[0].text.length < firstChars);
    if (calls === 2) return { ...names(), linkTypes: [{ ...names().linkTypes[0], targetType: 'Missing' }] };
    assert.match(input.context!, /failed server validation/);
    return names();
  }, { timeoutMs: 180000, ontologyTimeoutMs: 300000, effort: 'xhigh', efforts: { 'ontology-design': 'high' } }, {
    id: 'retry-design', signal: new AbortController().signal, usage: () => { usages++; }, progress: () => {},
    metrics: delta => { for (const [key, value] of Object.entries(delta)) metrics[key] = (metrics[key] ?? 0) + value; },
  });
  assert.equal(result.id, 'retry-design'); assert.equal(calls, 3); assert.equal(usages, 3);
  assert.equal(metrics.designTimeoutRetries, 1); assert.equal(metrics.validationRetries, 1);
  assert.ok(metrics.designMs > 0); assert.ok(metrics.codexRunMs > 0); assert.deepEqual(original, snapshot);
});

test('repeated design timeouts stop with resumable saved input and measured failure time', async t => {
  let calls = 0;
  const { manager, store } = setup(t, async input => {
    calls++; assert.equal(input.purpose, 'ontology-design');
    throw new CodexError('CODEX_TIMEOUT', 'Simulated design timeout');
  });
  const input = { question: '고용 관계', documents: [source()] };
  const job = await finish(manager, manager.create(input).id);
  assert.equal(job.status, 'failed'); assert.equal(job.stage, 'designing'); assert.equal(job.resumable, true);
  assert.equal(job.errorCode, 'CODEX_TIMEOUT'); assert.match(job.error!, /온톨로지 설계.*축약 재시도/);
  assert.equal(calls, 2); assert.equal(job.metrics?.codexCalls, 2); assert.equal(job.metrics?.designTimeoutRetries, 1);
  assert.ok(job.metrics!.designMs > 0); assert.ok(job.metrics!.codexRunMs > 0);
  assert.deepEqual(JSON.parse(String(store.db.prepare('SELECT input_json FROM generation_jobs WHERE id=?').get(job.id)!.input_json)).documents, input.documents);
  assert.equal(store.listDefinitions().length, 0); assert.equal(job.graphCount, 0);
});

test('cancelling ontology design never starts the timeout recovery request', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(designOntology({ question: '설계', documents: [source()] }, undefined, async () => {
    calls++; controller.abort(); throw new CodexError('CODEX_TIMEOUT', 'Simulated late timeout');
  }, {}, { id: 'cancel-design', signal: controller.signal, usage: () => {}, progress: () => {} }), error => error instanceof Error && error.name === 'AbortError');
  assert.equal(calls, 1);
});

test('planning compaction preserves every exact column and observed type even for wide schemas', () => {
  const columns = Array.from({ length: 128 }, (_, index) => ({ name: `column_${index}_${'x'.repeat(160)}`, kinds: ['string', 'null'], presentCount: 400, maxLength: 25000, examples: ['sample '.repeat(60), 'another '.repeat(60)] }));
  const profile = { sourceName: 'wide.csv', records: 400, columns, truncated: false };
  const document = { id: 'profile', name: 'wide.csv', text: JSON.stringify(profile) };
  const compact = compactPlanningDocument(document, 1800);
  const result = JSON.parse(compact.text);
  assert.ok(compact.text.length < document.text.length); assert.equal(result.records, 400);
  assert.deepEqual(result.columns.map((column: Record<string, unknown>) => [column.name, column.kinds, column.presentCount, column.maxLength]), columns.map(column => [column.name, column.kinds, column.presentCount, column.maxLength]));
  assert.ok(columns[0].examples[0].length > 100, 'original profiling data remains unchanged');
});

test('ontology deadline is configurable without changing extraction or chat deadlines', () => {
  const config = readProductConfig(process.cwd(), { CODEX_TIMEOUT_MS: '180000', CODEX_ONTOLOGY_TIMEOUT_MS: '300000', CODEX_REASONING_EFFORT: 'xhigh', CODEX_ONTOLOGY_EFFORT: 'high' }).codex;
  assert.equal(effectiveCodexConfig(config, 'ontology-design').timeoutMs, 300000);
  assert.equal(effectiveCodexConfig(config, 'ontology-design').effort, 'high');
  assert.equal(effectiveCodexConfig(config, 'extraction').timeoutMs, 180000);
  assert.equal(effectiveCodexConfig(config, 'case-chat').timeoutMs, 180000);
  assert.equal(effectiveCodexConfig(config, 'extraction').effort, 'xhigh');
  assert.throws(() => readProductConfig(process.cwd(), { CODEX_ONTOLOGY_TIMEOUT_MS: 'NaN' }), /CODEX_ONTOLOGY_TIMEOUT_MS/);
  assert.throws(() => readProductConfig(process.cwd(), { CODEX_ONTOLOGY_TIMEOUT_MS: '600001' }), /CODEX_ONTOLOGY_TIMEOUT_MS/);
});

const narrativeDefinition = () => parseOntologyDefinition({ apiName: 'Reports', displayName: '보고서',
  objectTypes: [{ apiName: 'Report', primaryKey: 'reportId', titleProperty: 'reportId', properties: [{ apiName: 'reportId', baseType: 'string' }] }],
  sourceMappings: [{ sourceName: 'reports.jsonl', format: 'jsonl', objectType: 'Report', columns: [{ column: 'doc_id', property: 'reportId' }], identityColumns: ['doc_id'], semanticColumns: ['body'], relations: [] }],
});
const narrativeInput = (rows = 2): GraphGenerationInput => ({ question: '보고서별 출하 내용을 분석해 주세요.', documents: [{ id: 'reports', name: 'reports.jsonl', text: Array.from({ length: rows }, (_, index) => JSON.stringify({ doc_id: `R${index + 1}`, body: `Shipment O${index + 1} was dispatched.` })).join('\n') }] });
const reportRule = { apiName: 'reportForm', displayName: '보고서 형식', purpose: 'classification', sourceName: 'reports.jsonl', columns: ['body'], question: '서술된 보고서 형식은 무엇인가요?', choices: [{ apiName: 'shipment', description: '출하 내역을 직접 보고함' }, { apiName: 'uncertain', description: '분류를 명시적으로 확인할 수 없음' }] };

test('jobs separate high ontology design from xhigh Jev rule planning and persist validated rules', async t => {
  const stages: string[] = [];
  const { manager, store } = setup(t, async (input, config) => {
    stages.push(input.purpose ?? 'extraction');
    if (input.purpose === 'ontology-design') {
      assert.equal(config?.effort, 'high');
      assert.match(input.context!, /decisionRules=\[\]/);
      return narrativeDefinition();
    }
    if (input.purpose === 'jev-planning') {
      assert.equal(config?.effort, 'xhigh');
      assert.deepEqual(input.documents.map(document => document.name), ['reports.jsonl']);
      assert.match(input.context!, /semanticColumns/);
      return { decisionRules: [reportRule] };
    }
    assert.equal(config?.effort, 'xhigh');
    return { ...extracted(input), entities: [], relationships: [], limitations: ['추가로 확인할 관계가 없습니다.'] };
  }, { assessJevDecisions: async () => ({ route: 'individual', reason: '개별 검토', context: 'Advisory only.', decisions: [] }) });
  const job = await finish(manager, manager.create(narrativeInput()).id);
  assert.equal(job.status, 'completed', job.error);
  assert.deepEqual(stages.slice(0, 2), ['ontology-design', 'jev-planning']);
  assert.equal(stages.filter(stage => stage === 'jev-planning').length, 1);
  assert.equal(job.metrics?.codexCalls, stages.length);
  const saved = store.getDefinitionForJob(job.id)!;
  assert.deepEqual(saved.processing.decisionRules, [reportRule]);
  assert.deepEqual(saved.objectTypes, narrativeDefinition().objectTypes);
  assert.deepEqual(saved.sourceMappings, narrativeDefinition().sourceMappings);
});

test('Jev rule planning is skipped without configuration or repeated semantic rows', async () => {
  for (const [enabled, rows] of [[false, 2], [true, 1]] as const) {
    let calls = 0;
    const result = await designOntology(narrativeInput(rows), undefined, async input => {
      calls++; assert.equal(input.purpose, 'ontology-design'); return narrativeDefinition();
    }, {}, { id: 'no-rules', planJevRules: enabled, signal: new AbortController().signal, usage: () => {}, progress: () => {} });
    assert.equal(calls, 1); assert.deepEqual(result.processing.decisionRules, []);
  }
});

test('invalid or timed-out Jev rule plans keep the valid ontology and never retry schema design', async () => {
  for (const failure of ['timeout', 'column', 'uncertain', 'extra'] as const) {
    let calls = 0; const progress: string[] = [];
    const result = await designOntology(narrativeInput(), undefined, async input => {
      calls++;
      if (input.purpose === 'ontology-design') return narrativeDefinition();
      assert.equal(input.purpose, 'jev-planning');
      if (failure === 'timeout') throw new CodexError('CODEX_TIMEOUT', 'provider internal details');
      if (failure === 'extra') return { decisionRules: [reportRule], objectTypes: [] };
      return { decisionRules: [{ ...reportRule, ...(failure === 'column' ? { columns: ['doc_id'] } : { choices: reportRule.choices.slice(0, 1) }) }] };
    }, {}, { id: 'fallback-rules', planJevRules: true, signal: new AbortController().signal, usage: () => {}, progress: message => { progress.push(message); } });
    assert.equal(calls, 2); assert.deepEqual(result.processing.decisionRules, []);
    assert.deepEqual(result.sourceMappings, narrativeDefinition().sourceMappings);
    assert.match(progress.join('\n'), /Codex 원문 검토로 계속/);
    assert.doesNotMatch(progress.join('\n'), /provider internal details/);
  }
});

test('cancelled Jev planning propagates without redesign or fallback completion', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(designOntology(narrativeInput(), undefined, async input => {
    calls++;
    if (input.purpose === 'ontology-design') return narrativeDefinition();
    controller.abort(); return { decisionRules: [reportRule] };
  }, {}, { id: 'cancel-rules', planJevRules: true, signal: controller.signal, usage: () => {}, progress: () => {} }), { name: 'AbortError' });
  assert.equal(calls, 2);
});
