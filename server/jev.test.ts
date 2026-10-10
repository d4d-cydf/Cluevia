import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { JevError, readJevConfig, runJevExtraction } from './jev.ts';
import { compileExtraction } from './ontology.ts';
import type { GraphGenerationInput } from '../src/types/graph.ts';

const config = readJevConfig({ TYPESAFE_API_KEY: 'test-private-key' });
const input: GraphGenerationInput = { question: '자료의 객체 관계를 만들어주세요.', documents: [{ id: 'source-1', name: 'evidence.txt', text: 'Acme Shipping operates Sea Star.' }] };
type Question = { type: string; criteria?: Record<string, unknown>; instructions: string };
type Body = { model: string; state: { candidates?: { label: string }[]; documents?: { id: string; text: string }[] }; questions: Record<string, Question> };
type Answer = { type: string; choice?: string; confidence?: number; probabilities?: Record<string, number>; noul?: number };

function responseBody(body: Body, decide?: (key: string, question: Question, body: Body) => string | number | undefined): { model: string; answers: Record<string, Answer>; usage: { input_tokens: number; output_tokens: number } } {
  const answers: Record<string, Answer> = {};
  for (const [key, question] of Object.entries(body.questions)) {
    let value = decide?.(key, question, body);
    if (question.type === 'noul') { answers[key] = { type: 'noul', noul: typeof value === 'number' ? value : key.startsWith('date_') ? 1 : 0 }; continue; }
    if (value === undefined && key.startsWith('entity_')) {
      const label = body.state.candidates?.[Number(key.slice(7))]?.label;
      value = label === 'Acme Shipping' || label === '청해해운' ? 'organization' : label === 'Sea Star' || label === '청해호' ? 'vessel' : 'none';
    }
    if (value === undefined) value = 'forward_operates';
    const choice = String(value);
    answers[key] = { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria!).map(key => [key, key === choice ? 1 : 0])) };
  }
  return { model: body.model, answers, usage: { input_tokens: 100, output_tokens: 20 } };
}
function mockProvider(t: TestContext, callback?: (body: Body, call: number) => Response | Promise<Response>): Body[] {
  const calls: Body[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options: RequestInit) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.equal((options.headers as Record<string, string>).Authorization, 'Bearer test-private-key');
    const body = JSON.parse(String(options.body)) as Body; calls.push(body);
    return callback ? callback(body, calls.length) : Response.json(responseBody(body));
  });
  return calls;
}

test('configuration is bounded, server-only and pins model defaults', () => {
  assert.deepEqual(readJevConfig({}), { apiKey: '', model: 'jev-1.13.0', concurrency: 4, timeoutMs: 30_000, minConfidence: 0.85, fallback: true });
  assert.equal(readJevConfig({ CLUEVIA_JEV_FALLBACK: 'false' }).fallback, false);
  for (const environment of [{ TYPESAFE_CONCURRENCY: '17' }, { TYPESAFE_TIMEOUT_MS: '-1' }, { TYPESAFE_MIN_CONFIDENCE: 'NaN' }, { TYPESAFE_MODEL: 'invalid model' }, { CLUEVIA_JEV_FALLBACK: 'perhaps' }]) {
    assert.throws(() => readJevConfig(environment), error => error instanceof JevError && error.code === 'JEV_CONFIGURATION');
  }
});

test('two batched calls produce grounded entities and directed relations using official HTTP schema', async t => {
  const calls = mockProvider(t); const usage: { requests: number; inputTokens: number }[] = [];
  const result = await runJevExtraction(input, config, { onUsage: entry => usage.push(entry) });
  assert.equal(result.needsFallback, false); assert.equal(calls.length, 2);
  assert.equal(calls[0].model, 'jev-1.13.0'); assert.equal(calls[0].state.documents?.[0].text, input.documents[0].text);
  assert.deepEqual(result.extraction.entities.map(entity => [entity.label, entity.type]), [['Acme Shipping', 'organization'], ['Sea Star', 'vessel']]);
  assert.equal(result.extraction.relationships[0].type, 'operates');
  assert.equal(result.extraction.relationships[0].source, result.extraction.entities[0].id);
  assert.equal(result.extraction.relationships[0].target, result.extraction.entities[1].id);
  assert.equal(result.extraction.relationships[0].evidence[0].quote, input.documents[0].text);
  assert.equal(compileExtraction(result.extraction, input).edges.length, 1);
  assert.equal(usage.reduce((sum, entry) => sum + entry.requests, 0), 2);
  assert.equal(usage.reduce((sum, entry) => sum + entry.inputTokens, 0), 200);
});

test('literal named relationships omit inapplicable context guards without changing confidence thresholds', async t => {
  const literal = { ...input, documents: [{ ...input.documents[0], text: 'The shipping company "Northstar Shipping" operates the vessel "Ocean Star".' }] };
  const calls = mockProvider(t, body => Response.json(responseBody(body, (key, _question, request) => {
    if (key === 'missing_entities') return 0.11;
    if (key === 'contextual_relations' || key === 'reference_relations') return 0.41;
    if (key.startsWith('entity_')) {
      const label = request.state.candidates?.[Number(key.slice(7))]?.label;
      return label === 'Northstar Shipping' ? 'organization' : label === 'Ocean Star' ? 'vessel' : 'none';
    }
    return undefined;
  })));
  const result = await runJevExtraction(literal, config);
  assert.equal(config.minConfidence, 0.85);
  assert.equal(Object.hasOwn(calls[0].questions, 'contextual_relations'), false);
  assert.equal(Object.hasOwn(calls[0].questions, 'reference_relations'), false);
  assert.equal(result.needsFallback, false); assert.equal(calls.length, 2);
  assert.deepEqual(result.extraction.entities.map(entity => entity.label), ['Northstar Shipping', 'Ocean Star']);
  assert.equal(result.extraction.relationships[0].type, 'operates');
  assert.equal(compileExtraction(result.extraction, literal).edges.length, 1);
});

test('single-sentence English and Korean references keep positive or uncertain coverage checks', async t => {
  const examples = [
    ['Acme Shipping owns Sea Star and operates it.', 0.9],
    ['Acme Shipping owns Sea Star and its operator is unknown.', 0.41],
    ['청해해운은 청해호를 소유하며 해당 선박을 운영한다.', 0.9],
    ['청해해운은 청해호와 그들의 운영자를 조사한다.', 0.41],
  ] as const;
  for (const [text, probability] of examples) {
    await t.test(text, async subtest => {
      const calls = mockProvider(subtest, body => Response.json(responseBody(body, key => key === 'reference_relations' ? probability : undefined)));
      const result = await runJevExtraction({ ...input, documents: [{ ...input.documents[0], text }] }, config);
      assert.equal(Object.hasOwn(calls[0].questions, 'contextual_relations'), false);
      assert.equal(calls[0].questions.reference_relations.type, 'noul');
      assert.equal(result.needsFallback, true); assert.match(result.reason!, /대명사|지시 표현/);
    });
  }
});

test('multiple sentences or documents retain cross-sentence coverage checks and uncertain answers require review', async t => {
  const examples = [
    [{ ...input.documents[0], text: 'Acme Shipping is an operator. Sea Star is a vessel.' }],
    [{ ...input.documents[0], text: 'Acme Shipping is an operator.' }, { id: 'source-2', name: 'vessel.txt', text: 'Sea Star is a vessel.' }],
  ];
  for (const [index, documents] of examples.entries()) {
    await t.test(`case ${index + 1}`, async subtest => {
      const calls = mockProvider(subtest, body => Response.json(responseBody(body, key => key === 'contextual_relations' ? 0.41 : undefined)));
      const result = await runJevExtraction({ ...input, documents }, config);
      assert.equal(calls[0].questions.contextual_relations.type, 'noul');
      assert.equal(result.needsFallback, true); assert.match(result.reason!, /문장 사이/);
      assert.equal(result.extraction.relationships.length, 0);
    });
  }
});

test('Korean particles are removed from proposals while all evidence remains exact', async t => {
  mockProvider(t);
  const korean = { ...input, documents: [{ ...input.documents[0], text: '청해해운은 청해호를 운영한다.' }] };
  const result = await runJevExtraction(korean, config);
  assert.equal(result.needsFallback, false);
  assert.deepEqual(result.extraction.entities.map(entity => entity.label), ['청해해운', '청해호']);
  assert.equal(compileExtraction(result.extraction, korean).nodes.length, 2);
});

test('same-sentence co-occurrence does not create edges when Jev selects none', async t => {
  mockProvider(t, body => Response.json(responseBody(body, key => key.startsWith('relation_') ? 'none' : undefined)));
  const result = await runJevExtraction(input, config);
  assert.equal(result.needsFallback, false); assert.deepEqual(result.extraction.relationships, []);
});

test('negative, uncertain and multiple relationships require review instead of invented single edges', async t => {
  for (const choice of ['insufficient_evidence', 'multiple']) {
    await t.test(choice, async subtest => {
      mockProvider(subtest, body => Response.json(responseBody(body, key => key.startsWith('relation_') ? choice : undefined)));
      const result = await runJevExtraction(input, config);
      assert.equal(result.needsFallback, true); assert.equal(result.extraction.relationships.length, 0);
    });
  }
});

test('entity uncertainty and missing candidate coverage trigger explicit fallback', async t => {
  mockProvider(t, body => {
    const response = responseBody(body, key => key === 'missing_entities' ? 0.6 : undefined);
    if (response.answers.entity_1) {
      response.answers.entity_1.confidence = 0.6;
      response.answers.entity_1.probabilities = Object.fromEntries(Object.keys(body.questions.entity_1.criteria!).map(key => [key, key === 'vessel' ? 0.6 : key === 'asset' ? 0.4 : 0]));
    }
    return Response.json(response);
  });
  const result = await runJevExtraction(input, config);
  assert.equal(result.needsFallback, true); assert.match(result.reason!, /누락|불확실/);
  assert.equal(result.extraction.entities.length, 1); assert.equal(result.extraction.relationships.length, 0);
});

test('exact ISO date needs a separate positive relationship-date judgment', async t => {
  const dated = { ...input, documents: [{ ...input.documents[0], text: 'Acme Shipping operates Sea Star on 2026-10-10.' }] };
  mockProvider(t);
  const result = await runJevExtraction(dated, config);
  assert.equal(result.extraction.events[0].date, '2026-10-10');
  assert.equal(compileExtraction(result.extraction, dated).events.length, 1);
});

test('publication dates cannot automatically become event dates', async t => {
  const dated = { ...input, documents: [{ ...input.documents[0], text: 'Acme Shipping operates Sea Star, according to a publication dated 2026-10-10.' }] };
  mockProvider(t, body => Response.json(responseBody(body, key => key.startsWith('date_') ? 0 : undefined)));
  const result = await runJevExtraction(dated, config);
  assert.equal(result.extraction.relationships.length, 1); assert.equal(result.extraction.events.length, 0);
});

test('cross-sentence candidates are not expanded to all-pairs comparisons', async t => {
  const separate = { ...input, documents: [{ ...input.documents[0], text: 'Acme Shipping is an operator. Sea Star is a vessel.' }] };
  const calls = mockProvider(t);
  const result = await runJevExtraction(separate, config);
  assert.equal(calls.length, 1); assert.equal(result.extraction.relationships.length, 0);
});

test('abbreviations inside names do not split and silently drop their relationships', async t => {
  const abbreviated = { ...input, documents: [{ ...input.documents[0], text: 'Acme Inc. operates Sea Star.' }] };
  const calls = mockProvider(t, body => Response.json(responseBody(body, (key, _question, body) => key.startsWith('entity_') && body.state.candidates?.[Number(key.slice(7))]?.label === 'Acme Inc' ? 'organization' : undefined)));
  const result = await runJevExtraction(abbreviated, config);
  assert.equal(result.needsFallback, false); assert.equal(calls.length, 2);
  assert.equal(result.extraction.relationships.length, 1);
  assert.equal(result.extraction.relationships[0].evidence[0].quote, abbreviated.documents[0].text);
});

test('oversized units, long sentences, too many candidates and no candidates are never silently clipped', async t => {
  const calls = mockProvider(t);
  for (const text of ['x'.repeat(12_001), 'Acme Shipping ' + 'x'.repeat(950), Array.from({ length: 70 }, (_, index) => `Name${index} is an entity.`).join('\n'), 'nothing named here']) {
    const result = await runJevExtraction({ ...input, documents: [{ ...input.documents[0], text }] }, config);
    assert.equal(result.needsFallback, true); assert.equal(result.extraction.entities.length, 0);
  }
  assert.equal(calls.length, 0);
});

test('dense same-sentence pairs stop with fallback instead of silently dropping relations', async t => {
  const text = Array.from({ length: 12 }, (_, index) => `Entity${index}`).join(', ') + ' are listed together.';
  const calls = mockProvider(t, body => Response.json(responseBody(body, key => key.startsWith('entity_') ? 'organization' : undefined)));
  const result = await runJevExtraction({ ...input, documents: [{ ...input.documents[0], text }] }, config);
  assert.equal(result.needsFallback, true); assert.match(result.reason!, /객체 조합/); assert.equal(calls.length, 1);
});

test('429 retries are bounded and counted; Retry-After is honored', async t => {
  const calls = mockProvider(t, (body, call) => call < 3 ? new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } }) : Response.json(responseBody(body)));
  let requests = 0;
  const result = await runJevExtraction(input, config, { onUsage: entry => { requests += entry.requests; } });
  assert.equal(result.needsFallback, false); assert.equal(requests, 4); assert.equal(calls.length, 4);
});

test('persistent 5xx retries stop at three attempts without echoing provider errors', async t => {
  const calls = mockProvider(t, () => new Response('secret-provider-error', { status: 529, headers: { 'Retry-After': '0' } }));
  await assert.rejects(runJevExtraction(input, config), error => error instanceof JevError && error.code === 'JEV_UNAVAILABLE' && !error.message.includes('secret'));
  assert.equal(calls.length, 3);
});

test('invalid key fails once without leaking API key or provider response', async t => {
  const calls = mockProvider(t, () => new Response('test-private-key details', { status: 401 }));
  await assert.rejects(runJevExtraction(input, config), error => error instanceof JevError && error.code === 'JEV_AUTH' && !error.message.includes('test-private-key'));
  assert.equal(calls.length, 1);
});

test('malformed distributions and missing answers are rejected with sanitized errors', async t => {
  mockProvider(t, body => {
    const response = responseBody(body); response.answers.entity_0.probabilities!.vessel = 0.9;
    return Response.json(response);
  });
  let tokens = 0;
  await assert.rejects(runJevExtraction(input, config, { onUsage: entry => { tokens += entry.inputTokens; } }), error => error instanceof JevError && error.code === 'JEV_INVALID_RESPONSE');
  assert.equal(tokens, 100);
});

test('missing answer cannot pass despite otherwise valid JSON', async t => {
  mockProvider(t, body => { const response = responseBody(body); delete response.answers.entity_0; return Response.json(response); });
  await assert.rejects(runJevExtraction(input, config), error => error instanceof JevError && error.code === 'JEV_INVALID_RESPONSE');
});

test('cancellation before and during HTTP calls aborts promptly without another request', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => { options.signal?.addEventListener('abort', () => reject(new Error('private network error')), { once: true }); });
  });
  await assert.rejects(runJevExtraction(input, config, { signal: AbortSignal.abort() }), error => error instanceof JevError && error.code === 'JEV_CANCELLED');
  assert.equal(calls, 0);
  const controller = new AbortController(); const running = runJevExtraction(input, config, { signal: controller.signal });
  controller.abort();
  await assert.rejects(running, error => error instanceof JevError && error.code === 'JEV_CANCELLED');
  assert.equal(calls, 1);
});

test('request timeout is sanitized and does not retry an unknown billed call', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(new Error('private network error')), { once: true });
  }));
  await assert.rejects(runJevExtraction(input, { ...config, timeoutMs: 10 }), error => error instanceof JevError && error.code === 'JEV_TIMEOUT' && !error.message.includes('private'));
});
