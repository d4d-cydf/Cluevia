import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { GraphValidationError, parseGraphDocument } from '../src/lib/graph-document.ts';
import type { GraphGenerationInput } from '../src/types/graph.ts';
import { parseGenerationInput, AipError } from './aip.ts';
import { probeCodex } from './codex.ts';
import { OntologyStore } from './ontology-store.ts';
import { EvidenceUploads, EvidenceUploadError } from './evidence-uploads.ts';
import { ONTOLOGY_ENTITY_TYPES, ONTOLOGY_RELATION_TYPES } from './ontology.ts';
import { JobManager } from './jobs.ts';
import { buildAnalysisCase, getAnalysisRecord, getRecordDocument } from './analysis-case.ts';
import { deleteStandaloneGraph, jobForGraph } from './case-deletion.ts';
import { CaseChat, CaseChatError } from './case-chat.ts';
import { clarify, ClarificationError, parseAnalysisBrief, parseClarificationInput } from './clarification.ts';
import type { CodexRunner } from './jobs.ts';
import type { ProductConfig } from './product-config.ts';
import type { runJevExtraction } from './jev.ts';

type Next = (error?: unknown) => void;
class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
export function sendJson(response: ServerResponse, status: number, payload: unknown) {
  if (response.destroyed || response.writableEnded) return;
  if (status === 408 || status === 413) {
    response.setHeader('Connection', 'close');
  }
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(payload));
}
function loopback(request: IncomingMessage) { return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? ''); }
function authorized(request: IncomingMessage, token: string) {
  if (!token) return loopback(request);
  const supplied = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
  const left = Buffer.from(supplied); const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}
async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'JSON 요청이 필요합니다.');
  const maximum = 2_200_000;
  if (Number(request.headers['content-length']) > maximum) throw new HttpError(413, '요청 자료가 너무 큽니다.');
  const chunks: Buffer[] = []; let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new HttpError(408, '자료 업로드 시간이 초과되었습니다.')), 15_000); });
  const iterator = request[Symbol.asyncIterator]();
  try {
    while (true) {
      const item = await Promise.race([iterator.next(), deadline]);
      if (item.done) break;
      const chunk = Buffer.isBuffer(item.value) ? item.value : Buffer.from(item.value as string);
      bytes += chunk.length;
      if (bytes > maximum) throw new HttpError(413, '요청 자료가 너무 큽니다.');
      chunks.push(chunk);
    }
  } finally { if (timer) clearTimeout(timer); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, '올바른 JSON 요청이 필요합니다.'); }
}
function parseJobInput(value: unknown): GraphGenerationInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '질문과 자료를 입력해주세요.');
  const input = value as Record<string, unknown>;
  if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 2000) throw new HttpError(400, '질문은 1–2000자로 입력해주세요.');
  const parsed: GraphGenerationInput = input.documents === undefined || (Array.isArray(input.documents) && input.documents.length === 0)
    ? { question: input.question.trim(), documents: [] } : parseGenerationInput(input);
  if (input.uploadIds !== undefined) {
    if (!Array.isArray(input.uploadIds) || input.uploadIds.length > 10 || input.uploadIds.some(id => typeof id !== 'string' || !/^upload-[a-zA-Z0-9-]{1,70}$/.test(id)) || new Set(input.uploadIds).size !== input.uploadIds.length) throw new HttpError(400, '업로드한 자료 ID를 확인해주세요.');
    parsed.uploadIds = input.uploadIds as string[];
  }
  if (parsed.documents.length + (parsed.uploadIds?.length ?? 0) > 10) throw new HttpError(400, '자료는 한 번에 최대 10개까지 첨부할 수 있습니다.');
  if (input.analysisBrief !== undefined) parsed.analysisBrief = parseAnalysisBrief(input.analysisBrief);
  return parsed;
}
function resourceId(value: string) { if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,100}$/.test(value)) throw new HttpError(400, '잘못된 항목 ID입니다.'); return value; }

/** Bound idle time, not total file size or transfer duration. No whole-file buffer is created. */
async function* uploadBody(request: IncomingMessage, signal: AbortSignal) {
  const iterator = request[Symbol.asyncIterator]();
  while (true) {
    signal.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const interrupted = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new EvidenceUploadError(408, '60초 동안 전송이 없어 업로드를 중단했습니다. 다시 시도해주세요.')), 60_000);
        abort = () => reject(new EvidenceUploadError(499, '자료 업로드가 취소되었습니다.'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      const result = await Promise.race([iterator.next(), interrupted]);
      if (result.done) return;
      yield Buffer.isBuffer(result.value) ? result.value : Buffer.from(result.value as string);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal.removeEventListener('abort', abort);
    }
  }
}

export async function createProductBackend(config: ProductConfig, dependencies: { run?: CodexRunner; probe?: typeof probeCodex; runJev?: typeof runJevExtraction } = {}) {
  await mkdir(config.dataDir, { recursive: true });
  const store = new OntologyStore(join(config.dataDir, 'ontology.sqlite'));
  if (config.seedExample) {
    try {
      const [graph, text] = await Promise.all([readFile(join(config.root, 'public/examples/gfw-galapagos.json'), 'utf8'), readFile(join(config.root, 'public/examples/gfw-source-notes.txt'), 'utf8')]);
      store.seedGfw(parseGraphDocument(JSON.parse(graph)), text);
    } catch (error) { store.close(); throw error; }
  }
  const uploads = new EvidenceUploads(store.db);
  const jobs = new JobManager(store, config.codex, dependencies.run, uploads, config.jev || config.ontologyPlanning ? { jev: config.jev, runJev: dependencies.runJev, ontologyPlanning: config.ontologyPlanning } : undefined);
  const chat = new CaseChat(store.db, config.codex, dependencies.run);
  const transfers = new Map<AbortController, Promise<unknown>>();
  const clarifications = new Map<AbortController, Promise<unknown>>();
  let closed = false;
  let probeAt = 0;
  let probeResult: Awaited<ReturnType<typeof probeCodex>> | undefined;
  let probePending: Promise<Awaited<ReturnType<typeof probeCodex>>> | undefined;
  async function provider() {
    if (!probeResult || Date.now() - probeAt > 10_000) {
      probePending ??= (dependencies.probe ?? probeCodex)(config.codex).then(result => { probeResult = result; probeAt = Date.now(); return result; }).finally(() => { probePending = undefined; });
      await probePending;
    }
    if (config.ontologyPlanning) return { kind: 'hybrid' as const, ...probeResult!, ontologyPlanning: true, message: probeResult!.available && probeResult!.authenticated !== false ? 'Codex가 온톨로지를 먼저 설계합니다. 표는 규칙으로 변환하고 문서는 Codex로 추출하며, Jev는 적합한 명시적 관계 판정에만 사용합니다.' : probeResult!.message, jev: { configured: Boolean(config.jev?.apiKey), model: config.jev?.model }, codex: probeResult! };
    if (!config.jev) return { kind: 'codex' as const, ...probeResult! };
    return { kind: 'hybrid' as const, available: true, authenticated: true,
      message: config.jev.apiKey ? 'Jev 키가 설정되어 있습니다. 표 데이터는 직접 변환하고 문서는 Jev로 판정합니다.' : '표 데이터는 바로 분석할 수 있습니다. 문서의 Jev 분석은 .env.local의 TYPESAFE_API_KEY를 설정해주세요.',
      jev: { configured: Boolean(config.jev.apiKey), model: config.jev.model }, codex: probeResult!,
    };
  }
  const middleware = (request: IncomingMessage, response: ServerResponse, next: Next) => {
    let url: URL;
    try { url = new URL(request.url || '/', 'http://localhost'); }
    catch { sendJson(response, 400, { error: '잘못된 주소입니다.' }); return; }
    if (!url.pathname.startsWith('/api/')) { next(); return; }
    void (async () => {
      try {
        if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '현재 워크스페이스에서 요청해주세요.');
        const origin = request.headers.origin;
        if (origin) {
          let host = ''; try { host = new URL(origin).host; } catch { /* Invalid origin is rejected. */ }
          if (host !== request.headers.host) throw new HttpError(403, '현재 워크스페이스에서 요청해주세요.');
        }
        const authenticated = authorized(request, config.accessToken);
        if (url.pathname === '/api/system/status' && request.method === 'GET') {
          if (!authenticated) {
            sendJson(response, 200, { authenticated: false, authRequired: true, provider: { kind: 'codex', available: false, authenticated: null, message: config.accessToken ? '워크스페이스 연결키를 입력해주세요.' : '외부 접속에는 서버의 CLUEVIA_ACCESS_TOKEN 설정이 필요합니다.' } }); return;
          }
          sendJson(response, 200, { authenticated: true, authRequired: Boolean(config.accessToken), provider: await provider(), ontology: store.summary(), activeJobs: jobs.list().filter(job => ['queued', 'running'].includes(job.status)), resumableJobs: jobs.list().filter(job => job.resumable && ['failed', 'cancelled'].includes(job.status)).slice(0, 5), upload: { maxFileBytes: config.maxUploadBytes ?? 0, chunkChars: 30_000 } }); return;
        }
        if (!authenticated) throw new HttpError(401, config.accessToken ? '워크스페이스 연결키를 확인해주세요.' : '외부 접속에는 서버의 CLUEVIA_ACCESS_TOKEN 설정이 필요합니다.');
        if (closed) throw new HttpError(503, '서버를 종료하고 있습니다. 잠시 후 다시 시도해주세요.');
        if (url.pathname === '/api/analysis/clarify' && request.method === 'POST') {
          const input = parseClarificationInput(await readJson(request));
          if (closed) throw new HttpError(503, '서버를 종료하고 있습니다. 잠시 후 다시 시도해주세요.');
          if (clarifications.size >= 2) throw new HttpError(429, '다른 요청의 범위를 정리하고 있습니다. 잠시 후 다시 시도해주세요.');
          const controller = new AbortController();
          const disconnected = () => { if (!response.writableEnded) controller.abort(); };
          request.once('aborted', disconnected); response.once('close', disconnected);
          const task = clarify(input, config.codex, dependencies.run, controller.signal);
          clarifications.set(controller, task);
          try { sendJson(response, 200, await task); }
          finally { request.off('aborted', disconnected); response.off('close', disconnected); clarifications.delete(controller); }
          return;
        }
        if (url.pathname === '/api/documents/upload' && request.method === 'POST') {
          if (request.headers['content-type']?.split(';')[0].toLowerCase() !== 'application/octet-stream') throw new HttpError(415, '파일 본문을 application/octet-stream으로 전송해주세요.');
          let name: string;
          try { name = decodeURIComponent(String(request.headers['x-file-name'] || '')); } catch { throw new HttpError(400, '파일 이름이 올바르지 않습니다.'); }
          if (transfers.size >= 3) throw new HttpError(429, '업로드가 진행 중입니다. 잠시 후 다시 시도해주세요.');
          if (config.maxUploadBytes && Number(request.headers['content-length']) > config.maxUploadBytes) throw new HttpError(413, '서버에 설정된 업로드 용량을 초과했습니다.');
          const controller = new AbortController();
          const disconnected = () => controller.abort();
          request.once('aborted', disconnected);
          const transfer = uploads.receive(name, uploadBody(request, controller.signal), { signal: controller.signal, maxBytes: config.maxUploadBytes ?? 0 });
          transfers.set(controller, transfer);
          try { sendJson(response, 201, { document: await transfer }); }
          finally { request.off('aborted', disconnected); transfers.delete(controller); }
          return;
        }
        const documentMatch = /^\/api\/documents\/([^/]+)$/.exec(url.pathname);
        if (documentMatch && request.method === 'GET') {
          const document = uploads.get(resourceId(documentMatch[1]));
          if (!document) throw new HttpError(404, '업로드한 자료를 찾을 수 없습니다.');
          sendJson(response, 200, { document }); return;
        }
        if (url.pathname === '/api/jobs' && request.method === 'POST') {
          const input = parseJobInput(await readJson(request));
          for (const id of input.uploadIds ?? []) if (!uploads.get(id)) throw new HttpError(400, '업로드가 완료된 자료를 선택해주세요.');
          if (!config.jev || config.ontologyPlanning) {
            const state = await provider();
            if (!state.available || state.authenticated === false) throw new HttpError(503, state.message);
          }
          if (jobs.list(100).filter(job => ['queued', 'running'].includes(job.status)).length >= 5) throw new HttpError(429, '대기 중인 작업이 많습니다. 기존 작업이 끝난 뒤 다시 요청해주세요.');
          sendJson(response, 202, { job: jobs.create(input) }); return;
        }
        if (url.pathname === '/api/jobs' && request.method === 'GET') { sendJson(response, 200, { jobs: jobs.list() }); return; }
        const reviewMatch = /^\/api\/jobs\/([^/]+)\/claims\/([^/]+)\/review$/.exec(url.pathname);
        if (reviewMatch && request.method === 'POST') {
          const job = jobs.get(resourceId(reviewMatch[1]));
          if (!job) throw new HttpError(404, '케이스를 찾을 수 없습니다.');
          const edgeId = resourceId(reviewMatch[2]);
          if (!buildAnalysisCase(store.db, job).graph.edges.some(edge => edge.id === edgeId)) throw new HttpError(404, '관계 주장을 찾을 수 없습니다.');
          const raw = await readJson(request) as Record<string, unknown>;
          if (!raw || !['unreviewed', 'supported', 'disputed', 'needs-review'].includes(String(raw.status)) || typeof raw.note !== 'string' || raw.note.length > 2000 || (raw.status !== 'unreviewed' && !raw.note.trim())) throw new HttpError(400, '검토 상태와 2,000자 이내의 근거를 입력해주세요.');
          const review = { status: raw.status, note: raw.note.trim(), updatedAt: new Date().toISOString() };
          store.db.exec('CREATE TABLE IF NOT EXISTS claim_reviews (job_id TEXT NOT NULL, edge_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(job_id,edge_id)); CREATE TABLE IF NOT EXISTS claim_review_history (job_id TEXT NOT NULL, edge_id TEXT NOT NULL, payload TEXT NOT NULL)');
          store.db.exec('SAVEPOINT review');
          try {
            store.db.prepare('INSERT OR REPLACE INTO claim_reviews VALUES (?,?,?)').run(job.id, edgeId, JSON.stringify(review));
            store.db.prepare('INSERT INTO claim_review_history VALUES (?,?,?)').run(job.id, edgeId, JSON.stringify(review));
            store.db.exec('RELEASE review');
          } catch (error) { store.db.exec('ROLLBACK TO review; RELEASE review'); throw error; }
          sendJson(response, 200, { review }); return;
        }
        const caseMatch = /^\/api\/jobs\/([^/]+)\/case$/.exec(url.pathname);
        const chatMatch = /^\/api\/jobs\/([^/]+)\/chat$/.exec(url.pathname);
        if (chatMatch && ['GET', 'POST'].includes(request.method ?? '')) {
          const job = jobs.get(resourceId(chatMatch[1]));
          if (!job) throw new HttpError(404, '케이스를 찾을 수 없습니다.');
          if (request.method === 'GET') { sendJson(response, 200, chat.list(job.id)); return; }
          const raw = await readJson(request) as { question?: unknown; selection?: unknown };
          if (!raw || typeof raw.question !== 'string' || !raw.question.trim() || raw.question.length > 2000) throw new HttpError(400, '질문은 1–2000자로 입력해주세요.');
          let selection: import('../src/types/graph.ts').GraphSelection;
          if (raw.selection != null) {
            const selected = raw.selection as { kind?: unknown; id?: unknown };
            if (!selected || !['node', 'edge', 'event'].includes(String(selected.kind)) || typeof selected.id !== 'string' || selected.id.length > 100) throw new HttpError(400, '선택한 그래프 항목을 확인해주세요.');
            selection = { kind: selected.kind as 'node' | 'edge' | 'event', id: selected.id };
          } else selection = null;
          sendJson(response, 202, { turn: chat.send(job, raw.question.trim(), selection) }); return;
        }
        if (caseMatch && request.method === 'GET') {
          const job = jobs.get(resourceId(caseMatch[1]));
          if (!job) throw new HttpError(404, '생성 작업을 찾을 수 없습니다.');
          sendJson(response, 200, buildAnalysisCase(store.db, job)); return;
        }
        const recordMatch = /^\/api\/jobs\/([^/]+)\/records\/(\d+)(\/document)?$/.exec(url.pathname);
        if (recordMatch && request.method === 'GET') {
          const job = jobs.get(resourceId(recordMatch[1]));
          if (!job) throw new HttpError(404, '생성 작업을 찾을 수 없습니다.');
          const number = Number(recordMatch[2]);
          if (!Number.isSafeInteger(number) || number < 1) throw new HttpError(400, '기록 번호를 확인해주세요.');
          if (recordMatch[3]) {
            const offset = Number(url.searchParams.get('offset') ?? 0);
            if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, '원문 위치를 확인해주세요.');
            const document = getRecordDocument(store.db, job, number, url.searchParams.get('id') ?? '', offset);
            if (!document) throw new HttpError(404, '이 기록의 원문을 찾을 수 없습니다.');
            sendJson(response, 200, { document }); return;
          }
          const record = getAnalysisRecord(store.db, job, number);
          if (!record) throw new HttpError(404, '분석 기록을 찾을 수 없습니다.');
          sendJson(response, 200, record); return;
        }
        const decisionsMatch = /^\/api\/jobs\/([^/]+)\/decisions$/.exec(url.pathname);
        if (decisionsMatch && request.method === 'GET') {
          const id = resourceId(decisionsMatch[1]);
          if (!jobs.get(id)) throw new HttpError(404, '생성 작업을 찾을 수 없습니다.');
          sendJson(response, 200, { decisions: jobs.decisions(id) }); return;
        }
        const resumeMatch = /^\/api\/jobs\/([^/]+)\/resume$/.exec(url.pathname);
        if (resumeMatch && request.method === 'POST') {
          const id = resourceId(resumeMatch[1]);
          if (!jobs.get(id)) throw new HttpError(404, '생성 작업을 찾을 수 없습니다.');
          if (!config.jev || config.ontologyPlanning) {
            const state = await provider();
            if (!state.available || state.authenticated === false) throw new HttpError(503, state.message);
          }
          try { sendJson(response, 202, { job: jobs.resume(id) }); }
          catch (error) { throw new HttpError(400, error instanceof Error ? error.message : '작업을 이어서 실행할 수 없습니다.'); }
          return;
        }
        const jobMatch = /^\/api\/jobs\/([^/]+)(\/cancel)?$/.exec(url.pathname);
        if (jobMatch && !jobMatch[2] && request.method === 'DELETE') {
          const id = resourceId(jobMatch[1]);
          if (!jobs.get(id)) throw new HttpError(404, '삭제할 케이스를 찾을 수 없습니다.');
          await chat.remove(id);
          sendJson(response, 200, { deleted: true, graphIds: await jobs.remove(id) }); return;
        }
        if (jobMatch && ((jobMatch[2] && request.method === 'POST') || (!jobMatch[2] && request.method === 'GET'))) {
          const id = resourceId(jobMatch[1]); const job = jobMatch[2] ? jobs.cancel(id) : jobs.get(id);
          if (!job) throw new HttpError(404, '생성 작업을 찾을 수 없습니다.');
          sendJson(response, 200, { job }); return;
        }
        if (url.pathname === '/api/graphs' && request.method === 'GET') { sendJson(response, 200, { graphs: store.listGraphs() }); return; }
        if (url.pathname === '/api/graphs/import' && request.method === 'POST') {
          const input = await readJson(request);
          if (!input || typeof input !== 'object' || !('graph' in input)) throw new HttpError(400, '그래프 JSON을 선택해주세요.');
          const graph = parseGraphDocument((input as { graph: unknown }).graph);
          // A graph export is a display archive, not an authenticated ontology definition or raw extraction.
          const archive = { ...graph, origin: 'imported' as const, ontologyId: undefined, ontologyVersion: undefined, limitations: graph.ontologyId ? [...graph.limitations.slice(0, 19), '그래프 표시본을 가져왔습니다. 원래 온톨로지 정의와 검증된 객체 데이터는 별도로 포함되지 않았습니다.'] : graph.limitations };
          sendJson(response, 201, { graph: store.saveGraph(archive) }); return;
        }
        const collectionMatch = /^\/api\/graphs\/([^/]+)\/collection$/.exec(url.pathname);
        if (collectionMatch && request.method === 'GET') {
          const id = resourceId(collectionMatch[1]);
          const graph = store.getGraph(id);
          if (!graph) throw new HttpError(404, '저장된 그래프를 찾을 수 없습니다.');
          const linked = config.jev || config.ontologyPlanning ? store.db.prepare('SELECT job_id FROM analysis_parts WHERE graph_id=? LIMIT 1').get(id) : undefined;
          const row = linked ? undefined : store.db.prepare("SELECT id FROM generation_jobs WHERE EXISTS (SELECT 1 FROM json_each(payload, '$.graphIds') WHERE value = ?) OR json_extract(payload, '$.graphId') = ? ORDER BY created_at DESC LIMIT 1").get(id, id);
          const job = linked ? jobs.get(String(linked.job_id)) : row ? jobs.get(String(row.id)) : undefined;
          const ids = job?.graphIds?.length ? job.graphIds : [id];
          const graphs = ids.flatMap(graphId => { const item = store.db.prepare('SELECT id,title FROM graphs WHERE id = ?').get(graphId); return item ? [{ id: String(item.id), title: String(item.title) }] : []; });
          sendJson(response, 200, { jobId: job?.id ?? null, graphs, index: graphs.findIndex(item => item.id === id), total: graphs.length, status: job?.status ?? 'completed', completedChunks: job?.completedChunks ?? 1, totalChunks: job?.totalChunks ?? 1, emptyChunks: job?.emptyChunks ?? 0, resumable: job?.resumable ?? false }); return;
        }
        const graphMatch = /^\/api\/graphs\/([^/]+)$/.exec(url.pathname);
        if (graphMatch && request.method === 'DELETE') {
          const id = resourceId(graphMatch[1]);
          if (jobForGraph(store.db, id)) throw new HttpError(409, '분석에 속한 그래프는 케이스 전체를 삭제해주세요.');
          if (!deleteStandaloneGraph(store.db, id)) throw new HttpError(404, '삭제할 그래프를 찾을 수 없습니다.');
          sendJson(response, 200, { deleted: true }); return;
        }
        if (graphMatch && request.method === 'GET') {
          const graph = store.getGraph(resourceId(graphMatch[1]));
          if (!graph) throw new HttpError(404, '저장된 그래프를 찾을 수 없습니다.');
          sendJson(response, 200, { graph }); return;
        }
        if (url.pathname === '/api/ontology' && request.method === 'GET') {
          sendJson(response, 200, { summary: store.summary(), definitions: store.listDefinitions(), schema: { version: '1.0', entityTypes: ONTOLOGY_ENTITY_TYPES, relationTypes: ONTOLOGY_RELATION_TYPES } }); return;
        }
        const definitionMatch = /^\/api\/ontology\/definitions\/([^/]+)$/.exec(url.pathname);
        if (definitionMatch && request.method === 'GET') {
          const definition = store.getDefinition(resourceId(definitionMatch[1]));
          if (!definition) throw new HttpError(404, '온톨로지 정의를 찾지 못했습니다.');
          sendJson(response, 200, { definition }); return;
        }
        if (url.pathname === '/api/ontology/entities' && request.method === 'GET') { sendJson(response, 200, { entities: store.listEntities((url.searchParams.get('q') || '').slice(0, 200), url.searchParams.get('type') || undefined, url.searchParams.get('ontologyId') || undefined) }); return; }
        const identityMatch = /^\/api\/ontology\/entities\/([^/]+)\/identity$/.exec(url.pathname);
        if (identityMatch && request.method === 'POST') {
          const raw = await readJson(request) as Record<string, unknown>;
          if (!raw || typeof raw.target !== 'string' || !['linked', 'rejected', 'unreviewed'].includes(String(raw.status)) || typeof raw.note !== 'string' || raw.note.length > 2000) throw new HttpError(400, '동일 객체 판단 근거를 확인해주세요.');
          try { sendJson(response, 200, { candidates: store.reviewIdentity(resourceId(identityMatch[1]), resourceId(raw.target), String(raw.status), raw.note) }); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : '후보 검토 실패'); }
          return;
        }
        const entityMatch = /^\/api\/ontology\/entities\/([^/]+)$/.exec(url.pathname);
        if (entityMatch && request.method === 'GET') {
          const entity = store.getEntity(resourceId(entityMatch[1]));
          if (!entity) throw new HttpError(404, '저장된 객체를 찾을 수 없습니다.');
          sendJson(response, 200, { entity }); return;
        }
        throw new HttpError(404, '요청한 API를 찾을 수 없습니다.');
      } catch (error) {
        if (url.pathname === '/api/documents/upload' && !response.headersSent) response.setHeader('Connection', 'close');
        const expected = error instanceof HttpError || error instanceof AipError || error instanceof EvidenceUploadError || error instanceof CaseChatError || error instanceof ClarificationError;
        sendJson(response, expected ? error.status : error instanceof GraphValidationError ? 400 : 500, { error: expected || error instanceof GraphValidationError ? error.message : '요청을 처리하지 못했습니다. 서버 상태를 확인해주세요.' });
      }
    })();
  };
  return { middleware, store, jobs, uploads, async close() { if (closed) return; closed = true; for (const controller of transfers.keys()) controller.abort(); for (const controller of clarifications.keys()) controller.abort(); await Promise.allSettled([...transfers.values(), ...clarifications.values()]); await chat.close(); await jobs.close(); store.close(); } };
}
