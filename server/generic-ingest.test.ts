import assert from 'node:assert/strict';
import test from 'node:test';
import { genericStructuredBatches, profileStructured } from './generic-ingest.ts';
import type { GenericStructuredBatch } from './generic-ingest.ts';
import { parseOntologyDefinition, typedValuesFor } from './ontology-schema.ts';
import { compileExtraction } from './ontology.ts';
import { OntologyStore } from './ontology-store.ts';

function schema() {
  return parseOntologyDefinition({ apiName: 'Commerce', displayName: '고객 주문', objectTypes: [
    { apiName: 'Customer', primaryKey: 'id', titleProperty: 'name', properties: [{ apiName: 'id', baseType: 'string', required: true }, { apiName: 'name', baseType: 'string', required: true }, { apiName: 'active', baseType: 'boolean' }] },
    { apiName: 'Order', primaryKey: 'id', titleProperty: 'id', properties: [{ apiName: 'id', baseType: 'string', required: true }, { apiName: 'amount', baseType: 'double', constraints: { minimum: 0 } }, { apiName: 'orderedOn', baseType: 'date' }] },
  ], linkTypes: [{ apiName: 'placed', sourceType: 'Customer', targetType: 'Order', sourceCardinality: 'one', targetCardinality: 'many' }], sourceMappings: [
    { sourceName: 'orders.csv', format: 'csv', objectType: 'Customer', identityColumns: ['customer_id'], columns: [{ column: 'customer_id', property: 'id' }, { column: 'customer_name', property: 'name' }, { column: 'active', property: 'active' }], relations: [{ linkType: 'placed', targetType: 'Order', sourceColumn: 'order_id', targetProperty: 'id' }] },
    { sourceName: 'orders.csv', format: 'csv', objectType: 'Order', identityColumns: ['order_id'], columns: [{ column: 'order_id', property: 'id' }, { column: 'amount', property: 'amount' }, { column: 'ordered_on', property: 'orderedOn' }] },
  ] }, { id: 'ontology-commerce' });
}
const header = 'customer_id,customer_name,active,order_id,amount,ordered_on\n';
function* pieces(text: string) { for (let index = 0; index < text.length; index += 7) yield text.slice(index, index + 7); }
async function collect(text: string, definition = schema(), name = 'orders.csv'): Promise<GenericStructuredBatch[]> {
  const batches: GenericStructuredBatch[] = [];
  for await (const batch of genericStructuredBatches({ id: 'data-1', name }, pieces(text), definition)) batches.push(batch);
  return batches;
}

test('generated commerce mappings produce typed customer/order graphs without maritime assumptions', async () => {
  const definition = schema();
  const batches = await collect(`${header}C1,Alice,true,O1,12.5,2026-10-10\nC1,Alice,true,O2,9,2026-10-11\n`, definition);
  assert.equal(batches.length, 1); assert.equal(batches[0].records, 2);
  const extraction = batches[0].extraction!; assert.ok(extraction);
  assert.equal(extraction.entities.length, 3); assert.equal(extraction.relationships.length, 2);
  assert.deepEqual(typedValuesFor(extraction.entities.find(entity => entity.type === 'Customer')!, definition), { id: 'C1', name: 'Alice', active: true });
  assert.deepEqual(typedValuesFor(extraction.entities.find(entity => entity.label === 'O1')!, definition), { id: 'O1', amount: 12.5, orderedOn: '2026-10-10' });
  const graph = compileExtraction(extraction, { question: '관계 분석', documents: batches[0].documents }, definition);
  assert.deepEqual(graph.groups.map(group => group.id), ['Customer', 'Order']);
});

test('full profile sees late fields and counts all records while keeping model preview bounded', async () => {
  const text = `${Array.from({ length: 900 }, (_, index) => JSON.stringify({ id: index, amount: index })).join('\n')}\n${JSON.stringify({ id: 900, lateField: 'previously unseen' })}`;
  const profile = await profileStructured({ id: 'p', name: 'data.jsonl' }, pieces(text));
  assert.equal(profile.records, 901); assert.equal(profile.heterogeneous, true);
  assert.equal(profile.columns.find(column => column.name === 'lateField')?.presentCount, 1);
  assert.equal(profile.columns.find(column => column.name === 'lateField')?.maxLength, 'previously unseen'.length);
  assert.ok(profile.sampleDocument.text.includes('lateField')); assert.ok(profile.sampleDocument.text.length <= 24_000);
  const many = JSON.stringify(Object.fromEntries(Array.from({ length: 180 }, (_, index) => [`long_${index}_${'x'.repeat(190)}`, 'large'.repeat(100)])));
  const bounded = await profileStructured({ id: 'wide', name: 'wide.json' }, [many]);
  assert.equal(bounded.truncated, true); assert.ok(bounded.sampleDocument.text.length <= 24_000); assert.doesNotThrow(() => JSON.parse(bounded.sampleDocument.text));
  assert.equal(bounded.columns[0].maxLength, 500);
});

test('unknown columns, ambiguous booleans and invalid dates retain complete raw rows for Codex', async () => {
  for (const text of [
    `${header.replace('\n', ',new_column\n')}C1,Alice,true,O1,10,2026-10-10,new fact\n`,
    `${header}C1,Alice,yes,O1,10,2026-10-10\n`,
    `${header}C1,Alice,true,O1,10,2026-02-30\n`,
  ]) {
    const batches = await collect(text); assert.equal(batches[0].extraction, undefined); assert.equal(batches[0].records, 1);
    assert.equal(batches[0].documents[0].text, text);
  }
});

test('missing required target fields never manufacture a customer from a foreign key', async () => {
  const definition = schema();
  definition.sourceMappings = definition.sourceMappings.filter(mapping => mapping.objectType === 'Order');
  definition.linkTypes = [{ ...definition.linkTypes[0], sourceType: 'Order', targetType: 'Customer' }];
  definition.sourceMappings[0].relations = [{ linkType: 'placed', targetType: 'Customer', sourceColumn: 'customer_id', targetProperty: 'id' }];
  const batches = await collect('customer_id,order_id,amount,ordered_on\nC1,O1,12,2026-10-10\n', definition);
  assert.equal(batches[0].extraction, undefined); assert.ok(batches[0].documents[0].text.includes('C1,O1'));
});

test('all rows survive mixed deterministic/fallback batches with stable scoped primary keys', async () => {
  const rows = Array.from({ length: 305 }, (_, index) => `C1,Alice,${index === 151 ? 'yes' : 'true'},O${index},12,2026-10-10\n`);
  const first = await collect(header + rows.join('')); const second = await collect(header + rows.join(''));
  assert.equal(first.reduce((sum, batch) => sum + batch.records, 0), 305);
  assert.equal(first.filter(batch => !batch.extraction).reduce((sum, batch) => sum + batch.records, 0), 1);
  assert.deepEqual(first.map(batch => batch.documents[0].id), second.map(batch => batch.documents[0].id));
  const customerIds = first.flatMap(batch => batch.extraction?.entities.filter(entity => entity.type === 'Customer').map(entity => entity.id) ?? []);
  assert.equal(new Set(customerIds).size, 1);
  const other = schema(); other.id = 'ontology-other';
  const otherBatch = await collect(header + rows[0], other);
  assert.notEqual(otherBatch[0].extraction!.entities[0].id, customerIds[0]);
  for (const batch of first) if (batch.extraction) compileExtraction(batch.extraction, { question: '전체 변환', documents: batch.documents }, schema());
});

test('large unsupported cells remain complete for bounded downstream Codex chunking', async () => {
  const large = '내용 '.repeat(30_000);
  const text = `${header.replace('\n', ',long_note\n')}C1,Alice,true,O1,12,2026-10-10,${large}\n`;
  const batches = await collect(text); assert.equal(batches[0].records, 1); assert.equal(batches[0].extraction, undefined);
  assert.ok(batches[0].documents[0].text.includes(large));
});

function observations() {
  return parseOntologyDefinition({ apiName: 'SensorObservations', displayName: '센서 관측', objectTypes: [{
    apiName: 'Observation', primaryKey: 'recordId', titleProperty: 'recordId', properties: [
      { apiName: 'recordId', baseType: 'string', valueSource: 'evidenceId' },
      { apiName: 'sourceFile', baseType: 'string', valueSource: 'documentName' },
      { apiName: 'observedAt', baseType: 'timestamp', required: true },
      { apiName: 'sensorName', baseType: 'string', required: true },
      { apiName: 'measurement', baseType: 'double', required: true },
      { apiName: 'quality', baseType: 'string' },
    ],
  }], sourceMappings: [{ sourceName: 'observations.csv', format: 'csv', objectType: 'Observation', identityColumns: [], columns: [
    { column: 'timestamp', property: 'observedAt' }, { column: 'name', property: 'sensorName' },
    { column: 'value', property: 'measurement' }, { column: 'quality', property: 'quality' },
  ] }] }, { id: 'ontology-observations' });
}

test('100 rows without business primary keys use code conversion with all typed values and stable metadata IDs', async () => {
  const definition = observations();
  const rows = Array.from({ length: 100 }, (_, index) => `2026-10-10T00:00:00Z,Sensor-${index},${index / 10},\n`);
  const text = `timestamp,name,value,quality\n${rows.join('')}`;
  const batches = await collect(text, definition, 'observations.csv');
  assert.equal(batches.length, 1); assert.equal(batches[0].records, 100);
  const entities = batches[0].extraction!.entities;
  assert.equal(entities.length, 100); assert.equal(new Set(entities.map(entity => entity.id)).size, 100);
  for (const [index, entity] of entities.entries()) {
    const values = typedValuesFor(entity, definition);
    assert.match(String(values.recordId), /^evidence-[0-9a-f]{32}$/);
    assert.equal(entity.label, values.recordId);
    assert.equal(values.observedAt, '2026-10-10T00:00:00Z');
    assert.equal(values.sensorName, `Sensor-${index}`); assert.equal(values.measurement, index / 10);
    assert.equal(values.sourceFile, 'observations.csv'); assert.equal(values.quality, undefined);
    assert.ok(entity.evidence[0].quote.includes(`자료 메타데이터: 레코드 순번 ${index + 1}\n`));
    assert.ok(batches[0].documents[0].text.includes(rows[index]));
  }
  compileExtraction(batches[0].extraction!, { question: '전체 관측 분석', documents: batches[0].documents }, definition);
  const repeated = await collect(text, definition, 'observations.csv');
  assert.deepEqual(repeated[0].extraction, batches[0].extraction);
});

test('identical records remain separate observations and evidence IDs do not depend on batch boundaries', async () => {
  const definition = observations();
  const row = '2026-10-10T00:00:00Z,Sensor-A,1,good\n';
  const text = `timestamp,name,value,quality\n${row.repeat(102)}`;
  const first = await collect(text, definition, 'observations.csv');
  const ids = first.flatMap(batch => batch.extraction!.entities.map(entity => entity.properties.find(property => property.key === 'recordId')!.value));
  assert.equal(ids.length, 102); assert.equal(new Set(ids).size, 102);
  // An additional metadata property requires one document per row. The row evidence identity
  // is unchanged even though all 102 batching boundaries now differ.
  const separate = structuredClone(definition);
  separate.objectTypes.push({ ...structuredClone(separate.objectTypes[0]), apiName: 'DocumentRow', primaryKey: 'documentId', titleProperty: 'documentId', properties: [{ apiName: 'documentId', displayName: 'ID', description: '', baseType: 'string', required: true, valueSource: 'documentId', visibility: 'normal', renderHints: [], typeClasses: [] }] });
  separate.sourceMappings.push({ sourceName: 'observations.csv', format: 'csv', objectType: 'DocumentRow', columns: [], identityColumns: [], relations: [] });
  const second = await collect(text, separate, 'observations.csv');
  assert.equal(second.length, 102);
  assert.deepEqual(second.flatMap(batch => batch.extraction!.entities.filter(entity => entity.type === 'Observation').map(entity => entity.properties.find(property => property.key === 'recordId')!.value)), ids);
});

test('irregular structured records stay lossless but model fallback batches contain at most eight rows', async () => {
  const rows = Array.from({ length: 25 }, (_, index) => `C1,Alice,unclear,O${index},12,2026-10-10\n`);
  const batches = await collect(header + rows.join(''));
  assert.deepEqual(batches.map(batch => batch.records), [8, 8, 8, 1]);
  assert.ok(batches.every(batch => !batch.extraction));
  for (const row of rows) assert.ok(batches.some(batch => batch.documents[0].text.includes(row)));
});

test('long narrative columns preserve direct record identities and receive separate full-row semantic review', async () => {
  const definition = parseOntologyDefinition({ apiName: 'Documents', displayName: '문서', objectTypes: [{ apiName: 'Report', primaryKey: 'id', titleProperty: 'id', properties: [{ apiName: 'id', baseType: 'string' }] }], sourceMappings: [{ sourceName: 'reports.jsonl', format: 'jsonl', objectType: 'Report', columns: [{ column: 'doc_id', property: 'id' }], identityColumns: ['doc_id'], semanticColumns: ['text'] }] });
  const narratives = ['Alpha states that Beta supplied components. '.repeat(30), 'Beta denies the reported transfer.'];
  const rows = narratives.map((text, index) => JSON.stringify({ doc_id: `R-${index}`, text }));
  const batches = await collect(rows.join('\n'), definition, 'reports.jsonl');
  assert.equal(batches.length, 3); assert.equal(batches[0].records, 2);
  assert.equal(new Set(batches.map(batch => batch.documents[0].id)).size, 3);
  assert.equal(batches[0].extraction!.entities.length, 2);
  assert.equal(batches.reduce((total, batch) => total + batch.records, 0), 2);
  for (const [index, review] of batches.slice(1).entries()) {
    assert.equal(review.records, 0); assert.equal(review.semanticReview, true); assert.equal(review.extraction, undefined);
    assert.ok(review.documents[0].text.includes(rows[index]));
    assert.equal(review.semanticContext!.entities[0].properties[0].value, `R-${index}`);
    compileExtraction(review.semanticContext!, { question: '관계 분석', documents: review.documents }, definition);
  }
});

test('mapped short narrative fields still receive review and unknown extra columns are never discarded', async () => {
  const definition = parseOntologyDefinition({ apiName: 'Notes', displayName: '기록', objectTypes: [{ apiName: 'Note', primaryKey: 'id', titleProperty: 'id', properties: [{ apiName: 'id', baseType: 'string' }, { apiName: 'note', baseType: 'string' }] }], sourceMappings: [{ sourceName: 'notes.jsonl', format: 'jsonl', objectType: 'Note', columns: [{ column: 'id', property: 'id' }, { column: 'note', property: 'note' }], identityColumns: ['id'], semanticColumns: ['note'] }] });
  const clean = await collect(JSON.stringify({ id: 'N-1', note: 'A disputed transaction requires review.' }), definition, 'notes.jsonl');
  assert.equal(clean.length, 2); assert.ok(clean[0].extraction); assert.equal(clean[1].semanticReview, true);
  const extra = await collect(JSON.stringify({ id: 'N-1', note: 'A disputed transaction requires review.', unexpected: 'new relationship' }), definition, 'notes.jsonl');
  assert.equal(extra.length, 1); assert.equal(extra[0].extraction, undefined); assert.ok(extra[0].documents[0].text.includes('new relationship'));
});

test('stored semantic review preserves generated identities and every raw quote without reusing source IDs for different text', async () => {
  for (const valueSource of ['evidenceId', 'documentId'] as const) {
    const definition = parseOntologyDefinition({ apiName: 'Reports', displayName: '보고서', objectTypes: [{ apiName: 'Report', primaryKey: 'id', titleProperty: 'id', properties: [{ apiName: 'id', baseType: 'string', valueSource }] }], sourceMappings: [{ sourceName: 'reports.jsonl', format: 'jsonl', objectType: 'Report', columns: [], identityColumns: [], semanticColumns: ['text'] }] });
    const raw = [{ text: 'Alpha explicitly reports a supplied component.' }, { text: 'Beta explicitly disputes the previous report.' }].map(row => JSON.stringify(row));
    const batches = await collect(raw.join('\n'), definition, 'reports.jsonl');
    const sourceTexts = new Map<string, string>();
    const store = new OntologyStore(':memory:');
    try {
      store.saveDefinition(definition, `metadata-${valueSource}`);
      for (const batch of batches) {
        for (const document of batch.documents) {
          if (sourceTexts.has(document.id)) assert.equal(document.text, sourceTexts.get(document.id));
          sourceTexts.set(document.id, document.text);
        }
        const extraction = batch.extraction ?? batch.semanticContext!;
        assert.ok(extraction);
        const graph = compileExtraction(extraction, { question: '보고서 관계 분석', documents: batch.documents }, definition);
        graph.origin = batch.extraction ? 'structured' : 'codex'; graph.ontologyId = definition.id; graph.ontologyVersion = definition.version;
        store.saveGraph(graph, batch.documents, extraction);
      }
      assert.equal(store.summary().entities, 2);
      const documents = store.db.prepare('SELECT id,text FROM documents').all();
      for (const row of raw) assert.ok(documents.some(document => String(document.text).includes(row)));
      for (const row of store.db.prepare('SELECT claim_json FROM entity_claims').all()) {
        const claim = JSON.parse(String(row.claim_json));
        for (const evidence of claim.evidence) assert.ok(String(documents.find(document => document.id === evidence.documentId)?.text).includes(evidence.quote));
      }
    } finally { store.close(); }
  }
});
