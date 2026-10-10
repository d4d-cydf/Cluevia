import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { GraphGenerationInput } from '../src/types/graph.ts';
import type { OntologyExtraction } from '../src/types/ontology.ts';
import { compileExtraction, InsufficientEvidenceError, parseExtraction, strongIdentifier } from './ontology.ts';
import { OntologyStore } from './ontology-store.ts';

function fixture(suffix = ''): { input: GraphGenerationInput; extraction: OntologyExtraction } {
  const quote = 'Ocean Star (IMO 9074729) visited Busan on 2024-05-01.';
  const evidence = [{ documentId: 'report', quote }];
  return {
    input: { question: 'Ocean Star의 방문 기록은?', documents: [{ id: 'report', name: 'Port report', text: `${quote}\n${suffix}`, url: 'https://example.com/report' }] },
    extraction: { title: 'Ocean Star · Busan', summary: '선박의 부산 방문 기록.',
      entities: [
        { id: 'ship', label: 'Ocean Star', type: 'vessel', description: '방문 선박.', identifiers: [{ namespace: 'imo', value: '9074729' }], properties: [], evidence },
        { id: 'port', label: 'Busan', type: 'place', description: '방문 항구.', identifiers: [], properties: [], evidence },
      ],
      relationships: [{ id: 'visit', source: 'ship', target: 'port', type: 'visited', label: '방문', description: '2024-05-01 방문.', status: 'reported', evidence }],
      events: [{ id: 'arrival', label: '부산 방문', date: '2024-05-01', endDate: null, description: '입항 기록.', entityIds: ['ship', 'port'], evidence }],
      findings: [{ text: '부산 방문이 보고됨.', entityIds: ['ship'], relationshipIds: ['visit'], evidence }], limitations: ['단일 자료의 보고.'],
    },
  };
}

test('compiled extraction preserves graph references and requires exact evidence quotations', () => {
  const { input, extraction } = fixture();
  const graph = compileExtraction(extraction, input);
  assert.equal(graph.origin, 'codex'); assert.equal(graph.nodes.length, 2); assert.equal(graph.edges[0].target, 'port');
  assert.deepEqual(graph.events[0].sourceIds, ['report']);
  extraction.relationships[0].evidence = [{ documentId: 'report', quote: 'Ocean Star illegally transferred cargo.' }];
  assert.throws(() => parseExtraction(extraction, input), /인용문/);
});

test('an honest empty extraction yields a specific insufficient evidence error', () => {
  const { input, extraction } = fixture();
  assert.throws(() => parseExtraction({ ...extraction, entities: [], relationships: [], events: [], findings: [], limitations: ['No relevant evidence.'] }, input), InsufficientEvidenceError);
});

test('strict schema rejects unknown fields, unregistered types, missing references and invalid calendar days', () => {
  const { input, extraction } = fixture();
  assert.throws(() => parseExtraction({ ...extraction, confidence: 100 }, input), /정의되지/);
  const unknown = structuredClone(extraction); (unknown.entities[0] as { type: string }).type = 'unregistered';
  assert.throws(() => parseExtraction(unknown, input), /등록되지 않은 온톨로지/);
  const badRef = structuredClone(extraction); badRef.relationships[0].target = 'missing';
  assert.throws(() => parseExtraction(badRef, input), /존재하지 않는/);
  const badDate = structuredClone(extraction); badDate.events[0].date = '2024-02-30';
  assert.throws(() => parseExtraction(badDate, input), /실제 ISO/);
  const badRange = structuredClone(extraction); badRange.events[0].endDate = '2024-04-30';
  assert.throws(() => parseExtraction(badRange, input), /종료일/);
  const badType = structuredClone(extraction); badType.entities[1].type = 'organization';
  assert.throws(() => parseExtraction(badType, input), /대상은 장소/);
});

test('only exact quoted stable identifiers with valid syntax become identity anchors', () => {
  const { extraction } = fixture(); const ev = extraction.entities[0].evidence;
  assert.equal(strongIdentifier({ namespace: 'imo', value: '9074729' }, ev), 'imo:9074729');
  assert.equal(strongIdentifier({ namespace: 'imo', value: '9074728' }, [{ documentId: 'a', quote: 'IMO 9074728 is reported.' }]), undefined);
  assert.equal(strongIdentifier({ namespace: 'name', value: 'Ocean Star' }, ev), undefined);
  assert.equal(strongIdentifier({ namespace: 'imo', value: '9074729' }, [{ documentId: 'a', quote: 'ID 190747290 differs.' }]), undefined);
  assert.equal(strongIdentifier({ namespace: 'lei', value: '5493001KJTIIGC8Y1R12' }, [{ documentId: 'a', quote: 'LEI 5493001KJTIIGC8Y1R12' }]), 'lei:5493001KJTIIGC8Y1R12');
});

test('persistent identity joins verified IMO across sources but never joins names alone', () => {
  const store = new OntologyStore(':memory:');
  try {
    const a = fixture('First source.'); const b = fixture('An unrelated second source.');
    store.saveGraph(compileExtraction(a.extraction, a.input), a.input.documents, a.extraction);
    store.saveGraph(compileExtraction(b.extraction, b.input), b.input.documents, b.extraction);
    const ships = store.listEntities('Ocean Star'); const ports = store.listEntities('Busan');
    assert.equal(ships.length, 1); assert.equal(ships[0].caseCount, 2); assert.equal(ports.length, 2);
    const detail = store.getEntity(ships[0].id)!;
    assert.equal(detail.claims.length, 2); assert.equal(detail.identifiers[0].value, '9074729');
    assert.match(detail.claims[0].evidence[0].documentId, /^ctx-/); assert.equal(detail.relationships.length, 2);
  } finally { store.close(); }
});

test('different chunks of one trusted upload join the same vessel name without a strong identifier', () => {
  const store = new OntologyStore(':memory:');
  try {
    const first = fixture('First file chunk.'); const second = fixture('Another file chunk.');
    for (const part of [first, second]) {
      part.input.documents[0].identityScope = 'upload-same-original-file';
      part.extraction.entities[0].identifiers = [];
      store.saveGraph(compileExtraction(part.extraction, part.input), part.input.documents, part.extraction);
    }
    const ships = store.listEntities('Ocean Star');
    assert.equal(ships.length, 1); assert.equal(ships[0].caseCount, 2);
    assert.equal(store.getEntity(ships[0].id)!.claims.length, 2);
    assert.equal(store.summary().documents, 2);
  } finally { store.close(); }
});

test('conflicting strong identifiers invalidate a shared file/name key before later unidentified chunks', () => {
  const store = new OntologyStore(':memory:');
  try {
    const first = fixture('First file chunk.'); const second = fixture('Second file chunk.'); const unidentified = fixture('Later unidentified file chunk.');
    second.input.documents[0].text = second.input.documents[0].text.replace('9074729', '9074731');
    second.extraction.entities[0].identifiers[0].value = '9074731';
    // The fixture intentionally shares one evidence object across its claims.
    second.extraction.entities[0].evidence[0].quote = second.extraction.entities[0].evidence[0].quote.replace('9074729', '9074731');
    unidentified.extraction.entities[0].identifiers = [];
    unidentified.input.documents[0].text = unidentified.input.documents[0].text.replace(' (IMO 9074729)', '');
    unidentified.extraction.entities[0].evidence[0].quote = unidentified.extraction.entities[0].evidence[0].quote.replace(' (IMO 9074729)', '');
    for (const part of [first, second, unidentified]) {
      part.input.documents[0].identityScope = 'upload-conflicting-names';
      store.saveGraph(compileExtraction(part.extraction, part.input), part.input.documents, part.extraction);
    }
    const ships = store.listEntities('Ocean Star');
    assert.equal(ships.length, 3, 'The unidentified later chunk must not be assigned to either conflicting vessel.');
    assert.ok(ships.every(ship => ship.caseCount === 1));
    const details = ships.map(ship => store.getEntity(ship.id)!);
    assert.deepEqual(new Set(details.flatMap(entity => entity.identifiers.map(identifier => identifier.value))), new Set(['9074729', '9074731']));
    assert.equal(details.filter(entity => entity.identifiers.length === 0).length, 1);
    const ambiguous = store.db.prepare("SELECT identity_key FROM ambiguous_entity_keys WHERE identity_key LIKE 'vessel|source|scope-%|ocean star'").all();
    assert.equal(ambiguous.length, 1);
  } finally { store.close(); }
});

test('shared exact source may join repeated entity mentions and conflicting claims remain per case', () => {
  const store = new OntologyStore(':memory:');
  try {
    const a = fixture(); const b = fixture(); b.extraction.entities[0].description = '서로 다른 설명을 그대로 보존.'; b.extraction.relationships[0].status = 'inferred';
    const first = store.saveGraph(compileExtraction(a.extraction, a.input), a.input.documents, a.extraction);
    const second = store.saveGraph(compileExtraction(b.extraction, b.input), b.input.documents, b.extraction);
    assert.notEqual(first.id, second.id); assert.equal(store.summary().entities, 2); assert.equal(store.summary().documents, 1);
    const detail = store.getEntity(store.listEntities('Ocean Star')[0].id)!;
    assert.deepEqual(new Set(detail.claims.map(claim => claim.description)), new Set(['방문 선박.', '서로 다른 설명을 그대로 보존.']));
    assert.deepEqual(new Set(detail.relationships.map(relation => relation.status)), new Set(['reported', 'inferred']));
  } finally { store.close(); }
});

test('failed graph writes roll back every graph, document, entity and relationship change', () => {
  const store = new OntologyStore(':memory:');
  try {
    const { input, extraction } = fixture();
    store.db.exec("CREATE TRIGGER fail_relation BEFORE INSERT ON relations BEGIN SELECT RAISE(ABORT,'test rollback'); END;");
    assert.throws(() => store.saveGraph(compileExtraction(extraction, input), input.documents, extraction), /test rollback/);
    const counts = store.summary(); assert.equal(counts.graphs, 0); assert.equal(counts.documents, 0); assert.equal(counts.entities, 0); assert.equal(counts.relationships, 0);
  } finally { store.close(); }
});

test('distinct entities sharing a name within one source stay separate', () => {
  const store = new OntologyStore(':memory:');
  try {
    const { input, extraction } = fixture();
    extraction.entities[0].identifiers = [];
    extraction.entities.push({ ...structuredClone(extraction.entities[0]), id: 'other-ship', description: '동명이지만 별개의 선박.' });
    store.saveGraph(compileExtraction(extraction, input), input.documents, extraction);
    assert.equal(store.listEntities('Ocean Star').length, 2);
    store.saveGraph(compileExtraction(extraction, input), input.documents, extraction);
    assert.equal(store.listEntities('Ocean Star').length, 4, 'Ambiguous source/name keys must not merge later cases.');
  } finally { store.close(); }
});

test('graph, original documents and ontology survive database restart and retrieval is bounded', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cluevia-ontology-')); const path = join(directory, 'ontology.sqlite');
  const first = new OntologyStore(path); const { input, extraction } = fixture();
  const graph = first.saveGraph(compileExtraction(extraction, input), input.documents, extraction); first.close();
  const second = new OntologyStore(path);
  try {
    assert.deepEqual(second.getGraph(graph.id), graph); assert.equal(second.listGraphs()[0].id, graph.id);
    const context = second.searchContext('Ocean Star Busan');
    assert.equal(context.documents.length, 1); assert.equal(context.documents[0].text, input.documents[0].text);
    assert.match(context.documents[0].id, /^ctx-/); assert.ok(context.entities.length >= 2);
    assert.equal(second.searchContext('completelyunrelated').documents.length, 0);
    assert.equal(second.listEntities('%').length, 0);
  } finally { second.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a Korean entity label with a postposition retrieves its actual English source evidence', () => {
  const store = new OntologyStore(':memory:');
  try {
    const { input, extraction } = fixture();
    extraction.entities[1].label = '부산항';
    store.saveGraph(compileExtraction(extraction, input), input.documents, extraction);
    assert.ok(!input.documents[0].text.includes('부산항'));
    const context = store.searchContext('부산항의 관계를 알려줘');
    assert.equal(context.documents.length, 1);
    assert.equal(context.documents[0].text, input.documents[0].text);
    assert.match(context.documents[0].id, /^ctx-/);
    assert.equal(context.entities[0].label, '부산항');
    assert.equal(store.searchContext('인천항의 관계를 알려줘').documents.length, 0);
  } finally { store.close(); }
});

test('built-in public example is seeded once and imported graphs preserve their displayed contents', () => {
  const store = new OntologyStore(':memory:');
  try {
    const graph = JSON.parse(readFileSync(new URL('../public/examples/gfw-galapagos.json', import.meta.url), 'utf8'));
    const text = readFileSync(new URL('../public/examples/gfw-source-notes.txt', import.meta.url), 'utf8');
    store.seedGfw(graph, text); store.seedGfw(graph, text);
    assert.equal(store.summary().graphs, 1); assert.equal(store.summary().entities, 12); assert.equal(store.summary().relationships, 15);
    assert.equal(store.getGraph('gfw-galapagos')?.nodes[0].label, graph.nodes[0].label);
    const imported = store.saveGraph(graph); assert.notEqual(imported.id, graph.id); assert.deepEqual(imported.nodes, graph.nodes); assert.deepEqual(imported.edges, graph.edges);
    assert.equal(store.summary().entities, 24, 'Unverified name-only imports must not join existing records.');
  } finally { store.close(); }
});
