import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { GraphDocument } from '../src/types/graph';
import type { WhyRun, WhySnapshot } from '../src/types/why-not';
import { whyFixture } from '../server/why-not-fixture';
import { evaluateWhyNot } from '../server/why-not-engine';
import { mockCase } from './case-fixture';

const graph: GraphDocument = { schemaVersion: '1.0', id: 'why-graph', title: 'E1 검증', question: '사건 E1 완료 여부', summary: '검증용 사건', origin: 'codex', createdAt: '2026-10-11T00:00:00Z', groups: [{ id: 'g', label: '사건', color: '#916538' }], nodes: [{ id: 'n', type: 'Event', label: 'E1', group: 'g', description: '사건 E1', sourceIds: ['source'], properties: {} }], edges: [], events: [], findings: [], limitations: [], sources: [{ id: 'source', title: '원본 기록', excerpt: 'E1 완료 0' }] };
const job = { id: 'why-job', status: 'completed', stage: 'saving', message: '완료', question: graph.question, createdAt: graph.createdAt, updatedAt: graph.createdAt, completedChunks: 1, totalChunks: 1, graphIds: [graph.id], graphId: graph.id };
const endpoint = `/api/jobs/${job.id}/why-not`;
function run(id = 'why-1', snapshot = whyFixture(1)): WhyRun {
  const result = evaluateWhyNot(snapshot);
  const bayesian = result.confidence.bayesian!;
  return { id, jobId: job.id, previousId: null, createdAt: graph.createdAt, updatedAt: graph.createdAt, status: 'completed', stage: '진단 완료', phase: 'ready', baseSnapshot: structuredClone(snapshot), graphReadyAt: graph.createdAt, snapshot, result,
    preparation: { version: 'cluevia-preparation-1', ready: true, baselineScore: bayesian.baselineScore * 100, score: bayesian.score * 100, grade: bayesian.grade, preparedAt: graph.createdAt, animation: result.gaps.map((gap, index) => ({ gapId: gap.id, delayMs: index * 65, durationMs: 650 })), gapFill: [] } };
}
const errors = new Map<object, string[]>();
const modelPosts = new Map<object, unknown[]>();
const expectedModelPosts = new Map<object, unknown[]>();
async function openChecks(page: Page) {
  await expect(page.getByRole('button', { name: /^Cluevia (on|off)$/ })).toBeVisible();
  const enable = page.getByRole('button', { name: 'Cluevia on', exact: true });
  if (await enable.isVisible()) await enable.click();
  const goal = page.locator('[data-graph-decoration="goal"]');
  await expect(goal).toBeVisible();
  await goal.focus(); await goal.press('Enter');
  await expect(page.getByRole('dialog', { name: '공백 검토', exact: true })).toBeVisible();
}
async function closeChecks(page: Page) {
  await page.getByRole('button', { name: '공백 검토 닫기', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '공백 검토', exact: true })).toBeHidden();
}
async function openLogic(page: Page) {
  const panel = page.getByRole('region', { name: '주장 검증', exact: true });
  await panel.locator('summary').filter({ hasText: 'Logic · 주장과 필수 근거' }).click();
  await expect(panel.getByRole('region', { name: '주장과 필수 근거', exact: true })).toBeVisible();
}
test.beforeEach(async ({ page }) => {
  errors.set(page, []); page.on('pageerror', e => errors.get(page)!.push(e.message));
  modelPosts.set(page, []); expectedModelPosts.set(page, []);
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === endpoint) modelPosts.get(page)!.push(request.postDataJSON());
  });
  await page.route('**/api/system/status', r => r.fulfill({ json: { authenticated: true, authRequired: false, provider: { available: true, authenticated: true, message: 'Ready', kind: 'codex' }, ontology: { entities: 1, relationships: 0, documents: 1, graphs: 1 }, activeJobs: [] } }));
  await page.route('**/api/jobs', r => r.fulfill({ json: { jobs: [job] } }));
  await page.route('**/api/graphs', r => r.fulfill({ json: { graphs: [graph] } }));
  await page.route(`**/api/jobs/${job.id}`, r => r.fulfill({ json: { job } }));
  await mockCase(page, job.id, () => [graph]);
});
test.afterEach(({ page }) => {
  expect(errors.get(page)).toEqual([]);
  // Saved history never triggers a model call on open/reload. Only the explicit
  // supplement action below authorizes a new model-generated version.
  expect(modelPosts.get(page)).toEqual(expectedModelPosts.get(page));
});

for (const completedChunks of [0, 1]) test(`failed analysis with ${completedChunks} processed chunks opens its saved gap tree without factual nodes`, async ({ page }) => {
  const failure = '전체 1부분을 처리했으나 그래프로 저장할 근거를 찾지 못했습니다. 검토가 필요한 부분은 0개입니다.';
  const failedJob = { ...job, status: 'failed', message: '근거를 확인하지 못했습니다.', error: failure, completedChunks, graphIds: [], graphId: undefined };
  const snapshot = whyFixture(2);
  snapshot.nodes.slice(1).forEach(node => { node.children = []; });
  snapshot.bindings = []; snapshot.evidence = [];
  await page.route('**/api/jobs', route => route.fulfill({ json: { jobs: [failedJob] } }));
  await page.route(`**/api/jobs/${job.id}`, route => route.fulfill({ json: { job: failedJob } }));
  await page.route(`**/api/jobs/${job.id}/case`, route => route.fulfill({ json: {
    schemaVersion: 'case-1.0', jobId: job.id, status: 'failed', updatedAt: graph.createdAt,
    graph: { ...graph, nodes: [], edges: [], sources: [], summary: failure },
    records: [], provenance: {}, conflicts: [],
  } }));
  await page.route(`**${endpoint}`, route => route.fulfill({ json: { runs: [run('failed-gap-review', snapshot)] } }));
  await page.goto(`/analysis/${job.id}`);
  await expect(page.getByRole('region', { name: '분석 결과 요약', exact: true })).toBeVisible();
  await openChecks(page);
  const panel = page.getByRole('region', { name: '주장 검증', exact: true });
  await expect(panel).toBeVisible();
  await expect(page.getByRole('button', { name: '주장 검증 · 부족한 근거 찾기', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('region', { name: '주장과 필수 근거' })).toBeHidden();
  await openLogic(page);
  await expect(panel.getByRole('region', { name: '주장과 필수 근거' })).toContainText('필수 조건 0');
  await expect(panel.getByRole('region', { name: '근거 공백' })).toContainText('자료가 필요해요');
  await expect(page.getByRole('heading', { name: '분석을 완료하지 못했습니다', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText(failure);
  await expect(page.locator('.gw-live-state')).toContainText('저장된 객체 없음');
  await closeChecks(page);
  await expect(panel).toBeHidden();
  const connections = page.getByRole('region', { name: '분석 결과 요약', exact: true });
  await expect(connections).toBeVisible();
  await expect(connections.locator('[data-graph-node="n"]')).toHaveCount(0);
  await expect(connections.getByRole('button', { name: /^Event:/ })).toHaveCount(0);
  await expect(connections.locator('[data-graph-decoration="goal"]')).toHaveCount(1);
  await expect(connections.locator('[data-graph-decoration="gap"]').first()).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Overview layers' })).toHaveCount(0);
  await openChecks(page);
  await expect(panel).toBeVisible();
  await page.reload();
  await expect(page.getByRole('region', { name: '분석 결과 요약', exact: true })).toBeVisible();
  await openChecks(page);
  await expect(panel).toBeVisible();
  await expect(page.getByRole('alert')).toContainText(failure);
});

test('source review persists through save, reload, closing the overlay and version inspection', async ({ page }) => {
  const snapshot = whyFixture(1); snapshot.evidence[0].sourceGrade = null; snapshot.evidence[0].sourceReason = '계수 가정은 있으나 출처 등급 미평가'; let versions = [run('why-1', snapshot)]; let posted: { snapshot: WhySnapshot; previousId: string };
  await page.route(`**${endpoint}`, r => r.fulfill({ json: { runs: versions } }));
  await page.route(`**${endpoint}/runs/*`, r => r.fulfill({ json: { run: versions.find(v => r.request().url().endsWith(v.id)) } }));
  await page.route(`**${endpoint}/evaluate`, r => { posted = r.request().postDataJSON(); const next = { ...run('why-2', posted.snapshot), previousId: posted.previousId }; versions = [next, ...versions]; return r.fulfill({ json: { run: next } }); });
  await page.goto(`/analysis/${job.id}`); await openChecks(page);
  const panel = page.getByRole('region', { name: '주장 검증', exact: true }); await expect(panel).toContainText('판정 보류');
  await panel.locator('summary').filter({ hasText: '출처·판정·점수 검토' }).click();
  await panel.getByLabel('원본 0 출처 등급', { exact: true }).selectOption('B'); await panel.getByLabel('출처 평가 근거', { exact: true }).fill('기록 원본과 작성 주체를 확인했다.');
  await closeChecks(page); await openChecks(page);
  await expect(panel.getByLabel('출처 평가 근거', { exact: true })).toHaveValue('기록 원본과 작성 주체를 확인했다.');
  await panel.getByRole('button', { name: '검토 저장 및 재평가', exact: true }).click(); await expect(panel).toContainText('서버에 진단 버전을 저장했습니다.');
  await expect(panel.locator('.wn-metrics')).toContainText('설정한 기준 충족'); expect(posted!.previousId).toBe('why-1');
  await panel.getByLabel('진단 버전').selectOption('why-1'); await expect(panel).toContainText('이전 버전 열람 중'); await expect(panel.getByLabel('원본 0 출처 등급', { exact: true })).toBeDisabled();
  await page.reload(); await openChecks(page); await expect(panel.locator('.wn-metrics')).toContainText('설정한 기준 충족');
});

test('gap search populates supplementary evidence and starts a distinct version', async ({ page }) => {
  const s = whyFixture(1); s.nodes[1].children = []; s.bindings = []; let versions = [run('why-1', s)]; let posted: unknown;
  await page.route(`**${endpoint}`, r => {
    if (r.request().method() === 'POST') { posted = r.request().postDataJSON(); const next: WhyRun = { ...versions[0], id: 'why-2', previousId: 'why-1', status: 'running', stage: '추가 원문 검토', result: undefined }; versions = [next, ...versions]; return r.fulfill({ status: 202, json: { run: next } }); }
    return r.fulfill({ json: { runs: versions } });
  });
  await page.route(`**${endpoint}/search?*`, r => r.fulfill({ json: { indexedRecords: 3, hits: [{ number: 1, excerpts: ['E1 실제 완료 기록'], evidenceTexts: ['E1 실제 완료 기록'] }] } }));
  await page.goto(`/analysis/${job.id}`); await openChecks(page);
  const panel = page.getByRole('region', { name: '주장 검증', exact: true }); await panel.getByRole('button', { name: '현재 자료 검색', exact: true }).first().click(); await expect(panel).toContainText('검색 대상 3개 기록 · 1개 일치');
  await panel.getByRole('button', { name: '보완 입력에 가져오기' }).click(); await expect(panel.getByLabel('추가 원문', { exact: true })).toHaveValue('E1 실제 완료 기록');
  expectedModelPosts.set(page, [{ previousId: 'why-1', supplement: { name: '기록 1 · 추가 검색', text: 'E1 실제 완료 기록', url: '' } }]);
  await panel.getByRole('button', { name: '자료 추가 및 새 버전 평가' }).click(); await expect(panel.getByRole('button', { name: '검증 중단' })).toBeVisible();
  expect(posted).toEqual({ previousId: 'why-1', supplement: { name: '기록 1 · 추가 검색', text: 'E1 실제 완료 기록', url: '' } });
  await expect(panel.getByRole('button', { name: '자료 추가 및 새 버전 평가' })).toBeDisabled();
});

test('cancel waits for server confirmation; stale-write errors retain edits and do not show success', async ({ page }) => {
  let current: WhyRun = run();
  await page.route(`**${endpoint}`, r => r.fulfill({ json: { runs: [current] } }));
  await page.route(`**${endpoint}/cancel`, r => { current = { ...run(), status: 'cancelled', error: '사용자가 중단했습니다.' }; return r.fulfill({ json: { runs: [current] } }); });
  await page.route(`**${endpoint}/evaluate`, r => r.fulfill({ status: 409, json: { error: '다른 창에서 버전이 변경되었습니다.' } }));
  await page.goto(`/analysis/${job.id}`); await openChecks(page); const panel = page.getByRole('region', { name: '주장 검증', exact: true });
  current = { ...current, status: 'running', phase: 'diagnosing', result: undefined, stage: '검증 처리 중' };
  await closeChecks(page);
  await page.locator('[data-graph-decoration="goal"]').focus(); await page.locator('[data-graph-decoration="goal"]').press('Enter');
  await panel.getByRole('button', { name: '검증 중단' }).click(); await expect(panel).toContainText('검증을 중단했습니다.'); await expect(panel.getByRole('button', { name: '검증 중단' })).toHaveCount(0);
  await panel.locator('summary').filter({ hasText: '출처·판정·점수 검토' }).click(); await panel.getByLabel('출처 평가 근거', { exact: true }).fill('아직 저장하지 못한 수정');
  await panel.getByRole('button', { name: '검토 저장 및 재평가', exact: true }).click(); await expect(panel).toContainText('다른 창에서 버전이 변경되었습니다.'); await expect(panel.getByLabel('출처 평가 근거', { exact: true })).toHaveValue('아직 저장하지 못한 수정'); await expect(panel).not.toContainText('서버에 진단 버전을 저장했습니다.');
});

test('saved report downloads and responsive diagnosis has no horizontal overflow', async ({ page }, testInfo) => {
  const saved = run(); await page.route(`**${endpoint}`, r => r.fulfill({ json: { runs: [saved] } }));
  await page.goto(`/analysis/${job.id}`); await openChecks(page); const panel = page.getByRole('region', { name: '주장 검증', exact: true }); await expect(panel.locator('.wn-metrics')).toContainText('설정한 기준 충족');
  await panel.getByLabel('내보내기 더 보기').click(); const pending = page.waitForEvent('download'); await panel.getByRole('button', { name: '진단 JSON' }).click(); const downloaded = await pending; expect(JSON.parse(await readFile((await downloaded.path())!, 'utf8'))).toEqual(saved);
  await panel.getByLabel('내보내기 더 보기').click(); await page.screenshot({ path: testInfo.outputPath('why-not-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 }); await expect(panel.getByRole('button', { name: '보고서 받기' })).toBeVisible();
  const dimensions = await page.evaluate(() => [document.documentElement.clientWidth, document.documentElement.scrollWidth]); expect(dimensions[1]).toBeLessThanOrEqual(dimensions[0] + 1);
  await page.screenshot({ path: testInfo.outputPath('why-not-mobile.png') });
});

test('choosing a gap connects the priority list, logic condition and its requested evidence', async ({ page }) => {
  const snapshot = whyFixture(2); snapshot.nodes.slice(1).forEach(node => { node.children = []; }); snapshot.bindings = [];
  const saved = run('missing-evidence', snapshot);
  await page.route(`**${endpoint}`, route => route.fulfill({ json: { runs: [saved] } }));
  await page.goto(`/analysis/${job.id}`);
  await openChecks(page);
  const panel = page.getByRole('region', { name: '주장 검증', exact: true });
  const detail = panel.getByRole('region', { name: '선택한 공백 상세' });
  await expect(detail).toContainText('필수 조건 0');
  await panel.locator('.wn-gap-list').getByRole('button', { name: /자료가 필요해요.*필수 조건 1/ }).click();
  await expect(detail).toContainText('필수 조건 1');
  await openLogic(page);
  await expect(panel.getByRole('button', { name: '필수 조건 1 공백 확인', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByRole('button', { name: '필수 조건 0 공백 확인', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(detail).toContainText('완료 사실이 원문에 명시됨');
  await panel.getByRole('button', { name: '필수 조건 0 공백 확인', exact: true }).click();
  await expect(detail).toContainText('필수 조건 0');
  await expect(panel.getByLabel('추가 원문', { exact: true })).toBeHidden();
  await detail.getByRole('button', { name: '자료 보완', exact: true }).click();
  await expect(panel.getByLabel('추가 원문', { exact: true })).toBeVisible();
});

test('alternative route gaps stay separate from the condition blocking the conclusion', async ({ page }, testInfo) => {
  const snapshot = whyFixture(2); snapshot.nodes[0].operator = 'OR'; snapshot.nodes[1].children = []; snapshot.bindings = snapshot.bindings.slice(1); snapshot.policy.threshold = .9;
  const saved = run('alternative-route', snapshot);
  await page.route(`**${endpoint}`, route => route.fulfill({ json: { runs: [saved] } }));
  await page.goto(`/analysis/${job.id}`);
  await openChecks(page);
  const panel = page.getByRole('region', { name: '주장 검증', exact: true });
  await expect(panel.locator('.wn-gap-list .wn-gap-choice')).toHaveCount(1);
  await expect(panel.getByRole('region', { name: '선택한 공백 상세' })).toContainText('지지 수준을 확인해요');
  await expect(panel.locator('.wn-alternatives .wn-gap-choice')).toBeHidden();
  await openLogic(page);
  await panel.getByRole('button', { name: '필수 조건 0 공백 확인', exact: true }).click();
  await expect(panel.locator('.wn-alternatives .wn-gap-choice')).toBeVisible();
  await expect(panel.getByRole('region', { name: '선택한 공백 상세' })).toContainText('대안 경로');
  await expect(panel.locator('.wn-metrics')).toContainText('대안 경로 1개 별도 확인');
  await page.screenshot({ path: testInfo.outputPath('gap-selection-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  const dimensions = await page.evaluate(() => [document.documentElement.clientWidth, document.documentElement.scrollWidth]);
  expect(dimensions[1]).toBeLessThanOrEqual(dimensions[0] + 1);
});
