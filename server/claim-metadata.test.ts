import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphGenerationInput } from '../src/types/graph.ts';
import type { OntologyExtraction } from '../src/types/ontology.ts';
import { normalizeClaimMetadata } from './claim-metadata.ts';
import { parseExtraction } from './ontology.ts';

function fixture() {
  const quote = 'Harbor Office stated that Ocean Star visited Busan on 2024-05-01.';
  const evidence = [{ documentId: 'report', quote }];
  const input: GraphGenerationInput = { question: '선박 방문 관계', documents: [{ id: 'report', name: 'Shipping Times', text: `${quote}\nOther Author appears elsewhere.` }] };
  const extraction: OntologyExtraction = {
    title: '선박 방문 관계', summary: '원문에 보고된 선박 방문 관계.',
    entities: [
      { id: 'ship', label: 'Ocean Star', type: 'vessel', description: '', identifiers: [], properties: [], evidence },
      { id: 'port', label: 'Busan', type: 'place', description: '', identifiers: [], properties: [], evidence },
    ], relationships: [{ id: 'visit', source: 'ship', target: 'port', type: 'visited', label: '방문', description: '', status: 'reported', evidence,
      claim: { stance: 'asserted', attributedTo: 'Shipping Times', derivedFrom: 'Other Author', validFrom: null, validTo: null, publishedAt: null } }],
    events: [], findings: [], limitations: ['단일 자료의 보고입니다.'],
  };
  return { input, extraction };
}

test('omits unsupported optional attribution without dropping a grounded relationship or mutating the proposal', () => {
  const { input, extraction } = fixture();
  const original = structuredClone(extraction);
  assert.throws(() => parseExtraction(extraction, input), /인용문/);
  const result = normalizeClaimMetadata(extraction, input);
  const parsed = parseExtraction(result.value, input);
  assert.equal(result.changed, true);
  assert.equal(parsed.relationships.length, 1);
  assert.equal(parsed.relationships[0].claim!.attributedTo, null);
  assert.equal(parsed.relationships[0].claim!.derivedFrom, null);
  assert.deepEqual(parsed.relationships[0].evidence, original.relationships[0].evidence);
  assert.match(parsed.limitations[0], /출처 2개/);
  assert.deepEqual(extraction, original);
});

test('valid literal attribution preserves the original reference and exact identifier boundaries', () => {
  const { input, extraction } = fixture();
  extraction.relationships[0].claim!.attributedTo = 'Harbor Office';
  extraction.relationships[0].claim!.derivedFrom = null;
  const unchanged = normalizeClaimMetadata(extraction, input);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.value, extraction);
  extraction.relationships[0].claim!.attributedTo = 'Harbor Off';
  const normalized = parseExtraction(normalizeClaimMetadata(extraction, input).value, input);
  assert.equal(normalized.relationships[0].claim!.attributedTo, null);
});

test('denied and uncertain relations keep their stance and reported/inferred status', () => {
  for (const stance of ['denied', 'uncertain'] as const) {
    const { input, extraction } = fixture();
    extraction.relationships[0].claim!.stance = stance;
    extraction.relationships[0].status = 'inferred';
    const result = parseExtraction(normalizeClaimMetadata(extraction, input).value, input);
    assert.equal(result.relationships[0].claim!.stance, stance);
    assert.equal(result.relationships[0].status, 'inferred');
  }
});

test('normalization cannot repair a fabricated quote or unknown source', () => {
  for (const evidence of [{ documentId: 'report', quote: 'This sentence was never supplied.' }, { documentId: 'missing-source', quote: fixture().input.documents[0].text }]) {
    const { input, extraction } = fixture();
    extraction.relationships[0].evidence = [evidence];
    const result = normalizeClaimMetadata(extraction, input);
    assert.throws(() => parseExtraction(result.value, input), /인용문|등록되지 않은 출처/);
    assert.deepEqual((result.value as OntologyExtraction).relationships[0].evidence, [evidence]);
  }
});

test('date metadata is never normalized or guessed', () => {
  const { input, extraction } = fixture();
  extraction.relationships[0].claim!.validFrom = '2024-05-01';
  extraction.relationships[0].claim!.publishedAt = '2024-06-01';
  const result = normalizeClaimMetadata(extraction, input).value as OntologyExtraction;
  assert.equal(result.relationships[0].claim!.validFrom, '2024-05-01');
  assert.equal(result.relationships[0].claim!.publishedAt, '2024-06-01');
  assert.throws(() => parseExtraction(result, input), /ISO 날짜 인용/);
});

test('unknown root and claim fields and malformed attribution values remain validation errors', () => {
  const { input, extraction } = fixture();
  const root = { ...extraction, execute: 'unsupported' };
  const normalizedRoot = normalizeClaimMetadata(root, input).value as typeof root;
  assert.equal(normalizedRoot.execute, root.execute);
  assert.throws(() => parseExtraction(normalizedRoot, input), /정의되지 않은 필드/);
  const relation = extraction.relationships[0];
  const malformed = { ...extraction, relationships: [{ ...relation, claim: { ...relation.claim, attributedTo: 42, derivedFrom: null, extra: true } }] };
  const result = normalizeClaimMetadata(malformed, input);
  assert.equal(result.value, malformed);
  assert.equal(result.changed, false);
  assert.throws(() => parseExtraction(result.value, input), /허용된 자료형/);
  for (const value of [null, [], { ...extraction, limitations: [42] }, { ...extraction, relationships: null }]) {
    assert.deepEqual(normalizeClaimMetadata(value, input), { value, changed: false });
  }
});

test('attribution notice is first and remains within the existing limitation bound', () => {
  const { input, extraction } = fixture();
  extraction.limitations = Array.from({ length: 20 }, (_, index) => `제한 ${index}`);
  const result = parseExtraction(normalizeClaimMetadata(extraction, input).value, input);
  assert.equal(result.limitations.length, 20);
  assert.match(result.limitations[0], /선택적 주장 주체/);
  assert.deepEqual(result.limitations.slice(1), extraction.limitations.slice(0, 19));
});
