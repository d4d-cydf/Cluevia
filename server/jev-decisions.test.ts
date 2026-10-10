import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { assessJevDecisions, jevDecisionsEligible } from './jev-decisions.ts';
import type { JevDecisionInput } from './jev-decisions.ts';
import { parseOntologyDefinition } from './ontology-schema.ts';
import { readJevConfig } from './jev.ts';
import type { ChoiceQuestion } from './jev.ts';

const config = readJevConfig({ TYPESAFE_API_KEY: 'test-key', CLUEVIA_JEV_FALLBACK: 'false' });
function source(text = '{"doc_id":"D-17","published":"2026-10-10","text":"Employee Alice Park joined company Acme Labs on 2026-10-10."}'): JevDecisionInput {
  const definition = parseOntologyDefinition({
    apiName: 'EmploymentReports', displayName: '고용 보고서',
    objectTypes: [
      { apiName: 'Report', primaryKey: 'docId', titleProperty: 'docId', properties: [{ apiName: 'docId', baseType: 'string' }, { apiName: 'text', baseType: 'string' }] },
      { apiName: 'Person', primaryKey: 'name', titleProperty: 'name', properties: [{ apiName: 'name', baseType: 'string' }, { apiName: 'age', baseType: 'integer' }] },
      { apiName: 'Company', primaryKey: 'name', titleProperty: 'name', properties: [{ apiName: 'name', baseType: 'string' }] },
    ],
    linkTypes: [{ apiName: 'employedBy', description: 'A person is employed by a company.', sourceType: 'Person', targetType: 'Company', sourceCardinality: 'many', targetCardinality: 'one' }],
    sourceMappings: [{ sourceName: 'reports.jsonl', format: 'jsonl', objectType: 'Report', columns: [{ column: 'doc_id', property: 'docId' }], identityColumns: ['doc_id'], semanticColumns: ['text'] }],
    processing: { textStrategy: 'codex', jevEligibleLinkTypes: [], rationale: 'Complex attributes and claims require Codex.' },
  });
  return { documents: [{ id: 'record-17', name: 'reports.jsonl', text }], definition, source: { sourceName: 'reports.jsonl', semanticColumns: ['text'] } };
}
interface RecordedCall { state: { records: { fullOriginalText: string; documentId: string }[] }; questions: Record<string, ChoiceQuestion>; model: string }
function mock(t: TestContext, decide?: (key: string, question: ChoiceQuestion) => { choice: string; confidence?: number; probability?: number }): RecordedCall[] {
  const calls: RecordedCall[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body)) as RecordedCall; calls.push(body);
    const answers = Object.fromEntries(Object.entries(body.questions).map(([key, question]) => {
      const answer = decide?.(key, question) ?? { choice: key === 'stance' ? 'direct_assertion' : key === 'complexity' ? 'self_contained' : key === 'candidateLinkType' ? 'link_0' : 'choice_0' };
      const probability = answer.probability ?? answer.confidence ?? 1;
      const choices = Object.keys(question.criteria);
      return [key, { type: 'choice', choice: answer.choice, confidence: answer.confidence ?? 1, probabilities: Object.fromEntries(choices.map(choice => [choice, choice === answer.choice ? probability : (1 - probability) / (choices.length - 1)])) }];
    }));
    return Response.json({ model: body.model, answers, usage: { input_tokens: 75 } });
  });
  return calls;
}

test('typed complex ontology and codex-only policy still run one bounded Jev call with the whole unquoted record', async t => {
  const input = source(); const before = structuredClone(input); const calls = mock(t);
  const usage = { requests: 0, inputTokens: 0 };
  assert.equal(jevDecisionsEligible(input), true);
  const result = await assessJevDecisions(input, config, { onUsage: value => { usage.requests += value.requests; usage.inputTokens += value.inputTokens; } });
  assert.equal(calls.length, 1); assert.equal(Object.keys(calls[0].questions).length, 3);
  assert.equal(calls[0].state.records[0].fullOriginalText, input.documents[0].text);
  assert.deepEqual(input, before); assert.equal(result.route, 'batch');
  assert.equal(result.decisions.find(decision => decision.id === 'candidateLinkType')?.selection, 'employedBy');
  assert.deepEqual(usage, { requests: 1, inputTokens: 75 });
  assert.match(result.context, /NOT source evidence/); assert.match(result.context, /EVERY full original/);
  assert.equal('extraction' in result, false);
});

test('Codex-planned scoped classification executes alongside fixed questions without arbitrary generated instructions or field loss', async t => {
  const input = source();
  input.definition.processing.decisionRules = [
    { apiName: 'stance', displayName: '고용 사건', purpose: 'classification', sourceName: 'reports.jsonl', columns: ['text'], question: 'Which employment event is described?', choices: [{ apiName: 'joined', description: 'An explicit joining event.' }, { apiName: 'uncertain', description: 'Cannot establish one event.' }] },
    { apiName: 'otherFile', displayName: '다른 파일', purpose: 'classification', sourceName: 'other.jsonl', columns: ['text'], question: 'Not applicable.', choices: [{ apiName: 'yes', description: 'Yes.' }, { apiName: 'uncertain', description: 'Uncertain.' }] },
  ];
  const calls = mock(t); const result = await assessJevDecisions(input, config);
  assert.equal(calls.length, 1); assert.equal(Object.keys(calls[0].questions).length, 4);
  assert.equal(calls[0].questions.rule_otherFile, undefined);
  assert.equal(result.route, 'batch');
  assert.equal(result.decisions.find(decision => decision.id === 'stance')?.selection, 'direct_assertion');
  assert.equal(result.decisions.find(decision => decision.id === 'rule_stance')?.selection, 'joined');
  assert.match(calls[0].questions.rule_stance.instructions, /specified narrative columns/);
});

test('core uncertainty and either confidence check retain individual original-source review despite legacy fallback=false', async t => {
  for (const issue of ['stance', 'complexity', 'confidence', 'probability']) {
    t.mock.restoreAll();
    const input = source(); const calls = mock(t, key => {
      const choice = key === 'stance' ? (issue === 'stance' ? 'mixed_or_uncertain' : 'direct_assertion') : key === 'complexity' ? (issue === 'complexity' ? 'uncertain' : 'self_contained') : 'link_0';
      return { choice, confidence: issue === 'confidence' && key === 'complexity' ? 0.89 : 1, probability: issue === 'probability' && key === 'complexity' ? 0.89 : 1 };
    });
    const result = await assessJevDecisions(input, config);
    assert.equal(calls.length, 1, issue); assert.equal(result.route, 'individual', issue);
    assert.ok(result.decisions.some(decision => !decision.accepted), issue);
    assert.match(result.reason, issue === 'stance' ? /서술 태도/ : /독립 처리 가능성/);
    assert.equal(calls[0].state.records[0].fullOriginalText, input.documents[0].text);
  }
});

test('uncertain advisory candidates and custom labels remain unresolved while confident independent records can share a full-source Codex pass', async t => {
  for (const issue of ['candidate-confidence', 'candidate-uncertain', 'custom-uncertain']) {
    t.mock.restoreAll();
    const input = source();
    input.definition.processing.decisionRules = [{ apiName: 'category', displayName: '사건 분류', purpose: 'classification', sourceName: 'reports.jsonl', columns: ['text'], question: 'Which category fits?', choices: [{ apiName: 'employment', description: 'An employment event.' }, { apiName: 'uncertain', description: 'Cannot determine the category.' }] }];
    const calls = mock(t, key => ({
      choice: key === 'stance' ? 'direct_assertion' : key === 'complexity' ? 'self_contained' : key === 'candidateLinkType' ? (issue === 'candidate-uncertain' ? 'multiple_or_uncertain' : 'link_0') : issue === 'custom-uncertain' ? 'uncertain' : 'choice_0',
      confidence: key === 'candidateLinkType' && issue === 'candidate-confidence' ? 0.51 : 1,
    }));
    const result = await assessJevDecisions(input, config);
    assert.equal(result.route, 'batch', issue); assert.equal(calls.length, 1);
    assert.equal(calls[0].state.records[0].fullOriginalText, input.documents[0].text);
    const unresolved = result.decisions.find(decision => decision.id === (issue === 'custom-uncertain' ? 'rule_category' : 'candidateLinkType'))!;
    assert.equal(unresolved.accepted, false, issue);
    if (issue === 'candidate-confidence') assert.equal(unresolved.confidence, 0.51);
    assert.match(result.reason, /불확실한 관계 후보·분류는 Codex가 확인/);
    assert.match(result.context, /Unaccepted candidate or custom classifications are unresolved/);
  }
});

test('no relationship candidate never means no facts or discarded input', async t => {
  const calls = mock(t, key => ({ choice: key === 'stance' ? 'direct_assertion' : key === 'complexity' ? 'self_contained' : 'none' }));
  const result = await assessJevDecisions(source(), config);
  assert.equal(result.route, 'batch'); assert.equal(calls.length, 1);
  assert.match(result.context, /omit a record because candidateLinkType is none/);
  assert.equal(result.decisions.find(decision => decision.id === 'candidateLinkType')?.selection, 'none');
});

test('an attributed claim stays a hypothesis for full Codex review rather than materializing a true event', async t => {
  const input = source('{"doc_id":"D-17","text":"Named witness Alice alleges that employee Ben joined company Acme."}');
  mock(t, key => ({ choice: key === 'stance' ? 'attributed_claim' : key === 'complexity' ? 'self_contained' : 'link_0' }));
  const result = await assessJevDecisions(input, config);
  assert.equal(result.route, 'batch'); assert.match(result.context, /Never turn an allegation or category into a true event/);
  assert.equal('relationships' in result, false);
});

test('negation, refutation and re-quotation bypass Jev and retain individual originals', async t => {
  const calls = mock(t);
  for (const text of [
    '{"text":"Alice is not employed by Acme."}',
    '{"text":"The report refuted the allegation about Acme."}',
    '{"text":"This record re-quotes the previous report."}',
    '{"text":"앞선 보도를 재인용한 내용이며 회사 측은 사실이 아니라고 부인했다."}',
    '{"text":"이름이 같은 동명 인물로 신원은 확인되지 않았다."}',
  ]) {
    const result = await assessJevDecisions(source(text), config);
    assert.equal(result.route, 'individual', text);
  }
  assert.equal(calls.length, 0);
});

test('context dependence, denial and multiple claims route to individual review using accurate choices', async t => {
  for (const complexity of ['context_required', 'multiple_claims']) {
    t.mock.restoreAll(); mock(t, key => ({ choice: key === 'stance' ? 'direct_assertion' : key === 'complexity' ? complexity : 'link_0' }));
    assert.equal((await assessJevDecisions(source(), config)).route, 'individual');
  }
  t.mock.restoreAll(); mock(t, key => ({ choice: key === 'stance' ? 'denial_or_correction' : key === 'complexity' ? 'self_contained' : 'link_0' }));
  assert.equal((await assessJevDecisions(source(), config)).route, 'individual');
});

test('bounds and declared source scope skip Jev without truncating or calling a provider', async t => {
  const calls = mock(t);
  const inputs: JevDecisionInput[] = [
    { ...source(), source: undefined },
    { ...source(), source: { sourceName: 'different.jsonl', semanticColumns: ['text'] } },
    { ...source(), source: { sourceName: 'reports.jsonl', semanticColumns: ['unknown'] } },
    { ...source(), source: { sourceName: 'reports.jsonl', semanticColumns: ['text', 'text'] } },
    source('x'.repeat(8_001)),
    { ...source(), documents: [...source().documents, { ...source().documents[0], id: 'other' }] },
  ];
  for (const input of inputs) {
    const before = structuredClone(input);
    assert.equal(jevDecisionsEligible(input), false);
    assert.equal((await assessJevDecisions(input, config)).route, 'individual');
    assert.deepEqual(input, before);
  }
  assert.equal((await assessJevDecisions(source(), { ...config, apiKey: '' })).route, 'individual');
  assert.equal(calls.length, 0);
});

test('unknown provider choices, invalid probability distributions and transport failure do not escape to accepted routing', async t => {
  for (const scenario of ['unknown', 'malformed', 'distribution', 'network']) {
    t.mock.restoreAll();
    if (scenario === 'unknown') mock(t, () => ({ choice: 'unrequested_generated_fact' }));
    else t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
      if (scenario === 'network') throw new Error('provider secret must never be logged');
      if (scenario === 'distribution') {
        const request = JSON.parse(String(options.body)) as RecordedCall;
        return Response.json({ model: config.model, usage: { input_tokens: 12 }, answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, {
          type: 'choice', choice: Object.keys(question.criteria)[0], confidence: 1,
          probabilities: Object.fromEntries(Object.keys(question.criteria).map(choice => [choice, 1])),
        }])) });
      }
      return Response.json({ model: config.model, answers: {}, usage: { input_tokens: 12 } });
    });
    const result = await assessJevDecisions(source(), config);
    assert.equal(result.route, 'individual', scenario); assert.deepEqual(result.decisions, []);
    assert.doesNotMatch(JSON.stringify(result), /secret|unrequested_generated_fact/);
  }
});

test('cancellation propagates instead of becoming a successful individual fallback', async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async () => { controller.abort(); throw new Error('aborted'); });
  await assert.rejects(assessJevDecisions(source(), config, { signal: controller.signal }), error => error instanceof Error && error.name === 'AbortError');
});
