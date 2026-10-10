import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mockCase } from './case-fixture';
import type { GenerationJob, GraphSummary } from '../src/services/api-client';
import type { GraphDocument } from '../src/types/graph';

const createdAt = '2026-10-10T00:00:00Z';
const caseQuestion = '분할 자료의 고객 주문 관계';
const importedGraphs: GraphSummary[] = Array.from({ length: 11 }, (_, index) => ({
  id: `sidebar-import-${index + 1}`, title: `보관된 자료 ${String(index + 1).padStart(2, '0')}`,
  createdAt: `2026-09-${String(20 - index).padStart(2, '0')}T00:00:00Z`, origin: 'imported', nodeCount: 1, edgeCount: 0,
}));
const partialGraphs: GraphSummary[] = Array.from({ length: 3 }, (_, index) => ({
  id: `sidebar-part-${index + 1}`, title: `고객 주문 부분 ${index + 1}`, createdAt, origin: 'codex', nodeCount: 1, edgeCount: 0,
}));
const jobs: GenerationJob[] = [
  { id: 'sidebar-completed-job', question: caseQuestion, status: 'completed', stage: 'saving', message: '전체 자료의 그래프를 저장했습니다.', createdAt, updatedAt: createdAt, graphId: partialGraphs[0].id, graphIds: partialGraphs.map(graph => graph.id), completedChunks: 3, totalChunks: 3 },
  { id: 'sidebar-paused-job', question: '이어서 확인할 거래 자료', status: 'cancelled', stage: 'extracting', message: '분석을 중단했습니다.', createdAt, updatedAt: createdAt, graphIds: [], completedChunks: 0, totalChunks: 4, resumable: true },
  { id: 'sidebar-schema-job', question: '새로운 공급망 온톨로지 설계', status: 'completed', stage: 'saving', message: '온톨로지를 저장했습니다.', createdAt, updatedAt: createdAt, schemaOnly: true, ontologyId: 'sidebar-schema', ontologyVersion: 1, graphIds: [] },
];

function graphDocument(summary: GraphSummary): GraphDocument {
  return {
    schemaVersion: '1.0', id: summary.id, title: summary.title, question: summary.title,
    summary: '저장된 원문의 객체를 확인합니다.', origin: summary.origin === 'codex' ? 'codex' : 'imported',
    createdAt: summary.createdAt!, limitations: [], groups: [{ id: 'records', label: 'Records', color: '#357d84' }],
    sources: [{ id: 'source', title: '자료 원문', excerpt: '고객 Alex가 자료에 기록되어 있습니다.' }],
    nodes: [{ id: 'alex', label: 'Alex', type: 'Customer', group: 'records', description: '자료의 고객', sourceIds: ['source'], properties: {} }],
    edges: [], events: [], findings: [],
  };
}

const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = []; browserErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') {
      errors.push(`Unexpected API mutation: ${request.method()} ${path}`);
      return route.fulfill({ status: 500, json: { error: 'Navigation must not mutate the workspace.' } });
    }
    if (path === '/api/system/status') return route.fulfill({ json: {
      authenticated: true, authRequired: false, provider: { kind: 'codex', available: true, authenticated: true, message: 'Workspace ready' },
      ontology: { entities: 14, relationships: 0, documents: 14, graphs: 14 }, activeJobs: [], resumableJobs: [],
    } });
    if (path === '/api/jobs') return route.fulfill({ json: { jobs } });
    if (path === '/api/graphs') return route.fulfill({ json: { graphs: [...partialGraphs, ...importedGraphs] } });
    const job = jobs.find(value => path === `/api/jobs/${value.id}`);
    if (job) return route.fulfill({ json: { job } });
    const summary = [...partialGraphs, ...importedGraphs].find(value => path === `/api/graphs/${value.id}`);
    if (summary) return route.fulfill({ json: { graph: graphDocument(summary) } });
    const collection = [...partialGraphs, ...importedGraphs].find(value => path === `/api/graphs/${value.id}/collection`);
    if (collection) return route.fulfill({ json: { jobId: null, graphs: [{ id: collection.id, title: collection.title }], total: 1, index: 0 } });
    errors.push(`Unexpected API read: ${path}`);
    return route.fulfill({ status: 404, json: { error: 'No fixture for this resource.' } });
  });
  await mockCase(page, jobs[0].id, () => partialGraphs.map(graphDocument));
});
test.afterEach(async ({ page }) => expect(browserErrors.get(page), 'No browser exceptions or unexpected API requests').toEqual([]));

async function openSidebar(page: Page) {
  const button = page.getByRole('button', { name: '사이드바 열기', exact: true });
  if (await button.isVisible()) await button.click();
  const sidebar = page.locator('#cluevia-case-sidebar');
  await expect(sidebar).toBeVisible();
  return sidebar;
}

async function expectNoOverflow(page: Page) {
  const widths = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
  expect(widths.content, 'The case sidebar must not add horizontal page overflow').toBeLessThanOrEqual(widths.viewport + 1);
}

test('sidebar groups existing analysis parts as cases and includes saved graphs beyond the old eight-item limit', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'MY CASES', exact: true })).toHaveCount(0);
  const sidebar = await openSidebar(page);
  const completedCase = sidebar.locator(`a[href="/analysis/${jobs[0].id}"]`);
  await expect(completedCase).toHaveCount(1);
  await expect(completedCase).toContainText(caseQuestion);
  await expect(completedCase).toContainText('3');
  await expect(sidebar.locator(`a[href="/analysis/${jobs[1].id}"]`)).toContainText(jobs[1].question);
  await expect(sidebar.locator(`a[href="/analysis/${jobs[2].id}"]`)).toContainText(jobs[2].question);
  for (const part of partialGraphs) await expect(sidebar.locator(`a[href="/case/${part.id}/board"]`)).toHaveCount(0);
  await expect(sidebar.locator('a[href^="/case/sidebar-import-"]')).toHaveCount(11);
  await expect(sidebar.locator('a[href="/case/sidebar-import-11/board"]')).toContainText('보관된 자료 11');
  await expectNoOverflow(page);
});

test('desktop sidebar toggle sits before the logo, searches cases, and keeps the current case selected', async ({ page }) => {
  await page.goto('/');
  const toggle = page.locator('button[aria-controls="cluevia-case-sidebar"]').first();
  const toggleBounds = await toggle.boundingBox();
  const logoBounds = await page.getByRole('link', { name: 'Cluevia home', exact: true }).boundingBox();
  expect(toggleBounds).not.toBeNull(); expect(logoBounds).not.toBeNull();
  expect(toggleBounds!.x, 'The toggle starts at the left window edge').toBeLessThanOrEqual(16);
  expect(toggleBounds!.x + toggleBounds!.width).toBeLessThanOrEqual(logoBounds!.x);
  const sidebar = await openSidebar(page);
  await expect.poll(async () => Math.abs((await toggle.boundingBox())!.x - toggleBounds!.x), {
    message: 'Opening the sidebar must keep the toggle and logo at the left window edge',
  }).toBeLessThan(1);
  await expect.poll(async () => Math.abs((await page.getByRole('link', { name: 'Cluevia home', exact: true }).boundingBox())!.x - logoBounds!.x)).toBeLessThan(1);
  await expect.poll(async () => {
    const header = await page.locator('.home-header').boundingBox();
    const drawer = await sidebar.boundingBox();
    return drawer!.y - (header!.y + header!.height);
  }, { message: 'The desktop sidebar begins below the full-width header' }).toBeGreaterThanOrEqual(-1);
  const search = sidebar.getByRole('searchbox');
  await search.fill('보관된 자료 11');
  const target = sidebar.locator('a[href="/case/sidebar-import-11/board"]');
  await expect(target).toBeVisible();
  await expect(sidebar.locator(`a[href="/analysis/${jobs[0].id}"]`)).toHaveCount(0);
  await target.click();
  await expect(page).toHaveURL('/case/sidebar-import-11/board');
  await expect(page.getByRole('button', { name: 'Customer: Alex', exact: true })).toBeVisible();
  await expect(target).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: '사이드바 닫기', exact: true }).click();
  await expect(sidebar).not.toBeVisible();
  await page.getByRole('button', { name: '사이드바 열기', exact: true }).click();
  await expect(sidebar).toBeVisible();
  await expect(target).toHaveAttribute('aria-current', 'page');
  await expectNoOverflow(page);
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto('/case/gfw-galapagos/board');
  await openSidebar(page);
  await expect(page.getByRole('region', { name: 'Galápagos · 2017: board view', exact: true })).toBeVisible();
  await expectNoOverflow(page);
});

test.describe('mobile sidebar', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('drawer closes from the backdrop or Escape and returns to the case without horizontal overflow', async ({ page }) => {
    await page.goto('/');
    const sidebar = await openSidebar(page);
    await expectNoOverflow(page);
    await page.keyboard.press('Escape');
    await expect(sidebar).not.toBeVisible();
    await expect(page.getByRole('button', { name: '사이드바 열기', exact: true })).toBeFocused();
    await openSidebar(page);
    await page.mouse.click(385, 420);
    await expect(sidebar).not.toBeVisible();
    await expectNoOverflow(page);
    await openSidebar(page);
    await sidebar.locator('a[href="/case/sidebar-import-1/board"]').click();
    await expect(page).toHaveURL('/case/sidebar-import-1/board');
    await expect(sidebar).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Customer: Alex', exact: true })).toBeVisible();
    await expectNoOverflow(page);
  });
});
