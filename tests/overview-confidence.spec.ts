import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { GraphDocument } from '../src/types/graph';
import type { OverviewConfidenceSummary, WhyRun, WhySnapshot } from '../src/types/why-not';
import { whyFixture } from '../server/why-not-fixture';
import { evaluateWhyNot } from '../server/why-not-engine';
import { contentHash, parseWhySnapshot } from '../server/why-not-contract';

const at = '2026-10-11T00:00:00Z';
const jobId = 'confidence-overview-job';
const endpoint = `/api/jobs/${jobId}`;
const graph: GraphDocument = {
  schemaVersion: '1.0', id: 'confidence-graph', title: 'E1 완료 확인', question: '사건 E1의 모든 조건이 완료되었는가?',
  summary: '원본 기록에 완료 사실이 명시되어 있습니다.', origin: 'codex', createdAt: at,
  groups: [{ id: 'events', label: '사건', color: '#916538' }],
  nodes: [
    { id: 'event', type: 'Event', label: 'E1', group: 'events', description: '사건 E1', sourceIds: ['source'], properties: {} },
    { id: 'agency', type: 'Organization', label: '관측기관 A', group: 'events', description: '사건을 관측한 기관', sourceIds: ['source'], properties: {} },
  ],
  edges: [{ id: 'observed', source: 'agency', target: 'event', label: '관측', description: '관측기관 A가 E1을 기록했습니다.', status: 'reported', sourceIds: ['source'] }],
  events: [], limitations: [], findings: [{ text: '원본 기록에 완료 사실이 명시되어 있습니다.', sourceIds: ['source'], nodeIds: ['event'] }],
  sources: [{ id: 'source', title: '원본 기록', excerpt: 'E1 완료 0' }],
};

function sharedSnapshot() {
  const snapshot = whyFixture(3);
  snapshot.evidence.forEach((evidence, index) => { evidence.sourceCoefficient = [.8, .7, .6][index]; });
  snapshot.nodes[0].operator = 'OR';
  snapshot.nodes[0].children = ['left', 'right'];
  snapshot.nodes.push(
    { ...snapshot.nodes[0], id: 'left', statement: '첫 번째 완료 경로', operator: 'AND', children: ['r0', 'r1'] },
    { ...snapshot.nodes[0], id: 'right', statement: '두 번째 완료 경로', operator: 'AND', children: ['r0', 'r2'] },
  );
  snapshot.policy.threshold = null;
  return snapshot;
}

function savedRun(snapshot = sharedSnapshot()): WhyRun {
  snapshot.goal = graph.question;
  const result = evaluateWhyNot(snapshot);
  return { id: 'confidence-review', jobId, previousId: null, createdAt: at, updatedAt: at, status: 'completed', stage: '진단 완료', phase: 'ready', graphReadyAt: at, baseSnapshot: structuredClone(snapshot), snapshot, result, preparation: { version: 'cluevia-preparation-1', ready: true, baselineScore: (result.confidence.bayesian?.baselineScore ?? .5) * 100, score: (result.confidence.bayesian?.score ?? .5) * 100, grade: result.confidence.bayesian?.grade ?? 'C', preparedAt: at, animation: result.gaps.map((gap, index) => ({ gapId: gap.id, delayMs: index * 65, durationMs: 650 })), gapFill: [] } };
}

/** Supply real engine values; the browser must only render the saved assessment. */
function assessed(run: WhyRun, state: OverviewConfidenceSummary['state'] = 'ready'): OverviewConfidenceSummary {
  const snapshot = run.snapshot!;
  return {
    state, confidence: run.result!.confidence, goal: snapshot.goal,
    reason: run.result!.confidence.reason, unknownReasons: [],
    inputs: snapshot.bindings.map(binding => {
      const evidence = snapshot.evidence.find(item => item.id === binding.evidenceId)!;
      return { id: binding.id, label: evidence.name, sourceCoefficient: evidence.sourceCoefficient, materialCoefficient: binding.materialCoefficient, sourceReason: evidence.sourceReason, materialReason: binding.materialReason };
    }),
    policyVersion: snapshot.policy.version, assessmentVersion: snapshot.decisionVersion, evaluatedAt: run.updatedAt,
    assumptions: snapshot.policy.independence.map(group => group.reason), coverageNote: snapshot.coverage.note,
    accepted: run.result!.accepted, nodeLabels: Object.fromEntries(snapshot.nodes.map(node => [node.id, node.statement])),
  };
}

const unassessed = (): OverviewConfidenceSummary => ({
  state: 'unassessed', confidence: null, goal: null, reason: '아직 저장된 근거 평가가 없습니다.', unknownReasons: ['자료와 주장의 지지 관계가 평가되지 않았습니다.'],
  inputs: [], policyVersion: null, assessmentVersion: null, evaluatedAt: null, assumptions: [], coverageNote: '', accepted: false,
});

async function fixture(page: Page, assessment = assessed(savedRun()), runs: WhyRun[] = [savedRun()]) {
  const state = { assessment, runs, pending: false, confidenceReads: 0, posts: [] as string[], evaluations: [] as { previousId: string; snapshot: WhySnapshot }[], errors: [] as string[] };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/api/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') {
      state.posts.push(path);
      if (path === `${endpoint}/why-not/evaluate`) {
        const body = request.postDataJSON() as { previousId: string; snapshot: WhySnapshot };
        state.evaluations.push(body);
        const run = { ...savedRun(parseWhySnapshot(body.snapshot)), id: `confidence-reviewed-${state.evaluations.length}`, previousId: body.previousId };
        state.runs = [run, ...state.runs]; state.assessment = assessed(run);
        return route.fulfill({ json: { run } });
      }
      return route.fulfill({ status: 500, json: { error: `Unexpected mutation ${path}` } });
    }
    const job = { id: jobId, question: graph.question, status: state.pending ? 'running' : 'completed', stage: state.pending ? 'extracting' : 'saving', message: state.pending ? '자료 분석 중' : '완료', createdAt: at, updatedAt: at, completedChunks: 1, totalChunks: state.pending ? 2 : 1, graphIds: [graph.id], graphId: graph.id };
    if (path === '/api/system/status') return route.fulfill({ json: { authenticated: true, authRequired: false, provider: { available: true, authenticated: true, message: 'Ready', kind: 'codex' }, ontology: { entities: graph.nodes.length, relationships: graph.edges.length, documents: graph.sources.length, graphs: 1 }, activeJobs: [] } });
    if (path === '/api/jobs') return route.fulfill({ json: { jobs: [job] } });
    if (path === '/api/graphs') return route.fulfill({ json: { graphs: [graph] } });
    if (path === endpoint) return route.fulfill({ json: { job } });
    if (path === `${endpoint}/confidence`) {
      state.confidenceReads++;
      return route.fulfill({ json: state.assessment });
    }
    if (path === `${endpoint}/chat`) return route.fulfill({ json: { turns: [], model: 'fixture-model', effort: 'medium' } });
    if (path === `${endpoint}/decisions`) return route.fulfill({ json: { decisions: [] } });
    if (path === `${endpoint}/why-not`) return route.fulfill({ json: { runs: state.runs } });
    if (path === `${endpoint}/why-not/layout`) return route.fulfill({ json: { jobId, revision: 0, updatedAt: null, positions: {} } });
    if (path.startsWith(`${endpoint}/why-not/runs/`)) return route.fulfill({ json: { run: state.runs.find(run => path.endsWith(`/${run.id}`)) } });
    if (path === `${endpoint}/case`) return route.fulfill({ json: { schemaVersion: 'case-1.0', jobId, status: job.status, updatedAt: at, graph: { ...graph, id: `case-${jobId}` }, records: [], conflicts: [], provenance: {} } });
    return route.fulfill({ status: 404, json: { error: `Missing fixture ${path}` } });
  });
  return state;
}

const badge = (page: Page) => page.locator('[data-overview-confidence]');
const noFooter = (page: Page) => expect(page.locator('.gw-detail-dock, .gw-detail-bar, .gw-session-footer, .cg-footer')).toHaveCount(0);

function goalRun() {
  const snapshot = whyFixture(1);
  snapshot.evidence[0].sourceGrade = 'C';
  snapshot.bindings[0].likelihood = { ratio: 5, basis: 'EXPERT_ESTIMATE', reason: '전체 결론에 대한 비교 관측' };
  snapshot.policy.bayes = { target: 'GOAL', priors: [{ nodeId: snapshot.rootId, probability: .5, reason: '중립 사전확률' }], conditionalIndependence: [] };
  return savedRun(snapshot);
}

for (const boundary of [
  { score: 99.9873, text: '>99.9', spoken: '99.9점 초과, 100점 미만', grade: 'A' },
  { score: .0127, text: '<0.1', spoken: '0점 초과, 0.1점 미만', grade: 'E' },
  { score: 0, text: '0', spoken: '0점', grade: 'F' },
  { score: 100, text: '100', spoken: '100점', grade: 'A' },
  { score: .1, text: '0.1', spoken: '0.1점', grade: 'E' },
  { score: 99.9, text: '99.9', spoken: '99.9점', grade: 'A' },
]) {
  test(`saved score ${boundary.score} keeps its boundary meaning before and after Cluevia`, async ({ page }) => {
    const snapshot = whyFixture(1);
    snapshot.evidence[0].sourceGrade = 'A';
    snapshot.bindings[0].likelihood = { ratio: 1, basis: 'EXPERT_ESTIMATE', reason: '중립 관측으로 저장된 경계 점수를 유지' };
    snapshot.policy.bayes = { target: 'GOAL', priors: [{ nodeId: snapshot.rootId, probability: boundary.score / 100, reason: '경계 표시 검증' }], conditionalIndependence: [] };
    const saved = savedRun(snapshot);
    expect(saved.preparation!.score).toBeCloseTo(boundary.score, 10);
    // Keep the exact stored decimal at the two display thresholds; no rounding in the UI.
    saved.preparation!.baselineScore = boundary.score;
    saved.preparation!.score = boundary.score;
    const state = await fixture(page, assessed(saved), [saved]);
    await page.goto(`/analysis/${jobId}`);
    await expect(badge(page).locator('.oc-number')).toHaveText(boundary.text);
    await expect(badge(page)).toHaveAttribute('aria-label', `신뢰도 ${boundary.spoken} ${boundary.grade}등급`);
    await page.getByRole('button', { name: 'Cluevia on', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Cluevia off', exact: true })).toBeVisible();
    await expect(badge(page).locator('.oc-number')).toHaveText(boundary.text);
    await expect(badge(page)).toHaveAttribute('aria-label', `신뢰도 ${boundary.spoken} ${boundary.grade}등급`);
    expect(state.runs[0].preparation!.score).toBe(boundary.score);
    expect(state.posts).toEqual([]); expect(state.errors).toEqual([]);
  });
}

test('the compact score shows only baseline then the cached result and grade without a popup', async ({ page }) => {
  const saved = goalRun();
  const state = await fixture(page, assessed(saved), [saved]);
  await page.goto(`/analysis/${jobId}`);
  await expect(badge(page).locator('.oc-number')).toHaveText('83.3');
  await expect(badge(page).locator('[data-confidence-grade]')).toHaveAttribute('data-confidence-grade', 'A');
  await expect(page.locator('[data-graph-decoration="goal"]')).toHaveAttribute('data-review-state', 'idle');
  await page.getByRole('button', { name: 'Cluevia on', exact: true }).click();
  await expect(badge(page).locator('.oc-number')).toHaveText('77.3');
  await expect(badge(page).locator('[data-confidence-grade]')).toHaveAttribute('data-confidence-grade', 'B');
  await expect(badge(page).locator('.oc-before')).toHaveText('83.3 A');
  await expect(badge(page)).toContainText('→');
  await expect(badge(page).getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: '신뢰도 계산 설명', exact: true })).toHaveCount(0);
  await expect(badge(page)).not.toContainText('Confidence');
  await page.getByRole('button', { name: 'Cluevia off', exact: true }).click();
  await expect(badge(page).locator('.oc-number')).toHaveText('83.3');
  await page.reload(); await page.getByRole('button', { name: 'Cluevia on', exact: true }).click();
  await expect(badge(page).locator('.oc-number')).toHaveText('77.3');
  expect(state.posts).toEqual([]); expect(state.errors).toEqual([]); await noFooter(page);
});

test('grade F applies fixed zero reliability and goal inputs save and survive reload', async ({ page }) => {
  const saved = savedRun(whyFixture(1));
  const state = await fixture(page, assessed(saved), [saved]);
  await page.goto(`/analysis/${jobId}`); await page.getByRole('button', { name: 'Cluevia on', exact: true }).click();
  const goal = page.locator('[data-graph-decoration="goal"]'); await goal.focus(); await goal.press('Enter');
  const review = page.getByRole('dialog', { name: '공백 검토', exact: true });
  await review.locator('summary').filter({ hasText: '출처·판정·점수 검토' }).click();
  await expect(review.getByLabel('b0 우도비', { exact: true })).toHaveValue('1');
  await expect(review.getByLabel('root 사전확률', { exact: true })).toHaveValue('0.5');
  await expect(review.getByLabel('r0 사전확률', { exact: true })).toHaveCount(0);
  await review.getByLabel('원본 0 출처 등급', { exact: true }).selectOption('F');
  await expect(review.getByLabel('원본 0 출처 계수', { exact: true })).toHaveValue('0');
  await expect(review.getByLabel('원본 0 출처 계수', { exact: true })).toHaveAttribute('readonly', '');
  await review.getByLabel('b0 우도비', { exact: true }).fill('5');
  await review.getByLabel('b0 우도비 근거', { exact: true }).fill('전체 결론 H의 관측 가능성 비교');
  await review.getByLabel('root 사전확률', { exact: true }).fill('0.5');
  await review.getByLabel('root 사전확률 근거', { exact: true }).fill('중립 기준');
  await review.getByRole('button', { name: '검토 저장 및 재평가', exact: true }).click();
  await expect(review).toContainText('서버에 진단 버전을 저장했습니다.');
  expect(state.evaluations).toHaveLength(1);
  expect(state.evaluations[0].snapshot.evidence[0].sourceGrade).toBe('F');
  expect(state.evaluations[0].snapshot.evidence[0].sourceCoefficient).toBe(0);
  expect(state.evaluations[0].snapshot.bindings[0].likelihood).toMatchObject({ ratio: 5, basis: 'EXPERT_ESTIMATE', hypothesisId: 'root' });
  expect(state.evaluations[0].snapshot.policy.bayes).toEqual({ target: 'GOAL', priors: [{ nodeId: 'root', probability: .5, reason: '중립 기준', basis: 'EXPERT_ESTIMATE' }], conditionalIndependence: [] });
  await review.getByRole('button', { name: '공백 검토 닫기', exact: true }).click();
  await expect(badge(page).locator('.oc-number')).toHaveText('50');
  await page.getByRole('button', { name: 'Cluevia off', exact: true }).click();
  await expect(badge(page).locator('.oc-number')).toHaveText('83.3');
  await page.getByRole('button', { name: 'Cluevia on', exact: true }).click();
  await expect(badge(page).locator('.oc-number')).toHaveText('50');
  await page.reload(); await page.getByRole('button', { name: 'Cluevia on', exact: true }).click();
  await goal.focus(); await goal.press('Enter');
  await review.locator('summary').filter({ hasText: '출처·판정·점수 검토' }).click();
  await expect(review.getByLabel('원본 0 출처 등급', { exact: true })).toHaveValue('F');
  await expect(review.getByLabel('b0 우도비', { exact: true })).toHaveValue('5');
  await expect(review.getByLabel('root 사전확률', { exact: true })).toHaveValue('0.5');
  expect(state.posts).toEqual([`${endpoint}/why-not/evaluate`]); expect(state.errors).toEqual([]);
});

test('mobile compact confidence stays on the canvas without extra panels or horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page, assessed(goalRun()), [goalRun()]);
  await page.goto(`/analysis/${jobId}`); await page.getByRole('button', { name: 'Cluevia on', exact: true }).click();
  await expect(badge(page).locator('.oc-number')).toHaveText('77.3');
  await expect(badge(page)).toBeInViewport();
  const bounds = (await badge(page).boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(391);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(845);
  await noFooter(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  await page.screenshot({ path: test.info().outputPath('confidence-compact-mobile.png'), fullPage: true });
  expect(state.posts).toEqual([]); expect(state.errors).toEqual([]);
});

test('new material refreshes the active diagnostic score without another Cluevia click', async ({ page }) => {
  const first = goalRun();
  const state = await fixture(page, assessed(first), [first]);
  await page.goto(`/analysis/${jobId}`);
  await page.getByRole('button', { name: 'Cluevia on', exact: true }).click();
  await expect(badge(page).locator('.oc-number')).toHaveText('77.3');
  const goal = page.locator('[data-graph-decoration="goal"]');
  const position = await goal.evaluate(element => ({ left: element.style.left, top: element.style.top }));
  const snapshot = whyFixture(2);
  snapshot.evidence.forEach(evidence => { evidence.sourceGrade = 'C'; });
  snapshot.bindings.forEach(binding => { binding.likelihood = { ratio: 5, basis: 'EXPERT_ESTIMATE', reason: '추가된 독립 관측의 목표 기준 우도비' }; });
  snapshot.policy.bayes = { target: 'GOAL', priors: [{ nodeId: 'root', probability: .5, reason: '중립 사전확률' }], conditionalIndependence: [{ requirementId: 'root', bindingIds: ['b0', 'b1'], reason: '사건이 참일 때와 거짓일 때 모두 별도로 기록되는 관측' }] };
  const completed: WhyRun = { ...savedRun(snapshot), id: 'confidence-supplemented', previousId: first.id, updatedAt: '2026-10-11T00:01:00Z' };
  const building: WhyRun = { ...completed, status: 'running', phase: 'diagnosing', result: undefined, preparation: { ...completed.preparation!, ready: false, score: null, grade: null, preparedAt: null, animation: [] } };
  state.runs = [building, first]; state.assessment = { ...assessed(first), state: 'pending' };
  await expect(page.getByRole('button', { name: 'Cluevia loading', exact: true })).toBeDisabled({ timeout: 10000 });
  await expect(page.locator('[data-graph-node^="gap-overview:evidence:"]')).toHaveCount(2);
  await expect(badge(page).locator('.oc-number')).toHaveText('77.3');
  await expect(badge(page)).toHaveAttribute('aria-busy', 'true');
  await expect(badge(page).locator('.oc-computing')).toHaveText('Calculating...');
  state.runs = [completed, first]; state.assessment = assessed(completed);
  await expect(page.getByRole('button', { name: 'Cluevia off', exact: true })).toBeVisible({ timeout: 10000 });
  await expect(badge(page).locator('.oc-number')).toHaveText('92', { timeout: 10000 });
  await expect(badge(page).locator('.oc-before')).toHaveText('77.3 B');
  await expect(badge(page)).toHaveAttribute('aria-busy', 'false');
  await expect(badge(page).locator('[data-confidence-grade]')).toHaveAttribute('data-confidence-grade', 'A');
  expect(await goal.evaluate(element => ({ left: element.style.left, top: element.style.top }))).toEqual(position);
  expect(state.posts).toEqual([]); expect(state.errors).toEqual([]);
});

test('uncomputed placeholder 50 stays hidden while an actual completed 50 is shown', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const saved = savedRun(whyFixture(1));
  const pending: WhyRun = { ...saved, status: 'running', phase: 'diagnosing', result: undefined, estimation: { status: 'running', model: 'claude-fixture', effort: 'low' }, preparation: { ...saved.preparation!, ready: false, baselineScore: 50, score: 50, preparedAt: null } };
  const state = await fixture(page, { ...unassessed(), state: 'pending' }, [pending]);
  await page.goto(`/analysis/${jobId}`);
  await expect(badge(page)).toHaveAttribute('aria-label', '신뢰도 계산 중');
  await expect(badge(page).locator('.oc-number, [data-confidence-grade]')).toHaveCount(0);
  await expect(badge(page).locator('.oc-computing')).toHaveText('Calculating...');
  await expect(badge(page).locator('.oc-dots i').first()).toHaveCSS('animation-name', 'none');
  await expect(page.getByRole('button', { name: 'Cluevia loading', exact: true })).toBeDisabled();
  state.runs = [saved]; state.assessment = assessed(saved);
  await expect(page.getByRole('button', { name: 'Cluevia on', exact: true })).toBeEnabled({ timeout: 10000 });
  await expect(badge(page).locator('.oc-number')).toHaveText('50');
  await expect(badge(page).locator('[data-confidence-grade]')).toHaveText('C');
  await expect(badge(page).locator('.oc-computing')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cluevia on', exact: true }).click();
  await expect(badge(page).locator('.oc-number')).toHaveText('50');
  await expect(badge(page)).toHaveAttribute('aria-busy', 'false');
  expect(state.posts).toEqual([]); expect(state.errors).toEqual([]); await noFooter(page);
});

test('AI estimates retain their provenance across passive saves and become manual only when edited', async ({ page }) => {
  const snapshot = goalRun().snapshot!;
  const binding = snapshot.bindings[0];
  const estimation = { model: 'claude-fixture', effort: 'low' as const, estimatedAt: at, anchors: [{ evidenceId: binding.evidenceId, quote: binding.quote, start: binding.start, end: binding.end }] };
  binding.likelihood = { ratio: 5, basis: 'MODEL_ESTIMATE', hypothesisId: binding.requirementId, reason: '원문에 나타난 하위 조건의 관련 관측을 모델이 비교했습니다.', estimation };
  snapshot.policy.bayes!.priors[0] = { nodeId: snapshot.rootId, probability: .4, reason: '관측 이전 배경 정보를 모델이 추정했습니다.', basis: 'MODEL_ESTIMATE', estimation };
  snapshot.evidence[0].sourceEstimation = estimation;
  const saved = savedRun(snapshot);
  const state = await fixture(page, assessed(saved), [saved]);
  const review = page.getByRole('dialog', { name: '공백 검토', exact: true });
  async function openReview() {
    await page.getByRole('button', { name: 'Cluevia on', exact: true }).click();
    await page.locator('[data-graph-decoration="goal"]').focus();
    await page.locator('[data-graph-decoration="goal"]').press('Enter');
    await review.locator('summary').filter({ hasText: '출처·판정·점수 검토' }).click();
  }
  await page.goto(`/analysis/${jobId}`); await openReview();
  await expect(review.getByLabel('b0 우도비 산정 방식', { exact: true })).toHaveValue('MODEL_ESTIMATE');
  await expect(review).toContainText('이 값은 이전 하위 조건에 대한 추정입니다.');
  await expect(review.getByLabel('root 사전확률 산정 방식', { exact: true })).toHaveText('AI estimate');
  await expect(review.getByLabel('원본 0 출처 등급 산정 방식', { exact: true })).toHaveText('AI estimate');
  await review.getByLabel('품질 점수 근거', { exact: true }).fill('기존 품질 기록에만 검토 메모를 추가합니다.');
  await review.getByRole('button', { name: '검토 저장 및 재평가', exact: true }).click();
  await expect(review).toContainText('서버에 진단 버전을 저장했습니다.');
  expect(state.evaluations[0].snapshot.bindings[0].likelihood).toEqual(binding.likelihood);
  expect(state.evaluations[0].snapshot.policy.bayes!.priors[0]).toEqual(snapshot.policy.bayes!.priors[0]);
  expect(state.evaluations[0].snapshot.evidence[0].sourceEstimation).toEqual(estimation);
  expect(state.runs[0].snapshot!.bindings[0].likelihood!.estimation).toEqual(estimation);
  expect(state.runs[0].snapshot!.policy.bayes!.priors[0].estimation).toEqual(estimation);
  await page.reload(); await openReview();
  await expect(review.getByLabel('b0 우도비 산정 방식', { exact: true })).toHaveValue('MODEL_ESTIMATE');
  await expect(review.getByLabel('root 사전확률 산정 방식', { exact: true })).toHaveText('AI estimate');
  await expect(review.getByLabel('원본 0 출처 등급 산정 방식', { exact: true })).toHaveText('AI estimate');
  await review.getByLabel('b0 우도비 근거', { exact: true }).fill('검토자가 원문을 다시 확인한 우도비 추정입니다.');
  await review.getByLabel('root 사전확률', { exact: true }).fill('0.6');
  await review.getByLabel('원본 0 출처 등급', { exact: true }).selectOption('D');
  await expect(review.getByLabel('b0 우도비 산정 방식', { exact: true })).toHaveValue('EXPERT_ESTIMATE');
  await expect(review.getByLabel('root 사전확률 산정 방식', { exact: true })).toHaveText('Manual estimate');
  await expect(review.getByLabel('원본 0 출처 등급 산정 방식', { exact: true })).toHaveText('Manual estimate');
  await review.getByRole('button', { name: '검토 저장 및 재평가', exact: true }).click();
  await expect(review).toContainText('서버에 진단 버전을 저장했습니다.');
  const manual = state.evaluations[1].snapshot;
  expect(manual.bindings[0].likelihood).toMatchObject({ ratio: 5, basis: 'EXPERT_ESTIMATE', hypothesisId: 'root' });
  expect(manual.bindings[0].likelihood!.estimation).toBeUndefined();
  expect(manual.policy.bayes!.priors[0]).toMatchObject({ probability: .6, basis: 'EXPERT_ESTIMATE' });
  expect(manual.policy.bayes!.priors[0].estimation).toBeUndefined();
  expect(manual.evidence[0].sourceEstimation).toBeUndefined();
  await page.reload(); await openReview();
  await expect(review.getByLabel('b0 우도비 산정 방식', { exact: true })).toHaveValue('EXPERT_ESTIMATE');
  await expect(review.getByLabel('root 사전확률 산정 방식', { exact: true })).toHaveText('Manual estimate');
  await expect(review.getByLabel('원본 0 출처 등급 산정 방식', { exact: true })).toHaveText('Manual estimate');
  expect(state.posts).toEqual([`${endpoint}/why-not/evaluate`, `${endpoint}/why-not/evaluate`]);
  expect(state.errors).toEqual([]);
});

test('supplement submission keeps progress visible and explains saved material without a justified new connection', async ({ page }) => {
  const first = goalRun();
  const state = await fixture(page, assessed(first), [first]);
  const submitted: { previousId: string; supplement: { name: string; text: string; url: string } }[] = [];
  const pending: WhyRun = { id: 'supplement-review', jobId, previousId: first.id, createdAt: at, updatedAt: at, status: 'running', phase: 'building-graph', stage: '추가 원문에서 연결 근거를 확인하고 있습니다.' };
  await page.route(`**${endpoint}/why-not`, route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { runs: state.runs } });
    submitted.push(route.request().postDataJSON()); state.posts.push(`${endpoint}/why-not`);
    state.runs = [pending, first]; state.assessment = { ...assessed(first), state: 'pending' };
    return route.fulfill({ status: 202, json: { run: pending } });
  });
  await page.goto(`/analysis/${jobId}`);
  await page.getByRole('button', { name: 'Cluevia on', exact: true }).click();
  await page.locator('[data-graph-decoration="goal"]').focus();
  await page.locator('[data-graph-decoration="goal"]').press('Enter');
  const review = page.getByRole('dialog', { name: '공백 검토', exact: true });
  await review.locator('summary').filter({ hasText: '부족한 자료 보완' }).click();
  await review.getByLabel('자료 제목', { exact: true }).fill('짧은 메모');
  await review.getByLabel('추가 원문', { exact: true }).fill('한국');
  const submit = review.getByRole('button', { name: '자료 추가 및 새 버전 평가', exact: true });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(review.getByRole('button', { name: '검증 중단', exact: true })).toBeVisible();
  await expect(review).toBeVisible();
  await expect(review).toContainText('추가 원문에서 연결 근거를 확인하고 있습니다.');
  expect(submitted).toEqual([{ previousId: first.id, supplement: { name: '짧은 메모', text: '한국', url: '' } }]);
  const snapshot = structuredClone(first.snapshot!);
  snapshot.evidence.push({ ...snapshot.evidence[0], id: 'user-new', name: '짧은 메모', text: '한국', contentHash: contentHash('한국'), sourceGrade: null, sourceCoefficient: null, sourceReason: '' });
  const completed: WhyRun = { ...savedRun(snapshot), id: pending.id, previousId: first.id, updatedAt: '2026-10-11T00:02:00Z' };
  state.runs = [completed, first]; state.assessment = assessed(completed);
  await expect(review.getByRole('status').filter({ hasText: '추가 자료 1개를 저장했습니다.' })).toBeVisible({ timeout: 10000 });
  await expect(review).toContainText('결론과 연결할 근거를 찾지 못해 그래프 연결은 그대로 유지됩니다.');
  await expect(review.getByRole('button', { name: '검증 중단', exact: true })).toHaveCount(0);
  await expect(review.getByLabel('추가 원문', { exact: true })).toHaveValue('');
  await expect(submit).toBeDisabled();
  expect(completed.snapshot!.bindings).toHaveLength(first.snapshot!.bindings.length);
  expect(state.posts).toEqual([`${endpoint}/why-not`]); expect(state.errors).toEqual([]);
});

for (const outcome of ['fetched', 'failed'] as const) test(`URL-only supplement ${outcome === 'fetched' ? 'closes a real gap and updates confidence automatically' : 'shows the read failure and retains the link for retry'}`, async ({ page }) => {
  const completeSnapshot = whyFixture(2);
  completeSnapshot.evidence.forEach(evidence => { evidence.sourceGrade = 'C'; });
  completeSnapshot.bindings.forEach(binding => { binding.likelihood = { ratio: 5, basis: 'EXPERT_ESTIMATE', reason: '별도 원문에서 확인된 직접 관측' }; });
  completeSnapshot.policy.bayes = { target: 'GOAL', priors: [{ nodeId: 'root', probability: .5, reason: '중립 사전확률' }], conditionalIndependence: [{ requirementId: 'root', bindingIds: ['b0', 'b1'], reason: '사건의 참·거짓 각각에서 별도로 생성되는 독립 관측' }] };
  const url = 'https://source.example/e1-record';
  Object.assign(completeSnapshot.evidence[1], { id: 'user-url-1', kind: 'WEB_PAGE', documentId: 'url-1', url });
  completeSnapshot.bindings[1].evidenceId = 'user-url-1';
  const initial = structuredClone(completeSnapshot);
  initial.nodes[2].children = []; initial.bindings.splice(1); initial.evidence.splice(1); initial.policy.bayes!.conditionalIndependence = [];
  const first = savedRun(initial);
  expect(first.result!.gaps.some(gap => gap.type === 'EVIDENCE_MISSING')).toBe(true);
  const state = await fixture(page, assessed(first), [first]);
  const pending: WhyRun = { ...first, id: 'url-supplement', previousId: first.id, status: 'running', phase: 'building-graph', stage: 'URL 원문을 읽고 있습니다.', result: undefined, preparation: { ...first.preparation!, ready: false, score: null, preparedAt: null } };
  const posts: unknown[] = [];
  await page.route(`**${endpoint}/why-not`, route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { runs: state.runs } });
    posts.push(route.request().postDataJSON()); state.posts.push(`${endpoint}/why-not`);
    state.runs = [pending, first]; state.assessment = { ...assessed(first), state: 'pending' };
    return route.fulfill({ status: 202, json: { run: pending } });
  });
  await page.goto(`/analysis/${jobId}`);
  await page.getByRole('button', { name: 'Cluevia on', exact: true }).click();
  await expect(badge(page).locator('.oc-number')).toHaveText('77.3');
  const goal = page.locator('[data-graph-decoration="goal"]');
  await goal.focus(); await goal.press('Enter');
  const review = page.getByRole('dialog', { name: '공백 검토', exact: true });
  await review.locator('summary').filter({ hasText: '부족한 자료 보완' }).click();
  await review.getByLabel('자료 제목', { exact: true }).fill('두 번째 완료 기록');
  await review.getByLabel('원출처 URL (선택)', { exact: true }).fill(url);
  await expect(review.getByLabel('추가 원문', { exact: true })).toHaveValue('');
  await expect(review.getByRole('button', { name: '자료 추가 및 새 버전 평가', exact: true })).toBeEnabled();
  await review.getByRole('button', { name: '자료 추가 및 새 버전 평가', exact: true }).click();
  await expect(review.getByRole('button', { name: '검증 중단', exact: true })).toBeVisible();
  await expect(review).toContainText('URL 원문을 읽고 있습니다.');
  expect(posts).toEqual([{ previousId: first.id, supplement: { name: '두 번째 완료 기록', text: '', url } }]);
  await review.getByRole('button', { name: '공백 검토 닫기', exact: true }).click();
  await expect(badge(page).locator('.oc-number')).toHaveText('77.3');
  await expect(badge(page).locator('.oc-computing')).toHaveText('Calculating...');
  if (outcome === 'fetched') {
    const completed: WhyRun = { ...savedRun(completeSnapshot), id: pending.id, previousId: first.id, updatedAt: '2026-10-11T00:03:00Z', urlReads: [{ documentId: 'url-1', url, status: 'fetched', characters: completeSnapshot.evidence[1].text.length }] };
    state.runs = [completed, first]; state.assessment = assessed(completed);
    await expect(badge(page).locator('.oc-number')).toHaveText('92', { timeout: 10000 });
    await expect(badge(page).locator('.oc-before')).toHaveText('77.3 B');
    await expect(page.getByRole('button', { name: 'Cluevia off', exact: true })).toBeVisible();
    await expect(page.locator('[data-graph-decoration="gap"][data-gap-type="EVIDENCE_MISSING"]')).toHaveCount(0);
    await expect(badge(page).locator('.oc-computing')).toHaveCount(0);
    await goal.focus(); await goal.press('Enter');
    await expect(review.getByRole('status').filter({ hasText: 'URL 원문 1개를 읽었습니다.' })).toBeVisible({ timeout: 10000 });
    await expect(review).toContainText('추가 자료 1개를 저장하고 1개를 주장에 연결했습니다.');
  } else {
    state.runs = [{ ...pending, status: 'failed', stage: 'URL 읽기 실패', error: '추가 URL 원문을 읽지 못했습니다. HTTP 403', urlReads: [{ documentId: 'url-1', url, status: 'failed', reason: 'HTTP 403' }] }, first];
    await expect(page.getByRole('button', { name: 'Cluevia failed', exact: true })).toBeVisible({ timeout: 10000 });
    await goal.focus(); await goal.press('Enter');
    await expect(review.getByRole('status').filter({ hasText: 'URL 원문 1개를 읽지 못했습니다.' })).toBeVisible({ timeout: 10000 });
    await expect(review).toContainText('읽지 못한 링크는 증거로 사용하지 않았습니다.');
    await expect(review.getByLabel('원출처 URL (선택)', { exact: true })).toHaveValue(url);
    await expect(review.getByRole('button', { name: '자료 추가 및 새 버전 평가', exact: true })).toBeEnabled();
    await expect(review).not.toContainText('새 진단과 점수에 반영했습니다.');
  }
  expect(state.posts).toEqual([`${endpoint}/why-not`]); expect(state.errors).toEqual([]);
});
