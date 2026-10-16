import { expect, test } from '@playwright/test';
import { mockClarification, startUnscopedAnalysis } from './clarification-fixture';
import type { Page } from '@playwright/test';
import { mockCase } from './case-fixture';
import type { GenerationJob } from '../src/services/api-client';
import type { GraphDocument } from '../src/types/graph';

const question = '고객과 주문의 관계를 분석해줘';
const sourceText = 'Customer C1 Alex placed order O1 for 125 dollars.';
const graph: GraphDocument = {
  schemaVersion: '1.0', id: 'analysis-graph-one', title: '고객 주문 관계', question,
  summary: sourceText, origin: 'codex', createdAt: '2026-10-10T00:00:00Z', limitations: [],
  ontologyId: 'retail-schema', ontologyVersion: 1,
  groups: [{ id: 'customers', label: '고객', color: '#357d84' }, { id: 'orders', label: '주문', color: '#846492' }],
  sources: [{ id: 'source-1', title: 'customers.txt', excerpt: sourceText }],
  nodes: [
    { id: 'C1', label: 'Alex', type: 'Customer', group: 'customers', description: '주문 고객', sourceIds: ['source-1'], properties: { customerId: 'C1' } },
    { id: 'O1', label: 'Order O1', type: 'Order', group: 'orders', description: '고객 주문', sourceIds: ['source-1'], properties: { amount: '125' } },
  ],
  edges: [{ id: 'places', source: 'C1', target: 'O1', label: '주문함', description: sourceText, status: 'reported', sourceIds: ['source-1'] }],
  events: [], findings: [],
};
const secondGraph: GraphDocument = { ...graph, id: 'analysis-graph-two', title: '다음 자료의 고객', nodes: [{ ...graph.nodes[0], id: 'C2', label: 'Jamie', properties: { customerId: 'C2' } }], edges: [] };
const initialJob: GenerationJob = {
  id: 'analysis-workspace-job', question, status: 'running', stage: 'designing',
  message: '자료에 맞는 온톨로지를 설계하고 있습니다.', createdAt: graph.createdAt, updatedAt: graph.createdAt,
  graphIds: [], completedChunks: 0, totalChunks: 0, processingMode: 'hybrid',
};
const status = {
  authenticated: true, authRequired: false,
  provider: { kind: 'hybrid', ontologyPlanning: true, available: true, authenticated: true, message: '온톨로지 설계 준비됨', codex: { available: true, authenticated: true, message: 'Codex 준비됨' }, jev: { configured: true, model: 'jev-1.13.0' } },
  activeJobs: [], ontology: { entities: 0, relationships: 0, documents: 0, graphs: 0 },
};
const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  await mockClarification(page);
  const errors: string[] = []; browserErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
  await mockCase(page, initialJob.id, () => [graph, secondGraph], () => ({ total: 3, completed: 3 }));
  await page.route('**/api/system/status', route => route.fulfill({ json: status }));
  await page.route('**/api/graphs', route => route.fulfill({ json: { graphs: [] } }));
  for (const value of [graph, secondGraph]) {
    await page.route(`**/api/graphs/${value.id}`, route => route.fulfill({ json: { graph: value } }));
    await page.route(`**/api/graphs/${value.id}/collection`, route => route.fulfill({ json: { jobId: initialJob.id, graphs: [graph, secondGraph].map(item => ({ id: item.id, title: item.title })), total: 2, index: value === graph ? 0 : 1, status: 'running', completedChunks: 1, totalChunks: 3 } }));
  }
});
test.afterEach(async ({ page }) => expect(browserErrors.get(page), 'No browser exceptions').toEqual([]));

async function expectNoOverflow(page: Page) {
  const widths = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
  expect(widths.content).toBeLessThanOrEqual(widths.width + 1);
}

test('analysis starts in the graph workspace and advances only with actual server stages and counts', async ({ page }) => {
  let job: GenerationJob = { ...initialJob };
  let submissions = 0;
  await page.route('**/api/jobs', route => { if (route.request().method() === 'GET') return route.fulfill({ json: { jobs: [job] } }); submissions++; return route.fulfill({ status: 202, json: { job } }); });
  await page.route(`**/api/jobs/${job.id}`, route => route.fulfill({ json: { job } }));
  await page.goto('/');
  await page.getByLabel('What do you want to find out?', { exact: true }).fill(question);
  await page.getByText(/^Paste source text/).click();
  await page.getByLabel('Source text', { exact: true }).fill(sourceText);
  await startUnscopedAnalysis(page);

  await expect(page).toHaveURL(`/analysis/${job.id}`);
  const activity = page.getByLabel('AI analysis activity', { exact: true });
  await expect(activity).toHaveAttribute('aria-busy', 'true');
  await expect(activity.locator('[aria-current="step"]')).toContainText('온톨로지 설계');
  await expect(activity).toContainText(job.message);
  await expect(page.getByLabel('Graph workspace', { exact: true })).toBeVisible();
  await expect(page.locator('.gw-detail-dock, .gw-detail-bar, .gw-session-footer, .cg-footer, .aw-canvas-footer, .aw-pending-footer')).toHaveCount(0);
  const pendingCanvas = (await page.locator('.aw-canvas').boundingBox())!;
  const pendingWorkspace = (await page.getByLabel('Graph workspace', { exact: true }).boundingBox())!;
  expect(Math.abs(pendingCanvas.y + pendingCanvas.height - pendingWorkspace.y - pendingWorkspace.height)).toBeLessThanOrEqual(1);
  await expect(page.getByRole('progressbar', { name: 'Analyzed source chunks', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Customer: Alex', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('What do you want to find out?', { exact: true })).toHaveCount(0);

  job = { ...job, stage: 'preparing', message: '전체 자료를 분석 구간으로 준비하고 있습니다.', ontologyId: 'retail-schema', ontologyName: '고객 주문 온톨로지', ontologyVersion: 1 };
  await expect(activity.locator('[aria-current="step"]')).toContainText('자료 준비');
  await expect(activity).toContainText(job.message);
  await expect(page.getByRole('button', { name: 'Customer: Alex', exact: true })).toHaveCount(0);

  job = { ...job, stage: 'extracting', message: '두 번째 자료에서 객체와 관계를 분석합니다.', currentSource: 'customers.txt', completedChunks: 1, totalChunks: 3, graphIds: [graph.id], graphId: graph.id };
  await expect(activity.locator('[aria-current="step"]')).toContainText('객체·관계 분석');
  const progress = page.getByRole('progressbar', { name: 'Analyzed source chunks', exact: true });
  await expect(progress).toHaveAttribute('value', '1');
  await expect(progress).toHaveAttribute('max', '3');
  await expect(activity).toContainText('customers.txt');
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Customer: Alex', exact: true })).toBeVisible();
  await expect(page.locator('.gw-detail-dock, .gw-detail-bar, .gw-session-footer, .cg-footer, .aw-canvas-footer, .aw-pending-footer')).toHaveCount(0);
  await expect(page).toHaveURL(`/analysis/${job.id}`);

  job = { ...job, status: 'completed', stage: 'saving', completedChunks: 3, graphIds: [graph.id, secondGraph.id], message: '전체 자료의 그래프를 저장했습니다.' };
  await expect(activity).toHaveAttribute('aria-busy', 'false');
  await expect(activity).toContainText(job.message);
  await expect(page.getByLabel('케이스 결과 대화', { exact: true })).toBeVisible();
  await page.getByLabel('분석 처리 내역', { exact: true }).click();
  await expect(progress).toHaveAttribute('value', '3');
  await expect(page).toHaveURL(`/analysis/${job.id}`);
  await expect(page.getByRole('combobox', { name: 'Graph part', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('통합 분석 그래프', { exact: true })).toContainText('전체 자료 · 통합 그래프');
  await page.getByRole('button', { name: '케이스 정보 보기', exact: true }).click();
  await page.getByRole('button', { name: '기록 · 3', exact: true }).click();
  await page.getByText('분석 기록 · 3', { exact: true }).click();
  await page.getByRole('button', { name: /기록 2 · 다음 자료의 고객/ }).click();
  await expect(page.getByLabel('분석 기록 상세', { exact: true })).toContainText(secondGraph.title);
  await expect(page.getByRole('button', { name: 'Customer: Alex', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Customer: Jamie', exact: true })).toBeVisible();
  await expect(page).toHaveURL(`/analysis/${job.id}`);
  expect(submissions).toBe(1);
});

test('a failed analysis retains its saved graph and resumes on the same route after reload', async ({ page }) => {
  let job: GenerationJob = {
    ...initialJob, status: 'failed', stage: 'extracting', resumable: true,
    completedChunks: 1, totalChunks: 3, graphIds: [graph.id], graphId: graph.id,
    error: '후속 자료의 근거를 확인하지 못했습니다. 저장된 첫 번째 구간은 유지됩니다.',
  };
  let resumes = 0;
  await page.route(`**/api/jobs/${job.id}`, route => route.fulfill({ json: { job } }));
  await page.route(`**/api/jobs/${job.id}/resume`, route => {
    resumes++;
    job = { ...job, status: 'running', resumable: false, error: undefined, message: '저장된 자료의 다음 구간부터 분석합니다.' };
    return route.fulfill({ status: 202, json: { job } });
  });
  await page.goto(`/analysis/${job.id}`);
  const activity = page.getByLabel('AI analysis activity', { exact: true });
  await expect(activity).toHaveAttribute('aria-busy', 'false');
  await expect(activity.getByRole('alert')).toContainText('후속 자료의 근거');
  await expect(activity.getByRole('alert')).toContainText('일부 구간 분석 중단');
  await expect(activity.getByRole('alert')).toContainText('1 / 3 구간 처리');
  await expect(activity.getByRole('alert')).toContainText('이미 저장된 1개 기록은 통합 그래프에서 계속 확인할 수 있습니다.');
  await expect(activity.getByRole('alert')).toContainText('남은 2개 구간은 추가 분석이 필요합니다.');
  await expect(activity).not.toContainText('COMPLETE');
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Customer: Alex', exact: true })).toBeVisible();
  await page.reload();
  await expect(activity.getByRole('alert')).toContainText('후속 자료의 근거');
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await page.getByRole('button', { name: '남은 구간 이어서 분석', exact: true }).click();
  await expect(activity).toHaveAttribute('aria-busy', 'true');
  await expect(activity).toContainText('저장된 자료의 다음 구간부터 분석합니다.');
  await expect(activity.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Customer: Alex', exact: true })).toBeVisible();
  await expect(page).toHaveURL(`/analysis/${job.id}`);
  expect(resumes).toBe(1);
});

test('an active analysis survives direct reload on mobile without page overflow or fabricated progress', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let job: GenerationJob = { ...initialJob, question: '긴자료명_' + '분석자료'.repeat(35), currentSource: '긴원본파일_' + '원본'.repeat(50) + '.csv' };
  await page.route(`**/api/jobs/${job.id}`, route => route.fulfill({ json: { job } }));
  await page.goto(`/analysis/${job.id}`);
  const activity = page.getByLabel('AI analysis activity', { exact: true });
  await expect(page.getByLabel('분석 세션 설명')).toContainText(job.question);
  await expect(page.locator('.case-sidebar')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('.gw-detail-dock, .gw-detail-bar, .gw-session-footer, .cg-footer, .aw-canvas-footer, .aw-pending-footer')).toHaveCount(0);
  await page.getByRole('button', { name: '사이드바 열기', exact: true }).click();
  await expect(activity.locator('[aria-current="step"]')).toContainText('온톨로지 설계');
  await expectNoOverflow(page);
  await page.reload();
  await page.getByRole('button', { name: '사이드바 열기', exact: true }).click();
  await expect(activity).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('progressbar', { name: 'Analyzed source chunks', exact: true })).toHaveCount(0);
  await expectNoOverflow(page);
  job = { ...job, stage: 'extracting', totalChunks: 12, completedChunks: 2, graphIds: [graph.id], graphId: graph.id };
  await expect(page.getByRole('progressbar', { name: 'Analyzed source chunks', exact: true })).toHaveAttribute('value', '2');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Customer: Alex', exact: true })).toBeVisible();
  await expect(page.locator('.gw-detail-dock, .gw-detail-bar, .gw-session-footer, .cg-footer, .aw-canvas-footer, .aw-pending-footer')).toHaveCount(0);
  const canvas = page.locator('.gw-renderer-surface [data-canvas-scroll]');
  const beforeSelection = (await canvas.boundingBox())!;
  const workbench = (await page.locator('.gw-main').boundingBox())!;
  expect(Math.abs(beforeSelection.y + beforeSelection.height - workbench.y - workbench.height)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Order: Order O1', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Selected graph item', exact: true })).toContainText('125');
  await expect(page.getByRole('dialog', { name: '케이스 상세', exact: true })).toHaveCSS('position', 'absolute');
  expect((await canvas.boundingBox())!.height).toBeCloseTo(beforeSelection.height, 0);
  await expectNoOverflow(page);
});

test('legacy home job links open the same analysis workspace without submitting another job', async ({ page }) => {
  let submissions = 0;
  await page.route('**/api/jobs', route => { if (route.request().method() === 'GET') return route.fulfill({ json: { jobs: [initialJob] } }); submissions++; return route.fulfill({ status: 500, json: { error: 'Unexpected job creation' } }); });
  await page.route(`**/api/jobs/${initialJob.id}`, route => route.fulfill({ json: { job: initialJob } }));
  await page.goto(`/?job=${initialJob.id}`);
  await expect(page).toHaveURL(`/analysis/${initialJob.id}`);
  await expect(page.getByLabel('AI analysis activity', { exact: true })).toContainText(initialJob.message);
  expect(submissions).toBe(0);
});

test('a slow partial graph finishes while newer revisions coalesce and the selected object survives', async ({ page }) => {
  let job: GenerationJob = { ...initialJob, stage: 'extracting', totalChunks: 3, completedChunks: 1, graphIds: [graph.id], graphId: graph.id, message: '첫 번째 근거를 저장했습니다.' };
  let requests = 0;
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const firstReady = new Promise<void>(resolve => { releaseFirst = resolve; });
  const secondReady = new Promise<void>(resolve => { releaseSecond = resolve; });
  await page.route(`**/api/jobs/${job.id}`, route => route.fulfill({ json: { job } }));
  await page.route(`**/api/jobs/${job.id}/case`, async route => {
    const number = ++requests;
    const parts = number === 1 ? [graph] : [graph, secondGraph];
    await (number === 1 ? firstReady : secondReady);
    await route.fulfill({ json: {
      schemaVersion: 'case-1.0', jobId: job.id, updatedAt: graph.createdAt, status: 'running',
      graph: { ...graph, id: `case-${job.id}`, nodes: parts.flatMap(part => part.nodes), edges: parts.flatMap(part => part.edges) },
      records: parts.map((part, index) => ({ number: index + 1, title: part.title, status: 'saved', graphId: part.id, nodeCount: part.nodes.length, edgeCount: part.edges.length, archived: true })),
      provenance: {}, conflicts: [],
    } });
  });
  try {
    await page.goto(`/analysis/${job.id}`);
    await expect.poll(() => requests).toBe(1);
    await expect(page.getByText('그래프 준비 화면 · 아직 표시할 근거가 없습니다')).toBeVisible();
    // A saved result can arrive before completedChunks changes. Its ID still invalidates the projection.
    job = { ...job, graphIds: [graph.id, secondGraph.id], message: '두 번째 근거를 저장했습니다.' };
    await expect(page.getByLabel('분석 활동 기록')).toContainText(job.message);
    expect(requests).toBe(1);
    releaseFirst();
    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Customer: Alex', exact: true })).toBeVisible();
    await expect.poll(() => requests).toBe(2);
    await expect(page.getByRole('button', { name: 'Customer: Jamie', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Order: Order O1', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Selected graph item', exact: true })).toContainText('125');
    releaseSecond();
    await expect(page.getByRole('button', { name: 'Customer: Jamie', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Selected graph item', exact: true })).toContainText('125');
    await expect(page.getByLabel('분석 세션 설명')).toContainText('객체 3 · 관계 1');
    expect(requests).toBe(2);
  } finally { releaseFirst(); releaseSecond(); }
});

test('loading guidance rotates without advancing server progress and respects reduced motion', async ({ page }) => {
  await page.clock.install();
  let job: GenerationJob = { ...initialJob, status: 'queued', createdAt: new Date().toISOString() };
  await page.route(`**/api/jobs/${job.id}`, route => route.fulfill({ json: { job } }));
  await page.goto(`/analysis/${job.id}`);
  const activity = page.getByLabel('AI analysis activity', { exact: true });
  const indicator = activity.locator('.processing-indicator');
  await expect(indicator).toHaveAttribute('data-phase', 'queued');
  await expect(page.getByRole('heading', { name: '분석 시작을 기다리고 있습니다' })).toHaveCount(2);
  await expect(activity.locator('[aria-current="step"]')).toHaveCount(0);
  await expect(indicator).toContainText('실행 순서가 되면');
  await page.clock.fastForward(8500);
  await expect(indicator).toContainText('앞선 작업');
  await expect(indicator.locator('.processing-dots b').first()).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.aw-network-flow')).toHaveCSS('animation-name', 'none');
  await expect(page.getByRole('progressbar', { name: 'Analyzed source chunks', exact: true })).toHaveCount(0);

  job = { ...job, status: 'running', stage: 'designing', startedAt: new Date().toISOString() };
  await page.clock.fastForward(2000);
  await expect(indicator).toHaveAttribute('data-phase', 'designing');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('.aw-network-flow')).toHaveCSS('animation-name', 'aw-network-travel');
  await page.clock.runFor(400);
  await page.screenshot({ path: test.info().outputPath('analysis-loading-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoOverflow(page);
  await page.screenshot({ path: test.info().outputPath('analysis-loading-mobile.png'), fullPage: true });

  await page.getByRole('button', { name: '사이드바 열기', exact: true }).click();
  job = { ...job, status: 'cancelled', message: '사용자가 생성을 취소했습니다.' };
  await page.clock.fastForward(2000);
  await expect(indicator).toHaveCount(0);
  await expect(activity).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.aw-canvas-visual')).not.toHaveClass(/is-active/);
});

test('a missing job shows a connection error instead of working and can be refreshed', async ({ page }) => {
  let unavailable = true;
  await page.route(`**/api/jobs/${initialJob.id}`, route => unavailable
    ? route.fulfill({ status: 404, json: { error: '작업을 찾을 수 없습니다.' } })
    : route.fulfill({ json: { job: { ...initialJob, status: 'completed', schemaOnly: true, ontologyId: 'retail-schema' } } }));
  await page.goto(`/analysis/${initialJob.id}`);
  const activity = page.getByLabel('AI analysis activity', { exact: true });
  await expect(activity).toHaveAttribute('aria-busy', 'false');
  await expect(activity).toContainText('CONNECTION ISSUE');
  await expect(activity.getByRole('alert')).toContainText('작업을 찾을 수 없습니다.');
  await expect(activity.locator('.processing-indicator')).toHaveCount(0);
  await expect(page.locator('.aw-canvas-visual')).not.toHaveClass(/is-active/);
  unavailable = false;
  await activity.getByRole('button', { name: '상태 다시 확인' }).click();
  await expect(activity).toContainText('COMPLETE');
  await expect(page.getByRole('link', { name: '온톨로지 열기 ↗' })).toBeVisible();
});

test('a delayed status poll cannot overwrite cancellation', async ({ page }) => {
  let job = { ...initialJob };
  let holdNext = false;
  let held = false;
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  let finished = false;
  await page.route(`**/api/jobs/${job.id}`, async route => {
    const snapshot = { ...job };
    if (holdNext && !held) {
      held = true;
      await delayed;
      await route.fulfill({ json: { job: snapshot } });
      finished = true;
    } else await route.fulfill({ json: { job: snapshot } });
  });
  await page.route(`**/api/jobs/${job.id}/cancel`, route => {
    job = { ...job, status: 'cancelled', message: '생성을 취소했습니다.' };
    return route.fulfill({ json: { job } });
  });
  await page.goto(`/analysis/${job.id}`);
  const activity = page.getByLabel('AI analysis activity', { exact: true });
  await expect(activity).toHaveAttribute('aria-busy', 'true');
  await expect(activity.getByRole('button', { name: '생성 취소' })).toBeVisible();
  holdNext = true;
  await expect.poll(() => held).toBe(true);
  await activity.getByRole('button', { name: '생성 취소' }).click();
  await expect(activity).toContainText('PAUSED');
  release();
  await expect.poll(() => finished).toBe(true);
  await expect(activity).toHaveAttribute('aria-busy', 'false');
  await expect(activity).toContainText('생성을 취소했습니다.');
  await expect(activity.getByRole('button', { name: '생성 취소' })).toHaveCount(0);
});

test('connection loss preserves the last known stage without pretending the job is still progressing', async ({ page }) => {
  let offline = false;
  await page.route(`**/api/jobs/${initialJob.id}`, route => offline
    ? route.fulfill({ status: 503, json: { error: '진행 상태 연결이 끊겼습니다.' } })
    : route.fulfill({ json: { job: initialJob } }));
  await page.goto(`/analysis/${initialJob.id}`);
  const activity = page.getByLabel('AI analysis activity', { exact: true });
  await expect(activity).toHaveAttribute('aria-busy', 'true');
  offline = true;
  await expect(activity.getByRole('alert')).toContainText('진행 상태 연결이 끊겼습니다.');
  await expect(activity).toHaveAttribute('aria-busy', 'false');
  await expect(activity).toContainText('마지막 확인 상태');
  await expect(activity.locator('[aria-current="step"]')).toContainText('온톨로지 설계');
  await expect(activity.locator('.aw-spinner')).toHaveCount(0);
  await expect(activity.getByRole('progressbar')).toHaveCount(0);
  await expect(page.locator('.aw-canvas-visual')).not.toHaveClass(/is-active/);
  offline = false;
  await activity.getByRole('button', { name: '상태 다시 확인' }).click();
  await expect(activity).toHaveAttribute('aria-busy', 'true');
  await expect(activity.getByRole('alert')).toHaveCount(0);
});

test('Jev shows the server routing reason and separates calls, decisions, and AI batches', async ({ page }) => {
  let decisionRequests = 0;
  let job: GenerationJob = {
    ...initialJob, stage: 'preparing',
    jevRouting: { message: '의미 분석할 본문·설명 열을 확인하고 있습니다.' },
    metrics: { structuredRecords: 0, deterministicParts: 0, jevRequests: 0, jevInputTokens: 0, codexCalls: 1, cacheHits: 0, reviewParts: 0, jevDecisions: 0, jevAssistedParts: 0, jevFallbackParts: 0, codexBatches: 0 },
  };
  await page.route(`**/api/jobs/${job.id}`, route => route.fulfill({ json: { job } }));
  await page.route(`**/api/jobs/${job.id}/decisions`, route => {
    decisionRequests++;
    return route.fulfill({ json: { decisions: [{
      ontologyId: 'retail-schema', ontologyVersion: 1, sourceName: 'customer-notes.jsonl', documentIds: ['private-document-42'], characters: 340, cached: false, createdAt: initialJob.createdAt,
      result: { route: 'batch', reason: '기록을 독립적으로 읽을 수 있습니다. 불확실한 분류는 원문으로 확인합니다.', context: 'INTERNAL_CONTEXT_DO_NOT_SHOW', decisions: [
        { id: 'stance', selection: 'direct_assertion', confidence: 0.97, accepted: true },
        { id: 'complexity', selection: 'self_contained', confidence: 0.99, accepted: true },
        { id: 'rule_privateRuleApiName', selection: 'privateChoiceApiName', displayName: '문서 유형', selectionLabel: '고객 동향 보고', confidence: 0.71, accepted: false },
      ] },
    }] } });
  });
  await page.goto(`/analysis/${job.id}`);
  const routing = page.getByLabel('Jev processing route', { exact: true });
  await expect(routing).toContainText(job.jevRouting!.message);
  await page.getByLabel('처리 내역', { exact: true }).click();
  const metrics = page.getByLabel('Analysis processing statistics', { exact: true });
  const count = (label: string) => metrics.locator('div').filter({ has: page.getByText(label, { exact: true }) });
  await expect(count('Jev 호출')).toContainText('0회');
  await expect(count('Jev 분류·후보 판정')).toContainText('0건');

  job = {
    ...job, stage: 'extracting', totalChunks: 8, completedChunks: 2,
    jevRouting: { message: '짧은 기록은 묶어서 분석하고, 복잡하거나 불확실한 기록은 개별 분석합니다.' },
    metrics: { ...job.metrics!, jevRequests: 5, jevDecisions: 20, jevAssistedParts: 5, jevFallbackParts: 1, codexCalls: 3, codexBatches: 1 },
  };
  await expect(routing).toContainText(job.jevRouting!.message);
  await expect(count('Jev 호출')).toContainText('5회');
  await expect(count('Jev 분류·후보 판정')).toContainText('20건');
  await expect(count('Jev 보조 분석')).toContainText('5구간');
  await expect(count('Jev 개별 검토 판정')).toContainText('1구간');
  await expect(count('AI 묶음 분석')).toContainText('1회');
  await expect(page.getByText(/불확실 판정도 건수에 포함/)).toBeVisible();
  expect(decisionRequests).toBe(0);
  await page.getByText('Jev 판정 내역', { exact: true }).click();
  const history = page.getByLabel('Jev decision history', { exact: true });
  await expect(history).toContainText('customer-notes.jsonl');
  await expect(history).toContainText('직접 서술');
  await expect(history).toContainText('고객 동향 보고');
  await expect(history).toContainText('확신도 71% · 추가 확인');
  await expect(history).not.toContainText('private-document-42');
  await expect(history).not.toContainText('privateRuleApiName');
  await expect(history).not.toContainText('privateChoiceApiName');
  await expect(history).not.toContainText('INTERNAL_CONTEXT_DO_NOT_SHOW');
  expect(decisionRequests).toBe(1);
  await history.getByRole('button', { name: '내역 새로고침', exact: true }).click();
  await expect.poll(() => decisionRequests).toBe(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoOverflow(page);
  await page.getByRole('button', { name: '사이드바 열기', exact: true }).click();

  job = { ...initialJob, status: 'completed', jevRouting: { message: 'Jev 키가 설정되지 않아 원문을 Codex로 분석했습니다.' }, metrics: { structuredRecords: 0, deterministicParts: 0, jevRequests: 0, jevInputTokens: 0, codexCalls: 2, cacheHits: 0, reviewParts: 0 } };
  await expect(routing).toContainText('Jev 키가 설정되지 않아');
  await expect(count('Jev 분류·후보 판정')).toHaveCount(0);
  await expect(metrics).not.toContainText('NaN');
});
