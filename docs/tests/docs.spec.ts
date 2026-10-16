import { test, expect } from '@playwright/test';

test('example supports selecting evidence and switching perspectives by keyboard', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'From evidence. To a graph.' })).toBeVisible();
  await page.getByRole('button', { name: 'EVENT 운반선 나포' }).click();
  await expect(page.locator('.preview-inspector strong')).toHaveText('운반선 나포');
  await expect(page.getByRole('link', { name: '운반선 나포 출처 원문 열기' })).toHaveAttribute('href', /globalfishingwatch\.org/);
  await page.getByRole('tab', { name: 'Board', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Lanes', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Timeline', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: /갈라파고스에서 나포/ }).click();
  await expect(page.locator('.preview-inspector strong')).toHaveText('운반선 나포');
  await page.getByRole('button', { name: '예제 보기 초기화' }).click();
  await expect(page.getByRole('tab', { name: 'Board', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.preview-inspector strong')).toHaveText('Fu Yuan Yu Leng 999');
  expect(errors).toEqual([]);
});

test('Korean search opens relevant documentation from the static index', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '문서 검색', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox').fill('Gap Find 단계별 규칙');
  const result = dialog.getByRole('option').filter({ hasText: 'Gap Find 단계별 규칙' }).first();
  await expect(result).toBeVisible();
  await result.click();
  await expect(page.getByRole('heading', { name: 'Gap Find 단계별 규칙', exact: true })).toBeVisible();
  await expect(dialog).not.toBeVisible();
});

test('all documentation pages and shipped example downloads resolve', async ({ request }) => {
  const paths = ['', '/main-algorithm/overview', '/main-algorithm/model', '/main-algorithm/gap-find', '/main-algorithm/confidence', '/main-algorithm/gap-fill', '/main-algorithm/worked-example', '/main-algorithm/implementation', '/algorithms/current-pipeline', '/algorithms/extraction', '/algorithms/validation', '/algorithms/board-layout', '/algorithms/edge-routing', '/algorithms/timeline', '/algorithms/exploration', '/guide/quickstart', '/guide/workspace', '/guide/import-export', '/guide/example', '/guide/troubleshooting', '/concepts/evidence-model', '/concepts/architecture', '/reference/graph-document', '/reference/api', '/reference/aip', '/development/local', '/development/deployment'];
  for (const path of paths) {
    const response = await request.get(`/docs${path}/`, { timeout: 90_000 });
    expect(response.status(), path).toBe(200);
    expect(await response.text()).toContain('Cluevia');
  }
  const download = await request.get('/examples/gfw-galapagos.json');
  expect(download.ok()).toBeTruthy();
  expect(await download.json()).toMatchObject({ schemaVersion: '1.0', id: 'gfw-galapagos' });
  expect((await request.get('/examples/gfw-source-notes.txt')).ok()).toBeTruthy();
});

test('mobile landing and document remain within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Cluevia 시작하기', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('tab', { name: 'Lanes', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const appHref = await page.getByRole('link', { name: 'Cluevia 열기', exact: true }).getAttribute('href');
  expect(appHref).toMatch(/^https?:\/\//);
  await expect(page.getByRole('link', { name: 'Cluevia 시작하기', exact: true })).toHaveAttribute('href', appHref!);
  await page.goto('/docs/');
  await expect(page.getByRole('heading', { name: '알고리즘 개요', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('theme preference and mobile navigation work on documentation pages', async ({ page }) => {
  await page.goto('/docs/');
  await expect(page.locator('.language-sidebar .language-trigger')).toBeEnabled();
  await page.locator('[data-theme-toggle]').click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator('.language-sidebar .language-trigger')).toBeEnabled();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '목차 열기', exact: true }).click();
  const sidebar = page.getByRole('complementary');
  await expect(sidebar).toBeVisible();
  await sidebar.getByRole('link', { name: '그래프 배치', exact: true }).click();
  await expect(page.getByRole('heading', { name: '그래프 배치', exact: true })).toBeVisible();
  await expect(sidebar).not.toBeVisible();
});
