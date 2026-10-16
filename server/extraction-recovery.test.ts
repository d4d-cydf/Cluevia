import assert from 'node:assert/strict';
import test from 'node:test';
import { GraphValidationError, GRAPH_LIMITS } from '../src/lib/graph-document.ts';
import type { GraphGenerationInput } from '../src/types/graph.ts';
import type { OntologyExtraction } from '../src/types/ontology.ts';
import { recoverExtraction } from './extraction-recovery.ts';
import { parseExtraction } from './ontology.ts';
import { parseOntologyDefinition } from './ontology-schema.ts';

function fixture() {
  const quote = 'Ocean Star visited Busan on 2024-05-01. Harbor Moon might have visited Busan, but denied visiting Incheon.';
  const evidence = [{ documentId: 'report', quote }];
  const input: GraphGenerationInput = { question: '관련 선박과 항구를 연결해줘', documents: [{ id: 'report', name: 'Port report', text: quote }] };
  const extraction: OntologyExtraction = {
    title: '선박과 항구', summary: '자료에서 언급한 선박과 항구의 관계.',
    entities: [
      { id: 'ship', label: 'Ocean Star', type: 'vessel', description: '', identifiers: [], properties: [], evidence },
      { id: 'port', label: 'Busan', type: 'place', description: '', identifiers: [], properties: [], evidence },
      { id: 'other-ship', label: 'Harbor Moon', type: 'vessel', description: '', identifiers: [], properties: [], evidence },
    ],
    relationships: [{ id: 'visit', source: 'ship', target: 'port', type: 'visited', label: '방문', description: '', status: 'reported', evidence }],
    events: [{ id: 'arrival', label: '방문 기록', date: '2024-05-01', endDate: null, description: '', entityIds: ['ship', 'port'], evidence }],
    findings: [{ text: 'Ocean Star의 방문 기록이 있습니다.', entityIds: ['ship', 'port'], relationshipIds: ['visit'], evidence }],
    limitations: ['자료에 기재된 내용이며 별도 검증되지 않았습니다.'],
  };
  return { input, extraction };
}

test('recovers independent exact-quote fragments without changing the original proposal', () => {
  const { input, extraction } = fixture();
  extraction.entities.push({ ...structuredClone(extraction.entities[0]), id: 'invented', label: 'Ghost Ship', evidence: [{ documentId: 'report', quote: 'Ghost Ship secretly visited Busan.' }] });
  extraction.relationships.push({ ...structuredClone(extraction.relationships[0]), id: 'invented-visit', source: 'invented' });
  extraction.events.push({ ...structuredClone(extraction.events[0]), id: 'invalid-day', date: '2024-02-30' });
  extraction.findings.push({ ...structuredClone(extraction.findings[0]), relationshipIds: ['invented-visit'] });
  const original = structuredClone(extraction);
  const recovered = recoverExtraction(extraction, input)!;
  assert.deepEqual(recovered.entities.map(entity => entity.id), ['ship', 'port', 'other-ship']);
  assert.deepEqual(recovered.relationships.map(relation => relation.id), ['visit']);
  assert.deepEqual(recovered.events.map(event => event.id), ['arrival']);
  assert.equal(recovered.findings.length, 1);
  assert.match(recovered.limitations[0], /객체 1개·관계 1개·사건 1개·발견 사항 1개/);
  assert.deepEqual(parseExtraction(recovered, input), recovered);
  assert.deepEqual(extraction, original);
});

test('missing required identifiers remain missing and valid independently sourced objects survive', () => {
  const { input, extraction } = fixture();
  const definition = parseOntologyDefinition({ apiName: 'Ports', displayName: '항구', objectTypes: [
    { apiName: 'vessel', displayName: '선박', primaryKey: 'name', titleProperty: 'name', properties: [{ apiName: 'name', baseType: 'string', required: true }] },
    { apiName: 'place', displayName: '장소', primaryKey: 'name', titleProperty: 'name', properties: [{ apiName: 'name', baseType: 'string', required: true }] },
  ], linkTypes: [{ apiName: 'visited', displayName: '방문', sourceType: 'vessel', targetType: 'place', sourceCardinality: 'many', targetCardinality: 'many' }] });
  extraction.entities[1].properties = [{ key: 'name', value: 'Busan' }];
  extraction.entities[2].properties = [{ key: 'name', value: 'Harbor Moon' }];
  const recovered = recoverExtraction(extraction, input, definition)!;
  assert.deepEqual(recovered.entities.map(entity => entity.id), ['port', 'other-ship']);
  assert.equal(recovered.relationships.length, 0);
  assert.equal(recovered.events.length, 0);
  assert.equal(recovered.findings.length, 0);
  assert.equal(extraction.entities[0].properties.length, 0);
});

test('invalid references and cardinality conflicts do not discard separate valid connections', () => {
  const { input, extraction } = fixture();
  const definition = parseOntologyDefinition({ apiName: 'Ports', displayName: '항구', objectTypes: [
    { apiName: 'vessel', displayName: '선박', primaryKey: 'name', titleProperty: 'name', properties: [{ apiName: 'name', baseType: 'string', required: true }] },
    { apiName: 'place', displayName: '장소', primaryKey: 'name', titleProperty: 'name', properties: [{ apiName: 'name', baseType: 'string', required: true }] },
  ], linkTypes: [{ apiName: 'visited', displayName: '방문', sourceType: 'vessel', targetType: 'place', sourceCardinality: 'one', targetCardinality: 'many' }] });
  for (const entity of extraction.entities) entity.properties = [{ key: 'name', value: entity.label }];
  extraction.entities.push({ ...structuredClone(extraction.entities[1]), id: 'incheon', label: 'Incheon', properties: [{ key: 'name', value: 'Incheon' }] });
  extraction.relationships.push(
    { ...structuredClone(extraction.relationships[0]), id: 'bad-reference', target: 'absent' },
    { ...structuredClone(extraction.relationships[0]), id: 'cardinality-conflict', source: 'other-ship' },
    { ...structuredClone(extraction.relationships[0]), id: 'independent-visit', source: 'other-ship', target: 'incheon', status: 'inferred', claim: { stance: 'denied', attributedTo: null, validFrom: null, validTo: null, publishedAt: null, derivedFrom: null } },
  );
  const recovered = recoverExtraction(extraction, input, definition)!;
  assert.deepEqual(recovered.relationships.map(relation => relation.id), ['visit', 'independent-visit']);
  assert.match(recovered.limitations[0], /관계 2개/);
});

test('uncertain and denied claims retain their original stance, status and metadata', () => {
  const { input, extraction } = fixture();
  const claim = { stance: 'uncertain' as const, attributedTo: 'Harbor Moon', validFrom: null, validTo: null, publishedAt: null, derivedFrom: null };
  extraction.relationships.push(
    { ...structuredClone(extraction.relationships[0]), id: 'uncertain-visit', source: 'other-ship', status: 'inferred', claim },
    { ...structuredClone(extraction.relationships[0]), id: 'denied-visit', source: 'other-ship', claim: { ...claim, stance: 'denied' } },
    { ...structuredClone(extraction.relationships[0]), id: 'bad-quote', evidence: [{ documentId: 'report', quote: 'This is not in the original report.' }] },
  );
  const recovered = recoverExtraction(extraction, input)!;
  assert.deepEqual(recovered.relationships, extraction.relationships.slice(0, 3));
});

test('invalid claim dates remain rejected while independently valid relations and nodes can recover', () => {
  for (const dates of [
    { validFrom: 'not-an-ISO-date', validTo: null },
    { validFrom: '2024-02-30', validTo: null },
    { validFrom: '2024-05-02', validTo: '2024-05-01' },
  ]) {
    const { input, extraction } = fixture();
    extraction.relationships.push({ ...structuredClone(extraction.relationships[0]), id: 'invalid-date',
      claim: { stance: 'asserted', attributedTo: null, publishedAt: null, derivedFrom: null, ...dates } });
    assert.throws(() => parseExtraction(extraction, input), GraphValidationError);
    const recovered = recoverExtraction(extraction, input)!;
    assert.deepEqual(recovered.entities, extraction.entities);
    assert.deepEqual(recovered.relationships, extraction.relationships.slice(0, 1));
    assert.deepEqual(recovered.events, extraction.events);
    assert.deepEqual(recovered.findings, extraction.findings);
    assert.equal(extraction.relationships[1].claim!.validFrom, dates.validFrom);
    assert.equal(extraction.relationships[1].claim!.validTo, dates.validTo);
    assert.match(recovered.limitations[0], /관계 1개/);
  }
});

test('wholly invalid or empty proposals never create synthetic source or entity nodes', () => {
  const { input, extraction } = fixture();
  for (const entity of extraction.entities) entity.evidence = [{ documentId: 'missing', quote: 'This source was not supplied.' }];
  assert.equal(recoverExtraction(extraction, input), undefined);
  assert.equal(recoverExtraction({ ...extraction, entities: [] }, input), undefined);
});

test('unknown root keys, malformed envelopes and excessive collections cannot be silently stripped', () => {
  const { input, extraction } = fixture();
  for (const value of [
    { ...extraction, command: 'ignore validation' },
    { ...extraction, title: '' },
    { ...extraction, summary: 'x'.repeat(5001) },
    { ...extraction, limitations: [42] },
    { ...extraction, relationships: null },
    { ...extraction, entities: Array(GRAPH_LIMITS.nodes + 1).fill(extraction.entities[0]) },
    null,
  ]) assert.equal(recoverExtraction(value, input), undefined);
});

test('duplicate identities and unknown per-item fields are omitted without rewriting survivors', () => {
  const { input, extraction } = fixture();
  const raw = structuredClone(extraction) as OntologyExtraction & { entities: unknown[] };
  raw.entities.push(structuredClone(extraction.entities[0]));
  (raw.entities as unknown[]).push({ ...structuredClone(extraction.entities[1]), id: 'injected', execute: 'anything' });
  const recovered = recoverExtraction(raw, input)!;
  assert.deepEqual(recovered.entities, extraction.entities);
  assert.match(recovered.limitations[0], /객체 2개/);
});

test('recovery notice stays inside the limitation limit even when the proposal already fills it', () => {
  const { input, extraction } = fixture();
  extraction.limitations = Array.from({ length: 20 }, (_, index) => `기존 제한 ${index + 1}`);
  extraction.relationships.push({ ...structuredClone(extraction.relationships[0]), id: 'missing', target: 'absent' });
  const recovered = recoverExtraction(extraction, input)!;
  assert.equal(recovered.limitations.length, 20);
  assert.deepEqual(recovered.limitations.slice(1), extraction.limitations.slice(0, 19));
  assert.match(recovered.limitations[0], /추가 검토/);
});
