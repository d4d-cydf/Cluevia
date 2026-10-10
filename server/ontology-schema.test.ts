import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphGenerationInput } from '../src/types/graph.ts';
import type { OntologyExtraction } from '../src/types/ontology.ts';
import { ontologyDefinitionSchema, parseOntologyDefinition, PROPERTY_BASE_TYPES, typedValuesFor } from './ontology-schema.ts';
import { compileExtraction, extractionSchemaFor, parseExtraction, rebindExtractionSources } from './ontology.ts';

function definitionInput() {
  return {
    apiName: 'CustomerOrders', displayName: '고객과 주문',
    objectTypes: [
      { apiName: 'Customer', displayName: '고객', primaryKey: 'customerId', titleProperty: 'name', properties: [{ apiName: 'customerId', baseType: 'string', required: true }, { apiName: 'name', baseType: 'string', required: true }, { apiName: 'active', baseType: 'boolean' }] },
      { apiName: 'Order', displayName: '주문', primaryKey: 'orderId', titleProperty: 'orderId', properties: [{ apiName: 'orderId', baseType: 'string', required: true }, { apiName: 'amount', baseType: 'double', constraints: { minimum: 0 } }, { apiName: 'orderedOn', baseType: 'date' }] },
    ],
    linkTypes: [{ apiName: 'placed', displayName: '주문', sourceType: 'Customer', targetType: 'Order', sourceCardinality: 'one', targetCardinality: 'many' }],
  };
}
function sample() {
  const text = 'Customer C-12 named Alice is active true. Alice placed order O-8 for 125.5 on 2026-10-10.';
  const evidence = [{ documentId: 'orders', quote: text }];
  const input: GraphGenerationInput = { question: '고객의 주문을 연결해줘', documents: [{ id: 'orders', name: 'orders.txt', text }] };
  const extraction: OntologyExtraction = {
    title: '고객 주문', summary: 'Alice의 주문 내역',
    entities: [
      { id: 'alice', label: 'Alice', type: 'Customer', description: '', identifiers: [], properties: [{ key: 'customerId', value: 'C-12' }, { key: 'name', value: 'Alice' }, { key: 'active', value: 'true' }], evidence },
      { id: 'order8', label: 'O-8', type: 'Order', description: '', identifiers: [], properties: [{ key: 'orderId', value: 'O-8' }, { key: 'amount', value: '125.5' }, { key: 'orderedOn', value: '2026-10-10' }], evidence },
    ], relationships: [{ id: 'placed8', source: 'alice', target: 'order8', type: 'placed', label: '주문', description: '', status: 'reported', evidence }], events: [], findings: [], limitations: [],
  };
  return { input, extraction };
}

test('generic customer/order definitions compile a graph with typed numeric, boolean and date claims', () => {
  const definition = parseOntologyDefinition(definitionInput(), { id: 'ontology-orders', version: 2 });
  const { input, extraction } = sample(); const graph = compileExtraction(extraction, input, definition);
  assert.equal(definition.id, 'ontology-orders'); assert.equal(definition.version, 2); assert.equal(definition.processing.textStrategy, 'codex');
  assert.deepEqual(graph.groups.map(g => g.id), ['Customer', 'Order']); assert.equal(graph.groups[0].label, '고객');
  assert.deepEqual(typedValuesFor(extraction.entities[0], definition), { customerId: 'C-12', name: 'Alice', active: true });
  assert.deepEqual(typedValuesFor(extraction.entities[1], definition), { orderId: 'O-8', amount: 125.5, orderedOn: '2026-10-10' });
  assert.equal(graph.nodes[1].properties.amount, '125.5');
  assert.match(JSON.stringify(extractionSchemaFor(definition)), /Customer/); assert.doesNotMatch(JSON.stringify(extractionSchemaFor(definition)), /vessel/);
});

test('schema rejects unknown references, duplicate names, invalid cardinalities and unsafe capabilities', () => {
  const raw = definitionInput();
  assert.throws(() => parseOntologyDefinition({ ...raw, rid: 'foundry-fake' }), /정의되지/);
  assert.throws(() => parseOntologyDefinition({ ...raw, objectTypes: [raw.objectTypes[0], raw.objectTypes[0]] }), /중복/);
  assert.throws(() => parseOntologyDefinition({ ...raw, linkTypes: [{ ...raw.linkTypes[0], targetType: 'Missing' }] }), /존재하지/);
  assert.throws(() => parseOntologyDefinition({ ...raw, linkTypes: [{ ...raw.linkTypes[0], targetCardinality: 'two' }] }), /허용 값/);
  assert.throws(() => parseOntologyDefinition({ ...raw, actionTypes: [{ apiName: 'deleteOrders', executable: true }] }), /실행 가능한/);
  assert.throws(() => parseOntologyDefinition({ ...raw, functions: [{ apiName: 'run', status: 'active' }] }), /draft/);
  const planned = parseOntologyDefinition({ ...raw, actionTypes: [{ apiName: 'reassignOrder', objectTypes: ['Order'] }] });
  assert.equal(planned.actionTypes[0].executable, false); assert.equal(planned.actionTypes[0].status, 'draft');
});

test('advisory Jev decision rules work independently of the final Codex extractor and preserve legacy definitions', () => {
  const raw = definitionInput();
  assert.deepEqual(parseOntologyDefinition(raw).processing.decisionRules, []);
  const mapping = { sourceName: 'orders.csv', format: 'csv', objectType: 'Order', columns: [{ column: 'orderId', property: 'orderId' }], identityColumns: ['orderId'], semanticColumns: ['note'] };
  const rule = { apiName: 'noteForm', displayName: '메모 유형', purpose: 'classification', sourceName: 'orders.csv', columns: ['note'], question: '이 메모의 서술 유형은 무엇인가?', choices: [{ apiName: 'directReport', description: '직접 보고한 서술' }, { apiName: 'uncertain', description: '불확실하거나 분류할 근거가 부족함' }] };
  const definition = parseOntologyDefinition({ ...raw, sourceMappings: [mapping], processing: { textStrategy: 'codex', jevEligibleLinkTypes: [], decisionRules: [rule] } });
  assert.equal(definition.processing.textStrategy, 'codex');
  assert.deepEqual(definition.processing.jevEligibleLinkTypes, []);
  assert.deepEqual(definition.processing.decisionRules, [rule]);
  assert.deepEqual(parseOntologyDefinition(definition).processing.decisionRules, [rule]);
  const withRules = (rules: unknown[]) => ({ ...raw, sourceMappings: [mapping], processing: { decisionRules: rules } });
  assert.throws(() => parseOntologyDefinition(withRules([{ ...rule, sourceName: 'unseen.csv' }])), /의미 분석 컬럼/);
  assert.throws(() => parseOntologyDefinition(withRules([{ ...rule, columns: ['orderId'] }])), /의미 분석 컬럼/);
  assert.throws(() => parseOntologyDefinition(withRules([{ ...rule, columns: [] }])), /배열/);
  assert.throws(() => parseOntologyDefinition(withRules([{ ...rule, columns: ['note', 'note'] }])), /중복/);
  assert.throws(() => parseOntologyDefinition(withRules([{ ...rule, choices: [{ apiName: 'directReport', description: '직접 서술' }, { apiName: 'quotedReport', description: '재인용' }] }])), /uncertain/);
  assert.throws(() => parseOntologyDefinition(withRules([{ ...rule, choices: [rule.choices[1], rule.choices[1]] }])), /중복/);
  assert.throws(() => parseOntologyDefinition(withRules([rule, rule])), /중복/);
  assert.throws(() => parseOntologyDefinition(withRules(Array.from({ length: 9 }, (_, index) => ({ ...rule, apiName: `rule${index}` })))), /배열/);
  assert.throws(() => parseOntologyDefinition(withRules([{ ...rule, purpose: 'discard' }])), /허용 값/);
  assert.throws(() => parseOntologyDefinition(withRules([{ ...rule, script: 'return true;' }])), /정의되지/);
  assert.throws(() => parseOntologyDefinition(withRules([{ ...rule, choices: [{ ...rule.choices[0], createLink: 'placed' }, rule.choices[1]] }])), /정의되지/);
});

test('dynamic extraction enforces properties, endpoint types, required values and exact provenance', () => {
  const definition = parseOntologyDefinition(definitionInput());
  const { input, extraction } = sample();
  const unknown = structuredClone(extraction); unknown.entities[0].properties.push({ key: 'imo', value: '1234567' });
  assert.throws(() => parseExtraction(unknown, input, definition), /등록되지 않은 온톨로지/);
  const wrongType = structuredClone(extraction); wrongType.entities[0].properties[2].value = '"true"';
  assert.throws(() => parseExtraction(wrongType, input, definition), /boolean/);
  const absent = structuredClone(extraction); absent.entities[0].properties = absent.entities[0].properties.filter(p => p.key !== 'customerId');
  assert.throws(() => parseExtraction(absent, input, definition), /필수 속성/);
  const reversed = structuredClone(extraction); reversed.relationships[0].source = 'order8'; reversed.relationships[0].target = 'alice';
  assert.throws(() => parseExtraction(reversed, input, definition), /출발·대상/);
  const invented = structuredClone(extraction); invented.entities[0].evidence = [{ documentId: 'orders', quote: 'Alice is not in the provided document.' }];
  assert.throws(() => parseExtraction(invented, input, definition), /인용문/);
});

test('value constraints reject impossible dates, negative amounts and duplicate primary keys', () => {
  const definition = parseOntologyDefinition(definitionInput()); const { input, extraction } = sample();
  const invalidDate = structuredClone(extraction); invalidDate.entities[1].properties[2].value = '2026-02-30';
  assert.throws(() => parseExtraction(invalidDate, input, definition), /존재하지 않는 날짜/);
  const invalidAmount = structuredClone(extraction); invalidAmount.entities[1].properties[1].value = '-1';
  assert.throws(() => parseExtraction(invalidAmount, input, definition), /허용 범위/);
  const duplicate = structuredClone(extraction); duplicate.entities.push({ ...structuredClone(duplicate.entities[0]), id: 'anotherAlice' });
  assert.throws(() => parseExtraction(duplicate, input, definition), /Primary Key/);
});

test('one source per order cardinality catches conflicting customers but allows multiple orders', () => {
  const definition = parseOntologyDefinition(definitionInput()); const { input, extraction } = sample();
  input.documents[0].text += ' Additional customer C-13 and order O-9 are documented.';
  extraction.entities[0].evidence[0].quote = input.documents[0].text;
  const another = structuredClone(extraction.entities[0]); another.id = 'bob'; another.label = 'Bob'; another.properties[0].value = 'C-13'; extraction.entities.push(another);
  extraction.relationships.push({ ...extraction.relationships[0], id: 'placedOther', source: 'bob' });
  assert.throws(() => parseExtraction(extraction, input, definition), /Cardinality/);
  extraction.relationships.pop(); const order = structuredClone(extraction.entities[1]); order.id = 'order9'; order.properties[0].value = 'O-9'; extraction.entities.push(order);
  extraction.relationships.push({ ...extraction.relationships[0], id: 'placed9', target: 'order9' });
  assert.equal(parseExtraction(extraction, input, definition).relationships.length, 2);
});

test('interfaces, shared properties, groups and value types validate contracts', () => {
  const raw = definitionInput();
  const definition = parseOntologyDefinition({ ...raw,
    sharedProperties: [{ apiName: 'sharedName', baseType: 'string', constraints: { maxLength: 40 } }],
    interfaces: [{ apiName: 'Named', properties: [{ apiName: 'name', baseType: 'string', required: true }] }],
    valueTypes: [{ apiName: 'CustomerCode', baseType: 'string', constraints: { pattern: '^C-[0-9]+$' } }],
    groups: [{ apiName: 'Commerce', displayName: '상거래' }],
    objectTypes: [{ ...raw.objectTypes[0], groups: ['Commerce'], implementsInterfaces: ['Named'], properties: raw.objectTypes[0].properties.map(p => p.apiName === 'name' ? { ...p, sharedProperty: 'sharedName' } : p.apiName === 'customerId' ? { ...p, valueType: 'CustomerCode' } : p) }, raw.objectTypes[1]],
  });
  const { extraction } = sample(); assert.equal(typedValuesFor(extraction.entities[0], definition).name, 'Alice');
  extraction.entities[0].properties[0].value = 'BAD'; assert.throws(() => typedValuesFor(extraction.entities[0], definition), /패턴/);
  assert.throws(() => parseOntologyDefinition({ ...raw, interfaces: [{ apiName: 'A', extendsInterfaces: ['B'] }, { apiName: 'B', extendsInterfaces: ['A'] }] }), /상속 순환/);
  assert.throws(() => parseOntologyDefinition({ ...raw, interfaces: [{ apiName: 'Named', properties: [{ apiName: 'name', baseType: 'integer' }] }], objectTypes: [{ ...raw.objectTypes[0], implementsInterfaces: ['Named'] }, raw.objectTypes[1]] }), /Property 계약/);
});

test('all 22 base types are explicit; exact decimal and long values never become lossy JS numbers', () => {
  assert.equal(PROPERTY_BASE_TYPES.length, 22);
  const raw = definitionInput(); const definition = parseOntologyDefinition({ ...raw, objectTypes: [{ ...raw.objectTypes[0], properties: [...raw.objectTypes[0].properties, { apiName: 'balance', baseType: 'decimal' }, { apiName: 'largeId', baseType: 'long' }, { apiName: 'coords', baseType: 'geopoint' }, { apiName: 'labels', baseType: 'array', elementType: 'string', constraints: { uniqueItems: true } }] }, raw.objectTypes[1]] });
  const { extraction } = sample(); const entity = extraction.entities[0];
  entity.properties.push({ key: 'balance', value: '999999999999999999.000001' }, { key: 'largeId', value: '9223372036854775807' }, { key: 'coords', value: '{"latitude":37.5,"longitude":127}' }, { key: 'labels', value: '["new","active"]' });
  const values = typedValuesFor(entity, definition); assert.equal(values.balance, '999999999999999999.000001'); assert.equal(values.largeId, '9223372036854775807'); assert.deepEqual(values.coords, { latitude: 37.5, longitude: 127 });
  entity.properties.at(-1)!.value = '["same","same"]'; assert.throws(() => typedValuesFor(entity, definition), /중복/);
  entity.properties.pop(); entity.properties.at(-1)!.value = '{"latitude":200,"longitude":127}'; assert.throws(() => typedValuesFor(entity, definition), /경위도|latitude/);
});

test('struct fields validate recursively; reference types do not claim encryption or series execution', () => {
  const raw = definitionInput(); const definition = parseOntologyDefinition({ ...raw, objectTypes: [{ ...raw.objectTypes[0], properties: [...raw.objectTypes[0].properties,
    { apiName: 'address', baseType: 'struct', fields: [{ apiName: 'city', baseType: 'string', required: true }, { apiName: 'postalCode', baseType: 'string' }] }, { apiName: 'attachmentRef', baseType: 'attachment' },
  ] }, raw.objectTypes[1]] });
  const { extraction } = sample(); const entity = extraction.entities[0]; entity.properties.push({ key: 'address', value: '{"city":"Seoul","postalCode":"01234"}' }, { key: 'attachmentRef', value: '{"reference":"file-123"}' });
  assert.deepEqual(typedValuesFor(entity, definition).attachmentRef, { reference: 'file-123' });
  entity.properties.at(-2)!.value = '{"postalCode":"01234"}'; assert.throws(() => typedValuesFor(entity, definition), /필수 속성/);
  assert.throws(() => parseOntologyDefinition({ ...raw, objectTypes: [{ ...raw.objectTypes[0], properties: [...raw.objectTypes[0].properties, { apiName: 'nested', baseType: 'struct', fields: [{ apiName: 'children', baseType: 'array', elementType: 'string' }] }] }, raw.objectTypes[1]] }), /중첩/);
});

test('Jev eligibility and structured mappings can refer only to existing schema resources', () => {
  const raw = definitionInput();
  const planned = parseOntologyDefinition({ ...raw, processing: { textStrategy: 'jev-assisted', jevEligibleLinkTypes: ['placed'], rationale: '명시적 주문 관계만 분류' }, sourceMappings: [{ sourceName: 'orders.csv', format: 'csv', objectType: 'Order', columns: [{ column: 'Order ID', property: 'orderId' }], identityColumns: ['Order ID'] }] });
  assert.equal(planned.sourceMappings[0].objectType, 'Order');
  assert.throws(() => parseOntologyDefinition({ ...raw, processing: { textStrategy: 'jev-assisted', jevEligibleLinkTypes: ['unknown'] } }), /Jev/);
  assert.throws(() => parseOntologyDefinition({ ...raw, sourceMappings: [{ sourceName: 'orders.csv', format: 'csv', objectType: 'Order', columns: [{ column: 'x', property: 'unknown' }] }] }), /매핑 대상 속성/);
});

test('structured mappings permit server generated identity and distinguish semantic columns from literal identity columns', () => {
  const type = { apiName: 'Record', primaryKey: 'recordId', titleProperty: 'recordId', properties: [
    { apiName: 'recordId', baseType: 'string', valueSource: 'evidenceId' },
    { apiName: 'amount', baseType: 'double' },
  ] };
  const mapping = { sourceName: 'records.csv', format: 'csv', objectType: 'Record', columns: [{ column: 'amount', property: 'amount' }], identityColumns: [], semanticColumns: ['description'] };
  const raw = { apiName: 'Records', displayName: '기록', objectTypes: [type], sourceMappings: [mapping] };
  const definition = parseOntologyDefinition(raw);
  assert.deepEqual(definition.sourceMappings[0].identityColumns, []);
  assert.deepEqual(definition.sourceMappings[0].semanticColumns, ['description']);
  assert.throws(() => parseOntologyDefinition({ ...raw, sourceMappings: [{ ...mapping, semanticColumns: ['description', 'description'] }] }), /중복 의미 분석/);
  const literal = { ...type, properties: type.properties.map(property => property.apiName === 'recordId' ? { ...property, valueSource: 'evidence' } : property) };
  assert.throws(() => parseOntologyDefinition({ ...raw, objectTypes: [literal] }), /Primary Key/);
  const explicit = parseOntologyDefinition({ ...raw, objectTypes: [literal], sourceMappings: [{ ...mapping, columns: [{ column: 'id', property: 'recordId' }, ...mapping.columns], identityColumns: ['id'] }] });
  assert.equal(explicit.sourceMappings[0].columns[0].property, 'recordId');
});

test('closed planning schema stays below CLI limit and permits prompt-only domain definitions', () => {
  assert.ok(Buffer.byteLength(JSON.stringify(ontologyDefinitionSchema)) < 200_000);
  const definition = parseOntologyDefinition({ ...definitionInput(), sourceMappings: [] });
  assert.deepEqual(definition.sourceMappings, []);
  assert.throws(() => parseOntologyDefinition({ ...definitionInput(), version: 1.5 }), /양의 정수/);
  assert.throws(() => parseOntologyDefinition({ ...definitionInput(), valueTypes: [{ apiName: 'Bad', baseType: 'string', constraints: { pattern: '(a+)+$' } }] }), /정규식/);
});


test('primary and title properties are mandatory even when planner marks them optional', () => {
  const raw = definitionInput(); raw.objectTypes[0].properties.forEach(property => { property.required = false; });
  const definition = parseOntologyDefinition(raw);
  assert.equal(definition.objectTypes[0].properties.find(p => p.apiName === 'customerId')!.required, true);
  assert.equal(definition.objectTypes[0].properties.find(p => p.apiName === 'name')!.required, true);
  const { input, extraction } = sample();
  const missingPrimary = structuredClone(extraction); missingPrimary.entities[0].properties = missingPrimary.entities[0].properties.filter(p => p.key !== 'customerId');
  assert.throws(() => parseExtraction(missingPrimary, input, definition), /필수 속성/);
  const missingTitle = structuredClone(extraction); missingTitle.entities[0].properties = missingTitle.entities[0].properties.filter(p => p.key !== 'name');
  assert.throws(() => parseExtraction(missingTitle, input, definition), /필수 속성/);
  const blank = structuredClone(extraction); blank.entities[0].properties[0].value = '   ';
  assert.throws(() => parseExtraction(blank, input, definition), /비어 있을/);
});


test('name keys default to source scope; declared stable identifiers can use ontology scope', () => {
  const definition = parseOntologyDefinition({ apiName: 'People', displayName: '사람', objectTypes: [{ apiName: 'Person', primaryKey: 'name', titleProperty: 'name', properties: [{ apiName: 'name', baseType: 'string' }] }] });
  assert.equal(definition.objectTypes[0].identityScope, 'source');
  assert.equal(parseOntologyDefinition(definitionInput()).objectTypes[0].identityScope, 'ontology');
});

test('invented and partial primary keys fail while CSV and JSON escaped anchors remain grounded', () => {
  const definition = parseOntologyDefinition(definitionInput()); const { input, extraction } = sample();
  extraction.entities[0].properties[0].value = 'C-99';
  assert.throws(() => parseExtraction(extraction, input, definition), /Primary Key 값이 인용/);
  extraction.entities[0].properties[0].value = 'C-1';
  assert.throws(() => parseExtraction(extraction, input, definition), /Primary Key 값이 인용/);
  const escaped = parseOntologyDefinition({ apiName: 'People', displayName: '사람', objectTypes: [{ apiName: 'Person', primaryKey: 'name', titleProperty: 'name', properties: [{ apiName: 'name', baseType: 'string' }] }] });
  for (const [value, text] of [['Alice', '{"name":"\\u0041lice"}'], ['A"B', 'name,active\n"A""B",true'], ['A"B', '{"name":"A\\"B"}']]) {
    const source = { question: '사람 추출', documents: [{ id: 'people', name: 'data', text }] };
    const out: OntologyExtraction = { title: '사람', summary: '원문 이름', entities: [{ id: 'person', type: 'Person', label: value, description: '', identifiers: [], properties: [{ key: 'name', value }], evidence: [{ documentId: 'people', quote: text }] }], relationships: [], events: [], findings: [], limitations: [] };
    assert.equal(parseExtraction(out, source, escaped).entities.length, 1);
  }
});


test('source-scoped primary keys may repeat in unrelated documents but not the same source family', () => {
  const definition = parseOntologyDefinition({ apiName: 'People', displayName: '사람', objectTypes: [{ apiName: 'Person', primaryKey: 'name', titleProperty: 'name', properties: [{ apiName: 'name', baseType: 'string' }] }] });
  const input: GraphGenerationInput = { question: '모든 사람', documents: [{ id: 'a', name: 'A', text: 'Alice works here.' }, { id: 'b', name: 'B', text: 'Alice studies there.' }] };
  const extraction: OntologyExtraction = { title: '사람', summary: '다른 출처의 이름', entities: input.documents.map(document => ({ id: `person-${document.id}`, label: 'Alice', type: 'Person', description: '', identifiers: [], properties: [{ key: 'name', value: 'Alice' }], evidence: [{ documentId: document.id, quote: document.text }] })), relationships: [], events: [], findings: [], limitations: [] };
  assert.equal(parseExtraction(extraction, input, definition).entities.length, 2);
  input.documents.forEach(document => { document.identityScope = 'same-upload'; });
  assert.throws(() => parseExtraction(extraction, input, definition), /중복 Primary Key/);
});

function metadataSample(valueSource: 'documentId' | 'evidenceId' = 'documentId') {
  const definition = parseOntologyDefinition({ apiName: 'Reports', displayName: '자료 근거', objectTypes: [{
    apiName: 'Report', primaryKey: 'documentId', titleProperty: 'fileName', properties: [
      { apiName: 'documentId', baseType: 'string', valueSource },
      { apiName: 'fileName', baseType: 'string', valueSource: 'documentName' },
    ],
  }] });
  const input: GraphGenerationInput = { question: '자료의 근거를 정리해줘', documents: [{ id: 'source-1', name: 'report.txt', text: 'Alice recorded an observation about the shipment.' }] };
  const extraction: OntologyExtraction = { title: '자료', summary: '제공된 자료', entities: [{ id: 'report-source-1', label: 'report.txt', type: 'Report', description: '', identifiers: [], properties: [], evidence: [{ documentId: 'source-1', quote: input.documents[0].text }] }], relationships: [], events: [], findings: [], limitations: [] };
  return { definition, input, extraction };
}

test('declared document metadata is populated from validated sources while business document IDs remain quoted facts', () => {
  const { definition, input, extraction } = metadataSample();
  const parsed = parseExtraction(extraction, input, definition);
  assert.deepEqual(parsed.entities[0].properties, [{ key: 'documentId', value: 'source-1' }, { key: 'fileName', value: 'report.txt' }]);
  assert.equal(extraction.entities[0].properties.length, 0, 'normalization must not mutate caller input');
  assert.equal(compileExtraction(extraction, input, definition).nodes[0].properties.documentId, 'source-1');
  const forged = structuredClone(parsed); forged.entities[0].properties[0].value = 'fictional-document';
  assert.throws(() => parseExtraction(forged, input, definition), /메타데이터 값이 검증된 출처와 일치/);
  forged.entities[0].properties[0].value = 'source-1'; forged.entities[0].properties[1].value = 'another-file.txt';
  assert.throws(() => parseExtraction(forged, input, definition), /메타데이터 값이 검증된 출처와 일치/);
  const business = structuredClone(definition); business.objectTypes[0].properties[0].valueSource = 'evidence';
  assert.throws(() => parseExtraction(parsed, input, business), /Primary Key 값이 인용/);
  const absentQuote = structuredClone(extraction); absentQuote.entities[0].evidence[0].quote = 'A fabricated source statement.';
  assert.throws(() => parseExtraction(absentQuote, input, definition), /인용문/);
});

test('metadata sources must be explicit String properties and cannot override original source columns', () => {
  const { definition, input, extraction } = metadataSample();
  const wrongType = structuredClone(definition); wrongType.objectTypes[0].properties[0].baseType = 'integer';
  assert.throws(() => parseOntologyDefinition(wrongType), /최상위 String/);
  const mapped = structuredClone(definition); mapped.sourceMappings = [{ sourceName: 'reports.csv', format: 'csv', objectType: 'Report', columns: [{ column: 'doc_id', property: 'documentId' }], identityColumns: ['doc_id'], relations: [] }];
  assert.throws(() => parseOntologyDefinition(mapped), /메타데이터 속성을 원문 컬럼에 매핑/);
  const another = { id: 'source-2', name: 'other.txt', text: 'A different source records another observation.' };
  input.documents.push(another); extraction.entities[0].evidence.push({ documentId: another.id, quote: another.text });
  assert.throws(() => parseExtraction(extraction, input, definition), /하나의 명확한 출처/);
});

test('server evidence IDs are deterministic scoped keys and fabricated extraction IDs cannot substitute for them', () => {
  const { definition, input, extraction } = metadataSample('evidenceId');
  const first = parseExtraction(extraction, input, definition);
  const firstId = first.entities[0].properties.find(property => property.key === 'documentId')!.value;
  assert.match(firstId, /^evidence-[a-f0-9]{32}$/);
  assert.deepEqual(parseExtraction(extraction, input, definition), first);
  const forged = structuredClone(first); forged.entities[0].properties[0].value = 'claim-1';
  assert.throws(() => parseExtraction(forged, input, definition), /메타데이터/);
  const altered = structuredClone(extraction); altered.entities[0].evidence[0].quote = 'an observation about the shipment.';
  assert.notEqual(parseExtraction(altered, input, definition).entities[0].properties[0].value, firstId);
});

test('cached metadata rebinding validates old values, then recalculates IDs and source titles for original documents', () => {
  for (const source of ['documentId', 'evidenceId'] as const) {
    const { definition, input, extraction } = metadataSample(source);
    definition.objectTypes[0].titleProperty = 'documentId';
    const canonical = parseExtraction(extraction, input, definition);
    const oldPrimary = canonical.entities[0].properties[0].value; canonical.entities[0].label = oldPrimary;
    const actual: GraphGenerationInput = { ...input, documents: [{ ...input.documents[0], id: 'upload-123-part-1', identityScope: 'upload-123', name: 'actual-report.txt' }] };
    const rebound = rebindExtractionSources(canonical, input, actual, definition);
    const primary = rebound.entities[0].properties[0].value;
    assert.notEqual(primary, oldPrimary); assert.equal(rebound.entities[0].label, primary);
    assert.equal(rebound.entities[0].properties[1].value, 'actual-report.txt');
    assert.equal(rebound.entities[0].evidence[0].documentId, actual.documents[0].id);
    assert.equal(rebound.entities[0].id, canonical.entities[0].id, 'local relation references stay stable');
    if (source === 'documentId') assert.equal(primary, actual.documents[0].id);
    if (source === 'evidenceId') {
      const sameUpload = { ...actual, documents: [{ ...actual.documents[0], id: 'upload-123-part-2' }] };
      assert.equal(rebindExtractionSources(canonical, input, sameUpload, definition).entities[0].properties[0].value, primary);
      const otherUpload = { ...actual, documents: [{ ...actual.documents[0], id: 'upload-456-part-1', identityScope: 'upload-456' }] };
      assert.notEqual(rebindExtractionSources(canonical, input, otherUpload, definition).entities[0].properties[0].value, primary);
    }
    const forged = structuredClone(canonical); forged.entities[0].properties[0].value = 'forged';
    assert.throws(() => rebindExtractionSources(forged, input, actual, definition), /메타데이터/);
    assert.throws(() => rebindExtractionSources(canonical, input, { ...actual, documents: [{ ...actual.documents[0], text: 'Different evidence text.' }] }, definition), /다른 원문/);
  }
});
