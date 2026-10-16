import assert from 'node:assert/strict';
import test from 'node:test';
import { extractArticleText, isPublicEvidenceAddress, resolveUrlEvidence } from './url-evidence.ts';
import type { UrlEvidenceDependencies } from './url-evidence.ts';

const article = '관계 당국은 2024년 12월 쿠르스크에서 북한군이 러시아군과 함께 전투에 참여했다고 발표했다. 이 보도는 현장에 배치된 병력과 실제 전투 참여를 구분해서 설명한다. 발표의 근거와 독립 확인 여부는 따로 검토해야 한다.';
const source = (text: string, id = 'pasted') => ({ id, name: 'Pasted source text', text });
function fixture(body: string, headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' }, status = 200) {
  return { status, headers, body: (async function* () { yield Buffer.from(body); })(), close() {} };
}
function dependencies(request?: UrlEvidenceDependencies['request']): UrlEvidenceDependencies {
  return { lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: request ?? (async () => fixture(`<title>발표 내용</title><article><p>${article}</p></article>`)) };
}

test('article reads preserve URL provenance and source names while excluding page navigation and scripts', async () => {
  const observed: string[] = [];
  const dep = dependencies(async (url, address) => {
    observed.push(url.href); assert.equal(address.address, '93.184.216.34');
    return fixture(`<html><head><title>Kursk &amp; evidence</title><script>not source facts</script></head><body><nav>Subscribe now</nav><article><header>2024-12-17 · 현장 기자</header><h1>현장 보도</h1><p>${article}</p></article><footer>Other stories</footer></body></html>`);
  });
  const result = await resolveUrlEvidence([source('https://news.example/article')], {}, dep);
  assert.deepEqual(observed, ['https://news.example/article']);
  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0].name, 'Pasted source text');
  assert.equal(result.documents[0].url, 'https://news.example/article');
  assert.ok(result.documents[0].id.length <= 80);
  assert.match(result.documents[0].text, /Kursk & evidence/);
  assert.match(result.documents[0].text, /쿠르스크/);
  assert.match(result.documents[0].text, /2024-12-17 · 현장 기자/);
  assert.doesNotMatch(result.documents[0].text, /not source facts|Subscribe|Other stories/);
  assert.deepEqual(result.results.map(read => [read.status, read.finalUrl, read.truncated]), [['fetched', 'https://news.example/article', false]]);
});

test('stand-alone links are resolved, adjacent user prose stays intact, embedded citations are not crawled', async () => {
  let requests = 0;
  const original = source('사실 여부를 확인해주세요.\r\nhttps://news.example/a\r\n관찰: 12월 발표를 참고했다 (https://news.example/citation).\r\n');
  const untouched = source('원래\r\n텍스트\r\n', 'other');
  const result = await resolveUrlEvidence([original, untouched], {}, dependencies(async () => { requests++; return fixture(article, { 'content-type': 'text/plain' }); }));
  assert.equal(requests, 1);
  assert.equal(result.documents[0].text, '사실 여부를 확인해주세요.\r\n관찰: 12월 발표를 참고했다 (https://news.example/citation).\r\n');
  assert.equal(result.documents[1], untouched);
  assert.equal(original.text.includes('https://news.example/a'), true, 'Original input is never mutated.');
});

test('an account modal before the substantive main region is not mistaken for the article', async () => {
  const body = `<html><head><title>Official statement</title></head><body>
    <main><h2>Media account</h2><p>Download our videos. Log in or create an account to continue.</p></main>
    <main><header>2024-12-17 · Official transcript</header><h1>Statement</h1><p>${article}</p><p>${article}</p></main>
    </body></html>`;
  const result = await resolveUrlEvidence([source('https://publisher.example/statement')], {}, dependencies(async () => fixture(body)));
  assert.equal(result.results[0].status, 'fetched');
  assert.match(result.documents[0].text, /Official transcript/);
  assert.ok(result.documents[0].text.includes(article));
  assert.doesNotMatch(result.documents[0].text, /Media account|Log in|Download our videos/);
});

test('CMS article text outside account main regions retains nested paragraphs without login content', async () => {
  const body = `<html><head><title>Official transcript</title></head><body>
    <main><h2>Media account</h2><p>${'Log in to download multimedia. '.repeat(8)}</p></main>
    <main><h2>Create account</h2><p>${'Enter your registration details. '.repeat(10)}</p></main>
    <div class="article-text-wrapper"><div class="cmp-text" data-layer='{"text":"&lt;p>Hidden attribute copy&lt;/p>"}'><div><p>${article}</p></div><p>둘째 문단에는 발표의 제한과 후속 확인 절차가 기록되어 있습니다.</p></div></div>
    <div>Unrelated page footer</div></body></html>`;
  const result = await resolveUrlEvidence([source('https://publisher.example/transcript')], {}, dependencies(async () => fixture(body)));
  assert.equal(result.results[0].status, 'fetched');
  assert.ok(result.documents[0].text.includes(article));
  assert.match(result.documents[0].text, /둘째 문단/);
  assert.doesNotMatch(result.documents[0].text, /Log in|registration details|Unrelated page footer|Hidden attribute copy/);
});

test('redirects are resolved with checked addresses and audit keeps both original and final URLs', async () => {
  const lookups: string[] = []; let closes = 0;
  const dep = dependencies(async url => ({ ...fixture(url.pathname === '/start' ? '' : article, url.pathname === '/start' ? { location: 'https://publisher.example/full' } : { 'content-type': 'text/plain' }, url.pathname === '/start' ? 302 : 200), close() { closes++; } }));
  dep.lookup = async hostname => { lookups.push(hostname); return [{ address: '93.184.216.34', family: 4 }]; };
  const result = await resolveUrlEvidence([source('https://news.example/start')], {}, dep);
  assert.deepEqual(lookups, ['news.example', 'publisher.example']);
  assert.equal(result.documents[0].url, 'https://news.example/start');
  assert.equal(result.results[0].finalUrl, 'https://publisher.example/full');
  assert.equal(closes, 2);
});

test('URL values inside structured records stay data without network reads', async () => {
  const documents = [{ id: 'table', name: 'articles.csv', text: 'url,title\nhttps://news.example/a,Report\n' }];
  const result = await resolveUrlEvidence(documents, {}, dependencies(async () => { throw new Error('Structured records must not trigger requests.'); }));
  assert.deepEqual(result.documents, documents);
  assert.deepEqual(result.results, []);
});

test('address eligibility excludes local, reserved and special-purpose ranges without any network calls', () => {
  for (const address of ['127.0.0.1', '10.20.30.40', '172.16.1.1', '192.168.0.1', '100.64.1.1', '169.254.1.1', '0.0.0.0', '198.18.0.1', '192.0.2.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002::1']) assert.equal(isPublicEvidenceAddress(address), false, address);
  for (const address of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicEvidenceAddress(address), true, address);
});

test('unsupported, credentialed, local and non-web-port inputs fail before requesting any content', async () => {
  let requests = 0;
  const dep = dependencies(async () => { requests++; throw new Error('Should not request'); });
  const result = await resolveUrlEvidence([source(['file:///tmp/article', 'http://localhost/article', 'https://user:password@news.example/article', 'https://news.example:8443/article'].join('\n'))], {}, dep);
  assert.equal(requests, 0); assert.equal(result.documents.length, 0);
  assert.ok(result.results.every(read => read.status === 'failed' && read.reason));
});

test('non-public DNS answers and redirected addresses are rejected using offline resolver fixtures', async () => {
  let requests = 0;
  const dep = dependencies(async () => { requests++; return fixture('', { location: 'https://private.example/story' }, 302); });
  dep.lookup = async hostname => hostname === 'private.example' ? [{ address: '192.168.1.1', family: 4 }] : [{ address: '93.184.216.34', family: 4 }];
  const result = await resolveUrlEvidence([source('https://news.example/start')], {}, dep);
  assert.equal(requests, 1); assert.equal(result.results[0].status, 'failed');
  assert.match(result.results[0].reason!, /공개 인터넷/);
  const mixed = await resolveUrlEvidence([source('https://news.example/start')], {}, { ...dep, lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }] });
  assert.equal(requests, 1); assert.equal(mixed.documents.length, 0);
});

test('HTTP errors, login pages, unsupported documents and excessive bodies are reported without invented evidence', async () => {
  const responses = [fixture('Blocked', { 'content-type': 'text/html' }, 403), fixture(`<title>Just a moment...</title><p>${article}</p>`), fixture('%PDF-1.0', { 'content-type': 'application/pdf' }), fixture(article, { 'content-type': 'text/plain', 'content-length': '3000000' }), fixture('x'.repeat(2 * 1024 * 1024 + 1), { 'content-type': 'text/plain' })];
  let closed = 0;
  const dep = dependencies(async () => ({ ...responses.shift()!, close() { closed++; } }));
  const result = await resolveUrlEvidence([source(Array.from({ length: 5 }, (_, index) => `https://news.example/${index}`).join('\n'))], {}, dep);
  assert.equal(result.documents.length, 0); assert.equal(closed, 5);
  assert.match(result.results[0].reason!, /HTTP 403/);
  assert.match(result.results[1].reason!, /로그인/);
  assert.match(result.results[2].reason!, /HTML·텍스트/);
  assert.match(result.results[3].reason!, /2 MB/);
  assert.match(result.results[4].reason!, /2 MB/);
});

test('duplicate pasted URLs share a single read and retained text has an explicit truncation audit', async () => {
  let requests = 0;
  const result = await resolveUrlEvidence([source('https://news.example/a\nhttps://news.example/a'), source('https://news.example/a', 'second')], {}, dependencies(async () => { requests++; return fixture(article.repeat(600), { 'content-type': 'text/plain' }); }));
  assert.equal(requests, 1); assert.equal(result.documents.length, 2);
  assert.notEqual(result.documents[0].id, result.documents[1].id);
  assert.equal(result.documents[0].identityScope, result.documents[1].identityScope);
  assert.equal(result.documents[0].text.length, 60_000);
  assert.ok(result.results.every(read => read.truncated && read.characters === 60_000));
});

test('URL count and concurrent reads are bounded; unread links remain in the audit', async () => {
  let active = 0; let peak = 0; let requests = 0;
  const result = await resolveUrlEvidence([source(Array.from({ length: 12 }, (_, index) => `https://news.example/${index}`).join('\n'))], {}, dependencies(async () => {
    requests++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 1)); active--;
    return fixture(article, { 'content-type': 'text/plain' });
  }));
  assert.equal(requests, 8); assert.equal(peak, 3);
  assert.equal(result.documents.length, 8); assert.equal(result.results.length, 12);
  assert.ok(result.results.slice(8).every(read => read.reason?.includes('최대 8개')));
});

test('user cancellation interrupts a pending lookup and does not turn cancellation into missing evidence', async () => {
  const controller = new AbortController();
  const resolving = resolveUrlEvidence([source('https://news.example/a')], { signal: controller.signal }, { ...dependencies(), lookup: () => new Promise(() => {}) });
  controller.abort();
  await assert.rejects(resolving, { name: 'AbortError' });
});

test('HTML decoding retains Korean, punctuation and paragraph boundaries; plain text stays plain', () => {
  const html = extractArticleText(`<main><h1>보고 &amp; 기록</h1><p>&#xBD81;&#54620;군 &ldquo;발표&rdquo;</p><style>noise</style><p>두 번째 문단</p></main>`, 'text/html');
  assert.equal(html.text, '보고 & 기록\n북한군 “발표”\n두 번째 문단');
  assert.deepEqual(extractArticleText('  텍스트 <관측> &amp; 그대로  ', 'text/plain'), { text: '텍스트 <관측> &amp; 그대로', title: '' });
});
