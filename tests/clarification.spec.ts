import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { ClarificationInput, ClarificationResult, AnalysisBrief } from '../src/types/clarification';
import type { GraphGenerationInput } from '../src/types/graph';

const question = '기업과 거래 관계를 분석해줘';
const brief: AnalysisBrief = { objective: '기업 사이의 거래 관계 확인', scope: '제공 자료의 2025년 직접 거래만 분석', output: '거래 관계와 원문 근거를 그래프로 표시', answers: [] };
const questions: ClarificationResult = {
  status: 'questions', source: 'codex', introduction: '거래 분석의 목적과 대상을 먼저 정리합니다.', brief,
  questions: [
    { id: 'goal', question: '어떤 관계를 확인할까요?', reason: '필요한 관계 유형을 정합니다.', options: [
      { id: 'trade', label: '거래 관계', description: '기업 사이의 구매와 판매를 확인합니다.' },
      { id: 'ownership', label: '소유 관계', description: '기업의 지분과 소유자를 확인합니다.' },
    ] },
    { id: 'scope', question: '기간과 대상을 어떻게 좁힐까요?', reason: '분석할 범위를 정합니다.', options: [
      { id: 'all', label: '제공 자료 전체', description: '모든 기간과 기업을 포함합니다.' },
      { id: 'year', label: '최근 1년', description: '자료의 최근 1년 거래를 확인합니다.' },
    ] },
  ],
};
const ready = (input: ClarificationInput): ClarificationResult => ({ status: 'ready', source: 'codex', introduction: '선택한 요구사항을 확인하고 시작하세요.', questions: [], brief: { ...brief, answers: input.answers } });
const job = { id: 'clarification-job', question, status: 'running', stage: 'designing', message: '확정한 범위로 온톨로지를 설계합니다.', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', graphIds: [] };

const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const caught: string[] = []; errors.set(page, caught); page.on('pageerror', error => caught.push(error.message));
  await page.route('**/api/system/status', route => route.fulfill({ json: { authenticated: true, authRequired: false, provider: { kind: 'hybrid', ontologyPlanning: true, available: true, authenticated: true, codex: { available: true, authenticated: true }, jev: { configured: true } }, activeJobs: [], ontology: { entities: 0, relationships: 0, documents: 0, graphs: 0 } } }));
  await page.route('**/api/graphs', route => route.fulfill({ json: { graphs: [] } }));
  await page.route('**/api/jobs', route => route.fulfill({ status: route.request().method() === 'GET' ? 200 : 500, json: route.request().method() === 'GET' ? { jobs: [] } : { error: 'Unexpected graph generation' } }));
  await page.route(`**/api/jobs/${job.id}`, route => route.fulfill({ json: { job } }));
});
test.afterEach(async ({ page }) => expect(errors.get(page), 'No browser exceptions').toEqual([]));

async function start(page: Page, text = question) {
  await page.getByLabel('What do you want to find out?', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'START INVESTIGATION', exact: true }).click();
  await expect(page.getByRole('region', { name: '분석 범위 확인', exact: true })).toBeVisible();
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
}

test('selected and custom answers become an editable confirmed brief before any full upload or job', async ({ page }) => {
  const requests: ClarificationInput[] = []; const submissions: GraphGenerationInput[] = []; let uploads = 0;
  const source = Buffer.from('buyer,seller,year\nAlpha,Beta,2025\n' + 'Alpha,Beta,2024\n'.repeat(180000));
  await page.route('**/api/analysis/clarify', route => { const input = route.request().postDataJSON() as ClarificationInput; requests.push(input); return route.fulfill({ json: input.round ? ready(input) : questions }); });
  await page.route('**/api/documents/upload', route => {
    uploads++; expect(route.request().postDataBuffer()).toEqual(source);
    return route.fulfill({ status: 201, json: { document: { id: 'uploaded-trades', name: 'trades.csv', bytes: source.length, characters: source.length, chunkCount: 100, createdAt: job.createdAt } } });
  });
  await page.route('**/api/jobs', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { jobs: [] } });
    submissions.push(route.request().postDataJSON()); return route.fulfill({ status: 202, json: { job: { ...job, analysisBrief: submissions[0].analysisBrief } } });
  });
  await page.route(`**/api/jobs/${job.id}`, route => route.fulfill({ json: { job: { ...job, analysisBrief: submissions[0]?.analysisBrief } } }));
  await page.goto('/');
  await page.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'trades.csv', mimeType: 'text/csv', buffer: source });
  await start(page);
  const panel = page.getByRole('region', { name: '분석 범위 확인', exact: true });
  const next = panel.getByRole('button', { name: '답변으로 범위 정리' });
  await expect(next).toBeDisabled();
  expect(requests).toHaveLength(1); expect(requests[0].sources[0].size).toBeGreaterThan(2 * 1024 * 1024);
  expect(requests[0].sources.reduce((sum, item) => sum + item.excerpt.length, 0)).toBeLessThanOrEqual(12000);
  expect(uploads).toBe(0); expect(submissions).toHaveLength(0);
  await panel.getByRole('group', { name: /어떤 관계를 확인할까요/ }).getByRole('radio', { name: /^거래 관계/ }).check();
  await panel.getByRole('group', { name: /기간과 대상을 어떻게 좁힐까요/ }).getByRole('radio', { name: /^기타/ }).check();
  await expect(next).toBeDisabled();
  const custom = '2025년 Alpha와 Beta 사이의 직접 거래만. 소유 관계는 제외.';
  await panel.getByLabel('기간과 대상을 어떻게 좁힐까요? — 직접 입력', { exact: true }).fill(custom);
  await next.click();
  await expect(panel.getByLabel('분석 범위', { exact: true })).toHaveValue(brief.scope);
  expect(requests).toHaveLength(2); expect(requests[1].round).toBe(1); expect(requests[1].answers[1].answer).toBe(custom);
  await panel.getByText('확인한 질문과 답변 2개', { exact: true }).click();
  await expect(panel.locator('dd').last()).toHaveText(custom);
  const editedScope = '2025년 1분기 Alpha와 Beta의 직접 거래만 분석';
  await panel.getByLabel('분석 범위', { exact: true }).fill(editedScope);
  expect(uploads).toBe(0); expect(submissions).toHaveLength(0);
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/jobs') && response.request().method() === 'POST' && response.status() === 202),
    panel.getByRole('button', { name: '이 범위로 분석 시작' }).click(),
  ]);
  await expect(page).toHaveURL(`/analysis/${job.id}`);
  expect(uploads).toBe(1); expect(submissions).toHaveLength(1);
  expect(submissions[0]).toEqual({ question, documents: [], uploadIds: ['uploaded-trades'], analysisBrief: { ...brief, scope: editedScope, answers: requests[1].answers } });
  if (await page.getByRole('button', { name: '사이드바 열기', exact: true }).isVisible()) await page.getByRole('button', { name: '사이드바 열기', exact: true }).click();
  await page.getByLabel('분석 세션 설명', { exact: true }).locator('summary').click();
  await expect(page.getByLabel('분석 세션 설명', { exact: true })).toContainText(editedScope);
  await page.reload();
  if (await page.getByRole('button', { name: '사이드바 열기', exact: true }).isVisible()) await page.getByRole('button', { name: '사이드바 열기', exact: true }).click();
  await page.getByLabel('분석 세션 설명', { exact: true }).locator('summary').click();
  await expect(page.getByLabel('분석 세션 설명', { exact: true })).toContainText(editedScope);
});

test('a clear request still requires confirmation and does not invent evidence for a prompt-only job', async ({ page }) => {
  let submission: GraphGenerationInput | undefined;
  await page.route('**/api/analysis/clarify', route => route.fulfill({ json: ready(route.request().postDataJSON()) }));
  await page.route('**/api/jobs', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { jobs: [] } });
    submission = route.request().postDataJSON(); return route.fulfill({ status: 202, json: { job } });
  });
  await page.goto('/'); await start(page);
  await expect(page.getByLabel('분석 목적', { exact: true })).toHaveValue(brief.objective);
  expect(submission).toBeUndefined();
  await page.getByLabel('분석 목적', { exact: true }).fill('');
  await expect(page.getByRole('button', { name: '이 범위로 분석 시작' })).toBeDisabled();
  await page.getByLabel('분석 목적', { exact: true }).fill('기업 거래 온톨로지 초안');
  await page.getByRole('button', { name: '이 범위로 분석 시작' }).click();
  await expect(page).toHaveURL(`/analysis/${job.id}`);
  expect(submission?.documents).toEqual([]); expect(submission?.analysisBrief?.objective).toBe('기업 거래 온톨로지 초안');
});

test('submitted answers and attachments survive a reload while the scope response is pending', async ({ page }) => {
  const source = Buffer.from('company,parent\n' + 'Alpha,Beta\n'.repeat(220000));
  const requests: ClarificationInput[] = []; const releases: (() => void)[] = [];
  let uploads = 0; let submission: GraphGenerationInput | undefined;
  await page.route('**/api/analysis/clarify', async route => {
    const input = route.request().postDataJSON() as ClarificationInput; requests.push(input);
    if (input.round && requests.filter(request => request.round).length === 1) await new Promise<void>(resolve => releases.push(resolve));
    await route.fulfill({ json: input.round ? ready(input) : questions }).catch(() => {});
  });
  await page.route('**/api/documents/upload', route => {
    uploads++; expect(route.request().postDataBuffer()).toEqual(source);
    return route.fulfill({ status: 201, json: { document: { id: 'restored-upload', name: 'source.csv', bytes: source.length, characters: source.length, chunkCount: 1, createdAt: job.createdAt } } });
  });
  await page.route('**/api/jobs', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { jobs: [] } });
    submission = route.request().postDataJSON(); return route.fulfill({ status: 202, json: { job } });
  });
  await page.goto('/');
  await page.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'source.csv', mimeType: 'text/csv', buffer: source });
  await start(page);
  await page.getByRole('radio', { name: /^거래 관계/ }).check();
  await page.getByRole('radio', { name: /^제공 자료 전체/ }).check();
  await page.getByRole('button', { name: '답변으로 범위 정리' }).click();
  await expect.poll(() => requests.filter(request => request.round).length).toBe(1);
  await expect(page.getByRole('button', { name: '답변 정리 중…' })).toBeDisabled();
  await expect(page.getByRole('radio', { name: /^거래 관계/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: /^거래 관계/ })).toBeDisabled();
  expect(uploads).toBe(0); expect(submission).toBeUndefined();
  await page.reload(); releases.forEach(release => release());
  await expect(page.getByLabel('분석 범위', { exact: true })).toHaveValue(brief.scope);
  expect(requests.map(request => request.round)).toEqual([0, 1, 1]);
  expect(requests[2].answers).toEqual(requests[1].answers);
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/jobs') && response.request().method() === 'POST' && response.status() === 202),
    page.getByRole('button', { name: '이 범위로 분석 시작' }).click(),
  ]);
  await expect(page).toHaveURL(`/analysis/${job.id}`);
  expect(uploads).toBe(1); expect(submission?.uploadIds).toEqual(['restored-upload']);
  expect(submission?.analysisBrief?.answers).toEqual(requests[1].answers);
  await page.goto('/');
  await expect(page.getByRole('region', { name: '분석 범위 확인', exact: true })).toHaveCount(0);
});

test('failed answer submission retries the same answers without returning home or creating a job', async ({ page }) => {
  const requests: ClarificationInput[] = []; let submissions = 0;
  await page.route('**/api/analysis/clarify', route => {
    const input = route.request().postDataJSON() as ClarificationInput; requests.push(input);
    if (requests.length === 2) return route.fulfill({ status: 503, json: { error: '연결이 끊겼습니다. 다시 시도해주세요.' } });
    return route.fulfill({ json: input.round ? ready(input) : questions });
  });
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/jobs')) submissions++; });
  await page.goto('/'); await start(page);
  await page.getByRole('radio', { name: /^거래 관계/ }).check();
  await page.getByRole('radio', { name: /^제공 자료 전체/ }).check();
  await page.getByRole('button', { name: '답변으로 범위 정리' }).click();
  await expect(page.getByRole('alert')).toContainText('연결이 끊겼습니다');
  await expect(page.getByRole('region', { name: 'New case', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '질문 다시 불러오기' }).click();
  await expect(page.getByLabel('분석 범위', { exact: true })).toHaveValue(brief.scope);
  expect(requests[2]).toEqual(requests[1]); expect(submissions).toBe(0);
});

test('browser storage failure does not prevent answering and reviewing the scope', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'indexedDB', { get() { throw new DOMException('Storage disabled', 'SecurityError'); } }); });
  await page.route('**/api/analysis/clarify', route => { const input = route.request().postDataJSON() as ClarificationInput; return route.fulfill({ json: input.round ? ready(input) : questions }); });
  await page.goto('/'); await start(page);
  await page.getByRole('radio', { name: /^거래 관계/ }).check();
  await page.getByRole('radio', { name: /^제공 자료 전체/ }).check();
  await page.getByRole('button', { name: '답변으로 범위 정리' }).click();
  await expect(page.getByLabel('분석 범위', { exact: true })).toHaveValue(brief.scope);
});

test('pending clarification is cancelled on request edit and cannot replace the new request', async ({ page }) => {
  const requests: ClarificationInput[] = []; const releases: (() => void)[] = []; let submissions = 0;
  await page.route('**/api/analysis/clarify', async route => {
    const input = route.request().postDataJSON() as ClarificationInput; requests.push(input);
    if (requests.length === 1) await new Promise<void>(resolve => releases.push(resolve));
    await route.fulfill({ json: { ...ready(input), brief: { ...brief, objective: input.question } } }).catch(() => {});
  });
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/jobs')) submissions++; });
  await page.goto('/'); await start(page);
  await expect.poll(() => requests.length).toBe(1);
  const aborted = page.waitForEvent('requestfailed', request => request.url().endsWith('/api/analysis/clarify'));
  await page.getByRole('button', { name: '요청 수정하기', exact: true }).click();
  await aborted;
  await expect(page.getByLabel('What do you want to find out?', { exact: true })).toBeFocused();
  await expect(page.getByLabel('What do you want to find out?', { exact: true })).toHaveValue(question);
  const revised = '2024년 공급망 관계만 분석해줘';
  await start(page, revised);
  await expect(page.getByLabel('분석 목적', { exact: true })).toHaveValue(revised);
  releases.forEach(resolve => resolve());
  await expect(page.getByLabel('분석 목적', { exact: true })).toHaveValue(revised);
  expect(requests[1].answers).toEqual([]); expect(requests[1].round).toBe(0); expect(submissions).toBe(0);
});

test('a failed clarification offers retry and an honest guided result without starting analysis', async ({ page }) => {
  let calls = 0; let submissions = 0;
  await page.route('**/api/analysis/clarify', route => ++calls === 1 ? route.fulfill({ status: 503, json: { error: '요구 확인 연결을 다시 시도해주세요.' } }) : route.fulfill({ json: { ...questions, source: 'guided', introduction: '기본 질문에서 분석 범위를 선택해주세요.' } }));
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/jobs')) submissions++; });
  await page.goto('/'); await start(page);
  await expect(page.getByRole('alert')).toContainText('요구 확인 연결');
  await page.getByRole('button', { name: '질문 다시 불러오기', exact: true }).click();
  await expect(page.getByText('기본 확인 질문 · 선택한 내용은 분석 범위에 반영됩니다.', { exact: true })).toBeVisible();
  await expect(page.getByRole('radio')).toHaveCount(6);
  expect(calls).toBe(2); expect(submissions).toBe(0);
});

test('two rounds preserve choices and custom input on mobile and support keyboard radios', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requests: ClarificationInput[] = [];
  await page.route('**/api/analysis/clarify', route => {
    const input = route.request().postDataJSON() as ClarificationInput; requests.push(input);
    return route.fulfill({ json: input.round >= 2 ? ready(input) : { ...questions, questions: [questions.questions[input.round]] } });
  });
  await page.goto('/'); await start(page);
  const first = page.getByRole('radio', { name: /^거래 관계/ });
  await first.focus(); await first.press('ArrowDown');
  await expect(page.getByRole('radio', { name: /^소유 관계/ })).toBeChecked();
  await noOverflow(page);
  await page.getByRole('button', { name: '답변으로 범위 정리' }).click();
  await page.getByRole('radio', { name: /^기타/ }).check();
  await page.getByLabel('기간과 대상을 어떻게 좁힐까요? — 직접 입력', { exact: true }).fill('Alpha와 Beta만. 기간은 전체.');
  await noOverflow(page);
  await page.getByRole('button', { name: '답변으로 범위 정리' }).click();
  await expect(page.getByLabel('분석 범위', { exact: true })).toBeVisible();
  await noOverflow(page);
  expect(requests.map(input => input.round)).toEqual([0, 1, 2]);
  expect(requests[2].answers).toHaveLength(2);
  expect(requests[2].answers[0].answer).toContain('소유 관계');
  expect(requests[2].answers[1].answer).toBe('Alpha와 Beta만. 기간은 전체.');
});
