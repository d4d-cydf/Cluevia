import { test, expect } from '@playwright/test';

const editions = [
  { code: 'ko', prefix: '', lang: 'ko' },
  { code: 'en', prefix: '/en', lang: 'en' },
  { code: 'ja', prefix: '/ja', lang: 'ja' },
  { code: 'zh', prefix: '/zh', lang: 'zh-CN' },
];

test('language menu preserves the current document and section in all four editions', async ({ page }) => {
  await page.goto('/docs/main-algorithm/overview/');
  const anchor = await page.locator('article h2[id]').first().getAttribute('id');
  await page.evaluate(id => { location.hash = id!; }, anchor);
  for (const edition of editions) {
    await page.locator('.language-sidebar .language-trigger').click();
    const links = page.getByRole('menuitemradio');
    await expect(links).toHaveCount(4);
    for (const [index, target] of editions.entries()) {
      await expect(links.nth(index)).toHaveAttribute('href', `${target.prefix}/docs/main-algorithm/overview/#${encodeURIComponent(anchor!)}`);
    }
    await links.nth(editions.indexOf(edition)).click();
    await expect(page).toHaveURL(new RegExp(`${edition.prefix}/docs/main-algorithm/overview/#`));
    await expect(page.locator('html')).toHaveAttribute('lang', edition.lang);
    await expect(page.locator('article h2[id]').first()).toHaveAttribute('id', anchor!);
    await expect(page.locator('.paper-equation')).toHaveCount(3);
    await expect(page.locator('.katex-error')).toHaveCount(0);
  }
});

test('search results stay within the selected document language', async ({ page }) => {
  for (const edition of editions) {
    await page.goto(`${edition.prefix}/docs/`);
    await expect(page.locator('.language-sidebar .language-trigger')).toBeEnabled();
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('combobox').fill('Gap Find');
    const results = dialog.getByRole('option');
    await expect(results.first()).toBeVisible();
    await results.first().click();
    await expect(page).toHaveURL(new RegExp(`${edition.prefix}/docs/`));
    await expect(page.locator('html')).toHaveAttribute('lang', edition.lang);
  }
});

test('mobile language menu stays visible and switches to the same document', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/en/docs/main-algorithm/confidence/');
  await page.locator('.language-floating .language-trigger').click();
  await expect(page.getByRole('menuitemradio')).toHaveCount(4);
  await page.getByRole('menuitemradio').nth(2).click();
  await expect(page).toHaveURL(/\/ja\/docs\/main-algorithm\/confidence\/$/);
  await expect(page.locator('.language-floating .language-trigger')).toContainText('日本語');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.locator('.research-explorer input[type=radio]').last().check();
  await expect(page.locator('[data-score=AND]')).toHaveText('0.400 – 0.600');
  await expect(page.locator('[data-score=OR]')).toHaveText('0.800 – 1.000');
});
