import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { GenerationJob } from '../src/services/api-client';
import type { GraphGenerationInput } from '../src/types/graph';
import type { ClarificationInput } from '../src/types/clarification';

const createdAt = '2026-10-11T00:00:00Z';
const running = (id: string, question: string): GenerationJob => ({ id, question, status: 'running', stage: 'designing', message: `${question} 온톨로지를 설계합니다.`, createdAt, updatedAt: createdAt, graphIds: [] });

async function workspace(page: Page, initial: GenerationJob[] = []) {
  const state = { jobs: initial, submissions: [] as GraphGenerationInput[], reads: [] as string[], mutations: [] as string[], clarifications: [] as ClarificationInput[], beforeJobResponse: undefined as undefined | (() => Promise<void>) };
  await page.route('**/api/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') {
      state.reads.push(path);
      if (path === '/api/system/status') return route.fulfill({ json: { authenticated: true, authRequired: false, provider: { kind: 'hybrid', ontologyPlanning: true, available: true, authenticated: true, codex: { available: true, authenticated: true }, jev: { configured: false } }, activeJobs: state.jobs.filter(job => job.status === 'running' || job.status === 'queued'), resumableJobs: [], ontology: { entities: 0, relationships: 0, documents: 0, graphs: 0 } } });
      if (path === '/api/jobs') return route.fulfill({ json: { jobs: state.jobs } });
      if (path === '/api/graphs') return route.fulfill({ json: { graphs: [] } });
      if (path === '/api/ontology') return route.fulfill({ json: { definitions: [] } });
      if (path.endsWith('/decisions')) return route.fulfill({ json: { decisions: [] } });
      const job = state.jobs.find(value => path === `/api/jobs/${value.id}`);
      if (job) return route.fulfill({ json: { job } });
    }
    if (request.method() === 'POST') {
      state.mutations.push(path);
      if (path === '/api/analysis/clarify') {
        const input = request.postDataJSON() as ClarificationInput; state.clarifications.push(input);
        return route.fulfill({ json: { status: 'ready', source: 'codex', introduction: '현재 요청과 자료의 분석 범위를 확인하세요.', questions: [], brief: { objective: input.question, scope: '제공 자료 전체', output: '객체·관계와 원문 근거', answers: input.answers } } });
      }
      if (path === '/api/jobs') {
        const input = request.postDataJSON() as GraphGenerationInput; state.submissions.push(input);
        const job = { ...running(`background-job-${state.submissions.length}`, input.question), analysisBrief: input.analysisBrief };
        state.jobs.push(job);
        await state.beforeJobResponse?.();
        return route.fulfill({ status: 202, json: { job } });
      }
    }
    return route.fulfill({ status: 404, json: { error: `Unexpected fixture request: ${request.method()} ${path}` } });
  });
  return state;
}

async function newCase(page: Page) {
  const open = page.getByRole('button', { name: '사이드바 열기', exact: true });
  if (await open.isVisible()) await open.click();
  await page.locator('#cluevia-case-sidebar').getByRole('link', { name: '새 케이스', exact: false }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByLabel('What do you want to find out?', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('What do you want to find out?', { exact: true })).toBeEnabled();
}

async function review(page: Page, question: string, source: string) {
  await page.getByLabel('What do you want to find out?', { exact: true }).fill(question);
  const text = page.getByLabel('Source text', { exact: true });
  if (!await text.isVisible()) await page.getByText(/^Paste source text/).click();
  await text.fill(source);
  await page.getByRole('button', { name: 'START INVESTIGATION', exact: true }).click();
  await expect(page.getByLabel('분석 목적', { exact: true })).toHaveValue(question);
}

test('two independent cases keep running while a fresh intake stays available', async ({ page }) => {
  const state = await workspace(page);
  await page.goto('/');
  const first = { question: '첫 번째 항만 기록 분석', source: 'First Harbor recorded Vessel Alpha.' };
  const second = { question: '두 번째 기업 거래 분석', source: 'Second Company purchased from Beta.' };
  await review(page, first.question, first.source);
  await page.getByRole('button', { name: '이 범위로 분석 시작' }).click();
  await expect(page).toHaveURL('/analysis/background-job-1');
  await newCase(page);
  await expect(page.getByRole('region', { name: '진행 중인 케이스', exact: true })).toContainText(first.question);
  await review(page, second.question, second.source);
  await page.getByRole('button', { name: '이 범위로 분석 시작' }).click();
  await expect(page).toHaveURL('/analysis/background-job-2');
  expect(state.submissions.map(input => [input.question, input.documents.map(document => document.text)])).toEqual([[first.question, [first.source]], [second.question, [second.source]]]);
  expect(state.submissions.map(input => input.analysisBrief?.objective)).toEqual([first.question, second.question]);
  await newCase(page);
  const background = page.getByRole('region', { name: '진행 중인 케이스', exact: true });
  await expect(background.getByRole('link')).toHaveCount(2);
  await background.getByRole('link', { name: new RegExp(first.question) }).click();
  await expect(page).toHaveURL('/analysis/background-job-1');
  await expect(page.getByLabel('분석 세션 설명', { exact: true })).toContainText(first.question);
  await newCase(page);
  await expect(background.getByRole('link')).toHaveCount(2);
  expect(state.jobs.map(job => job.status)).toEqual(['running', 'running']);
  expect(state.mutations.filter(path => path.endsWith('/cancel') || path.endsWith('/resume'))).toEqual([]);
});

test('active status updates and stale remembered jobs never overwrite a new question', async ({ page }) => {
  const active = running('other-running-case', '이전에 시작한 분석');
  const stale = { ...running('old-completed-case', '오래된 완료 질문'), status: 'completed' as const };
  const state = await workspace(page, [active, stale]);
  await page.addInitScript(() => localStorage.setItem('cluevia.active-job', 'old-completed-case'));
  await page.goto('/?question=새로운%20요청');
  const input = page.getByLabel('What do you want to find out?', { exact: true });
  await expect(input).toHaveValue('새로운 요청'); await expect(input).toBeEnabled();
  await input.fill('편집 중인 독립 케이스');
  active.message = '원문에서 두 번째 분석 구간을 처리합니다.';
  await expect(page.getByRole('region', { name: '진행 중인 케이스', exact: true })).toContainText(active.message);
  await expect(input).toHaveValue('편집 중인 독립 케이스');
  active.status = 'completed';
  await expect(page.getByRole('region', { name: '진행 중인 케이스', exact: true })).toHaveCount(0);
  await expect(input).toHaveValue('편집 중인 독립 케이스');
  expect(state.reads).not.toContain('/api/jobs/old-completed-case');
  expect(state.mutations).toEqual([]);
});

test('ordinary returns restore a confirmed draft but explicit new case clears its files and answers', async ({ page }) => {
  const existing = running('already-running-case', '진행 중인 원래 케이스');
  const state = await workspace(page, [existing]);
  await page.goto('/');
  await page.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'old-source.txt', mimeType: 'text/plain', buffer: Buffer.from('Original case source bytes.') });
  await review(page, '작성 중인 두 번째 케이스', '초안에만 포함된 자료');
  await page.getByLabel('분석 범위', { exact: true }).fill('직접 수정한 초안 범위');
  await page.reload();
  await expect(page.getByLabel('분석 범위', { exact: true })).toHaveValue('직접 수정한 초안 범위');
  await page.getByRole('region', { name: '진행 중인 케이스', exact: true }).getByRole('link').click();
  await expect(page).toHaveURL(`/analysis/${existing.id}`);
  await page.goto('/');
  await expect(page.getByLabel('분석 범위', { exact: true })).toHaveValue('직접 수정한 초안 범위');
  await newCase(page);
  await expect(page.getByRole('region', { name: '분석 범위 확인', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Attached files', { exact: true })).toHaveCount(0);
  await page.getByText(/^Paste source text/).click();
  await expect(page.getByLabel('Source text', { exact: true })).toHaveValue('');
  await page.reload();
  await expect(page.getByLabel('What do you want to find out?', { exact: true })).toHaveValue('');
  expect(state.submissions).toHaveLength(0);
  expect(existing.status).toBe('running');
});

test('a delayed submission response cannot redirect or erase the next case draft', async ({ page }) => {
  const state = await workspace(page);
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  state.beforeJobResponse = () => held;
  await page.goto('/');
  await review(page, '먼저 제출한 케이스', 'First evidence stays in its own case.');
  await page.getByRole('button', { name: '이 범위로 분석 시작' }).click();
  await expect.poll(() => state.submissions.length).toBe(1);
  await expect(page.getByRole('button', { name: '분석 준비 중…' })).toBeDisabled();
  await newCase(page);
  await review(page, '다음 케이스의 새 초안', 'Separate evidence for the new draft.');
  const response = page.waitForResponse(value => value.url().endsWith('/api/jobs') && value.request().method() === 'POST');
  release(); await response;
  await page.evaluate(() => new Promise(resolve => window.setTimeout(resolve, 0)));
  await expect(page).toHaveURL('/');
  await expect(page.getByLabel('분석 목적', { exact: true })).toHaveValue('다음 케이스의 새 초안');
  await page.reload();
  await expect(page.getByLabel('분석 목적', { exact: true })).toHaveValue('다음 케이스의 새 초안');
  expect(state.submissions).toHaveLength(1);
  expect(state.jobs[0].question).toBe('먼저 제출한 케이스');
  expect(state.jobs[0].status).toBe('running');
  expect(state.mutations.filter(path => path.endsWith('/cancel'))).toEqual([]);
});

test('explicit legacy job links still open their requested analysis', async ({ page }) => {
  const existing = running('requested-legacy-case', '명시적으로 선택한 분석');
  await workspace(page, [existing]);
  await page.goto(`/?job=${existing.id}`);
  await expect(page).toHaveURL(`/analysis/${existing.id}`);
  await expect(page.getByLabel('분석 세션 설명', { exact: true })).toContainText(existing.question);
});
