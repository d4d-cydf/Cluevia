import { expect, test } from '@playwright/test';
import { mockClarification, startUnscopedAnalysis } from './clarification-fixture';
import type { Page } from '@playwright/test';
import type { GraphDocument } from '../src/types/graph';
import { mockCase } from './case-fixture';

const question = 'Harbor archive에 나온 선박 관계를 찾아줘';
const sourceText = 'Harbor archive mentions Ocean Survey.';
const graph = {
  schemaVersion: '1.0', id: 'graph-product-test', title: 'Harbor archive investigation', question,
  summary: sourceText, origin: 'codex', createdAt: '2026-10-10T00:00:00Z', limitations: ['One supplied source.'],
  groups: [{ id: 'records', label: 'Records', color: '#3c7890' }],
  sources: [{ id: 'pasted-source', title: 'Pasted source text', excerpt: sourceText }],
  nodes: [
    { id: 'archive', label: 'Harbor archive', type: 'document', group: 'records', description: sourceText, sourceIds: ['pasted-source'], properties: {} },
    { id: 'vessel', label: 'Ocean Survey', type: 'vessel', group: 'records', description: 'Mentioned in the archive.', sourceIds: ['pasted-source'], properties: {} },
  ],
  edges: [{ id: 'mentions', source: 'archive', target: 'vessel', label: 'mentions', description: sourceText, status: 'reported', sourceIds: ['pasted-source'] }], events: [], findings: [],
};
const runningJob = { id: 'job-product-test', status: 'running', stage: 'extracting', message: '제공된 자료에서 객체와 관계를 분석하고 있습니다.', question, createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:01Z' };
const connectedStatus = { authenticated: true, authRequired: false, provider: { kind: 'codex', available: true, authenticated: true, message: 'Codex 연결 준비 완료' }, ontology: { entities: 12, relationships: 15, documents: 3, graphs: 1 }, activeJobs: [] };

async function mockCommon(page: Page) {
  await mockClarification(page);
  await mockCase(page, runningJob.id, () => [graph as GraphDocument]);
  await page.route('**/api/system/status', route => route.fulfill({ json: connectedStatus }));
  await page.route('**/api/graphs', route => route.fulfill({ json: { graphs: [] } }));
  await page.route('**/api/graphs/graph-product-test', route => route.fulfill({ json: { graph } }));
  await page.route('**/api/graphs/graph-product-test/collection', route => route.fulfill({ json: { jobId: null, graphs: [{ id: graph.id, title: graph.title }], index: 0, total: 1 } }));
}
const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = []; browserErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
test.afterEach(async ({ page }) => expect(browserErrors.get(page), 'No browser exceptions').toEqual([]));

test('source submission opens the analysis workspace and retains its server graph after reload', async ({ page }) => {
  await mockCommon(page);
  let submission: unknown;
  let reads = 0;
  await page.route('**/api/jobs', route => { submission = route.request().postDataJSON(); return route.fulfill({ status: 202, json: { job: { ...runningJob, status: 'queued', stage: 'preparing', message: '작업 대기 중' } } }); });
  await page.route('**/api/jobs/job-product-test', route => route.fulfill({ json: { job: ++reads < 2 ? runningJob : { ...runningJob, status: 'completed', stage: 'saving', graphId: graph.id, message: '그래프가 저장되었습니다.' } } }));
  await page.goto('/');
  await expect(page.getByText('분석 엔진 준비됨', { exact: true })).toBeVisible();
  await page.getByLabel('What do you want to find out?', { exact: true }).fill(question);
  await page.getByText(/^Paste source text/).click();
  await page.getByLabel('Source text', { exact: true }).fill(sourceText);
  await startUnscopedAnalysis(page);
  await expect(page).toHaveURL('/analysis/job-product-test');
  await expect(page.getByLabel('AI analysis activity', { exact: true })).toBeVisible();
  expect(submission).toEqual({ question, documents: [{ id: 'pasted-source', name: 'Pasted source text', text: sourceText }] });
  await expect(page.getByRole('button', { name: 'vessel: Ocean Survey', exact: true })).toBeVisible();
  await expect(page.getByLabel('AI analysis activity', { exact: true })).toHaveAttribute('aria-busy', 'false');
  await page.reload();
  await expect(page.getByRole('button', { name: 'vessel: Ocean Survey', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('cluevia.active-job'))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('cluevia.graph.v1.graph-product-test'))).toBeNull();
});

test('a legacy question-only job resumes on reload and cancels without opening a graph', async ({ page }) => {
  await mockCommon(page);
  let started = false;
  let cancelled = false;
  let submission: unknown;
  await page.route('**/api/system/status', route => route.fulfill({ json: { ...connectedStatus, activeJobs: started && !cancelled ? [runningJob] : [] } }));
  await page.route('**/api/jobs', route => { started = true; submission = route.request().postDataJSON(); return route.fulfill({ status: 202, json: { job: runningJob } }); });
  await page.route('**/api/jobs/job-product-test', route => route.fulfill({ json: { job: cancelled ? { ...runningJob, status: 'cancelled', message: '취소됨' } : runningJob } }));
  await page.route('**/api/jobs/job-product-test/cancel', route => { cancelled = true; return route.fulfill({ json: { job: { ...runningJob, status: 'cancelled', message: '취소됨' } } }); });
  await page.goto('/');
  await page.getByLabel('What do you want to find out?', { exact: true }).fill(question);
  await startUnscopedAnalysis(page);
  await expect(page.getByLabel('AI analysis activity', { exact: true })).toBeVisible();
  expect(submission).toEqual({ question, documents: [] });
  await page.reload();
  await expect(page).toHaveURL('/analysis/job-product-test');
  await expect(page.getByLabel('AI analysis activity', { exact: true })).toContainText(question);
  await expect(page.getByLabel('AI analysis activity', { exact: true })).toContainText(runningJob.message);
  await page.getByRole('button', { name: '생성 취소', exact: true }).click();
  await expect(page.getByLabel('AI analysis activity', { exact: true })).toContainText('취소됨');
  await expect(page.getByLabel('AI analysis activity', { exact: true })).toHaveAttribute('aria-busy', 'false');
  await expect(page).toHaveURL('/analysis/job-product-test');
  expect(cancelled).toBe(true);
});

test('provider setup failure is explicit and never displays a fabricated graph', async ({ page }) => {
  await mockCommon(page);
  await page.route('**/api/system/status', route => route.fulfill({ json: { ...connectedStatus, provider: { kind: 'codex', available: false, authenticated: false, message: '서버에서 Codex 로그인이 필요합니다.' } } }));
  const jobRequests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/jobs') jobRequests.push(request.method()); });
  await page.goto('/');
  await expect(page.getByText('분석 엔진 연결 필요', { exact: true })).toBeVisible();
  await page.getByLabel('What do you want to find out?', { exact: true }).fill(question);
  await page.getByRole('button', { name: 'START INVESTIGATION', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Codex 로그인이 필요합니다.');
  expect(jobRequests).toEqual([]);
  await expect(page).toHaveURL('/');
});

test('hybrid structured analysis starts without Codex login and shows actual processing counters on mobile', async ({ page }) => {
  await mockCommon(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/system/status', route => route.fulfill({ json: {
    ...connectedStatus,
    provider: { kind: 'hybrid', available: true, authenticated: true, message: '표 데이터를 로컬에서 변환합니다.', jev: { configured: false, model: 'jev-1.13.0' }, codex: { available: true, authenticated: false, message: 'Codex 로그인이 필요합니다.' } },
  } }));
  const hybridJob = { ...runningJob, processingMode: 'hybrid', completedChunks: 12, totalChunks: 20, graphIds: [], metrics: { structuredRecords: 12345, deterministicParts: 9, jevRequests: 4, jevInputTokens: 2400, codexCalls: 1, cacheHits: 3, reviewParts: 2 } };
  let submission: unknown;
  await page.route('**/api/jobs', route => { submission = route.request().postDataJSON(); return route.fulfill({ status: 202, json: { job: hybridJob } }); });
  await page.route('**/api/jobs/job-product-test', route => route.fulfill({ json: { job: hybridJob } }));
  await page.goto('/');
  await expect(page.getByText('표 데이터 분석 준비됨', { exact: true })).toBeVisible();
  await page.getByLabel('What do you want to find out?', { exact: true }).fill(question);
  await page.getByText(/^Paste source text/).click();
  await page.getByLabel('Source text', { exact: true }).fill('vessel_name,owner\nOcean Survey,Harbor Company');
  await startUnscopedAnalysis(page);
  const progress = page.getByLabel('AI analysis activity', { exact: true });
  await expect(progress).toContainText('12 / 20 구간 처리');
  const metrics = page.getByLabel('Analysis processing statistics', { exact: true });
  await expect(metrics.locator('div').filter({ has: page.getByText('표 데이터 처리', { exact: true }) })).toContainText('12,345행');
  await expect(metrics.locator('div').filter({ has: page.getByText('Jev 호출', { exact: true }) })).toContainText('4회');
  await expect(metrics.locator('div').filter({ has: page.getByText('Codex 설계·분석', { exact: true }) })).toContainText('1회');
  await expect(metrics.locator('div').filter({ has: page.getByText('기존 분석 재사용', { exact: true }) })).toContainText('3구간');
  await expect(metrics.locator('div').filter({ has: page.getByText('추가 검토 대상', { exact: true }) })).toContainText('2구간');
  expect(submission).toEqual({ question, documents: [{ id: 'pasted-source', name: 'Pasted source text', text: 'vessel_name,owner\nOcean Survey,Harbor Company' }] });
  const widths = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
  expect(widths.content).toBeLessThanOrEqual(widths.width + 1);
});

test('saved Jev and structured part links open the integrated case and retain records across reloads', async ({ page }) => {
  await mockCommon(page);
  const jevGraph = { ...graph, origin: 'jev', title: 'Jev document relations' } as GraphDocument;
  const structuredGraph = { ...graph, id: 'graph-structured-part', origin: 'structured', title: 'Structured source records' } as GraphDocument;
  const graphs = [jevGraph, structuredGraph];
  await mockCase(page, runningJob.id, () => graphs);
  await page.route('**/api/jobs/job-product-test', route => route.fulfill({ json: { job: { ...runningJob, status: 'completed', graphIds: graphs.map(item => item.id), completedChunks: 2, totalChunks: 2 } } }));
  for (const part of graphs) {
    await page.route(`**/api/graphs/${part.id}`, route => route.fulfill({ json: { graph: part } }));
    await page.route(`**/api/graphs/${part.id}/collection`, route => route.fulfill({ json: { jobId: runningJob.id, graphs, index: graphs.indexOf(part), total: 2 } }));
  }
  await page.goto('/case/graph-product-test/board');
  await expect(page).toHaveURL('/analysis/job-product-test');
  await expect(page.getByLabel('통합 분석 그래프', { exact: true })).toContainText('2 / 2 기록 처리');
  await page.getByRole('button', { name: 'Lanes', exact: true }).click();
  await page.getByText('분석 기록 · 2', { exact: true }).click();
  await page.getByRole('button', { name: /기록 2 · Structured source records/ }).click();
  await expect(page.getByLabel('분석 기록 상세', { exact: true })).toContainText('Structured source records');
  await page.reload();
  await expect(page.getByLabel('통합 분석 그래프', { exact: true })).toBeVisible();
  await page.goto('/case/graph-structured-part/board');
  await expect(page).toHaveURL('/analysis/job-product-test');
  await expect(page.getByRole('button', { name: 'vessel: Ocean Survey', exact: true })).toBeVisible();
});

test('a remote workspace unlocks with a tab-scoped key and sends authenticated API requests', async ({ page }) => {
  await mockCommon(page);
  const seenTokens: string[] = [];
  await page.route('**/api/system/status', route => {
    const auth = route.request().headers().authorization;
    if (auth) seenTokens.push(auth);
    return route.fulfill({ json: auth === 'Bearer test-workspace-key' ? { ...connectedStatus, authRequired: true } : { authenticated: false, authRequired: true, provider: { kind: 'codex', available: false, authenticated: null, message: '워크스페이스 연결키가 필요합니다.' } } });
  });
  await page.goto('/');
  await page.getByLabel('워크스페이스 접속 키', { exact: true }).fill('test-workspace-key');
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await expect(page.getByText('분석 엔진 준비됨', { exact: true })).toBeVisible();
  expect(seenTokens).toContain('Bearer test-workspace-key');
  expect(await page.evaluate(() => sessionStorage.getItem('cluevia.workspace.token'))).toBe('test-workspace-key');
  expect(await page.evaluate(() => localStorage.getItem('cluevia.workspace.token'))).toBeNull();
});

test('ontology search opens persisted claims and their source graph without mobile overflow', async ({ page }) => {
  await mockCommon(page);
  const summary = { entities: 2, relationships: 1, documents: 1, graphs: 1, types: [{ type: 'vessel', count: 1 }, { type: 'document', count: 1 }] };
  const entity = { id: 'entity-ocean', label: 'Ocean Survey', type: 'vessel', description: 'Mentioned in the archive.', caseCount: 1, updatedAt: '2026-10-10T00:00:00Z' };
  const queries: string[] = [];
  await page.route('**/api/ontology', route => route.fulfill({ json: { summary, schema: { version: '1.0', entityTypes: ['vessel', 'document'], relationTypes: ['mentions'] } } }));
  await page.route('**/api/ontology/entities?*', route => { queries.push(route.request().url()); return route.fulfill({ json: { entities: [entity] } }); });
  await page.route('**/api/ontology/entities/entity-ocean', route => route.fulfill({ json: { entity: { ...entity, identifiers: [{ namespace: 'imo', value: '1234567' }], claims: [{ graphId: graph.id, graphTitle: graph.title, nodeId: 'vessel', label: entity.label, description: entity.description, properties: {}, sourceIds: ['pasted-source'], evidence: [{ documentId: 'pasted-source', quote: sourceText }], createdAt: graph.createdAt }], relationships: [] } } }));
  await page.goto('/ontology');
  await page.getByRole('button', { name: /^선박/ }).click();
  await page.getByLabel('Search knowledge', { exact: true }).fill('Ocean');
  await expect.poll(() => queries.some(value => value.includes('q=Ocean') && value.includes('type=vessel'))).toBe(true);
  await page.getByRole('button', { name: /Ocean Survey/ }).click();
  const detail = page.getByRole('complementary', { name: 'Ontology entity detail' });
  await expect(detail.getByRole('heading', { name: 'Ocean Survey', exact: true })).toBeVisible();
  await expect(detail).toContainText(sourceText);
  await expect(detail).toContainText('1234567');
  await page.setViewportSize({ width: 390, height: 844 });
  const widths = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
  expect(widths.content).toBeLessThanOrEqual(widths.width + 1);
  await detail.getByRole('link', { name: `${graph.title} ↗`, exact: true }).click();
  await expect(page).toHaveURL('/case/graph-product-test/board');
});

test('failed extraction keeps the actual error and allows a new attempt', async ({ page }) => {
  await mockCommon(page);
  await page.route('**/api/jobs', route => route.fulfill({ status: 202, json: { job: runningJob } }));
  await page.route('**/api/jobs/job-product-test', route => route.fulfill({ json: { job: { ...runningJob, status: 'failed', error: '자료에서 확인할 수 없는 인용이 포함되어 저장하지 않았습니다.' } } }));
  await page.goto('/');
  await page.getByLabel('What do you want to find out?', { exact: true }).fill(question);
  await startUnscopedAnalysis(page);
  await expect(page.getByRole('alert')).toContainText('확인할 수 없는 인용');
  await expect(page).toHaveURL('/analysis/job-product-test');
  await page.getByRole('link', { name: 'Cluevia home', exact: true }).click();
  await expect(page.getByRole('button', { name: 'START INVESTIGATION', exact: true })).toBeVisible();
});

test('ordinary versioned JSON is submitted as evidence instead of being mistaken for a graph', async ({ page }) => {
  await mockCommon(page);
  const evidence = JSON.stringify({ schemaVersion: '2.0', records: [{ vessel: 'Ocean Survey', observation: 'Harbor archive' }] });
  let submission: unknown;
  let uploadedBody = '';
  await page.route('**/api/documents/upload', route => { uploadedBody = route.request().postDataBuffer()!.toString('utf8'); return route.fulfill({ status: 201, json: { document: { id: 'upload-versioned-json', name: 'evidence.json', bytes: Buffer.byteLength(evidence), characters: evidence.length, chunkCount: 1, createdAt: graph.createdAt } } }); });
  const imports: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/graphs/import') imports.push(request.method()); });
  await page.route('**/api/jobs', route => { submission = route.request().postDataJSON(); return route.fulfill({ status: 202, json: { job: runningJob } }); });
  await page.route('**/api/jobs/job-product-test', route => route.fulfill({ json: { job: runningJob } }));
  await page.goto('/');
  await page.getByLabel('What do you want to find out?', { exact: true }).fill(question);
  await page.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'evidence.json', mimeType: 'application/json', buffer: Buffer.from(evidence) });
  await startUnscopedAnalysis(page);
  await expect(page.getByLabel('AI analysis activity', { exact: true })).toBeVisible();
  expect(uploadedBody).toBe(evidence);
  expect(submission).toEqual({ question, documents: [], uploadIds: ['upload-versioned-json'] });
  expect(imports).toEqual([]);
});


test('a source larger than 2MB uploads all bytes and exposes its records in one integrated case', async ({ page }) => {
  await mockCommon(page);
  await page.addInitScript(() => {
    const original = Blob.prototype.text;
    Blob.prototype.text = function () { if (this.size > 2_000_000) throw new Error('Large sources must stream directly to the server.'); return original.call(this); };
  });
  const evidence = Buffer.from('{"schemaVersion":"2.0","records":["' + 'Ocean observation. '.repeat(140000) + 'FINAL_SEGMENT_MARKER"]}');
  expect(evidence.byteLength).toBeGreaterThan(2_000_000);
  const totalChunks = Math.ceil(evidence.byteLength / 30000);
  let uploaded: Buffer | null = null;
  let submission: unknown;
  const longSourceId = 'upload-123e4567-e89b-12d3-a456-426614174000-part-123';
  const multipartGraph = { ...graph, sources: graph.sources.map(source => ({ ...source, id: longSourceId })), nodes: graph.nodes.map(node => ({ ...node, sourceIds: [longSourceId] })), edges: graph.edges.map(edge => ({ ...edge, sourceIds: [longSourceId] })) };
  const secondGraph = { ...multipartGraph, id: 'graph-product-part-two', title: 'Later source connections' };
  await mockCase(page, runningJob.id, () => [multipartGraph, secondGraph] as GraphDocument[], () => ({ total: totalChunks, completed: totalChunks }));
  await page.route('**/api/graphs/graph-product-test', route => route.fulfill({ json: { graph: multipartGraph } }));
  const collection = { jobId: runningJob.id, graphs: [{ id: graph.id, title: graph.title }, { id: secondGraph.id, title: secondGraph.title }], total: 2, status: 'completed', completedChunks: totalChunks, totalChunks, emptyChunks: totalChunks - 2 };
  await page.route('**/api/documents/upload', route => {
    expect(route.request().headers()['content-type']).toBe('application/octet-stream');
    expect(route.request().headers()['x-file-name']).toBe(encodeURIComponent('대형자료.json'));
    uploaded = route.request().postDataBuffer();
    return route.fulfill({ status: 201, json: { document: { id: 'upload-large-file', name: '대형자료.json', bytes: evidence.byteLength, characters: evidence.length, chunkCount: totalChunks, createdAt: graph.createdAt } } });
  });
  await page.route('**/api/jobs', route => { submission = route.request().postDataJSON(); return route.fulfill({ status: 202, json: { job: { ...runningJob, completedChunks: 0, totalChunks, emptyChunks: 0, graphIds: [], currentSource: '대형자료.json' } } }); });
  await page.route('**/api/jobs/job-product-test', route => route.fulfill({ json: { job: { ...runningJob, status: 'completed', stage: 'saving', graphId: graph.id, graphIds: [graph.id, secondGraph.id], completedChunks: totalChunks, totalChunks, emptyChunks: totalChunks - 2 } } }));
  await page.route('**/api/graphs/graph-product-test/collection', route => route.fulfill({ json: { ...collection, index: 0 } }));
  await page.route('**/api/graphs/graph-product-part-two', route => route.fulfill({ json: { graph: secondGraph } }));
  await page.route('**/api/graphs/graph-product-part-two/collection', route => route.fulfill({ json: { ...collection, index: 1 } }));
  await page.goto('/');
  await page.getByLabel('What do you want to find out?', { exact: true }).fill(question);
  await page.getByLabel('Attach files', { exact: true }).setInputFiles({ name: '대형자료.json', mimeType: 'application/json', buffer: evidence });
  await expect(page.getByRole('list', { name: 'Attached files' })).toContainText('대형자료.json');
  await startUnscopedAnalysis(page);
  await expect(page).toHaveURL('/analysis/job-product-test');
  await expect(page.getByRole('button', { name: 'vessel: Ocean Survey', exact: true })).toBeVisible();
  expect(uploaded).toEqual(evidence);
  expect(submission).toEqual({ question, documents: [], uploadIds: ['upload-large-file'] });
  await page.goto('/case/graph-product-test/board');
  await expect(page).toHaveURL('/analysis/job-product-test');
  await expect(page.getByLabel('통합 분석 그래프', { exact: true })).toContainText(`${totalChunks} / ${totalChunks} 기록 처리`);
  await page.getByText(`분석 기록 · ${totalChunks}`, { exact: true }).click();
  await page.getByRole('button', { name: /기록 2 · Later source connections/ }).click();
  await expect(page.getByLabel('분석 기록 상세', { exact: true })).toContainText('Later source connections');
  await expect(page.getByRole('button', { name: 'vessel: Ocean Survey', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Lanes', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const widths = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
  expect(widths.content).toBeLessThanOrEqual(widths.width + 1);
  await page.getByRole('button', { name: /기록 3 · 분석 기록 3/ }).click();
  await expect(page.getByLabel('분석 기록 상세', { exact: true })).toContainText('객체·관계를 확인하지 못했습니다.');
  await expect(page).toHaveURL('/analysis/job-product-test');
});

test('upload retry reuses completed files and cancelled analysis can resume its remaining chunks', async ({ page }) => {
  await mockCommon(page);
  const uploads: string[] = [];
  let secondAttempts = 0;
  let resumed = false;
  let wasCancelled = false;
  const partialJob = { ...runningJob, completedChunks: 1, totalChunks: 3, emptyChunks: 0, graphIds: [graph.id], currentSource: 'second.txt' };
  await page.route('**/api/system/status', route => route.fulfill({ json: { ...connectedStatus, resumableJobs: wasCancelled && !resumed ? [{ ...partialJob, status: 'cancelled', resumable: true }] : [] } }));
  await page.route('**/api/documents/upload', route => {
    const name = decodeURIComponent(route.request().headers()['x-file-name']); uploads.push(name);
    if (name === 'second.txt' && secondAttempts++ === 0) return route.fulfill({ status: 500, json: { error: 'second.txt 전송에 실패했습니다. 다시 시도해주세요.' } });
    return route.fulfill({ status: 201, json: { document: { id: `upload-${name}`, name, bytes: 50, characters: 50, chunkCount: name === 'first.txt' ? 1 : 2, createdAt: graph.createdAt } } });
  });
  await page.route('**/api/jobs', route => route.fulfill({ status: 202, json: { job: partialJob } }));
  await page.route('**/api/jobs/job-product-test', route => route.fulfill({ json: { job: wasCancelled && !resumed ? { ...partialJob, status: 'cancelled', resumable: true, message: '남은 구간의 분석을 중단했습니다.' } : { ...partialJob, message: resumed ? '저장된 자료의 다음 구간부터 분석합니다.' : partialJob.message } } }));
  await page.route('**/api/jobs/job-product-test/cancel', route => { wasCancelled = true; return route.fulfill({ json: { job: { ...partialJob, status: 'cancelled', resumable: true, message: '남은 구간의 분석을 중단했습니다.' } } }); });
  await page.route('**/api/jobs/job-product-test/resume', route => { resumed = true; return route.fulfill({ status: 202, json: { job: { ...partialJob, resumable: false, message: '저장된 자료의 다음 구간부터 분석합니다.' } } }); });
  await page.goto('/');
  await page.getByLabel('What do you want to find out?', { exact: true }).fill(question);
  await page.getByLabel('Attach files', { exact: true }).setInputFiles([{ name: 'first.txt', mimeType: 'text/plain', buffer: Buffer.from('First source.') }, { name: 'second.txt', mimeType: 'text/plain', buffer: Buffer.from('Second source.') }]);
  await startUnscopedAnalysis(page);
  await expect(page.getByRole('alert')).toContainText('second.txt 전송에 실패');
  await page.getByRole('button', { name: '요청 수정하기', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Attached files' })).toContainText('전송됨 · 1구간');
  await startUnscopedAnalysis(page);
  await expect(page.getByLabel('AI analysis activity', { exact: true })).toContainText('1 / 3 구간 처리');
  expect(uploads).toEqual(['first.txt', 'second.txt', 'second.txt']);
  await page.getByRole('button', { name: '생성 취소', exact: true }).click();
  const progress = page.getByLabel('AI analysis activity', { exact: true });
  await expect(page.getByRole('button', { name: 'vessel: Ocean Survey', exact: true })).toBeVisible();
  await expect(progress).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('button', { name: '남은 구간 이어서 분석', exact: true })).toBeVisible();
  await page.reload();
  await expect(progress).toContainText('남은 구간의 분석을 중단했습니다.');
  await page.goto('/');
  await page.getByRole('region', { name: 'Unfinished analyses' }).getByRole('button', { name: '이어서 분석', exact: true }).click();
  await expect(progress).toContainText('저장된 자료의 다음 구간부터 분석합니다.');
  expect(resumed).toBe(true);
  expect(uploads).toEqual(['first.txt', 'second.txt', 'second.txt']);
});

test('an in-flight source upload can be cancelled before a generation job is submitted', async ({ page }) => {
  await mockCommon(page);
  let releaseUpload: (() => void) | undefined;
  const uploadHold = new Promise<void>(resolve => { releaseUpload = resolve; });
  const jobRequests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/jobs') jobRequests.push(request.method()); });
  await page.route('**/api/documents/upload', async route => { await uploadHold; await route.fulfill({ status: 201, json: { document: { id: 'unused-upload', name: 'cancel.txt', bytes: 5, characters: 5, chunkCount: 1, createdAt: graph.createdAt } } }).catch(() => {}); });
  await page.goto('/');
  await page.getByLabel('What do you want to find out?', { exact: true }).fill(question);
  await page.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'cancel.txt', mimeType: 'text/plain', buffer: Buffer.from('Pause this upload.') });
  await startUnscopedAnalysis(page);
  await expect(page.getByRole('region', { name: '분석 범위 확인', exact: true }).getByRole('status')).toContainText('cancel.txt');
  await page.getByRole('button', { name: '업로드 취소', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('업로드를 취소했습니다.');
  await expect(page.getByRole('button', { name: '질문 없이 현재 요청으로 분석', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '요청 수정하기', exact: true }).click();
  await expect(page.getByRole('button', { name: 'START INVESTIGATION', exact: true })).toBeEnabled();
  releaseUpload?.();
  expect(jobRequests).toEqual([]);
});

test('long pasted evidence uses the complete uploaded text without the old textarea truncation', async ({ page }) => {
  await mockCommon(page);
  const evidence = 'Complete pasted evidence. '.repeat(2600) + 'PASTED_FINAL_MARKER';
  let uploaded = '';
  let submission: unknown;
  await page.route('**/api/documents/upload', route => { uploaded = route.request().postDataBuffer()!.toString('utf8'); return route.fulfill({ status: 201, json: { document: { id: 'upload-long-paste', name: 'Pasted source text.txt', bytes: evidence.length, characters: evidence.length, chunkCount: 3, createdAt: graph.createdAt } } }); });
  await page.route('**/api/jobs', route => { submission = route.request().postDataJSON(); return route.fulfill({ status: 202, json: { job: runningJob } }); });
  await page.route('**/api/jobs/job-product-test', route => route.fulfill({ json: { job: runningJob } }));
  await page.goto('/');
  await page.getByLabel('What do you want to find out?', { exact: true }).fill(question);
  await page.getByText(/^Paste source text/).click();
  await page.getByLabel('Source text', { exact: true }).fill(evidence);
  await expect(page.getByLabel('Source text', { exact: true })).toHaveValue(evidence);
  await startUnscopedAnalysis(page);
  await expect(page.getByLabel('AI analysis activity', { exact: true })).toBeVisible();
  expect(uploaded).toBe(evidence);
  expect(submission).toEqual({ question, documents: [], uploadIds: ['upload-long-paste'] });
});
