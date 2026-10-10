import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { GraphDocument, GraphGenerationInput } from '../src/types/graph.ts';
import { AIP_ENDPOINT, AipError, generateAipGraph, parseGenerationInput, readAipConfiguration } from './aip.ts';
import { createAipMiddleware } from './vite-api-plugin.ts';

const environment = { FOUNDRY_DOMAIN: 'example.palantirfoundry.com', FOUNDRY_TOKEN: 'test-only-token', FOUNDRY_MODEL_RID: 'ri.language-model-service..language-model.test-model' };
const configuration = readAipConfiguration(environment);
const input: GraphGenerationInput = { question: '자료에 나오는 관계를 보여 줘.', documents: [{ id: 'doc-1', name: 'evidence.txt', text: 'Alpha supports Beta.', url: 'https://example.org/evidence' }] };
const graph: GraphDocument = {
  schemaVersion: '1.0', id: 'model-id', title: 'Evidence graph', question: 'Model question', summary: 'Alpha supports Beta.', origin: 'aip', createdAt: '2026-10-10T00:00:00Z', limitations: ['One source.'],
  groups: [{ id: 'entities', label: 'Entities', color: '#aabbcc' }],
  sources: [{ id: 'doc-1', title: 'Fabricated title', url: 'https://fabricated.example.org' }],
  nodes: [
    { id: 'alpha', label: 'Alpha', type: 'Entity', group: 'entities', description: 'Alpha.', sourceIds: ['doc-1'], properties: {} },
    { id: 'beta', label: 'Beta', type: 'Entity', group: 'entities', description: 'Beta.', sourceIds: ['doc-1'], properties: {} },
  ],
  edges: [{ id: 'supports', source: 'alpha', target: 'beta', label: 'supports', description: 'Reported in the document.', status: 'reported', sourceIds: ['doc-1'] }],
  events: [], findings: [{ text: 'A reported relationship.', nodeIds: ['alpha', 'beta'], edgeIds: ['supports'], sourceIds: ['doc-1'] }],
};

function responseFor(value: unknown, finishReason = 'stop'): Response {
  return Response.json({ choices: [{ finish_reason: finishReason, message: { content: JSON.stringify(value) } }] });
}

test('Foundry settings validate an HTTPS origin and full model RID', () => {
  assert.equal(configuration.config?.domain, 'https://example.palantirfoundry.com');
  assert.equal(configuration.configured, true);
  assert.deepEqual(readAipConfiguration({}).missing, ['FOUNDRY_DOMAIN', 'FOUNDRY_TOKEN', 'FOUNDRY_MODEL_RID']);
  for (const domain of ['http://example.org', 'https://user:secret@example.org', 'https://example.org/path', 'https://example.org?token=secret']) {
    assert.deepEqual(readAipConfiguration({ ...environment, FOUNDRY_DOMAIN: domain }).missing, ['FOUNDRY_DOMAIN']);
  }
  assert.deepEqual(readAipConfiguration({ ...environment, FOUNDRY_MODEL_RID: 'gpt-model-alias' }).missing, ['FOUNDRY_MODEL_RID']);
});

test('input rejects missing documents, duplicate IDs, oversized text, and unsafe URLs', () => {
  assert.throws(() => parseGenerationInput({ question: 'x', documents: [] }), AipError);
  assert.throws(() => parseGenerationInput({ ...input, documents: [input.documents[0], input.documents[0]] }), AipError);
  assert.throws(() => parseGenerationInput({ ...input, documents: [{ ...input.documents[0], text: 'x'.repeat(50_001) }] }), AipError);
  assert.throws(() => parseGenerationInput({ ...input, documents: [{ ...input.documents[0], url: 'javascript:alert(1)' }] }), AipError);
  assert.throws(() => parseGenerationInput({ ...input, documents: Array.from({ length: 4 }, (_entry, index) => ({ id: `doc-${index}`, name: 'd', text: 'x'.repeat(40_000) })) }), AipError);
});

test('generation uses the documented endpoint and retains authoritative evidence metadata', async () => {
  let calls = 0;
  const fetchMock: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(url, `${configuration.config?.domain}${AIP_ENDPOINT}`);
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${environment.FOUNDRY_TOKEN}`);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, environment.FOUNDRY_MODEL_RID);
    assert.equal(body.stream, false);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.tools, undefined);
    assert.deepEqual(JSON.parse(body.messages[1].content), input);
    return responseFor(graph);
  };
  const result = await generateAipGraph(input, configuration, { fetch: fetchMock });
  assert.equal(calls, 1);
  assert.equal(result.question, input.question);
  assert.match(result.id, /^aip-/);
  assert.equal(result.origin, 'aip');
  assert.deepEqual(result.sources, [{ id: 'doc-1', title: 'evidence.txt', url: 'https://example.org/evidence', excerpt: input.documents[0].text }]);
  assert.equal(result.edges.length, 1);
});

test('unconfigured requests do not call the provider', async () => {
  await assert.rejects(generateAipGraph(input, readAipConfiguration({}), { fetch: async () => { throw new Error('must not call'); } }), (error: unknown) => error instanceof AipError && error.status === 503);
});

test('provider failures return useful errors without provider response or secret details', async () => {
  for (const status of [400, 401, 403, 404, 429, 500]) {
    await assert.rejects(generateAipGraph(input, configuration, { fetch: async () => new Response('test-only-token provider-sensitive-detail', { status }) }), (error: unknown) => {
      assert.ok(error instanceof AipError);
      assert.equal(error.status, status === 429 ? 429 : 502);
      assert.doesNotMatch(error.message, /test-only-token|provider-sensitive-detail/);
      return true;
    });
  }
});

test('generation rejects uncited entities and fabricated source IDs', async () => {
  for (const sourceIds of [[], ['invented-source']]) {
    const candidate = { ...graph, nodes: [{ ...graph.nodes[0], sourceIds }, graph.nodes[1]], sources: [...graph.sources, { id: 'invented-source', title: 'Fake source' }] };
    await assert.rejects(generateAipGraph(input, configuration, { fetch: async () => responseFor(candidate) }), (error: unknown) => error instanceof AipError && error.status === 502);
  }
});

test('generation rejects dangling graph references and incomplete model output', async () => {
  await assert.rejects(generateAipGraph(input, configuration, { fetch: async () => responseFor({ ...graph, edges: [{ ...graph.edges[0], target: 'missing' }] }) }), AipError);
  await assert.rejects(generateAipGraph(input, configuration, { fetch: async () => responseFor(graph, 'length') }), AipError);
  await assert.rejects(generateAipGraph(input, configuration, { fetch: async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: '```json\n{}\n```' } }] }) }), AipError);
  await assert.rejects(generateAipGraph(input, configuration, { fetch: async () => new Response('not JSON') }), AipError);
});

test('provider read size is bounded', async () => {
  await assert.rejects(generateAipGraph(input, configuration, { fetch: async () => new Response('x'.repeat(2_200_001)) }), (error: unknown) => error instanceof AipError && error.status === 502);
});

test('provider timeout aborts the request and returns a safe timeout message', async () => {
  const fetchMock: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('sensitive connection detail')), { once: true });
  });
  await assert.rejects(generateAipGraph(input, configuration, { fetch: fetchMock, timeoutMs: 5 }), (error: unknown) => error instanceof AipError && error.status === 504 && !error.message.includes('sensitive'));
});

test('caller cancellation aborts the provider and prevents a pre-cancelled provider call', async () => {
  const controller = new AbortController();
  let providerSignal: AbortSignal | null | undefined;
  const fetchMock: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    providerSignal = init?.signal;
    init?.signal?.addEventListener('abort', () => reject(new Error('provider cancelled')), { once: true });
  });
  const pending = generateAipGraph(input, configuration, { fetch: fetchMock, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof AipError && error.status === 499);
  assert.equal(providerSignal?.aborted, true);
  await assert.rejects(generateAipGraph(input, configuration, { signal: controller.signal, fetch: async () => { assert.fail('Pre-cancelled requests must not call the provider.'); } }), (error: unknown) => error instanceof AipError && error.status === 499);
});

test('disconnecting the browser request aborts the provider and permits a new generation', async () => {
  let started!: () => void;
  const providerStarted = new Promise<void>(resolve => { started = resolve; });
  let aborted!: () => void;
  const providerAborted = new Promise<void>(resolve => { aborted = resolve; });
  let calls = 0;
  const fetchMock: typeof fetch = async (_url, init) => {
    calls++;
    if (calls > 1) return responseFor(graph);
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted(); reject(new Error('cancelled')); }, { once: true });
      started();
    });
  };
  const middleware = createAipMiddleware(configuration, { fetch: fetchMock });
  const server = createServer((request, response) => middleware(request, response, () => { response.statusCode = 404; response.end(); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const controller = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = fetch(`${base}/api/graphs/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: controller.signal });
    await providerStarted;
    controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError');
    await Promise.race([providerAborted, new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('Provider was not cancelled.')), 1000); })]);
    const next = await fetch(`${base}/api/graphs/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(next.status, 200);
    assert.equal(calls, 2);
  } finally {
    if (deadline) clearTimeout(deadline);
    controller.abort();
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
  }
});

test('local middleware exposes status only and handles validation and origin failures', async () => {
  const middleware = createAipMiddleware(readAipConfiguration({}));
  const server = createServer((request, response) => middleware(request, response, () => { response.statusCode = 404; response.end(); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const status = await fetch(`${base}/api/aip/status`);
    assert.deepEqual(await status.json(), { configured: false, missing: ['FOUNDRY_DOMAIN', 'FOUNDRY_TOKEN', 'FOUNDRY_MODEL_RID'] });
    const unsupported = await fetch(`${base}/api/graphs/generate`);
    assert.equal(unsupported.status, 405);
    const malformed = await fetch(`${base}/api/graphs/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(malformed.status, 400);
    const wrongType = await fetch(`${base}/api/graphs/generate`, { method: 'POST', body: '{}' });
    assert.equal(wrongType.status, 415);
    const foreign = await fetch(`${base}/api/graphs/generate`, { method: 'POST', headers: { Origin: 'https://another.example', 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(foreign.status, 403);
    const unconfigured = await fetch(`${base}/api/graphs/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(unconfigured.status, 503);
  } finally {
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
  }
});
