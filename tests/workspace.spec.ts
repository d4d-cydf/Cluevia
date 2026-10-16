import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { mockClarification, startUnscopedAnalysis } from './clarification-fixture';
import type { Page } from '@playwright/test';

const demoCase = '/case/0143';
const evidenceFile = { name: 'evidence.txt', mimeType: 'text/plain', buffer: Buffer.from('Example evidence for the local prototype.') };

// Capture actual browser exceptions and console errors throughout every workflow.
test.beforeEach(async ({ page }) => {
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('console', message => {
    const expectedMissingGraph = message.location().url.endsWith('/api/graphs/not-a-case') && /404/.test(message.text());
    if (message.type() === 'error' && !expectedMissingGraph) browserErrors.push(message.text());
  });
  (page as Page & { browserErrors: string[] }).browserErrors = browserErrors;
  // Unmocked mutations must never reach a live model or workspace while testing UI.
  await page.route('**/api/**', route => {
    if (route.request().method() === 'GET') return route.fallback();
    browserErrors.push(`Unexpected unmocked API mutation: ${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 500, json: { error: 'Unexpected unmocked API mutation' } });
  });
  await page.route('**/api/system/status', route => route.fulfill({ json: { authenticated: true, authRequired: false, provider: { kind: 'codex', available: true, authenticated: true, message: 'Workspace ready' }, ontology: { entities: 12, relationships: 15, documents: 3, graphs: 1 }, activeJobs: [] } }));
  await page.route('**/api/graphs', route => route.fulfill({ json: { graphs: [] } }));
  await mockClarification(page);
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

test('dropped evidence starts an analysis with the default extraction question', async ({ page }) => {
  const question = '첨부 자료의 객체와 관계를 근거에 따라 정리해줘.';
  const job = { id: 'dropped-source-job', status: 'running', stage: 'designing', message: '자료에 맞는 온톨로지를 설계하고 있습니다.', question, createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z' };
  let submission: unknown;
  await page.route('**/api/documents/upload', route => route.fulfill({ status: 201, json: { document: { id: 'dropped-source', name: 'dropped.txt', bytes: 14, characters: 14, chunkCount: 1, createdAt: job.createdAt } } }));
  await page.route('**/api/jobs', route => { if (route.request().method() === 'GET') return route.fulfill({ json: { jobs: [job] } }); submission = route.request().postDataJSON(); return route.fulfill({ status: 202, json: { job } }); });
  await page.route('**/api/jobs/dropped-source-job', route => route.fulfill({ json: { job } }));
  await page.goto('/');
  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['Local evidence'], 'dropped.txt', { type: 'text/plain' }));
    return transfer;
  });
  await page.locator('.home-screen').dispatchEvent('drop', { dataTransfer });
  await expect(page.getByRole('list', { name: 'Attached files' })).toContainText('dropped.txt');
  await startUnscopedAnalysis(page);
  await expect(page).toHaveURL('/analysis/dropped-source-job');
  await expect(page.getByLabel('분석 세션 설명', { exact: true })).toContainText(question);
  expect(submission).toEqual({ question, documents: [], uploadIds: ['dropped-source'] });
});

test('a question without uploaded evidence submits an existing-knowledge job', async ({ page }) => {
  const question = 'What connections are shown in this example case?';
  let submitted: unknown;
  const job = { id: 'workspace-test-job', status: 'queued', stage: 'preparing', message: '저장된 자료로 작업 대기 중', question, createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z' };
  await page.route('**/api/jobs', route => { if (route.request().method() === 'GET') return route.fulfill({ json: { jobs: [job] } }); submitted = route.request().postDataJSON(); return route.fulfill({ status: 202, json: { job } }); });
  await page.route('**/api/jobs/workspace-test-job', route => route.fulfill({ json: { job } }));
  await page.goto('/');
  await page.getByLabel('What do you want to find out?').fill(question);
  await startUnscopedAnalysis(page);
  await expect(page).toHaveURL('/analysis/workspace-test-job');
  await expect(page.getByLabel('AI analysis activity', { exact: true })).toContainText(job.message);
  expect(submitted).toEqual({ question, documents: [] });
  await expect(page.getByLabel('분석 세션 설명', { exact: true })).toContainText(question);
});

test('view tabs present overview before the detailed graph layouts', async ({ page }) => {
  await page.goto(`${demoCase}/board`);
  await expect(page.getByRole('navigation', { name: 'Graph views' }).getByRole('link')).toHaveText(['OVERVIEW', 'BOARD', 'LANES']);
  await page.getByRole('link', { name: /^Overview$/i }).click();
  await expect(page).toHaveURL(`${demoCase}/overview`);
  await expect(page.getByRole('region', { name: '분석 결과 요약', exact: true })).toBeVisible();
  await page.getByRole('link', { name: /^Lanes$/i }).click();
  await expect(page).toHaveURL(`${demoCase}/lanes`);
  await expect(page.getByRole('region', { name: 'Investigation graph, lanes view' })).toBeVisible();
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
  await expect(page.getByText('Your question is saved in this demo case. Explore the linked evidence in Overview or on the board. Live research is not available in this preview.', { exact: true })).toBeVisible();
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

test('a legacy timeline link opens Overview and preserves access to the board', async ({ page }) => {
  await page.goto(`${demoCase}/timeline`);
  await expect(page).toHaveURL(`${demoCase}/overview`);
  await expect(page.getByRole('region', { name: '분석 결과 요약', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Timeline$/i })).toHaveCount(0);
  await page.getByRole('link', { name: /^Board$/i }).click();
  await expect(page.getByRole('region', { name: 'Investigation graph, board view' })).toBeVisible();
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
    await page.getByRole('button', { name: '사이드바 열기', exact: true }).click();
    await page.getByRole('link', { name: /Original design demo/ }).click();
    await expect(page).toHaveURL(`${demoCase}/overview`);
    await expect(page.getByRole('region', { name: '분석 결과 요약', exact: true })).toBeVisible();
    await page.getByRole('link', { name: /^Board$/i }).click();
    await expectNoPageOverflow(page);
    await page.getByRole('button', { name: 'IP ADDRESS: 203.0.113.42', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Selected object', exact: true })).toContainText('203.0.113.42');

    await page.getByRole('link', { name: /^Lanes$/i }).click();
    await expect(page).toHaveURL(`${demoCase}/lanes`);
    await expectNoPageOverflow(page);
    await page.getByRole('link', { name: /^Overview$/i }).click();
    await expect(page).toHaveURL(`${demoCase}/overview`);
    await expectNoPageOverflow(page);
  });
});
