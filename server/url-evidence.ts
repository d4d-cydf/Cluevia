import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { EvidenceDocument } from '../src/types/graph.ts';
import { isStructuredName } from './structured-ingest.ts';

const MAX_URLS = 8;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 60_000;
const REQUEST_MS = 10_000;
const TOTAL_MS = 25_000;
const MAX_REDIRECTS = 3;

export interface UrlEvidenceRead {
  documentId: string;
  url: string;
  status: 'fetched' | 'failed';
  finalUrl?: string;
  title?: string;
  characters?: number;
  truncated?: boolean;
  reason?: string;
}
interface Address { address: string; family: number }
interface ArticleResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  close: () => void;
}
/** Dependency injection is used by offline tests; callers use the bounded reader below. */
export interface UrlEvidenceDependencies {
  lookup: (hostname: string) => Promise<Address[]>;
  request: (url: URL, address: Address, signal: AbortSignal) => Promise<ArticleResponse>;
}
interface Article { text: string; title: string; finalUrl: string; truncated: boolean }

/** Only global unicast addresses are eligible for server-side article reads. */
export function isPublicEvidenceAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6 || address.includes('.') || address.includes('%')) return false;
  const [first, second = 0] = address.split(':').slice(0, 2).map(part => Number.parseInt(part || '0', 16));
  // Conservatively exclude special-purpose, documentation and transition ranges.
  return first >= 0x2000 && first <= 0x3fff
    && !(first === 0x2001 && (second <= 0x01ff || second === 0x0db8))
    && first !== 0x2002 && !(first === 0x3fff && second <= 0x0fff);
}

function articleUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('올바른 웹 주소가 아닙니다.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('공개 HTTP·HTTPS 웹 문서만 읽을 수 있습니다.');
  if (url.username || url.password) throw new Error('로그인 정보가 포함된 주소는 읽지 않습니다.');
  if (url.port && !((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443'))) throw new Error('일반 웹 포트의 공개 문서만 읽을 수 있습니다.');
  const host = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase().replace(/\.$/u, '');
  if (!host || host === 'localhost' || /\.(?:localhost|local|internal|home|lan)$/u.test(host) || (!host.includes('.') && !isIP(host))) throw new Error('로컬 또는 내부 주소는 읽지 않습니다.');
  url.hash = '';
  return url;
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([promise, stopped]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

const network: UrlEvidenceDependencies = {
  lookup: hostname => dnsLookup(hostname, { all: true, verbatim: true }),
  request: (url, address, signal) => new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET', agent: false, signal, family: address.family,
      // Resolve once, validate all answers, then pin this connection to that answer.
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      headers: { 'User-Agent': 'Cluevia/0.1 (+public-source-reader)', Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9', 'Accept-Encoding': 'identity' },
    }, response => {
      const headers = Object.fromEntries(['content-type', 'content-length', 'content-encoding', 'location'].map(key => [key, typeof response.headers[key] === 'string' ? response.headers[key] : undefined]));
      resolve({ status: response.statusCode ?? 0, headers, body: response, close: () => { response.destroy(); request.destroy(); } });
    });
    request.once('error', reject);
    request.end();
  }),
};

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', bull: '•', middot: '·', copy: '©' };
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (original, entity: string) => {
    if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? original;
    const value = Number.parseInt(entity.slice(entity[1].toLowerCase() === 'x' ? 2 : 1), entity[1].toLowerCase() === 'x' ? 16 : 10);
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : ' ';
  });
}
function visibleText(html: string): string {
  return decodeEntities(html
    .replace(/<!--[^]*?-->/gu, ' ')
    .replace(/<(script|style|noscript|template|svg|nav|footer|form)\b[^>]*>[^]*?<\/\1\s*>/giu, ' ')
    .replace(/<(?:br|hr)\b[^>]*>|<\/(?:p|div|section|article|main|h[1-6]|li|tr|blockquote)\s*>/giu, '\n')
    .replace(/<(?:"[^"]*"|'[^']*'|[^'">])*>/gu, ' '))
    .replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/gu, '')
    .replace(/[\t \f\v\u00a0]+/gu, ' ').replace(/ *\n */gu, '\n').replace(/\n{3,}/gu, '\n\n').trim();
}

/** Common CMS article containers are sometimes outside the page's <main>
 * elements. Read their balanced content, without executing page scripts. */
function articleRegions(html: string): string[] {
  const regions: string[] = [];
  const opening = /<(div|section)\b(?:"[^"]*"|'[^']*'|[^'">])*>/giu;
  const marker = /\b(?:class|id)\s*=\s*(["'])([^]*?)\1/giu;
  let candidates = 0;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(html)) && regions.length < 32) {
    const marked = [...match[0].matchAll(marker)].some(attribute => attribute[2].split(/\s+/u).some(name => /^(?:article-(?:body|content|text)(?:-wrapper)?|story-(?:body|content)|entry-content|post-content)$/iu.test(name)));
    if (!marked) continue;
    if (candidates++ >= 32) break;
    const tag = match[1].toLowerCase();
    const tokens = new RegExp(`<(/?)${tag}\\b(?:"[^"]*"|'[^']*'|[^'">])*>`, 'giu');
    tokens.lastIndex = opening.lastIndex;
    let depth = 1; let token: RegExpExecArray | null;
    while ((token = tokens.exec(html))) {
      depth += token[1] ? -1 : /\/\s*>$/u.test(token[0]) ? 0 : 1;
      if (!depth) { regions.push(visibleText(html.slice(opening.lastIndex, token.index))); break; }
    }
  }
  return regions;
}

/** Extracts supplied page text only. It never creates a summary or follows page links. */
export function extractArticleText(raw: string, contentType: string): { text: string; title: string } {
  if (contentType.split(';')[0].trim().toLowerCase() === 'text/plain') return { text: raw.trim(), title: '' };
  const title = visibleText(raw.match(/<title\b[^>]*>([^]*?)<\/title\s*>/iu)?.[1] ?? '').slice(0, 300);
  const clean = raw.replace(/<!--[^]*?-->/gu, ' ').replace(/<(script|style|noscript|template|svg)\b[^>]*>[^]*?<\/\1\s*>/giu, ' ');
  const articles = [...clean.matchAll(/<article\b[^>]*>([^]*?)<\/article\s*>/giu)].map(match => visibleText(match[1]));
  articles.push(...articleRegions(clean));
  // Some publishers place an account dialog in a separate <main> before the
  // actual article. Inspect every content region instead of taking that modal.
  const mains = [...clean.matchAll(/<main\b[^>]*>([^]*?)<\/main\s*>/giu)].map(match => visibleText(match[1]));
  const main = mains.sort((a, b) => b.length - a.length)[0];
  const body = clean.match(/<body\b[^>]*>([^]*?)<\/body\s*>/iu)?.[1] ?? clean.replace(/<head\b[^>]*>[^]*?<\/head\s*>/giu, ' ');
  const article = articles.sort((a, b) => b.length - a.length)[0];
  // Article headers can carry the publication date/byline, so keep them. Only
  // strip the site-wide header when there is no article/main container.
  const text = article && article.length >= 120 ? article : main ?? visibleText(body.replace(/<header\b[^>]*>[^]*?<\/header\s*>/giu, ' '));
  return { text: title && !text.startsWith(title) ? `${title}\n\n${text}` : text, title };
}

async function readArticle(raw: string, signal: AbortSignal, dependencies: UrlEvidenceDependencies): Promise<Article> {
  let target = articleUrl(raw);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    signal.throwIfAborted();
    const hostname = target.hostname.replace(/^\[|\]$/gu, '');
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await abortable(dependencies.lookup(hostname), signal);
    if (!addresses.length || addresses.some(address => !isPublicEvidenceAddress(address.address))) throw new Error('공개 인터넷의 문서 주소로 확인되지 않았습니다.');
    const response = await abortable(dependencies.request(target, addresses[0], signal), signal);
    try {
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.headers.location || redirect === MAX_REDIRECTS) throw new Error('문서의 이동 경로를 확인하지 못했습니다.');
        target = articleUrl(new URL(response.headers.location, target).href);
        continue;
      }
      if (response.status < 200 || response.status >= 300) throw new Error(`원문 서버가 본문을 제공하지 않았습니다 (HTTP ${response.status}).`);
      const contentType = response.headers['content-type'] ?? '';
      if (!/^(?:text\/(?:html|plain)|application\/xhtml\+xml)(?:;|$)/iu.test(contentType)) throw new Error('이 링크는 바로 읽을 수 있는 HTML·텍스트 문서가 아닙니다. 문서 내용을 텍스트로 첨부해주세요.');
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new Error('원문 서버의 압축 응답을 직접 읽지 못했습니다. 본문 텍스트를 첨부해주세요.');
      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error('원문 크기가 2 MB 읽기 한도를 넘었습니다. 필요한 본문을 첨부해주세요.');
      const chunks: Uint8Array[] = []; let size = 0;
      const iterator = response.body[Symbol.asyncIterator]();
      while (true) {
        const part = await abortable(iterator.next(), signal);
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_BYTES) throw new Error('원문 크기가 2 MB 읽기 한도를 넘었습니다. 필요한 본문을 첨부해주세요.');
        chunks.push(part.value);
      }
      const encoding = /charset\s*=\s*["']?([^;\s"']+)/iu.exec(contentType)?.[1] ?? 'utf-8';
      let rawText: string;
      try { rawText = new TextDecoder(encoding, { fatal: true }).decode(Buffer.concat(chunks)); }
      catch { throw new Error('원문의 문자 인코딩을 읽지 못했습니다. UTF-8 텍스트로 첨부해주세요.'); }
      const article = extractArticleText(rawText, contentType);
      if (/^(?:just a moment|access denied|attention required|verify (?:you are|your)|robot check|sign in|log in)(?:[!.\s]|$)/iu.test(article.title)) throw new Error('원문 사이트의 접근 확인 또는 로그인 화면만 받았습니다. 본문을 직접 첨부해주세요.');
      const bodyText = article.title && article.text.startsWith(article.title) ? article.text.slice(article.title.length).trim() : article.text;
      if (bodyText.length < 80) throw new Error('링크에서 분석할 만한 본문을 읽지 못했습니다. 본문 텍스트를 첨부해주세요.');
      return { text: article.text.slice(0, MAX_TEXT), title: article.title, finalUrl: target.href, truncated: article.text.length > MAX_TEXT };
    } finally { response.close(); }
  }
  throw new Error('문서의 이동 경로를 확인하지 못했습니다.');
}

/** Reads only stand-alone URL lines explicitly supplied by the user. Other prose
 * stays intact. Embedded citations and links inside downloaded pages are not crawled.
 * Failed URLs are returned as results, never promoted to factual source content. */
export async function resolveUrlEvidence(
  documents: EvidenceDocument[],
  options: { signal?: AbortSignal; progress?: (message: string) => void } = {},
  dependencies: UrlEvidenceDependencies = network,
): Promise<{ documents: EvidenceDocument[]; results: UrlEvidenceRead[] }> {
  options.signal?.throwIfAborted();
  const entries: { document: EvidenceDocument; url: string; index: number }[] = [];
  const retained: EvidenceDocument[] = [];
  for (const document of documents) {
    // URLs in table cells are data; only free text is an instruction to read links.
    if (isStructuredName(document.name)) { retained.push(document); continue; }
    const before = entries.length;
    const other: string[] = [];
    const urls = new Set<string>();
    for (const line of document.text.split(/(?<=\n)/u)) {
      const url = line.trim();
      if (/^[a-z][a-z\d+.-]*:\/\/\S+$/iu.test(url)) {
        if (!urls.has(url)) { entries.push({ document, url, index: entries.length }); urls.add(url); }
      }
      else other.push(line);
    }
    if (entries.length === before) retained.push(document);
    else if (other.join('').trim()) retained.push({ ...document, text: other.join('') });
  }
  if (!entries.length) return { documents, results: [] };
  const deadline = AbortSignal.timeout(TOTAL_MS);
  const totalSignal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const resultDocuments: (EvidenceDocument | undefined)[] = new Array(entries.length);
  const results: UrlEvidenceRead[] = new Array(entries.length);
  const reads = new Map<string, Promise<Article>>();
  let next = 0; let finished = 0;
  options.progress?.(`링크 ${entries.length}개의 원문을 읽고 있습니다.`);
  async function worker() {
    while (next < entries.length) {
      options.signal?.throwIfAborted();
      const entry = entries[next++];
      const { url, document, index } = entry;
      try {
        let promise = reads.get(url);
        if (!promise) {
          if (reads.size >= MAX_URLS) throw new Error('한 번에 최대 8개 링크를 읽습니다. 나머지 본문은 추가 자료로 첨부해주세요.');
          const signal = AbortSignal.any([totalSignal, AbortSignal.timeout(REQUEST_MS)]);
          promise = readArticle(url, signal, dependencies);
          reads.set(url, promise);
        }
        const article = await promise;
        const digest = createHash('sha256').update(url).digest('hex');
        const id = `url-${createHash('sha256').update(`${document.id}|${url}`).digest('hex').slice(0, 32)}`;
        resultDocuments[index] = { id, name: document.name, text: article.text, url, identityScope: `url-${digest}` };
        results[index] = { documentId: document.id, url, status: 'fetched', finalUrl: article.finalUrl, title: article.title, characters: article.text.length, truncated: article.truncated };
      } catch (error) {
        options.signal?.throwIfAborted();
        const reason = error instanceof Error && error.name !== 'AbortError' && error.name !== 'TimeoutError' && !('code' in error)
          ? error.message : '제한 시간 안에 원문에 연결하지 못했습니다. 본문을 직접 첨부하거나 다시 시도해주세요.';
        results[index] = { documentId: document.id, url, status: 'failed', reason };
      }
      finished++;
      options.progress?.(`링크 원문 ${finished}/${entries.length}개 확인 · ${results.filter(result => result?.status === 'fetched').length}개 읽음`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, entries.length) }, worker));
  return { documents: [...retained, ...resultDocuments.filter((document): document is EvidenceDocument => Boolean(document))], results };
}
