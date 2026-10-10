import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { parseOntologyDefinition } from './ontology-schema.ts';
import { ontologyJevEligible, runOntologyJev } from './ontology-jev.ts';
import { readJevConfig } from './jev.ts';
import type { ChoiceQuestion } from './jev.ts';
import type { GraphGenerationInput } from '../src/types/graph.ts';

function schema() {
  return parseOntologyDefinition({ apiName: 'Employment', displayName: '고용 관계', objectTypes: [
    { apiName: 'Person', description: 'A human employee.', primaryKey: 'name', titleProperty: 'name', properties: [{ apiName: 'name', baseType: 'string', required: true }] },
    { apiName: 'Company', description: 'An employing company.', primaryKey: 'name', titleProperty: 'name', properties: [{ apiName: 'name', baseType: 'string', required: true }] },
  ], linkTypes: [{ apiName: 'employedBy', description: 'A person explicitly employed by a company.', sourceType: 'Person', targetType: 'Company', sourceCardinality: 'many', targetCardinality: 'one' }],
  processing: { textStrategy: 'jev-assisted', jevEligibleLinkTypes: ['employedBy'], rationale: 'Explicit employment sentence only.' } });
}
const input: GraphGenerationInput = { question: '고용 관계', documents: [{ id: 'source', name: 'employment.txt', text: 'Employee "Alice Park" is employed by company "Acme Labs".' }] };
const config = readJevConfig({ TYPESAFE_API_KEY: 'test-key', CLUEVIA_JEV_FALLBACK: 'false' });
function mock(t: TestContext, decide?: (key: string) => { choice: string; confidence?: number }): { calls: number } {
  const counter = { calls: 0 };
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    counter.calls++;
    const body = JSON.parse(String(options.body)) as { model: string; questions: Record<string, ChoiceQuestion> };
    const answers = Object.fromEntries(Object.entries(body.questions).map(([key, question]) => {
      const response = decide?.(key) ?? { choice: key === 'coverage' ? 'complete' : key === 'entity_0' ? 'type_0' : key === 'entity_1' ? 'type_1' : 'option_0' };
      const confidence = response.confidence ?? 1;
      const alternatives = Object.keys(question.criteria);
      return [key, { type: 'choice', choice: response.choice, confidence, probabilities: Object.fromEntries(alternatives.map(choice => [choice, choice === response.choice ? confidence : (1 - confidence) / (alternatives.length - 1)])) }];
    }));
    return Response.json({ model: body.model, answers, usage: { input_tokens: 30, output_tokens: 10 } });
  });
  return counter;
}

test('nonmaritime name-only schema makes one Jev request for independent coverage, type and relation decisions', async t => {
  const count = mock(t); const definition = schema();
  assert.equal(ontologyJevEligible(input, definition), true);
  const result = await runOntologyJev(input, definition, config);
  assert.equal(count.calls, 1); assert.equal(result.needsFallback, false);
  assert.deepEqual(result.extraction.entities.map(entity => entity.type), ['Person', 'Company']);
  assert.equal(result.extraction.relationships[0].type, 'employedBy');
  assert.equal(result.extraction.relationships[0].source, 'named-1');
  assert.equal(result.extraction.relationships[0].evidence[0].quote, input.documents[0].text);
});

test('typed attributes, separate identifiers, cross-sentence context and default policy use Codex without Jev requests', async t => {
  const count = mock(t);
  const defaultSchema = schema(); defaultSchema.processing.textStrategy = 'codex';
  const typed = schema(); typed.objectTypes[0].properties.push({ ...typed.objectTypes[0].properties[0], apiName: 'age', baseType: 'integer', required: false });
  const identifiers = schema(); identifiers.objectTypes[0].primaryKey = 'personId';
  for (const definition of [defaultSchema, typed, identifiers]) {
    assert.equal(ontologyJevEligible(input, definition), false);
    assert.equal((await runOntologyJev(input, definition, config)).needsFallback, true);
  }
  for (const text of ['"Alice Park" is a person. "Acme Labs" employs her.', '"Alice Park" works for "Acme Labs" and they discussed her promotion.', 'Alice Park works at Acme Labs.']) {
    const source = { ...input, documents: [{ ...input.documents[0], text }] };
    assert.equal(ontologyJevEligible(source, schema()), false);
    assert.equal((await runOntologyJev(source, schema(), config)).needsFallback, true);
  }
  assert.equal(count.calls, 0);
});

test('uncertainty falls back even if legacy Jev fallback setting was disabled', async t => {
  const count = mock(t, key => key === 'coverage' ? { choice: 'complete', confidence: 0.86 } : { choice: key === 'entity_0' ? 'type_0' : key === 'entity_1' ? 'type_1' : 'option_0' });
  const result = await runOntologyJev(input, schema(), config);
  assert.equal(count.calls, 1); assert.equal(result.needsFallback, true); assert.equal(result.extraction.entities.length, 0);
});

test('extra or negated claims cannot pass the coverage decision', async t => {
  const count = mock(t, key => ({ choice: key === 'coverage' ? 'requires_codex' : key === 'entity_0' ? 'type_0' : key === 'entity_1' ? 'type_1' : 'option_0' }));
  const result = await runOntologyJev(input, schema(), config);
  assert.equal(count.calls, 1); assert.equal(result.needsFallback, true); assert.equal(result.extraction.relationships.length, 0);
});

function mixedSchema() {
  const definition = schema();
  definition.objectTypes.push({ ...definition.objectTypes[0], apiName: 'Report', primaryKey: 'documentId', titleProperty: 'text', description: 'A report document with detailed narrative facts.', properties: [
    { ...definition.objectTypes[0].properties[0], apiName: 'documentId', valueSource: 'documentId' },
    { ...definition.objectTypes[0].properties[0], apiName: 'text' },
  ] });
  definition.linkTypes.push({ ...definition.linkTypes[0], apiName: 'mentionsPerson', sourceType: 'Report', targetType: 'Person', description: 'A report mentions a person.' });
  definition.processing.jevEligibleLinkTypes.push('mentionsPerson');
  return definition;
}

test('a supported simple link can use Jev inside an ontology containing complex document types', async t => {
  const count = mock(t); const definition = mixedSchema();
  assert.equal(ontologyJevEligible(input, definition), true);
  const result = await runOntologyJev(input, definition, config);
  assert.equal(count.calls, 1); assert.equal(result.needsFallback, false);
  assert.deepEqual(result.extraction.entities.map(entity => entity.type), ['Person', 'Company']);
  assert.equal(result.extraction.relationships[0].type, 'employedBy');
});

test('an unsupported type in the mixed schema sends the entire statement to Codex even with confident relation and coverage choices', async t => {
  const count = mock(t, key => ({ choice: key === 'coverage' ? 'complete' : key === 'entity_0' ? 'type_2' : key === 'entity_1' ? 'type_1' : 'option_0' }));
  const original = structuredClone(input);
  const result = await runOntologyJev(input, mixedSchema(), config);
  assert.equal(count.calls, 1); assert.equal(result.needsFallback, true);
  assert.equal(result.extraction.entities.length, 0);
  assert.deepEqual(input, original);
});

test('local rejection prevents confident Jev mistakes on denial, time, quantities, compound assertions and duplicate names without API calls', async t => {
  const count = mock(t);
  const examples = [
    'Employee "Alice Park" is not employed by company "Acme Labs".',
    'Employee "Alice Park" denies being employed by company "Acme Labs".',
    'Employee "Alice Park" isn’t employed by company "Acme Labs".',
    'Employee "Alice Park" is employed by company "Acme Labs" since 2024.',
    'Employee "Alice Park" was employed by company "Acme Labs".',
    'Employee "Alice Park" is employed by company "Acme Labs" today.',
    'Employee "Alice Park" is employed by company "Acme Labs" for 20 hours.',
    'Employee "Alice Park" is employed by company "Acme Labs" and manages a team.',
    'Employee "Alice Park" is employed by company "Acme Labs"; the claim is false.',
    'Employee "Alice Park" is employed by company "Acme Labs", a blue-chip firm.',
    'Employee "Alice Park" is employed by company "Acme Labs" with manager "Bill Smith".',
    'Employee "Alice Park" is employed by company "alice park".',
    '직원 "김민수"는 회사 "미래기업"의 직원이 아니다.',
    '직원 "김민수"는 회사 "미래기업"에 고용되었다는 주장을 부인했다.',
    '직원 "김민수"는 회사 "미래기업"에 오늘 입사했다.',
  ];
  for (const text of examples) {
    const source = { ...input, documents: [{ ...input.documents[0], text }] };
    assert.equal(ontologyJevEligible(source, mixedSchema()), false, text);
    const result = await runOntologyJev(source, mixedSchema(), config);
    assert.equal(result.needsFallback, true, text); assert.equal(result.extraction.relationships.length, 0, text);
  }
  assert.equal(count.calls, 0);
});

test('candidate names containing time or conjunction words are not confused with assertions', async t => {
  const count = mock(t);
  const source = { ...input, documents: [{ ...input.documents[0], text: 'Employee "May Park" is employed by company "Smith and Sons".' }] };
  assert.equal(ontologyJevEligible(source, mixedSchema()), true);
  const result = await runOntologyJev(source, mixedSchema(), config);
  assert.equal(result.needsFallback, false); assert.equal(count.calls, 1);
  assert.deepEqual(result.extraction.entities.map(entity => entity.label), ['May Park', 'Smith and Sons']);
});

test('unestablished type, incompatible direction, no relation and low confidence always fall back without partial results', async t => {
  for (const issue of ['unknown-type', 'opposite-direction', 'none', 'requires_codex', 'low-confidence']) {
    t.mock.restoreAll();
    const count = mock(t, key => {
      if (key === 'coverage') return { choice: 'complete' };
      if (key === 'entity_0') return { choice: issue === 'unknown-type' ? 'unknown' : 'type_0' };
      if (key === 'entity_1') return { choice: 'type_1' };
      return { choice: issue === 'opposite-direction' ? 'option_1' : issue === 'none' || issue === 'requires_codex' ? issue : 'option_0', confidence: issue === 'low-confidence' ? 0.7 : 1 };
    });
    const result = await runOntologyJev(input, mixedSchema(), config);
    assert.equal(count.calls, 1, issue); assert.equal(result.needsFallback, true, issue);
    assert.equal(result.extraction.entities.length, 0, issue); assert.equal(result.extraction.relationships.length, 0, issue);
  }
});

test('qualitative extra attributes rejected by coverage do not silently disappear from a successful relation', async t => {
  const count = mock(t, key => ({ choice: key === 'coverage' ? 'requires_codex' : key === 'entity_0' ? 'type_0' : key === 'entity_1' ? 'type_1' : 'option_0' }));
  const source = { ...input, documents: [{ ...input.documents[0], text: 'Senior employee "Alice Park" is employed by company "Acme Labs".' }] };
  assert.equal(ontologyJevEligible(source, mixedSchema()), true);
  const result = await runOntologyJev(source, mixedSchema(), config);
  assert.equal(count.calls, 1); assert.equal(result.needsFallback, true);
  assert.equal(result.extraction.entities.length, 0);
});
