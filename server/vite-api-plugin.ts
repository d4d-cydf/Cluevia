import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadEnv } from 'vite';
import type { Connect, Plugin, ResolvedConfig } from 'vite';
import { AipError, generateAipGraph, MAX_REQUEST_BYTES, readAipConfiguration } from './aip.ts';
import type { AipConfiguration } from './aip.ts';

function sendJson(response: ServerResponse, status: number, payload: unknown) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (status === 408 || status === 413) response.setHeader('Connection', 'close');
  response.end(JSON.stringify(payload));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new AipError(415, 'application/json 요청이 필요합니다.');
  if (Number(request.headers['content-length']) > MAX_REQUEST_BYTES) throw new AipError(413, '요청은 1MB 이하여야 합니다.');
  const chunks: Buffer[] = [];
  let bytes = 0;
  const iterator = request[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new AipError(408, '자료 업로드 시간이 초과되었습니다.')), 15_000); });
  try {
    while (true) {
      const part = await Promise.race([iterator.next(), deadline]);
      if (part.done) break;
      const chunk = Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value as string);
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BYTES) throw new AipError(413, '요청은 1MB 이하여야 합니다.');
      chunks.push(chunk);
    }
  } finally { if (timer) clearTimeout(timer); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AipError(400, '올바른 JSON 요청이 필요합니다.'); }
}

/** Local development/preview API. A static dist deployment needs its own server. */
export function createAipMiddleware(configuration: AipConfiguration, options: { fetch?: typeof fetch } = {}): Connect.NextHandleFunction {
  let active = false;
  return (request, response, next) => {
    const path = request.url?.split('?')[0];
    if (path !== '/api/aip/status' && path !== '/api/graphs/generate') { next(); return; }
    if (path === '/api/aip/status') {
      if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); sendJson(response, 405, { error: 'GET 요청이 필요합니다.' }); return; }
      sendJson(response, 200, { configured: configuration.configured, missing: configuration.missing });
      return;
    }
    if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); sendJson(response, 405, { error: 'POST 요청이 필요합니다.' }); return; }
    const origin = request.headers.origin;
    if (request.headers['sec-fetch-site'] === 'cross-site' || (origin && (() => { try { return new URL(origin).host !== request.headers.host; } catch { return true; } })())) { sendJson(response, 403, { error: '현재 웹 앱에서 요청해 주세요.' }); return; }
    if (active) { sendJson(response, 429, { error: '그래프를 생성하고 있습니다. 현재 작업이 끝난 후 다시 시도해 주세요.' }); return; }
    active = true;
    const controller = new AbortController();
    const abortRequest = () => controller.abort();
    const closeResponse = () => { if (!response.writableEnded) controller.abort(); };
    request.once('aborted', abortRequest);
    response.once('close', closeResponse);
    void (async () => {
      try {
        const input = await readJson(request);
        const graph = await generateAipGraph(input, configuration, { fetch: options.fetch, signal: controller.signal });
        if (!response.destroyed && !response.writableEnded) sendJson(response, 200, { graph });
      } catch (error) {
        const expected = error instanceof AipError;
        if (!response.destroyed && !response.writableEnded) sendJson(response, expected ? error.status : 500, { error: expected ? error.message : '그래프 요청을 처리하지 못했습니다.' });
      } finally {
        active = false;
        request.removeListener('aborted', abortRequest);
        response.removeListener('close', closeResponse);
      }
    })();
  };
}

export function aipApiPlugin(): Plugin {
  let resolved: ResolvedConfig;
  const configure = (middlewares: Connect.Server) => {
    const environment = { ...loadEnv(resolved.mode, resolved.envDir, 'FOUNDRY_'), ...process.env };
    middlewares.use(createAipMiddleware(readAipConfiguration(environment)));
  };
  return {
    name: 'cluevia-aip-api',
    configResolved(config) { resolved = config; },
    configureServer(server) { configure(server.middlewares); },
    configurePreviewServer(server) { configure(server.middlewares); },
  };
}
