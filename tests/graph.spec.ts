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
  await expect(page).toHaveURL(exampleUrl);
  const board = page.getByRole('region', { name: 'Galápagos · 2017: board view', exact: true });
  await expect(board.getByRole('button', { name: nodeNames })).toHaveCount(12);
  await expect(board.getByRole('button', { name: /^Relation:/ })).toHaveCount(15);
  await board.getByRole('button', { name: 'fishing-vessel: Fu Yuan Yu 7866', exact: true }).click();
  const inspector = page.getByRole('region', { name: 'Selected graph item', exact: true });
  await expect(inspector.getByRole('heading', { name: 'Fu Yuan Yu 7866', exact: true })).toBeVisible();
  await inspector.getByRole('button', { name: '출처 gfw-2017 보기', exact: true }).click();
  const source = page.getByRole('link', { name: 'GFW · 갈라파고스 AIS 사례 분석 ↗', exact: true });
  await expect(source).toBeVisible();
  await expect(source).toHaveAttribute('href', example.sources[0].url!);
  await expect(page.getByText('공개 문헌을 구조화한 역사적 사례입니다. 실시간 선박 위치가 아닙니다.', { exact: true })).toBeVisible();
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

test('lanes and timeline use the loaded case and its actual 2017 dates', async ({ page }) => {
  await page.goto(exampleUrl);
  await page.getByRole('link', { name: 'Lanes', exact: true }).click();
  const lanes = page.getByRole('region', { name: 'Galápagos · 2017: lanes view', exact: true });
  await expect(lanes.getByRole('button', { name: nodeNames })).toHaveCount(12);
  await page.getByRole('link', { name: 'Timeline', exact: true }).click();
  const timeline = page.getByRole('region', { name: 'Galápagos · 2017: timeline view', exact: true });
  await expect(timeline.getByRole('button', { name: /2017$/ })).toHaveCount(2);
  await timeline.getByRole('button', { name: '네 연승선과 조우, 05 Aug 2017', exact: true }).click();
  const inspector = page.getByRole('region', { name: 'Selected graph item', exact: true });
  await expect(inspector).toContainText('2017-08-05 → 2017-08-07');
  await timeline.getByRole('button', { name: '갈라파고스에서 나포, 13 Aug 2017', exact: true }).click();
  await expect(inspector).toContainText('2017-08-13');
  await expect(timeline).not.toContainText('2026');
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
  await expect(page).toHaveURL(/\/case\/graph-[\w-]+\/board$/);
  await expect(page.getByText('IMPORTED GRAPH', { exact: true })).toBeVisible();
  const importedId = new URL(page.url()).pathname.split('/')[2];
  const stored = await page.request.get(`/api/graphs/${importedId}`);
  expect(stored.ok()).toBe(true);
  expect((await stored.json()).graph.nodes).toEqual(example.nodes);
  expect(await page.evaluate(id => localStorage.getItem(`cluevia.graph.v1.${id}`), importedId)).toBeNull();
  await page.reload();
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

test('an unrelated imported graph renders arbitrary IDs and an honest empty timeline', async ({ page }) => {
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
  await expect(page).toHaveURL(/\/case\/graph-[\w-]+\/board$/);
  const board = page.getByRole('region', { name: 'Independent research: board view', exact: true });
  await expect(board.getByRole('status').filter({ hasText: '2 entities · 1 relations' })).toBeVisible();
  await board.getByRole('button', { name: 'object: Beta object', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Selected graph item', exact: true })).toContainText('Mentioned by Alpha.');
  await page.getByRole('link', { name: 'Timeline', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'This graph has no timeline yet.', exact: true })).toBeVisible();
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

test('the completed graph remains selectable on mobile without page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(exampleUrl);
  await page.getByRole('button', { name: 'carrier: Fu Yuan Yu Leng 999', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Selected graph item', exact: true })).toContainText('Fu Yuan Yu Leng 999');
  for (const view of ['Lanes', 'Timeline', 'Board']) {
    await page.getByRole('link', { name: view, exact: true }).click();
    const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.width + 1);
  }
});
