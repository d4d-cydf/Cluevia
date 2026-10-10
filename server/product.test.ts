import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { GraphDocument } from '../src/types/graph.ts';
import type { AnalysisCase, AnalysisRecordDetail } from '../src/types/analysis-case.ts';
import type { CaseChatState } from '../src/types/case-chat.ts';
import type { OntologyEntityDetail, OntologyEntitySummary, OntologyExtraction, OntologySummary } from '../src/types/ontology.ts';
import type { CodexInput } from './codex.ts';
import type { CodexRunner, GenerationJob } from './jobs.ts';
import { createProductBackend } from './product-api.ts';

const quote = 'Ocean Star (IMO 9074729) visited Busan on 2024-05-01.';
const source = { id: 'port-report', name: 'Ocean Star port report', text: quote, url: 'https://example.com/report' };
const request = { question: 'Ocean Star와 Busan의 관계를 그래프로 만들어줘.', documents: [source] };
function extraction(input: CodexInput): OntologyExtraction {
  const evidence = [{ documentId: input.documents[0].id, quote }];
  return {
    title: 'Ocean Star · Busan', summary: '항구 방문 관계.',
    entities: [
      { id: 'ship', label: 'Ocean Star', type: 'vessel', description: '자료의 선박.', identifiers: [{ namespace: 'imo', value: '9074729' }], properties: [], evidence },
      { id: 'port', label: 'Busan', type: 'place', description: '방문 항구.', identifiers: [], properties: [], evidence },
    ],
    relationships: [{ id: 'visit', source: 'ship', target: 'port', type: 'visited', label: '방문', description: '부산 방문 기록.', status: 'reported', evidence }],
    events: [{ id: 'arrival', label: '방문', date: '2024-05-01', endDate: null, description: '자료의 방문 날짜.', entityIds: ['ship', 'port'], evidence }],
    findings: [{ text: '선박이 부산에 방문한 것으로 보고됨.', entityIds: ['ship', 'port'], relationshipIds: ['visit'], evidence }], limitations: ['단일 자료의 보고.'],
  };
}

async function setup(t: TestContext, runner: CodexRunner, options: { token?: string; onProbe?: () => void; maxUploadBytes?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cluevia-product-test-'));
  const sessions: { close: () => Promise<void> }[] = [];
  t.after(async () => {
    for (const session of sessions.reverse()) await session.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function open() {
    const backend = await createProductBackend({ root: process.cwd(), dataDir: directory, accessToken: options.token ?? '', codex: { timeoutMs: 1000 }, seedExample: false, maxUploadBytes: options.maxUploadBytes }, {
      run: runner,
      probe: async () => { options.onProbe?.(); return { available: true, authenticated: true, message: 'Test provider ready.' }; },
    });
    const server = createServer((req, res) => backend.middleware(req, res, () => { res.writeHead(404); res.end(); }));
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await backend.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    };
    sessions.push({ close });
    async function call<T>(path: string, body?: unknown, token = options.token, method = body === undefined ? 'GET' : 'POST') {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(3000),
      });
      return { status: response.status, headers: response.headers, data: await response.json() as T };
    }
    return { backend, call, close, base };
  }
  return { ...await open(), reopen: open };
}

type Session = Awaited<ReturnType<typeof setup>>;
async function terminal(session: Pick<Session, 'call'>, id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { status, data } = await session.call<{ job: GenerationJob }>(`/api/jobs/${id}`);
    assert.equal(status, 200);
    if (['completed', 'failed', 'cancelled'].includes(data.job.status)) return data.job;
    await delay(10);
  }
  throw new Error('Generation did not reach a terminal state.');
}
async function create(session: Pick<Session, 'call'>, body: unknown = request) {
  const { status, data } = await session.call<{ job: GenerationJob }>('/api/jobs', body);
  assert.equal(status, 202);
  return terminal(session, data.job.id);
}

test('case and record HTTP endpoints enforce auth, preserve evidence and work after restart', async t => {
  const token = 'case-test-access-token';
  const session = await setup(t, async input => extraction(input), { token });
  const job = await create(session);
  assert.equal(job.status, 'completed', job.error);
  const path = `/api/jobs/${job.id}`;
  for (const endpoint of ['/case', '/records/1', '/records/1/document?id=port-report']) {
    assert.equal((await session.call(path + endpoint, undefined, '')).status, 401);
  }
  const result = await session.call<AnalysisCase>(`${path}/case`);
  assert.equal(result.status, 200); assert.equal(result.data.graph.nodes.length, 2);
  assert.equal(result.data.records[0].graphId, job.graphId);
  const detail = await session.call<AnalysisRecordDetail>(`${path}/records/1`);
  assert.equal(detail.data.documents[0].text, quote);
  assert.equal(detail.data.claims[0].evidence[0].quote, quote);
  assert.equal((await session.call(`${path}/records/1/document?id=port-report&offset=-1`)).status, 400);
  assert.equal((await session.call(`${path}/records/1/document?id=private-other-source`)).status, 404);
  assert.equal((await session.call(`${path}/records/99`)).status, 404);
  assert.equal((await session.call('/api/jobs/nonexistent/case')).status, 404);
  await session.close();
  const reopened = await session.reopen();
  assert.deepEqual((await reopened.call<AnalysisCase>(`${path}/case`)).data, result.data);
});

test('relationship review requires a reason, survives restart, supports undo, and is deleted with its case', async t => {
  const token = 'review-test-token';
  const session = await setup(t, async input => extraction(input), { token });
  const job = await create(session);
  const casePath = `/api/jobs/${job.id}/case`;
  const edge = (await session.call<AnalysisCase>(casePath)).data.graph.edges[0];
  const reviewPath = `/api/jobs/${job.id}/claims/${edge.id}/review`;
  assert.equal((await session.call(reviewPath, { status: 'disputed', note: 'Source checked' }, '')).status, 401);
  assert.equal((await session.call(reviewPath, { status: 'disputed', note: ' ' })).status, 400);
  assert.equal((await session.call(`/api/jobs/${job.id}/claims/unknown/review`, { status: 'disputed', note: 'Source checked' })).status, 404);
  assert.equal((await session.call(reviewPath, { status: 'disputed', note: 'Single-source statement' })).status, 200);
  await session.close();
  const reopened = await session.reopen();
  const restored = (await reopened.call<AnalysisCase>(casePath)).data.graph.edges[0].review;
  assert.equal(restored?.status, 'disputed'); assert.equal(restored?.note, 'Single-source statement');
  assert.equal((await reopened.call(reviewPath, { status: 'unreviewed', note: '' })).status, 200);
  assert.equal((await reopened.call<AnalysisCase>(casePath)).data.graph.edges[0].review?.status, 'unreviewed');
  assert.equal(reopened.backend.store.db.prepare('SELECT count(*) AS n FROM claim_review_history WHERE job_id=?').get(job.id)!.n, 2);
  await reopened.backend.jobs.remove(job.id);
  assert.equal(reopened.backend.store.db.prepare('SELECT count(*) AS n FROM claim_reviews WHERE job_id=?').get(job.id)!.n, 0);
  assert.equal(reopened.backend.store.db.prepare('SELECT count(*) AS n FROM claim_review_history WHERE job_id=?').get(job.id)!.n, 0);
});

test('case chat cites only its supplied evidence, persists history, and deletion removes the case without harming another', async t => {
  const token = 'case-chat-test-token';
  const session = await setup(t, async input => {
    if (input.purpose !== 'case-chat') return extraction(input);
    assert.match(input.context ?? '', /recordsUsed/);
    assert.ok(input.documents.some(document => document.text.includes(quote)));
    if (input.question === 'invalid quote') return { answer: 'Invalid answer', citations: [{ record: 1, quote: 'Fabricated quotation, not in the source.' }] };
    return { answer: '자료에는 Ocean Star의 부산 방문이 보고되어 있습니다.', citations: [{ record: 1, quote }] };
  }, { token });
  const first = await create(session);
  const second = await create(session, { ...request, documents: [{ ...source, id: 'separate-report', text: `${quote}\nSecond case only.` }] });
  assert.equal(first.status, 'completed'); assert.equal(second.status, 'completed');
  const path = `/api/jobs/${first.id}/chat`;
  assert.equal((await session.call(path, { question: '확인된 사실은?' }, '')).status, 401);
  assert.equal((await session.call(path, { question: '확인된 사실은?', selection: { kind: 'node', id: 'not-from-this-case' } })).status, 400);
  assert.equal((await session.call(path, { question: '확인된 사실은?' })).status, 202);
  let state: CaseChatState | undefined;
  for (let i = 0; i < 100; i++) { state = (await session.call<CaseChatState>(path)).data; if (state.turns[0]?.status !== 'running') break; await delay(5); }
  assert.equal(state!.turns[0].status, 'completed'); assert.deepEqual(state!.turns[0].citations, [{ record: 1, quote }]);
  assert.equal(state!.model, 'gpt-6.1-sol'); assert.equal(state!.effort, 'xhigh');
  assert.equal((await session.call(path, { question: 'invalid quote' })).status, 202);
  for (let i = 0; i < 100; i++) { state = (await session.call<CaseChatState>(path)).data; if (state.turns[1]?.status !== 'running') break; await delay(5); }
  assert.equal(state!.turns[1].status, 'failed'); assert.match(state!.turns[1].error!, /일치하지 않는 인용/);
  await session.close();
  const reopened = await session.reopen();
  assert.deepEqual((await reopened.call<CaseChatState>(path)).data.turns, state!.turns);
  assert.equal((await reopened.call(`/api/jobs/${first.id}`, undefined, '', 'DELETE')).status, 401);
  const removal = await reopened.call<{ graphIds: string[] }>(`/api/jobs/${first.id}`, undefined, token, 'DELETE');
  assert.equal(removal.status, 200); assert.deepEqual(removal.data.graphIds, first.graphIds);
  for (const endpoint of [`/api/jobs/${first.id}`, path, `/api/jobs/${first.id}/case`, `/api/graphs/${first.graphId}`]) assert.equal((await reopened.call(endpoint)).status, 404);
  assert.equal((await reopened.call(`/api/jobs/${second.id}/case`)).status, 200);
  assert.equal(reopened.backend.store.getEntity(reopened.backend.store.listEntities('Ocean Star')[0].id)!.claims.length, 1);
  assert.equal(Number(reopened.backend.store.db.prepare('SELECT count(*) n FROM case_chat_turns WHERE job_id=?').get(first.id)!.n), 0);
});

test('deleting an active generation cancels and settles its runner before removing checkpoints', async t => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const session = await setup(t, async (_input, _config, options) => {
    started(); await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    throw new Error('Runner must be aborted.');
  });
  const creation = await session.call<{ job: GenerationJob }>('/api/jobs', request);
  await ready;
  const id = creation.data.job.id;
  assert.equal((await session.call(`/api/jobs/${id}`, undefined, undefined, 'DELETE')).status, 200);
  await delay(30);
  assert.equal(session.backend.jobs.get(id), null); assert.equal(session.backend.store.summary().graphs, 0);
});

test('HTTP job creates persistent graph, ontology entities, quotations and relationships across restart', async t => {
  const session = await setup(t, async input => extraction(input));
  const job = await create(session);
  assert.equal(job.status, 'completed', job.error); assert.ok(job.graphId);
  const graph = await session.call<{ graph: GraphDocument }>(`/api/graphs/${job.graphId}`);
  assert.equal(graph.status, 200); assert.equal(graph.data.graph.origin, 'codex'); assert.equal(graph.data.graph.nodes.length, 2); assert.equal(graph.data.graph.edges.length, 1); assert.equal(graph.data.graph.events[0].date, '2024-05-01');
  const ontology = await session.call<{ summary: OntologySummary }>('/api/ontology');
  assert.equal(ontology.data.summary.entities, 2); assert.equal(ontology.data.summary.relationships, 1); assert.equal(ontology.data.summary.documents, 1);
  const entities = await session.call<{ entities: OntologyEntitySummary[] }>('/api/ontology/entities?type=vessel&q=Ocean');
  assert.equal(entities.data.entities.length, 1);
  const detail = await session.call<{ entity: OntologyEntityDetail }>(`/api/ontology/entities/${entities.data.entities[0].id}`);
  assert.equal(detail.data.entity.claims[0].evidence[0].quote, quote); assert.equal(detail.data.entity.relationships[0].type, 'visited');
  await session.close();
  const reopened = await session.reopen();
  assert.deepEqual((await reopened.call<{ graph: GraphDocument }>(`/api/graphs/${job.graphId}`)).data, graph.data);
  assert.equal((await reopened.call<{ job: GenerationJob }>(`/api/jobs/${job.id}`)).data.job.status, 'completed');
  assert.equal((await reopened.call<{ summary: OntologySummary }>('/api/ontology')).data.summary.entities, 2);
});

test('running generation cancellation aborts the runner and saves no graph or partial ontology', async t => {
  let start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  let aborted = false;
  const session = await setup(t, async (_input, _config, options) => new Promise((_resolve, reject) => {
    const abort = () => { aborted = true; reject(new Error('Cancelled test provider.')); };
    options?.signal?.addEventListener('abort', abort, { once: true });
    if (options?.signal?.aborted) abort();
    start();
  }));
  const created = await session.call<{ job: GenerationJob }>('/api/jobs', request);
  assert.equal(created.status, 202); await started;
  const cancelled = await session.call<{ job: GenerationJob }>(`/api/jobs/${created.data.job.id}/cancel`, {});
  assert.equal(cancelled.data.job.status, 'cancelled');
  assert.equal((await terminal(session, created.data.job.id)).status, 'cancelled'); assert.equal(aborted, true);
  const counts = (await session.call<{ summary: OntologySummary }>('/api/ontology')).data.summary;
  assert.equal(counts.graphs, 0); assert.equal(counts.entities, 0); assert.equal(counts.documents, 0);
});

test('one invalid quote receives bounded repair feedback and corrected output is stored once', async t => {
  const calls: CodexInput[] = [];
  const session = await setup(t, async input => {
    calls.push(input);
    const result = extraction(input);
    if (calls.length === 1) result.relationships[0].evidence[0] = { documentId: input.documents[0].id, quote: 'This sentence does not occur in the document.' };
    return result;
  });
  const job = await create(session);
  assert.equal(job.status, 'completed', job.error); assert.equal(calls.length, 2);
  assert.match(calls[1].context ?? '', /previous extraction failed validation/);
  const counts = (await session.call<{ summary: OntologySummary }>('/api/ontology')).data.summary;
  assert.equal(counts.graphs, 1); assert.equal(counts.relationships, 1);
});

test('invalid quotations on both attempts fail without persisting claims', async t => {
  let calls = 0;
  const session = await setup(t, async input => {
    calls++;
    const result = extraction(input); result.entities[0].evidence = [{ documentId: input.documents[0].id, quote: 'Unsupported fabricated quotation.' }];
    return result;
  });
  const job = await create(session);
  assert.equal(job.status, 'failed'); assert.match(job.error ?? '', /인용문/); assert.equal(calls, 2);
  assert.equal((await session.call<{ summary: OntologySummary }>('/api/ontology')).data.summary.graphs, 0);
});

test('missing or incorrect workspace keys return 401 without provider probing or invocation', async t => {
  let runs = 0; let probes = 0;
  const session = await setup(t, async input => { runs++; return extraction(input); }, { token: 'private-workspace-test-key', onProbe: () => { probes++; } });
  const noKey = await session.call<{ error: string }>('/api/jobs', request, '');
  assert.equal(noKey.status, 401);
  assert.equal((await session.call('/api/jobs', request, 'wrong-workspace-key')).status, 401);
  assert.equal((await session.call('/api/ontology', undefined, '')).status, 401);
  const status = await session.call<{ authenticated: boolean; authRequired: boolean }>('/api/system/status', undefined, '');
  assert.equal(status.status, 200); assert.equal(status.data.authenticated, false); assert.equal(status.data.authRequired, true);
  assert.equal(runs, 0); assert.equal(probes, 0);
});

test('declared oversized API bodies receive 413 before upload with a closed connection and no provider invocation', async t => {
  let runs = 0; let probes = 0;
  const session = await setup(t, async input => { runs++; return extraction(input); }, { onProbe: () => { probes++; } });
  const body = JSON.stringify({ ...request, documents: [{ ...source, text: 'x'.repeat(2_200_001) }] });
  // Test the early Content-Length rejection before sending the body. A simultaneous large
  // fetch upload and Connection: close can race into ECONNRESET on Windows before Undici
  // exposes the response; that transport race is independent of the API's rejection.
  const response = await new Promise<{ status: number | undefined; connection: string | undefined; data: { error: string } }>((resolve, reject) => {
    const outgoing = httpRequest(`${session.base}/api/jobs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, incoming => {
      let payload = '';
      incoming.setEncoding('utf8');
      incoming.on('data', chunk => { payload += chunk; });
      incoming.once('error', reject);
      incoming.once('end', () => {
        outgoing.destroy();
        try { resolve({ status: incoming.statusCode, connection: incoming.headers.connection, data: JSON.parse(payload) }); }
        catch (error) { reject(error); }
      });
    });
    outgoing.once('error', reject);
    outgoing.setTimeout(3000, () => outgoing.destroy(new Error('Early body rejection timed out.')));
    outgoing.flushHeaders();
  });
  assert.equal(response.status, 413); assert.equal(response.connection, 'close');
  assert.match(response.data.error, /너무 큽니다/); assert.equal(runs, 0); assert.equal(probes, 0);
  assert.equal(session.backend.jobs.list().length, 0); assert.equal(session.backend.store.summary().graphs, 0);
});

test('a cross-origin request is rejected even when a valid workspace key is supplied', async t => {
  let runs = 0; let probes = 0;
  const token = 'private-workspace-test-key';
  const session = await setup(t, async input => { runs++; return extraction(input); }, { token, onProbe: () => { probes++; } });
  const response = await fetch(`${session.base}/api/jobs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Origin: 'https://unrelated.example' },
    body: JSON.stringify(request), signal: AbortSignal.timeout(3000),
  });
  assert.equal(response.status, 403); await response.json();
  assert.equal(runs, 0); assert.equal(probes, 0); assert.equal(session.backend.jobs.list().length, 0);
});

test('a source-free question reuses persisted original evidence after restart and unsupported questions fail', async t => {
  const inputs: CodexInput[] = [];
  const session = await setup(t, async input => { inputs.push(input); return extraction(input); });
  assert.equal((await create(session)).status, 'completed');
  await session.close();
  const reopened = await session.reopen();
  const second = await create(reopened, { question: 'Ocean Star Busan 방문 기록을 다시 정리해줘.', documents: [] });
  assert.equal(second.status, 'completed', second.error); assert.equal(inputs.length, 2);
  assert.match(inputs[1].documents[0].id, /^ctx-/); assert.equal(inputs[1].documents[0].text, quote);
  const counts = (await reopened.call<{ summary: OntologySummary }>('/api/ontology')).data.summary;
  assert.equal(counts.graphs, 2); assert.equal(counts.documents, 1); assert.equal(counts.entities, 2);
  const unsupported = await create(reopened, { question: 'completelyunrelatedtopic' });
  assert.equal(unsupported.status, 'failed'); assert.match(unsupported.error ?? '', /저장된 자료가 없습니다/); assert.equal(inputs.length, 2);
});

test('insufficient evidence result fails immediately without asking the model to invent entities', async t => {
  let calls = 0;
  const session = await setup(t, async input => {
    calls++;
    return { ...extraction(input), entities: [], relationships: [], events: [], findings: [], limitations: ['Insufficient evidence.'] };
  });
  const job = await create(session);
  assert.equal(job.status, 'failed'); assert.match(job.error ?? '', /근거를 찾지 못했습니다/); assert.equal(calls, 1);
  assert.equal((await session.call<{ summary: OntologySummary }>('/api/ontology')).data.summary.graphs, 0);
});

test('a file larger than 2MB is streamed, every chunk analyzed, and all result graphs remain navigable after restart', async t => {
  const parts: string[] = [];
  const session = await setup(t, async input => { parts.push(input.documents[0].id); return extraction(input); });
  const raw = `${quote}\n`.repeat(42_000);
  assert.ok(Buffer.byteLength(raw) > 2_000_000);
  const upload = await fetch(`${session.base}/api/documents/upload`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent('큰 선박 기록.txt') }, body: raw,
  });
  assert.equal(upload.status, 201);
  const { document } = await upload.json() as { document: { id: string; chunkCount: number; characters: number; bytes: number } };
  assert.equal(document.characters, raw.length); assert.equal(document.bytes, Buffer.byteLength(raw)); assert.ok(document.chunkCount > 60);
  const job = await create(session, { question: request.question, documents: [], uploadIds: [document.id] });
  assert.equal(job.status, 'completed', job.error);
  assert.equal(parts.length, document.chunkCount); assert.equal(new Set(parts).size, document.chunkCount);
  assert.equal(job.completedChunks, document.chunkCount); assert.equal(job.totalChunks, document.chunkCount); assert.equal(job.graphIds?.length, document.chunkCount);
  const lastId = job.graphIds!.at(-1)!;
  type Collection = { graphs: { id: string; title: string }[]; index: number; total: number; status: string; completedChunks: number };
  const collection = await session.call<Collection>(`/api/graphs/${lastId}/collection`);
  assert.equal(collection.status, 200); assert.equal(collection.data.index, document.chunkCount - 1); assert.equal(collection.data.total, document.chunkCount);
  assert.equal(collection.data.status, 'completed');
  // Same upload names can join across chunks; different files still need stronger identity evidence.
  assert.equal(session.backend.store.summary().entities, 2);
  await session.close();
  const reopened = await session.reopen();
  assert.equal((await reopened.call<{ document: { bytes: number } }>(`/api/documents/${document.id}`)).data.document.bytes, Buffer.byteLength(raw));
  assert.deepEqual((await reopened.call<Collection>(`/api/graphs/${lastId}/collection`)).data, collection.data);
});

test('uploaded evidence requires authorization and optional configured byte cap is enforced independently of model limits', async t => {
  let runs = 0;
  const token = 'private-workspace-test-key';
  const session = await setup(t, async input => { runs++; return extraction(input); }, { token, maxUploadBytes: 100 });
  const upload = (body: string, key: string) => fetch(`${session.base}/api/documents/upload`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'test.txt', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body,
  });
  const denied = await upload(quote, ''); assert.equal(denied.status, 401); await denied.json();
  const tooLarge = await upload('x'.repeat(101), token); assert.equal(tooLarge.status, 413); await tooLarge.json();
  const accepted = await upload(quote, token); assert.equal(accepted.status, 201);
  const { document } = await accepted.json() as { document: { id: string } };
  assert.equal((await session.call(`/api/documents/${document.id}`, undefined, '')).status, 401);
  assert.equal((await session.call('/api/jobs', { question: request.question, uploadIds: ['upload-missing'] })).status, 400);
  assert.equal(runs, 0);
});

test('HTTP resume after restart keeps earlier graph parts and analyzes only unfinished upload chunks', async t => {
  const called: string[] = []; let failOnce = true;
  const session = await setup(t, async input => {
    const id = input.documents[0].id; called.push(id);
    if (id.endsWith('-part-2') && failOnce) { failOnce = false; throw new Error('Temporary provider failure.'); }
    return extraction(input);
  });
  const response = await fetch(`${session.base}/api/documents/upload`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'resume.txt' }, body: `${quote}\n`.repeat(1300),
  });
  assert.equal(response.status, 201);
  const { document } = await response.json() as { document: { id: string; chunkCount: number } };
  assert.ok(document.chunkCount >= 3);
  const failed = await create(session, { question: request.question, uploadIds: [document.id] });
  assert.equal(failed.status, 'failed'); assert.equal(failed.completedChunks, 1); assert.equal(failed.graphIds?.length, 1); assert.equal(failed.resumable, true);
  await session.close(); const reopened = await session.reopen();
  const status = await reopened.call<{ resumableJobs: GenerationJob[] }>('/api/system/status');
  assert.ok(status.data.resumableJobs.some(job => job.id === failed.id));
  const resumed = await reopened.call<{ job: GenerationJob }>(`/api/jobs/${failed.id}/resume`, {});
  assert.equal(resumed.status, 202); assert.equal(resumed.data.job.id, failed.id);
  const finished = await terminal(reopened, failed.id);
  assert.equal(finished.status, 'completed', finished.error); assert.equal(finished.completedChunks, document.chunkCount);
  assert.equal(finished.graphIds?.[0], failed.graphIds?.[0]); assert.equal(finished.graphIds?.length, document.chunkCount);
  assert.equal(called.filter(id => id.endsWith('-part-1')).length, 1); assert.equal(called.filter(id => id.endsWith('-part-2')).length, 2);
  assert.equal((await reopened.call(`/api/jobs/${failed.id}/resume`, {})).status, 400);
});
