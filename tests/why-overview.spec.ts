import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { GraphDocument } from '../src/types/graph';
import type { OverviewConfidenceSummary, WhyOverviewLayout, WhyRun, WhySnapshot } from '../src/types/why-not';
import { whyFixture } from '../server/why-not-fixture';
import { evaluateWhyNot } from '../server/why-not-engine';
import type { GenerationJob } from '../src/services/api-client';

const at = '2026-10-11T00:00:00Z';
const jobId = 'why-overview-job';
const endpoint = `/api/jobs/${jobId}/why-not`;
const graph: GraphDocument = {
  schemaVersion: '1.0', id: 'why-overview-graph', title: 'E1 검증', question: '사건 E1 완료 여부',
  summary: '원본 기록에는 E1 완료 0이 명시되어 있습니다.', origin: 'codex', createdAt: at,
  groups: [{ id: 'events', label: '사건', color: '#916538' }],
  nodes: [
    { id: 'event', type: 'Event', label: 'E1', group: 'events', description: '사건 E1', sourceIds: ['source'], properties: {} },
    { id: 'agency', type: 'Organization', label: '관측기관 A', group: 'events', description: '완료 여부를 확인 중인 기관', sourceIds: ['source'], properties: {} },
    { id: 'place', type: 'Place', label: '관측 구역 B', group: 'events', description: '사건 발생 주장이 부인된 장소', sourceIds: ['source'], properties: {} },
  ],
  edges: [
    { id: 'uncertain-report', source: 'agency', target: 'event', label: '보고', description: '관측기관 A는 E1의 완료 여부를 아직 확인하지 못했습니다.', status: 'reported', sourceIds: ['source'], claim: { stance: 'uncertain', attributedTo: '관측기관 A', validFrom: null, validTo: null, publishedAt: null, derivedFrom: null } },
    { id: 'denied-location', source: 'event', target: 'place', label: '발생', description: 'E1이 관측 구역 B에서 발생했다는 주장은 부인되었습니다.', status: 'reported', sourceIds: ['source'], claim: { stance: 'denied', attributedTo: '관측기관 A', validFrom: null, validTo: null, publishedAt: null, derivedFrom: null } },
  ], events: [], limitations: [],
  findings: [{ text: '원본 기록에는 E1 완료 0이 명시되어 있습니다.', sourceIds: ['source'], nodeIds: ['event'] }],
  sources: [{ id: 'source', title: '원본 기록', excerpt: 'E1 완료 0' }],
};
function savedRun(id = 'why-saved', snapshot = whyFixture(1)): WhyRun {
  snapshot.goal = graph.question;
  const result = evaluateWhyNot(snapshot);
  return { id, jobId, previousId: null, createdAt: at, updatedAt: at, status: 'completed', stage: '진단 완료', phase: 'ready', graphReadyAt: at, baseSnapshot: structuredClone(snapshot), snapshot, result, preparation: { version: 'cluevia-preparation-1', ready: true, baselineScore: (result.confidence.bayesian?.baselineScore ?? .5) * 100, score: (result.confidence.bayesian?.score ?? .5) * 100, grade: result.confidence.bayesian?.grade ?? 'C', preparedAt: at, animation: result.gaps.map((gap, index) => ({ gapId: gap.id, delayMs: index * 65, durationMs: 650 })), gapFill: [] } };
}

function assessment(run?: WhyRun): OverviewConfidenceSummary {
  return { state: run?.result ? run.result.evaluationStatus === 'INCOMPLETE' ? 'incomplete' : 'ready' : 'unassessed', confidence: run?.result?.confidence ?? null,
    goal: run?.snapshot?.goal ?? graph.question, reason: run?.result?.confidence.reason ?? '평가할 근거가 아직 준비되지 않았습니다.', unknownReasons: [], inputs: [],
    policyVersion: run?.snapshot?.policy.version ?? null, assessmentVersion: run?.id ?? null, evaluatedAt: run?.updatedAt ?? null,
    assumptions: [], coverageNote: run?.snapshot?.coverage.note ?? '', accepted: run?.result?.accepted ?? false };
}

async function fixture(page: Page, runs: WhyRun[] = [savedRun()], pending = false) {
  const state = { runs, readBlock: null as Promise<void> | null, reads: 0, runReads: [] as string[], recordReads: 0, confidenceReads: 0, posts: [] as { path: string; body: unknown }[], errors: [] as string[],
    layout: { jobId, revision: 0, updatedAt: null, positions: {} } as WhyOverviewLayout, layoutWrites: [] as WhyOverviewLayout[] };
  page.on('pageerror', error => state.errors.push(error.message));
  const job = { id: jobId, question: graph.question, status: pending ? 'running' : 'completed', stage: pending ? 'extracting' : 'saving', message: pending ? '자료 분석 중' : '완료', createdAt: at, updatedAt: at, completedChunks: 1, totalChunks: pending ? 2 : 1, graphIds: [graph.id], graphId: graph.id };
  const record = { number: 1, title: '원본 기록', status: 'saved', graphId: graph.id, nodeCount: graph.nodes.length, edgeCount: graph.edges.length, archived: true };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === `${endpoint}/layout`) {
      if (request.method() === 'PUT') {
        const body = request.postDataJSON() as Pick<WhyOverviewLayout, 'positions' | 'revision'>;
        state.layout = { jobId, revision: body.revision + 1, updatedAt: at, positions: body.positions };
        state.layoutWrites.push(state.layout);
      }
      return route.fulfill({ json: state.layout });
    }
    if (request.method() !== 'GET') {
      const body = request.postDataJSON();
      state.posts.push({ path, body });
      if (path === endpoint) {
        const run: WhyRun = { ...savedRun('why-building'), status: 'running', snapshot: undefined, result: undefined, stage: '필수 근거 연결 중' };
        state.runs = [run, ...state.runs];
        return route.fulfill({ status: 202, json: { run } });
      }
      if (path === `${endpoint}/evaluate`) {
        const run = { ...savedRun('why-reviewed', body.snapshot as WhySnapshot), previousId: body.previousId };
        state.runs = [run, ...state.runs];
        return route.fulfill({ json: { run } });
      }
      return route.fulfill({ status: 500, json: { error: `Unexpected mutation ${path}` } });
    }
    if (path === '/api/system/status') return route.fulfill({ json: { authenticated: true, authRequired: false, provider: { available: true, authenticated: true, message: 'Ready', kind: 'codex' }, ontology: { entities: graph.nodes.length, relationships: graph.edges.length, documents: graph.sources.length, graphs: 1 }, activeJobs: [] } });
    if (path === '/api/jobs') return route.fulfill({ json: { jobs: [job] } });
    if (path === '/api/graphs') return route.fulfill({ json: { graphs: [graph] } });
    if (path === `/api/jobs/${jobId}`) return route.fulfill({ json: { job } });
    if (path === `/api/jobs/${jobId}/chat`) return route.fulfill({ json: { turns: [], model: 'fixture-model', effort: 'medium' } });
    if (path === `/api/jobs/${jobId}/decisions`) return route.fulfill({ json: { decisions: [] } });
    if (path === `/api/jobs/${jobId}/confidence`) { state.confidenceReads++; return route.fulfill({ json: assessment(state.runs.find(run => run.status === 'completed' && run.result)) }); }
    if (path === endpoint) {
      state.reads++;
      if (state.readBlock) await state.readBlock;
      return route.fulfill({ json: { runs: state.runs.map((run, index) => index === 0 ? run : { ...run, snapshot: undefined, result: undefined }) } });
    }
    if (path.startsWith(`${endpoint}/runs/`)) {
      state.runReads.push(path.split('/').at(-1)!);
      return route.fulfill({ json: { run: state.runs.find(run => path.endsWith(`/${run.id}`)) } });
    }
    if (path === `/api/jobs/${jobId}/case`) return route.fulfill({ json: {
      schemaVersion: 'case-1.0', jobId, status: job.status, updatedAt: at, graph: { ...graph, id: `case-${jobId}` }, records: [record], conflicts: [],
      provenance: { event: [{ record: 1, localId: 'event' }], source: [{ record: 1, localId: 'source' }] },
    } });
    if (path === `/api/jobs/${jobId}/records/1`) {
      state.recordReads++;
      return route.fulfill({ json: { record, graph, summary: graph.summary, limitations: [], claims: [], relationClaims: [], documents: [{ id: 'source', name: '원본 기록', text: 'E1 완료 0', totalChars: 7, offset: 0 }] } });
    }
    return route.fulfill({ status: 404, json: { error: `Missing fixture ${path}` } });
  });
  return state;
}

const canvas = (page: Page) => page.locator('.case-overview .cg-root');
const rootNode = (page: Page) => canvas(page).locator('[data-graph-decoration="goal"]');
const materialNode = (page: Page, id = 'e0') => canvas(page).locator(`[data-graph-node="gap-overview:evidence:${id}"]`);
const gapNodes = (page: Page) => canvas(page).locator('[data-graph-decoration="gap"]');
const checks = (page: Page) => page.getByRole('dialog', { name: '공백 검토', exact: true });
const enableCluevia = (page: Page) => page.getByRole('button', { name: 'Cluevia on', exact: true }).click();
const openChecks = async (page: Page) => { await rootNode(page).focus(); await rootNode(page).press('Enter'); };
const closeChecks = (page: Page) => checks(page).getByRole('button', { name: '공백 검토 닫기', exact: true }).click();
const noFooter = (page: Page) => expect(page.locator('.gw-detail-dock, .gw-detail-bar, .gw-session-footer, .cg-footer, .aw-canvas-footer, .aw-pending-footer')).toHaveCount(0);
const badge = (page: Page) => page.locator('[data-overview-confidence]');

/** The diagnostic overlay may add annotations, never replace the base paths. */
async function baseCanvasState(page: Page) {
  return canvas(page).evaluate(element => ({
    nodes: Array.from(element.querySelectorAll<HTMLElement>('[data-graph-node]:not([data-graph-decoration="gap"])')).map(node => ({ id: node.dataset.graphNode, label: node.querySelector('strong')?.textContent, left: node.style.left, top: node.style.top })),
    edges: Array.from(element.querySelectorAll<SVGElement>('[data-graph-edge]:not([data-gap-type])')).map(edge => ({ id: edge.dataset.graphEdge, label: edge.getAttribute('aria-label'), path: edge.querySelector('.cg-edge-line')?.getAttribute('d') })),
  }));
}

async function expectNeutralBase(page: Page) {
  await expect(canvas(page).locator('[data-gap-type], [data-gap-warning], .cg-gap-legend')).toHaveCount(0);
  await expect(rootNode(page)).toHaveAttribute('data-review-state', 'idle');
  await expect(canvas(page).getByRole('button', { name: /지지 판정|반증 판정|불충분 판정|무관 판정|판정 대기/ })).toHaveCount(0);
  await expect(canvas(page).locator('.cg-edge-label')).not.toContainText([/지지 판정|반증 판정|불충분 판정|무관 판정|판정 대기/]);
}

test('saved gaps animate on the Evidence graph without mixing associations or starting another review', async ({ page }) => {
  const snapshot = whyFixture(2);
  snapshot.bindings[1] = { ...snapshot.bindings[1], evidenceId: 'e0', quote: snapshot.bindings[0].quote, start: 0, end: snapshot.bindings[0].quote.length, verdict: 'INSUFFICIENT', metadata: structuredClone(snapshot.bindings[0].metadata) };
  const run = savedRun('why-shared', snapshot);
  const state = await fixture(page, [run]);
  await page.goto(`/analysis/${jobId}`);
  await expect(page.getByRole('button', { name: 'Cluevia on', exact: true })).toBeEnabled();
  await expect(gapNodes(page)).toHaveCount(0);
  await expectNeutralBase(page);
  const baseline = await baseCanvasState(page);
  expect(state.posts).toEqual([]);
  await enableCluevia(page);
  await expect(rootNode(page)).toContainText(graph.question);
  await expect(canvas(page).locator('.cg-edge--uncertain, .cg-edge--denied')).toHaveCount(0);
  await expect(canvas(page).locator('[data-graph-node="event"], [data-graph-node="agency"]')).toHaveCount(0);
  await expect(materialNode(page)).toHaveCount(1);
  await expect(gapNodes(page)).toHaveCount(run.result!.gaps.length);
  await expect(canvas(page).locator('[data-gap-warning]')).toHaveCount(run.result!.gaps.length);
  const diagnosticLinks = await canvas(page).locator('[data-graph-edge][data-gap-type]').evaluateAll(elements => elements.map(element => ({ id: element.getAttribute('data-graph-edge')!, label: element.getAttribute('aria-label')! })));
  expect(diagnosticLinks.length).toBeGreaterThan(0);
  expect(diagnosticLinks.every(link => !link.label.endsWith(` to ${graph.question}`))).toBe(true);
  const insufficient = run.result!.gaps.find(gap => gap.type === 'EVIDENCE_INSUFFICIENT')!;
  const affected = diagnosticLinks.filter(link => link.id.includes(`["${insufficient.id}",`));
  expect(affected).toHaveLength(2);
  expect(affected.some(link => link.label.endsWith(' to 필수 조건 1'))).toBe(true);
  expect(affected.some(link => link.label.endsWith(' to 원본 0'))).toBe(true);
  expect(await baseCanvasState(page)).toEqual(baseline);
  await expect(page.getByRole('navigation', { name: 'Overview layers', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '주장 검증 · 부족한 근거 찾기', exact: true })).toHaveCount(0);
  await expect(checks(page)).toBeHidden();
  await noFooter(page);
  expect(state.reads).toBeGreaterThan(0);
  expect(state.posts).toEqual([]);
  await canvas(page).getByRole('button', { name: 'Fit graph to view', exact: true }).click();
  for (const node of await canvas(page).locator('[data-graph-node]').all()) await expect(node).toBeInViewport({ ratio: .999 });
  await page.screenshot({ path: test.info().outputPath('why-overview-desktop.png'), fullPage: true });
  await openChecks(page); await expect(checks(page)).toBeVisible(); await closeChecks(page);
  await expect(checks(page)).toBeHidden();
  await expect(canvas(page).locator('.cg-edge--uncertain')).toHaveCount(0);
  expect(state.posts).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('the complete neutral Why graph stays usable while diagnostic completion is blocked', async ({ page }) => {
  const full = savedRun('why-phased');
  const building: WhyRun = { ...full, status: 'running', phase: 'building-graph', baseSnapshot: undefined, graphReadyAt: undefined, snapshot: undefined, result: undefined, preparation: { version: 'cluevia-preparation-1', ready: false, baselineScore: 50, score: null, grade: null, preparedAt: null, animation: [], gapFill: [] } };
  const state = await fixture(page, [building]);
  await page.goto(`/analysis/${jobId}`);
  await expect(page.getByRole('button', { name: 'Overview loading', exact: true })).toBeDisabled();
  await expect(materialNode(page)).toHaveCount(0);
  await expect(gapNodes(page)).toHaveCount(0);
  const base = structuredClone(full.baseSnapshot!);
  base.bindings.forEach(binding => { binding.verdict = 'UNREVIEWED'; binding.reason = ''; });
  state.runs = [{ ...building, phase: 'diagnosing', baseSnapshot: base, snapshot: base, graphReadyAt: at }];
  await expect(materialNode(page)).toHaveCount(1, { timeout: 8000 });
  await expect(canvas(page).locator('[data-graph-node]')).toHaveCount(3);
  await expect(canvas(page).locator('[data-graph-edge]')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Cluevia loading', exact: true })).toBeDisabled();
  await expectNeutralBase(page);
  await expect(badge(page).locator('.oc-number')).toHaveCount(0);
  await expect(badge(page).locator('.oc-computing')).toHaveText('Calculating...');
  const baseline = await baseCanvasState(page);
  let release!: () => void;
  const reads = state.reads;
  state.readBlock = new Promise<void>(resolve => { release = resolve; });
  try {
    await expect.poll(() => state.reads, { timeout: 8000 }).toBeGreaterThan(reads);
    await canvas(page).getByRole('button', { name: 'Fit graph to view', exact: true }).click();
    await expect(materialNode(page)).toBeInViewport({ ratio: .999 });
    await expect(page.getByRole('button', { name: 'Cluevia loading', exact: true })).toBeDisabled();
    expect(await baseCanvasState(page)).toEqual(baseline);
    expect(state.posts).toEqual([]);
    const snapshot = structuredClone(full.snapshot!); snapshot.bindings[0].verdict = 'INSUFFICIENT'; snapshot.bindings[0].reason = '검토 단계에서만 노출할 불충분 판정';
    const finished = { ...savedRun('why-phased', snapshot), baseSnapshot: base };
    state.runs = [finished]; state.readBlock = null; release();
    await expect(page.getByRole('button', { name: 'Cluevia on', exact: true })).toBeEnabled({ timeout: 8000 });
    await expectNeutralBase(page);
    expect(await baseCanvasState(page)).toEqual(baseline);
    await enableCluevia(page);
    await expect(gapNodes(page)).toHaveCount(finished.result!.gaps.length);
    expect(await baseCanvasState(page)).toEqual(baseline);
    await expect(canvas(page).locator('.cg-edge--gap').first()).toHaveCSS('--cg-gap-duration', '650ms');
    await page.getByRole('button', { name: 'Cluevia off', exact: true }).click();
    await expectNeutralBase(page); expect(await baseCanvasState(page)).toEqual(baseline);
    await enableCluevia(page); await expect(gapNodes(page)).toHaveCount(finished.result!.gaps.length);
    await page.reload(); await enableCluevia(page); await expect(gapNodes(page)).toHaveCount(finished.result!.gaps.length);
    expect(state.posts).toEqual([]); expect(state.errors).toEqual([]);
  } finally { state.readBlock = null; release(); }
});

test('analysis in progress never starts a check or fabricates diagnostic findings', async ({ page }) => {
  const state = await fixture(page, [], true);
  await page.goto(`/analysis/${jobId}`);
  await expect(page.getByRole('region', { name: '분석 결과 요약', exact: true })).toBeVisible();
  await expect(canvas(page).locator('[data-review-state="checking"]')).toHaveCount(0);
  await expect(gapNodes(page)).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Overview layers', exact: true })).toHaveCount(0);
  await expect.poll(() => state.reads).toBeGreaterThan(0);
  expect(state.posts).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('the initial Why base appears before any extraction graph while diagnostics wait for analysis completion', async ({ page }) => {
  const full = savedRun('why-early');
  const building: WhyRun = { id: full.id, jobId, previousId: null, createdAt: at, updatedAt: at, status: 'running', phase: 'building-graph', stage: '초기 논리 그래프 생성 중' };
  const state = await fixture(page, [building], true);
  const earlyJob: GenerationJob = { id: jobId, question: graph.question, status: 'running', stage: 'preparing', message: '입력 자료를 준비하고 있습니다.', createdAt: at, updatedAt: at, completedChunks: 0, totalChunks: 2, graphIds: [] };
  let caseReads = 0;
  await page.route(`**/api/jobs/${jobId}`, route => route.fulfill({ json: { job: earlyJob } }));
  await page.route(`**/api/jobs/${jobId}/case`, route => {
    caseReads++;
    return route.fulfill({ json: { schemaVersion: 'case-1.0', jobId, status: earlyJob.status, updatedAt: at, graph: { ...graph, id: `case-${jobId}`, nodes: [], edges: [], sources: [], findings: [] }, records: [], provenance: {}, conflicts: [] } });
  });
  await page.goto(`/analysis/${jobId}`);
  await expect(page.getByRole('button', { name: 'Overview loading', exact: true })).toBeDisabled();
  expect(caseReads).toBeGreaterThan(0);
  await expect(materialNode(page)).toHaveCount(0);
  const base = structuredClone(full.baseSnapshot!);
  base.bindings.forEach(binding => { binding.verdict = 'UNREVIEWED'; binding.reason = ''; });
  state.runs = [{ ...building, phase: 'graph-ready', baseSnapshot: base, snapshot: base, graphReadyAt: at, preparation: { ...full.preparation!, ready: false, score: null, grade: null, preparedAt: null, animation: [] } }];
  await expect(page.getByRole('button', { name: 'Overview ready', exact: true })).toBeDisabled({ timeout: 8000 });
  await expect(materialNode(page)).toHaveCount(1);
  await expect(canvas(page).locator('[data-graph-node]')).toHaveCount(3);
  await expect(canvas(page).locator('[data-graph-edge]')).toHaveCount(2);
  await expect(page.locator('.case-overview')).toHaveAttribute('data-overview-phase', 'graph-ready');
  await expect(badge(page).locator('.oc-number, [data-confidence-grade]')).toHaveCount(0);
  await expect(badge(page)).toHaveAttribute('data-confidence-computing', 'true');
  await expect(page.getByRole('button', { name: 'Cluevia loading', exact: true })).toHaveCount(0);
  await expectNeutralBase(page);
  expect(earlyJob.completedChunks).toBe(0); expect(earlyJob.graphIds).toEqual([]);
  const baseline = await baseCanvasState(page);
  earlyJob.status = 'completed'; earlyJob.stage = 'saving'; earlyJob.completedChunks = 2;
  state.runs = [{ ...state.runs[0], phase: 'diagnosing', stage: '자료 판정 중' }];
  await expect(page.getByRole('button', { name: 'Cluevia loading', exact: true })).toBeDisabled({ timeout: 8000 });
  expect(await baseCanvasState(page)).toEqual(baseline);
  state.runs = [{ ...full, baseSnapshot: base }];
  await expect(page.getByRole('button', { name: 'Cluevia on', exact: true })).toBeEnabled({ timeout: 8000 });
  expect(await baseCanvasState(page)).toEqual(baseline);
  await expectNeutralBase(page);
  expect(state.posts).toEqual([]); expect(state.errors).toEqual([]); await noFooter(page);
});

test('failed or unfinished preparation keeps the saved Why base neutral and the toggle disabled', async ({ page }) => {
  const snapshot = whyFixture(1); snapshot.bindings[0].verdict = 'INSUFFICIENT';
  const old = savedRun('why-older', snapshot);
  const latest: WhyRun = { ...savedRun('why-new'), status: 'failed', phase: 'diagnosing', snapshot: undefined, result: undefined, preparation: undefined, error: '원문 응답 시간 초과' };
  const state = await fixture(page, [latest, old]);
  await page.goto(`/analysis/${jobId}`);
  await expect(page.getByRole('button', { name: 'Cluevia failed', exact: true })).toBeDisabled();
  await expect(materialNode(page)).toHaveCount(1); await expect(gapNodes(page)).toHaveCount(0);
  await expect(rootNode(page)).toHaveAttribute('data-review-state', 'idle');
  expect(state.runReads).toContain(old.id);
  state.runs = [{ ...latest, status: 'running', error: undefined }, old];
  await page.reload();
  await expect(page.getByRole('button', { name: 'Cluevia loading', exact: true })).toBeDisabled();
  await expect(gapNodes(page)).toHaveCount(0);
  await expect(badge(page).locator('.oc-number')).toHaveText('50');
  expect(state.posts).toEqual([]); expect(state.errors).toEqual([]);
});

test('gap clicks open the saved review, preserve closed editing drafts, and refresh gaps after saving', async ({ page }) => {
  const snapshot = whyFixture(1); snapshot.evidence[0].sourceGrade = null;
  const state = await fixture(page, [savedRun('why-before', snapshot)]);
  await page.goto(`/analysis/${jobId}`); await enableCluevia(page);
  const provenance = canvas(page).locator('[data-graph-decoration="gap"][data-gap-type="PROVENANCE_UNKNOWN"]');
  await canvas(page).getByRole('button', { name: 'Fit graph to view', exact: true }).click(); await provenance.click();
  await expect(checks(page)).toBeVisible();
  const review = checks(page).getByRole('region', { name: '주장 검증', exact: true });
  await expect(review.getByRole('region', { name: '선택한 공백 상세', exact: true })).toContainText('원출처');
  await review.locator('summary').filter({ hasText: '출처·판정·점수 검토' }).click();
  await review.getByLabel('원본 0 출처 등급', { exact: true }).selectOption('B');
  await review.getByLabel('출처 평가 근거', { exact: true }).fill('원본 기록과 작성 주체를 확인했습니다.');
  await closeChecks(page); await expect(checks(page)).toBeHidden(); await openChecks(page);
  await expect(review.getByLabel('원본 0 출처 등급', { exact: true })).toHaveValue('B');
  await expect(review.getByLabel('출처 평가 근거', { exact: true })).toHaveValue('원본 기록과 작성 주체를 확인했습니다.');
  await review.getByRole('button', { name: '검토 저장 및 재평가', exact: true }).click();
  await expect(review).toContainText('설정한 기준 충족'); await closeChecks(page);
  await expect(gapNodes(page)).toHaveCount(0);
  await expect(rootNode(page)).toHaveAttribute('data-review-state', 'resolved');
  await expect(badge(page).locator('.oc-number')).toHaveText('50', { timeout: 8000 });
  expect(state.runs[0].result?.confidence.supportScore).toBe(0.8);
  expect(state.runs[0].result?.confidence.bayesian?.score).toBe(.5);
  expect(state.posts.map(post => post.path)).toEqual([`${endpoint}/evaluate`]);
  expect(state.errors).toEqual([]);
});

test('evidence review exposes the saved quote and opens its original record above the graph', async ({ page }) => {
  const snapshot = whyFixture(1); snapshot.evidence[0].record = 1;
  const state = await fixture(page, [savedRun('why-record', snapshot)]);
  await page.goto(`/analysis/${jobId}`); await enableCluevia(page); await expect(materialNode(page)).toHaveCount(1);
  await canvas(page).getByRole('button', { name: 'Fit graph to view', exact: true }).click(); await materialNode(page).click();
  await expect(checks(page)).toBeVisible();
  await checks(page).locator('summary').filter({ hasText: '출처·판정·점수 검토' }).click();
  await expect(checks(page).locator('blockquote').filter({ hasText: snapshot.bindings[0].quote }).last()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('why-overview-evidence-detail.png'), fullPage: true });
  await checks(page).getByRole('button', { name: /^기록 1 열기/ }).first().click();
  await expect(page.getByRole('dialog', { name: '케이스 상세', exact: true })).toBeVisible();
  await expect(page.getByLabel('분석 기록 상세', { exact: true })).toContainText(graph.summary);
  await expect(checks(page)).toBeHidden();
  await page.getByRole('button', { name: '상세 닫기', exact: true }).click();
  await expect(canvas(page)).toBeVisible();
  expect(state.recordReads).toBeGreaterThan(0);
  expect(state.posts).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('mobile graph pans, drags individual nodes, cancels safely and fits without a footer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const snapshot = whyFixture(2); snapshot.bindings[0].verdict = 'INSUFFICIENT';
  const run = savedRun('why-mobile', snapshot);
  const state = await fixture(page, [run]);
  await page.goto(`/analysis/${jobId}`); await enableCluevia(page);
  await expect(gapNodes(page)).toHaveCount(run.result!.gaps.length);
  await expect(rootNode(page)).toBeInViewport();
  const viewport = canvas(page).locator('.cg-viewport');
  const fit = canvas(page).getByRole('button', { name: 'Fit graph to view', exact: true });
  const blank = await viewport.evaluate(element => {
    const rect = element.getBoundingClientRect();
    for (const across of [.82, .72, .22]) for (const down of [.85, .7, .5]) {
      const point = { x: rect.x + rect.width * across, y: rect.y + rect.height * down };
      const target = document.elementFromPoint(point.x, point.y);
      if (target && element.contains(target) && !target.closest('button, a, [role="button"]')) return point;
    }
    throw new Error('A blank canvas area is needed for the pan gesture.');
  });
  const before = await rootNode(page).boundingBox();
  await page.mouse.move(blank.x, blank.y); await page.mouse.down();
  await page.mouse.move(blank.x + 42, blank.y - 33, { steps: 4 }); await page.mouse.up();
  await expect.poll(async () => Math.abs((await rootNode(page).boundingBox())!.x - before!.x)).toBeGreaterThan(20);
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
  await fit.click();
  const card = (await rootNode(page).boundingBox())!;
  const original = await rootNode(page).evaluate(element => ({ left: element.style.left, top: element.style.top }));
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2); await page.mouse.down();
  await page.mouse.move(card.x + card.width / 2 + 35, card.y + card.height / 2 + 24, { steps: 4 }); await page.mouse.up();
  await expect.poll(async () => rootNode(page).evaluate(element => element.style.left)).not.toBe(original.left);
  await expect(checks(page)).toBeHidden();
  const moved = await rootNode(page).evaluate(element => ({ left: element.style.left, top: element.style.top }));
  await expect.poll(() => state.layoutWrites.length).toBe(1);
  const next = (await rootNode(page).boundingBox())!;
  await page.mouse.move(next.x + next.width / 2, next.y + next.height / 2); await page.mouse.down();
  await page.mouse.move(next.x + next.width / 2 + 20, next.y + next.height / 2 + 15, { steps: 4 });
  await rootNode(page).dispatchEvent('pointercancel', { pointerId: 1 }); await page.mouse.up();
  await expect.poll(async () => rootNode(page).evaluate(element => ({ left: element.style.left, top: element.style.top }))).toEqual(moved);
  await expect(checks(page)).toBeHidden();
  await fit.click(); await expect(rootNode(page)).toBeInViewport();
  for (const node of await canvas(page).locator('[data-graph-node]').all()) await expect(node).toBeInViewport({ ratio: .999 });
  await rootNode(page).focus(); await rootNode(page).press('Enter'); await expect(checks(page)).toBeVisible();
  const bounds = (await checks(page).boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(391);
  expect(bounds.y).toBeGreaterThanOrEqual(0); expect(bounds.y + bounds.height).toBeLessThanOrEqual(845);
  await page.screenshot({ path: test.info().outputPath('why-overview-mobile-checks.png'), fullPage: true });
  await page.keyboard.press('Escape'); await expect(checks(page)).toBeHidden();
  await page.getByRole('button', { name: 'Cluevia off', exact: true }).click();
  await expect(gapNodes(page)).toHaveCount(0);
  await enableCluevia(page);
  await expect.poll(async () => rootNode(page).evaluate(element => ({ left: element.style.left, top: element.style.top }))).toEqual(moved);
  await page.evaluate(() => { Object.keys(localStorage).filter(key => key.startsWith('cluevia.positions.')).forEach(key => localStorage.removeItem(key)); });
  await page.reload(); await enableCluevia(page);
  await expect(gapNodes(page)).toHaveCount(run.result!.gaps.length);
  await expect.poll(async () => rootNode(page).evaluate(element => ({ left: element.style.left, top: element.style.top }))).toEqual(moved);
  expect(state.layoutWrites).toHaveLength(1);
  const sizes = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
  expect(sizes.content).toBeLessThanOrEqual(sizes.width + 1); await noFooter(page);
  await page.screenshot({ path: test.info().outputPath('why-overview-mobile.png'), fullPage: true });
  expect(state.posts).toEqual([]);
  expect(state.errors).toEqual([]);
});
