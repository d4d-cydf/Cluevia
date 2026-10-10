import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProductBackend, sendJson } from './product-api.ts';
import { readProductConfig } from './product-config.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Environment variables already supplied by the operator take precedence.
for (const name of ['.env.local', '.env']) {
  try { process.loadEnvFile(resolve(root, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
const config = readProductConfig(root);
const backend = await createProductBackend(config);
const dist = resolve(root, 'dist');
try { await access(resolve(dist, 'index.html')); } catch { await backend.close(); throw new Error('Build the web app first: npm run build'); }
const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const server = createServer((request, response) => backend.middleware(request, response, () => {
  void (async () => {
    if (request.method !== 'GET' && request.method !== 'HEAD') { sendJson(response, 405, { error: '지원하지 않는 요청입니다.' }); return; }
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname); } catch { sendJson(response, 400, { error: '잘못된 주소입니다.' }); return; }
    let file = resolve(dist, `.${pathname}`);
    if (!file.startsWith(dist + sep) && file !== dist) { sendJson(response, 404, { error: '파일을 찾을 수 없습니다.' }); return; }
    let details = await stat(file).catch(() => null);
    if (!details?.isFile()) {
      if (extname(pathname) && !pathname.startsWith('/case/')) { sendJson(response, 404, { error: '파일을 찾을 수 없습니다.' }); return; }
      file = resolve(dist, 'index.html'); details = await stat(file);
    }
    response.writeHead(200, { 'Content-Type': contentTypes[extname(file)] || 'application/octet-stream', 'Content-Length': details.size, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': pathname.startsWith('/assets/') ? 'public,max-age=31536000,immutable' : 'no-cache' });
    if (request.method === 'HEAD') { response.end(); return; }
    const stream = createReadStream(file); stream.on('error', () => response.destroy()); stream.pipe(response);
  })().catch(() => sendJson(response, 500, { error: '페이지를 불러오지 못했습니다.' }));
}));
// Uploads can take arbitrarily long while making progress. API bodies enforce their own idle/deadline limits.
server.requestTimeout = 0;
server.headersTimeout = 15_000;
const port = Number(process.env.PORT || 5173);
if (!Number.isInteger(port) || port < 1 || port > 65535) { await backend.close(); throw new Error('PORT must be between 1 and 65535.'); }
const host = process.env.CLUEVIA_HOST || '127.0.0.1';
server.listen(port, host, () => console.log(`Cluevia running at http://${host}:${port}`));
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  server.close(); server.closeIdleConnections();
  await backend.close();
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
server.on('error', error => { console.error(error.message); process.exitCode = 1; void shutdown(); });
