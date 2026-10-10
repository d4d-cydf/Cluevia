import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const demoCase = '/case/0143';
const evidenceFile = { name: 'evidence.txt', mimeType: 'text/plain', buffer: Buffer.from('Example evidence for the local prototype.') };

// Capture actual browser exceptions and console errors throughout every workflow.
test.beforeEach(async ({ page }) => {
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  (page as Page & { browserErrors: string[] }).browserErrors = browserErrors;
});

test.afterEach(async ({ page }) => {
  expect((page as Page & { browserErrors: string[] }).browserErrors, 'No browser exceptions or console errors').toEqual([]);
});

async function expectNoPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content, 'Only the graph/timeline canvas may scroll horizontally').toBeLessThanOrEqual(dimensions.width + 1);
}

test('home requires a question or file and removes attached evidence', async ({ page }) => {
  await page.goto('/');
  const start = page.getByRole('button', { name: 'START INVESTIGATION' });
  await expect(start).toBeDisabled();
  await page.getByLabel('What do you want to find out?').fill('   ');
  await expect(start).toBeDisabled();

  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach files', exact: true }).click();
  await (await chooser).setFiles(evidenceFile);
  await expect(page.getByRole('list', { name: 'Attached files' })).toContainText('evidence.txt');
  await expect(start).toBeEnabled();
  await page.getByRole('button', { name: 'Remove evidence.txt', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Attached files' })).toHaveCount(0);
  await expect(start).toBeDisabled();
});

test('dropped evidence requires a question before generation', async ({ page }) => {
  await page.goto('/');
  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['Local evidence'], 'dropped.txt', { type: 'text/plain' }));
    return transfer;
  });
  await page.locator('.home-screen').dispatchEvent('drop', { dataTransfer });
  await expect(page.getByRole('list', { name: 'Attached files' })).toContainText('dropped.txt');
  await page.getByRole('button', { name: 'START INVESTIGATION' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('alert')).toContainText('질문을 입력');
});

test('a question without evidence reports the missing source', async ({ page }) => {
  await page.goto('/');
  const question = 'What connections are shown in this example case?';
  await page.getByLabel('What do you want to find out?').fill(question);
  await page.getByRole('button', { name: 'START INVESTIGATION' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('alert')).toContainText('자료');
  await expect(page.getByLabel('What do you want to find out?')).toHaveValue(question);
});

test('view tabs navigate between the graph layouts and timeline', async ({ page }) => {
  await page.goto(`${demoCase}/board`);
  await page.getByRole('link', { name: /^Lanes$/i }).click();
  await expect(page).toHaveURL(`${demoCase}/lanes`);
  await expect(page.getByRole('region', { name: 'Investigation graph, lanes view' })).toBeVisible();
  await page.getByRole('link', { name: /^Timeline$/i }).click();
  await expect(page).toHaveURL(`${demoCase}/timeline`);
  await expect(page.getByRole('region', { name: 'Investigation timeline. Scroll horizontally to explore dates.' })).toBeVisible();
  await page.getByRole('link', { name: /^Board$/i }).click();
  await expect(page).toHaveURL(`${demoCase}/board`);
});

test('node selection, evidence citations, and answer-path controls update the board', async ({ page }) => {
  await page.goto(`${demoCase}/board`);
  const wallet = page.getByRole('button', { name: 'WALLET: 0x5aAe…eAed', exact: true });
  await wallet.click();
  await expect(wallet).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Selected object', exact: true })).toContainText('0x5aAe…eAed');

  await page.getByRole('button', { name: 'Show evidence E1', exact: true }).first().click();
  await expect(page.getByRole('region', { name: 'Selected object', exact: true })).toContainText('203.0.113.42');
  await expect(page.getByRole('button', { name: 'IP ADDRESS: 203.0.113.42', exact: true })).toHaveAttribute('aria-pressed', 'true');

  const answerPath = page.getByRole('switch', { name: 'Answer path', exact: true });
  const initial = await answerPath.getAttribute('aria-checked');
  await answerPath.click();
  await expect(answerPath).toHaveAttribute('aria-checked', initial === 'true' ? 'false' : 'true');
  await answerPath.click();
  await expect(answerPath).toHaveAttribute('aria-checked', initial || 'true');
});

test('inspector actions queue locally and Ask about this prepares a follow-up', async ({ page }) => {
  await page.goto(`${demoCase}/board`);
  await page.getByRole('button', { name: 'WALLET: 0x5aAe…eAed', exact: true }).click();
  const inspector = page.getByRole('region', { name: 'Selected object', exact: true });
  await inspector.getByRole('button', { name: 'Flag wallet', exact: true }).click();
  await expect(inspector.getByRole('button', { name: 'Queued: Flag wallet', exact: true })).toBeVisible();
  await inspector.getByRole('button', { name: /Ask about this/i }).click();
  await expect(page.getByRole('textbox', { name: 'Follow-up question', exact: true })).toHaveValue(/0x5aAe…eAed/);
});

test('sending a follow-up adds the question and an honest prototype reply', async ({ page }) => {
  await page.goto(`${demoCase}/board`);
  const followup = 'Explain the selected connections in this sample.';
  await page.getByRole('textbox', { name: 'Follow-up question', exact: true }).fill(followup);
  await page.getByRole('button', { name: /^Send(?: message)?$/i }).click();
  await expect(page.getByText(followup, { exact: true })).toBeVisible();
  await expect(page.getByText('Your question is saved in this demo case. Explore the linked evidence on the board or timeline. Live research is not available in this preview.', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Follow-up question', exact: true })).toBeEmpty();
});

test('export produces a readable JSON case file', async ({ page }) => {
  await page.goto(`${demoCase}/board`);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /^Export(?: case)?$/i }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.json$/);
  const path = await download.path();
  expect(path).toBeTruthy();
  const exported = JSON.parse(await readFile(path!, 'utf8'));
  expect(exported).toMatchObject({ id: '0143', mode: 'demo', objects: { lead: { value: 'secure-login.example' }, ip: { value: '203.0.113.42' } } });
  expect(exported.links).toHaveLength(12);
  expect(exported.timeline.events).toHaveLength(17);
});

test('timeline event selection updates details and payment bars support keyboard inspection', async ({ page }) => {
  await page.goto(`${demoCase}/timeline`);
  const event = page.getByRole('button', { name: 'Deposit, 5 OCT 2026, Exchange deposit', exact: true });
  await event.click();
  await expect(event).toHaveAttribute('aria-pressed', 'true');
  const inspector = page.getByRole('region', { name: 'Selected event', exact: true });
  await expect(inspector).toContainText('Deposit');
  await expect(inspector).toContainText('exchange deposit address receives the funds');
  await page.getByRole('img', { name: '4 OCT 2026: 6 payments', exact: true }).focus();
  await expect(page.getByRole('status').filter({ hasText: '4 OCT · 6 payments' })).toBeVisible();
});

test('an unknown case shows a missing-case screen', async ({ page }) => {
  await page.goto('/case/not-a-case/board');
  await expect(page.getByText(/missing|not found|could not find|couldn.t find/i).first()).toBeVisible();
  await expect(page.getByRole('region', { name: 'Investigation graph, board view' })).toHaveCount(0);
});

test.describe('mobile layout', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('home and all case views fit the page while controls remain usable', async ({ page }) => {
    await page.goto('/');
    await expectNoPageOverflow(page);
    await page.getByRole('button', { name: 'MY CASES', exact: true }).click();
    await page.getByRole('link', { name: 'Original design demo ↗', exact: true }).click();
    await expect(page).toHaveURL(`${demoCase}/board`);
    await expectNoPageOverflow(page);
    await page.getByRole('button', { name: 'IP ADDRESS: 203.0.113.42', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Selected object', exact: true })).toContainText('203.0.113.42');

    await page.getByRole('link', { name: /^Lanes$/i }).click();
    await expect(page).toHaveURL(`${demoCase}/lanes`);
    await expectNoPageOverflow(page);
    await page.getByRole('link', { name: /^Timeline$/i }).click();
    await expect(page).toHaveURL(`${demoCase}/timeline`);
    await expectNoPageOverflow(page);
    await page.getByRole('button', { name: 'Deposit, 5 OCT 2026, Exchange deposit', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Selected event', exact: true })).toContainText('Deposit');
    await expectNoPageOverflow(page);
  });
});
