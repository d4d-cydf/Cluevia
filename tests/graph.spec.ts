import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { GraphDocument } from '../src/types/graph';

const example: GraphDocument = JSON.parse(readFileSync(new URL('../public/examples/gfw-galapagos.json', import.meta.url), 'utf8'));
const exampleUrl = '/case/gfw-galapagos/board';
const nodeNames = /^(carrier|fishing-vessel|encounter|interception|port|area|protected-area|authority|organization): /;
const errors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const messages: string[] = [];
  errors.set(page, messages);
  page.on('pageerror', error => messages.push(error.message));
  await page.route('**/api/system/status', route => route.fulfill({ json: { authenticated: true, authRequired: false, provider: { kind: 'codex', available: false, authenticated: null, message: '그래프 탐색 테스트' }, ontology: { entities: 12, relationships: 15, documents: 3, graphs: 1 }, activeJobs: [] } }));
});
test.afterEach(async ({ page }) => expect(errors.get(page), 'No browser exceptions').toEqual([]));

async function importFromHome(page: Page, graph: unknown) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach files', exact: true }).click();
  await (await chooser).setFiles({ name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(graph)) });
  await page.getByRole('button', { name: 'START INVESTIGATION', exact: true }).click();
}

test('the GFW entry renders sourced objects and opens evidence in the inspector', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '사이드바 열기', exact: true }).click();
  await page.getByRole('link', { name: /GFW · Galápagos 2017/ }).click();
  await expect(page).toHaveURL('/case/gfw-galapagos/overview');
  await page.getByRole('link', { name: 'Board', exact: true }).click();
  await expect(page).toHaveURL(exampleUrl);
  const board = page.getByRole('region', { name: 'Galápagos · 2017: board view', exact: true });
  await expect(board.getByRole('button', { name: nodeNames })).toHaveCount(12);
  await expect(board.getByRole('button', { name: /^Relation:/ })).toHaveCount(15);
  await board.getByRole('button', { name: 'fishing-vessel: Fu Yuan Yu 7866', exact: true }).click();
  const inspector = page.getByRole('region', { name: 'Selected graph item', exact: true });
  await expect(inspector.getByRole('heading', { name: 'Fu Yuan Yu 7866', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '케이스 상세', exact: true })).toBeVisible();
  await expect(page.locator('.gw-detail-dock, .gw-detail-bar, .gw-session-footer, .cg-footer, .aw-canvas-footer, .aw-pending-footer')).toHaveCount(0);
  await inspector.getByRole('button', { name: '출처 gfw-2017 보기', exact: true }).click();
  const source = page.getByRole('link', { name: 'GFW · 갈라파고스 AIS 사례 분석 ↗', exact: true });
  await expect(source).toBeVisible();
  await expect(source).toHaveAttribute('href', example.sources[0].url!);
  await page.getByRole('button', { name: '케이스 요약', exact: true }).click();
  await expect(page.getByText('공개 문헌을 구조화한 역사적 사례입니다. 실시간 선박 위치가 아닙니다.', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '케이스 상세', exact: true })).toBeHidden();
});

test('relationship inspection preserves inferred versus reported status and supports the keyboard', async ({ page }) => {
  await page.goto(exampleUrl);
  const relation = page.getByRole('button', { name: 'Relation: 환적 가능성, Fu Yuan Yu 7866 to Fu Yuan Yu Leng 999', exact: true });
  await relation.focus();
  await relation.press('Enter');
  await expect(relation).toHaveAttribute('aria-pressed', 'true');
  const inspector = page.getByRole('region', { name: 'Selected graph item', exact: true });
  await expect(inspector).toContainText('INFERRED · 추론');
  await expect(inspector).toContainText('Fu Yuan Yu Leng 999');
  await page.getByRole('button', { name: 'Relation: AIS 조우, Fu Yuan Yu Leng 999 to 4척과 AIS 조우', exact: true }).press('Enter');
  await expect(inspector).toContainText('SOURCE-REPORTED · 출처 보고');
  const connections = page.getByRole('switch', { name: 'Key connections', exact: true });
  await connections.click();
  await expect(connections).toHaveAttribute('aria-checked', 'false');
});

test('overview keeps recorded associations before board and lanes, and old timeline links redirect', async ({ page }) => {
  await page.goto(exampleUrl);
  const views = page.getByRole('navigation', { name: 'Graph views', exact: true });
  await expect(views.getByRole('link')).toHaveText(['OVERVIEW', 'BOARD', 'LANES']);
  await page.getByRole('link', { name: 'Lanes', exact: true }).click();
  const lanes = page.getByRole('region', { name: 'Galápagos · 2017: lanes view', exact: true });
  await expect(lanes.getByRole('button', { name: nodeNames })).toHaveCount(12);
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  const overview = page.getByRole('region', { name: '분석 결과 요약', exact: true });
  await expect(overview).toBeVisible();
  await expect(overview.getByRole('button', { name: /^Relation: 추정 · 환적 가능성,/ })).toHaveCount(4);
  await expect(overview.getByRole('button', { name: 'Relation: 추정 · 환적 가능성, Fu Yuan Yu 7866 to Fu Yuan Yu Leng 999', exact: true })).toBeVisible();
  await expect(overview.getByRole('button', { name: /^Relation:/ })).toHaveCount(example.edges.length);
  await expect(overview).not.toContainText(example.findings[0].text);
  await expect(page.getByRole('switch', { name: 'Key connections', exact: true })).toHaveCount(0);
  await page.goto('/case/gfw-galapagos/timeline');
  await expect(page).toHaveURL('/case/gfw-galapagos/overview');
  await expect(overview).toBeVisible();
  await expect(views.getByRole('link', { name: 'Timeline', exact: true })).toHaveCount(0);
});

test('export and server import preserve the complete graph and persist it after reload', async ({ page }) => {
  await page.goto(exampleUrl);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'EXPORT', exact: true }).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe('gfw-galapagos.graph.json');
  const exported = JSON.parse(await readFile((await file.path())!, 'utf8'));
  expect(exported).toEqual(example);
  await page.goto('/');
  await importFromHome(page, exported);
  await expect(page).toHaveURL(/\/case\/graph-[\w-]+\/overview$/);
  await expect(page.getByText('IMPORTED GRAPH', { exact: true })).toBeVisible();
  const importedId = new URL(page.url()).pathname.split('/')[2];
  const stored = await page.request.get(`/api/graphs/${importedId}`);
  expect(stored.ok()).toBe(true);
  expect((await stored.json()).graph.nodes).toEqual(example.nodes);
  expect(await page.evaluate(id => localStorage.getItem(`cluevia.graph.v1.${id}`), importedId)).toBeNull();
  await page.reload();
  await page.getByRole('link', { name: 'Board', exact: true }).click();
  const board = page.getByRole('region', { name: 'Galápagos · 2017: board view', exact: true });
  await expect(board.getByRole('button', { name: nodeNames })).toHaveCount(12);
  const nextDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'EXPORT', exact: true }).click();
  const importedExport = JSON.parse(await readFile((await (await nextDownload).path())!, 'utf8'));
  expect(importedExport.nodes).toEqual(example.nodes);
  expect(importedExport.edges).toEqual(example.edges);
  expect(importedExport.events).toEqual(example.events);
  expect(importedExport.sources).toEqual(example.sources);
});

test('an unrelated imported graph keeps arbitrary IDs and its direct answer in overview', async ({ page }) => {
  const custom: GraphDocument = {
    schemaVersion: '1.0', id: 'different-graph', title: 'Independent research', question: 'What mentions Beta?',
    summary: 'A separate two-object graph.', origin: 'imported', createdAt: '2026-10-10T00:00:00Z', limitations: [],
    groups: [{ id: 'custom-group', label: 'Documents', color: '#3c7890' }],
    sources: [{ id: 'doc:one', title: 'User evidence' }],
    nodes: [
      { id: 'custom:alpha.4', label: 'Alpha document', type: 'document', group: 'custom-group', description: 'Mentions Beta.', sourceIds: ['doc:one'], properties: {} },
      { id: 'custom_beta-8', label: 'Beta object', type: 'object', group: 'custom-group', description: 'Mentioned by Alpha.', sourceIds: ['doc:one'], properties: {} },
    ],
    edges: [{ id: 'custom:edge', source: 'custom:alpha.4', target: 'custom_beta-8', label: 'mentions', description: 'Explicit source reference.', status: 'reported', sourceIds: ['doc:one'] }],
    events: [], findings: [],
  };
  await page.goto('/');
  await importFromHome(page, custom);
  await expect(page).toHaveURL(/\/case\/graph-[\w-]+\/overview$/);
  await expect(page.getByRole('region', { name: '분석 결과 요약', exact: true }).getByRole('button', { name: 'Relation: mentions, Alpha document to Beta object', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Board', exact: true }).click();
  const board = page.getByRole('region', { name: 'Independent research: board view', exact: true });
  await expect(board.getByRole('status').filter({ hasText: '2 entities · 1 relations' })).toBeVisible();
  await board.getByRole('button', { name: 'object: Beta object', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Selected graph item', exact: true })).toContainText('Mentioned by Alpha.');
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(page.getByRole('region', { name: '분석 결과 요약', exact: true }).getByRole('button', { name: 'Relation: mentions, Alpha document to Beta object', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Timeline', exact: true })).toHaveCount(0);
});

test('invalid graph import reports the broken reference and stays on the input screen', async ({ page }) => {
  const invalid = structuredClone(example);
  invalid.edges[0].target = 'nonexistent-target';
  await page.goto('/');
  await importFromHome(page, invalid);
  await expect(page.getByRole('alert')).toContainText('nonexistent-target');
  await expect(page).toHaveURL('/');
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('cluevia.graph.v1.')))).toEqual([]);
});

test('the canvas fills the workbench and focus mode preserves the graph and sidebar state', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('cluevia.case-sidebar.open', 'true'));
  await page.goto(exampleUrl);
  const sidebar = page.getByRole('complementary', { name: '케이스 사이드바', exact: true });
  await expect(sidebar).toBeVisible();
  const canvas = page.locator('.gw-renderer-surface [data-canvas-scroll]');
  await expect(canvas).toBeVisible();
  const normal = (await canvas.boundingBox())!;
  const workbench = (await page.locator('.gw-main').boundingBox())!;
  expect(normal.width).toBeGreaterThanOrEqual(1100);
  expect(Math.abs(normal.y + normal.height - workbench.y - workbench.height)).toBeLessThanOrEqual(1);
  await expect(page.locator('.gw-detail-dock, .gw-detail-bar, .gw-session-footer, .cg-footer, .aw-canvas-footer, .aw-pending-footer')).toHaveCount(0);
  await expect(page.locator('.gw-body > .gw-conversation')).toHaveCount(0);
  await expect(page.getByRole('complementary')).toHaveCount(1);
  expect(normal.height).toBeGreaterThan(650);
  await expect(page.getByRole('region', { name: 'Selected graph item', exact: true })).toBeHidden();

  const selectedNode = page.getByRole('button', { name: 'fishing-vessel: Fu Yuan Yu 7866', exact: true });
  await selectedNode.click();
  await expect(page.getByRole('region', { name: 'Selected graph item', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '케이스 상세', exact: true })).toHaveCSS('position', 'absolute');
  expect((await canvas.boundingBox())!.height).toBeCloseTo(normal.height, 0);
  await page.getByRole('button', { name: '상세 닫기', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '케이스 상세', exact: true })).toBeHidden();
  await expect(selectedNode).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '케이스 정보 보기', exact: true }).click();
  const info = page.getByRole('dialog', { name: '케이스 상세', exact: true });
  await expect(info).toBeVisible();
  await expect(info.getByRole('button', { name: '케이스 요약', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect((await canvas.boundingBox())!.height).toBeCloseTo(normal.height, 0);
  expect((await canvas.boundingBox())!.width).toBeCloseTo(normal.width, 0);
  await page.keyboard.press('Escape');
  await expect(info).toBeHidden();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const zoom = await page.locator('.gw-renderer-surface').getByLabel('Zoom level', { exact: true }).textContent();
  await canvas.evaluate(element => { element.setAttribute('data-instance-check', 'original'); });

  await page.getByRole('button', { name: '그래프 크게 보기', exact: true }).click();
  await expect.poll(async () => (await canvas.boundingBox())!.height).toBeGreaterThan(normal.height + 60);
  const expanded = (await canvas.boundingBox())!;
  expect(expanded.width).toBe(1440);
  expect(expanded.height).toBeGreaterThan(normal.height + 60);
  await expect(page.locator('.case-sidebar')).toBeHidden();
  await expect(page.getByRole('region', { name: 'Case evidence', exact: true })).toBeHidden();
  await expect(canvas).toHaveAttribute('data-instance-check', 'original');
  await expect(page.locator('.gw-renderer-surface').getByLabel('Zoom level', { exact: true })).toHaveText(zoom!);
  await expect(selectedNode).toHaveAttribute('aria-pressed', 'true');

  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '그래프 크게 보기', exact: true })).toBeFocused();
  await expect(sidebar).toBeVisible();
  await expect(canvas).toHaveAttribute('data-instance-check', 'original');
  await expect(page.locator('.gw-renderer-surface').getByLabel('Zoom level', { exact: true })).toHaveText(zoom!);
  expect((await canvas.boundingBox())!.width).toBe(normal.width);
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(canvas).toBeHidden();
  await page.getByRole('link', { name: 'Board', exact: true }).click();
  await expect(canvas).toHaveAttribute('data-instance-check', 'original');
  await expect(page.locator('.gw-renderer-surface').getByLabel('Zoom level', { exact: true })).toHaveText(zoom!);
});

test('the completed graph remains selectable on mobile without page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(exampleUrl);
  const canvas = page.locator('.gw-renderer-surface [data-canvas-scroll]');
  await expect(canvas).toBeVisible();
  const mobileCanvas = (await canvas.boundingBox())!;
  expect(mobileCanvas.height).toBeGreaterThan(500);
  expect(mobileCanvas.y).toBeLessThan(260);
  await page.getByRole('button', { name: '그래프 크게 보기', exact: true }).click();
  await expect.poll(async () => (await canvas.boundingBox())!.height).toBeGreaterThan(650);
  await page.getByRole('button', { name: '원래 크기로 돌아가기', exact: true }).click();
  await page.getByRole('button', { name: 'carrier: Fu Yuan Yu Leng 999', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Selected graph item', exact: true })).toContainText('Fu Yuan Yu Leng 999');
  for (const view of ['Lanes', 'Overview', 'Board']) {
    await page.getByRole('link', { name: view, exact: true }).click();
    const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.width + 1);
  }
});
