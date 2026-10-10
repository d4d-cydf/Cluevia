import assert from 'node:assert/strict';
import test from 'node:test';
import { OntologyStore } from './ontology-store.ts';
import { compileExtraction } from './ontology.ts';
import { archiveRecord, buildAnalysisCase, createRecordArchive, getAnalysisRecord, getRecordDocument, searchCaseEvidence } from './analysis-case.ts';
import type { GraphDocument } from '../src/types/graph.ts';
import type { OntologyExtraction } from '../src/types/ontology.ts';

const job = { id: 'test-case', question: '모든 방문 기록', status: 'completed', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', completedChunks: 3, totalChunks: 3 };
function setup() {
  const store = new OntologyStore(':memory:');
  createRecordArchive(store.db);
  store.db.exec('CREATE TABLE analysis_parts (job_id TEXT, part_index INTEGER, graph_id TEXT, PRIMARY KEY(job_id,part_index))');
  return store;
}
function save(store: OntologyStore, number: number, state = 'active', caseId = job.id) {
  const text = `Ocean Star (IMO 9074729) visited Busan. Status ${state}. Report ${number}.`;
  const documents = [{ id: 'source-1', name: `Report ${number}`, text }];
  const evidence = [{ documentId: 'source-1', quote: text }];
  const extraction: OntologyExtraction = {
    title: `Report ${number}`, summary: text, limitations: [`Limitation ${number}`],
    entities: [
      { id: 'ship', label: 'Ocean Star', type: 'vessel', description: text, identifiers: [{ namespace: 'imo', value: '9074729' }], properties: [{ key: 'status', value: state }], evidence },
      { id: 'port', label: 'Busan', type: 'place', description: text, identifiers: [], properties: [], evidence },
    ],
    relationships: [{ id: 'visit', source: 'ship', target: 'port', label: 'Visited', type: 'visited', description: text, status: number === 2 ? 'inferred' : 'reported', evidence }],
    events: [], findings: [{ text, entityIds: ['ship'], relationshipIds: ['visit'], evidence }],
  };
  const graph = store.saveGraph(compileExtraction(extraction, { question: job.question, documents }), documents, extraction);
  store.db.prepare('INSERT INTO analysis_parts VALUES (?,?,?)').run(caseId, number, graph.id);
  archiveRecord(store.db, caseId, number, documents, extraction);
  return graph;
}

test('legacy FTS5 search cache migrates atomically without changing cases, graphs or original evidence', t => {
  const store = setup(); t.after(() => store.close());
  if (!store.db.prepare('PRAGMA module_list').all().some(module => module.name === 'fts5')) {
    t.skip('This SQLite build has no FTS5; the migration regression also runs on Windows Node.js.'); return;
  }
  const graph = save(store, 1);
  const rawArchive = store.db.prepare('SELECT record_json FROM analysis_record_archive').get()!.record_json;
  const rawDocument = store.db.prepare('SELECT text FROM documents').get()!.text;
  store.db.exec(`DROP TABLE evidence_search;
    CREATE VIRTUAL TABLE evidence_search USING fts5(job_id UNINDEXED, part_index UNINDEXED, document_id UNINDEXED, name UNINDEXED, text, tokenize='trigram');
    DROP TABLE evidence_search_versions;
    CREATE TABLE evidence_search_versions (job_id TEXT PRIMARY KEY, records INTEGER NOT NULL);
    INSERT INTO evidence_search_terms VALUES ('test-case','stale',999)`);
  store.db.prepare('INSERT INTO evidence_search VALUES (?,?,?,?,?)').run(job.id, 1, 'source-1', 'Report 1', 'Old cached excerpt');
  store.db.prepare('INSERT INTO evidence_search_versions VALUES (?,?)').run(job.id, 1);
  assert.throws(() => store.db.exec('CREATE INDEX evidence_search_job ON evidence_search(job_id)'), /virtual tables may not be indexed/);

  createRecordArchive(store.db);
  assert.doesNotMatch(String(store.db.prepare("SELECT sql FROM sqlite_master WHERE name='evidence_search'").get()!.sql), /VIRTUAL/i);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM evidence_search_versions').get()!.n, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM evidence_search_terms').get()!.n, 0);
  assert.equal(store.db.prepare('SELECT record_json FROM analysis_record_archive').get()!.record_json, rawArchive);
  assert.equal(store.db.prepare('SELECT text FROM documents').get()!.text, rawDocument);
  assert.deepEqual(store.getGraph(graph.id), graph);
  const result = searchCaseEvidence(store.db, job, '9074729');
  assert.equal(result.hits.length, 1); assert.ok(result.hits[0].evidenceTexts.some(text => text.includes('Ocean Star')));
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM evidence_search').get()!.n, 1);
  createRecordArchive(store.db);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM evidence_search').get()!.n, 1, 'repeated startup keeps the rebuilt index');
  assert.deepEqual(searchCaseEvidence(store.db, job, '9074729'), result);
});

test('failed legacy search migration rolls back the original virtual table and cached markers', t => {
  const store = setup(); t.after(() => store.close());
  if (!store.db.prepare('PRAGMA module_list').all().some(module => module.name === 'fts5')) {
    t.skip('This SQLite build has no FTS5; rollback coverage runs on Windows Node.js.'); return;
  }
  store.db.exec(`DROP TABLE evidence_search;
    CREATE VIRTUAL TABLE evidence_search USING fts5(job_id UNINDEXED, part_index UNINDEXED, document_id UNINDEXED, name UNINDEXED, text);
    INSERT INTO evidence_search VALUES ('test-case',1,'source-1','Report 1','preserve this cache on failure');
    INSERT INTO evidence_search_versions VALUES ('test-case',1,2);
    CREATE TRIGGER fail_cache_reset BEFORE DELETE ON evidence_search_versions BEGIN SELECT RAISE(ABORT,'forced migration failure'); END;`);
  assert.throws(() => createRecordArchive(store.db), /forced migration failure/);
  assert.match(String(store.db.prepare("SELECT sql FROM sqlite_master WHERE name='evidence_search'").get()!.sql), /VIRTUAL/i);
  assert.equal(store.db.prepare('SELECT text FROM evidence_search').get()!.text, 'preserve this cache on failure');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM evidence_search_versions').get()!.n, 1);
  store.db.exec('DROP TRIGGER fail_cache_reset');
  assert.doesNotThrow(() => createRecordArchive(store.db));
});

test('case joins stored identities across records, scopes all local IDs and preserves conflicting values', t => {
  const store = setup(); t.after(() => store.close());
  save(store, 1); save(store, 2, 'inactive');
  store.db.prepare('INSERT INTO analysis_parts VALUES (?,?,NULL)').run(job.id, 3);
  const value = buildAnalysisCase(store.db, job);
  assert.equal(value.graph.nodes.length, 3); // one identified ship, two unproven same-name ports
  const ship = value.graph.nodes.find(node => node.label === 'Ocean Star')!;
  assert.equal(value.provenance[ship.id].length, 2);
  assert.equal(value.graph.edges.filter(edge => edge.source === ship.id).length, 2);
  assert.deepEqual(value.graph.edges.map(edge => edge.status), ['reported', 'inferred']);
  assert.equal(new Set(value.graph.sources.map(source => source.id)).size, 2);
  assert.equal(new Set(value.graph.edges.map(edge => edge.id)).size, 2);
  assert.deepEqual(value.conflicts, [{ nodeId: ship.id, property: 'status', values: [{ value: 'active', records: [1] }, { value: 'inactive', records: [2] }] }]);
  assert.match(ship.properties.status, /서로 다른 값/);
  for (const finding of value.graph.findings) {
    assert.ok(finding.nodeIds.every(id => value.graph.nodes.some(node => node.id === id)));
    assert.ok(finding.edgeIds!.every(id => value.graph.edges.some(edge => edge.id === id)));
    assert.ok(finding.sourceIds.every(id => value.graph.sources.some(source => source.id === id)));
  }
  assert.equal(value.records[2].status, 'empty');
  assert.deepEqual(buildAnalysisCase(store.db, job), value); // IDs remain stable on reload
});

test('other cases never enter graph, conflict values, quotations or record document lookup', t => {
  const store = setup(); t.after(() => store.close());
  save(store, 1); save(store, 2, 'private-other-case', 'unrelated-case');
  const value = buildAnalysisCase(store.db, { ...job, completedChunks: 1, totalChunks: 1 });
  assert.equal(value.graph.nodes.length, 2); assert.equal(value.conflicts.length, 0);
  assert.ok(!JSON.stringify(value).includes('private-other-case'));
  assert.equal(getAnalysisRecord(store.db, job, 2), undefined);
  assert.equal(getRecordDocument(store.db, job, 2, 'source-1', 0), undefined);
  assert.equal(getRecordDocument(store.db, job, 1, 'unknown-source', 0), undefined);
});

test('empty records retain exact raw source, empty extraction reasoning, and page through the full text', t => {
  const store = setup(); t.after(() => store.close());
  const text = '근거 없음\n'.repeat(6000);
  store.db.prepare('INSERT INTO analysis_parts VALUES (?,?,NULL)').run(job.id, 1);
  archiveRecord(store.db, job.id, 1, [{ id: 'empty', name: 'Empty report', text }], { title: '추출 없음', summary: '객체 식별 근거 부족', entities: [], relationships: [], events: [], findings: [], limitations: ['부재가 반증은 아님'] });
  const detail = getAnalysisRecord(store.db, job, 1)!;
  assert.equal(detail.record.status, 'empty'); assert.equal(detail.record.archived, true);
  assert.equal(detail.summary, '객체 식별 근거 부족'); assert.deepEqual(detail.limitations, ['부재가 반증은 아님']);
  assert.equal(detail.documents[0].text.length, 12000);
  let recovered = '';
  for (let offset = 0; offset < text.length; offset += 12000) recovered += getRecordDocument(store.db, job, 1, 'empty', offset)!.text;
  assert.equal(recovered, text);
});

test('legacy records are readable without migration; missing empty record evidence is explicit', t => {
  const store = setup(); t.after(() => store.close());
  const graph = save(store, 1);
  store.db.exec('DROP TABLE analysis_record_archive; DROP TABLE analysis_parts');
  store.db.prepare('UPDATE graphs SET title=? WHERE id=?').run('Legacy · part 2/3', graph.id);
  const legacy = { ...job, graphIds: [graph.id] };
  const result = buildAnalysisCase(store.db, legacy);
  assert.equal(result.records.length, 3); assert.equal(result.records[1].graphId, graph.id);
  assert.equal(getAnalysisRecord(store.db, legacy, 2)!.documents[0].text.includes('Ocean Star'), true);
  assert.match(getAnalysisRecord(store.db, legacy, 3)!.limitations[0], /복원할 수 없습니다/);
});

test('running/cancelled cases include saved records and identify pending records without claiming completion', t => {
  const store = setup(); t.after(() => store.close()); save(store, 1);
  store.db.prepare('INSERT INTO analysis_parts VALUES (?,?,NULL)').run(job.id, 2);
  const value = buildAnalysisCase(store.db, { ...job, status: 'cancelled', completedChunks: 1, totalChunks: 2 });
  assert.equal(value.records[1].status, 'pending'); assert.equal(value.graph.nodes.length, 2);
  assert.ok(value.graph.limitations.some(text => text.includes('완료되지')));
});

test('case projections retain more than 200 objects and do not relax individual graph import limits', t => {
  const store = setup(); t.after(() => store.close());
  const base: GraphDocument = { schemaVersion: '1.0', id: 'part', title: 'Part', question: 'All records', summary: 'Records', origin: 'imported', createdAt: job.createdAt, limitations: [], groups: [{ id: 'items', label: 'Items', color: '#123456' }], sources: [{ id: 'source', title: 'Source' }], nodes: [], edges: [], events: [], findings: [] };
  for (let part = 1; part <= 3; part++) {
    const graph = store.saveGraph({ ...base, nodes: Array.from({ length: 100 }, (_, i) => ({ id: `n-${i}`, label: `Object ${part}-${i}`, type: 'record', group: 'items', description: 'Recorded object', properties: {}, sourceIds: ['source'] })) });
    store.db.prepare('INSERT INTO analysis_parts VALUES (?,?,?)').run(job.id, part, graph.id);
  }
  const value = buildAnalysisCase(store.db, job);
  assert.equal(value.graph.nodes.length, 300); assert.equal(Object.keys(value.provenance).length, 303);
  assert.throws(() => store.saveGraph(value.graph), /200/);
});
