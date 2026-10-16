import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { GraphDocument, GraphEdge } from '../src/types/graph';
import type { RelationClaim } from '../src/types/claims';

const createdAt = '2026-10-11T00:00:00Z';
const claim = (stance: RelationClaim['stance']): RelationClaim => ({ stance, attributedTo: null, validFrom: null, validTo: null, publishedAt: null, derivedFrom: null });
const edge = (id: string, source: string, target: string, label: string, description: string, extra: Partial<GraphEdge> = {}): GraphEdge => ({ id, source, target, label, description, status: 'reported', sourceIds: ['log'], ...extra });
const baseGraph: GraphDocument = {
  schemaVersion: '1.0', id: 'overview-graph', title: '선박 환적 조사', question: '환적한 배 찾아줘', summary: '환적 자료와 주변 선박 관계를 함께 분석했습니다.', origin: 'codex', createdAt, limitations: [],
  groups: [{ id: 'vessels', label: 'Vessels', color: '#8d6947' }, { id: 'organizations', label: 'Organizations', color: '#637657' }],
  sources: [{ id: 'log', title: '선박 작업 기록', excerpt: '새벽호는 해오름호로 화물을 환적했다. 나머지 선박에 대해서는 근접 운항 또는 불확실한 진술이 기록되어 있다.' }],
  nodes: [
    ...['새벽호', '해오름호', '조우선 A', '조우선 B', '부인선 A', '부인선 B', '추정선 A', '추정선 B', '불확실선 A', '불확실선 B', '철회선 A', '철회선 B'].map(id => ({ id, label: id, type: 'vessel', group: 'vessels', description: `자료에 등장한 ${id}`, properties: {}, sourceIds: ['log'] })),
    { id: 'owner', label: '해운 회사', type: 'organization', group: 'organizations', description: '새벽호 소유 회사', properties: {}, sourceIds: ['log'] },
  ],
  edges: [
    edge('transfer', '새벽호', '해오름호', '환적', '새벽호는 해오름호로 화물을 환적했다.', { claim: claim('asserted') }),
    edge('owner', '새벽호', 'owner', '소유', '해운 회사가 새벽호를 소유한다.'),
    edge('encounter', '조우선 A', '조우선 B', 'AIS 조우', '두 선박이 근접 운항했다.'),
    edge('denied', '부인선 A', '부인선 B', '환적', '환적 주장을 부인했다.', { claim: claim('denied') }),
    edge('inferred', '추정선 A', '추정선 B', '환적 가능성', '환적이 있었을 가능성을 추론했다.', { status: 'inferred' }),
    edge('uncertain', '불확실선 A', '불확실선 B', '환적', '환적 여부는 불확실하다.', { claim: claim('uncertain') }),
    edge('retracted', '철회선 A', '철회선 B', '환적', '환적 주장을 철회했다.', { claim: claim('retracted') }),
  ],
  events: [], findings: [{ text: '여러 종류의 선박 관계를 분석한 상세 요약입니다.', sourceIds: ['log'], nodeIds: ['새벽호', '해오름호'], edgeIds: ['transfer'] }],
};
const jobId = 'overview-job';
const overviewRegion = (page: Page) => page.getByRole('region', { name: '분석 결과 요약', exact: true });
const reportRegion = (page: Page) => page.getByRole('article', { name: '질문에 대한 짧은 보고서', exact: true });
const quantityFinding = '새벽호 선내 조사에서 상어 7,639마리와 지느러미 537포대가 확인되었습니다.';
function quantityGraph(): GraphDocument {
  return { ...structuredClone(baseGraph), question: '새벽호에서 발견된 화물 수량은?', summary: '선내 조사 기록을 분석했습니다.', nodes: [], edges: [],
    findings: [{ text: quantityFinding, sourceIds: ['log'], nodeIds: ['새벽호'], edgeIds: [] }],
    sources: [{ id: 'log', title: '선내 조사 기록', excerpt: quantityFinding }], limitations: ['자료에는 환적 상대 선박이 기록되어 있지 않습니다.'] };
}

async function fixture(page: Page, graph: GraphDocument = structuredClone(baseGraph), pending = false, archivedSummary?: string) {
  const state = { graph, whyReads: 0, recordReads: 0, mutations: [] as string[], errors: [] as string[] };
  page.on('pageerror', error => state.errors.push(error.message));
  const job = () => ({ id: jobId, question: state.graph.question, status: pending ? 'running' : 'completed', stage: pending ? 'extracting' : 'saving', message: pending ? '자료를 분석하고 있습니다.' : '분석 완료', createdAt, updatedAt: createdAt, graphIds: [state.graph.id], graphId: state.graph.id, completedChunks: 1, totalChunks: pending ? 2 : 1 });
  const record = () => ({ number: 1, title: archivedSummary ? '선내 조사 기록' : state.graph.title, status: archivedSummary ? 'empty' : 'saved', graphId: archivedSummary ? undefined : state.graph.id, nodeCount: state.graph.nodes.length, edgeCount: state.graph.edges.length, archived: true });
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') {
      state.mutations.push(`${route.request().method()} ${path}`);
      return route.fulfill({ status: 500, json: { error: 'Overview browsing must not start model work.' } });
    }
    if (path === '/api/system/status') return route.fulfill({ json: { authenticated: true, authRequired: false, provider: { kind: 'codex', available: true, authenticated: true, message: 'Ready' }, activeJobs: [], ontology: { entities: state.graph.nodes.length, relationships: state.graph.edges.length, documents: state.graph.sources.length, graphs: 1 } } });
    if (path === '/api/jobs') return route.fulfill({ json: { jobs: [job()] } });
    if (path === '/api/graphs') return route.fulfill({ json: { graphs: [state.graph] } });
    if (path === `/api/jobs/${jobId}`) return route.fulfill({ json: { job: job() } });
    if (path === `/api/jobs/${jobId}/chat`) return route.fulfill({ json: { turns: [], model: 'fixture-model', effort: 'medium' } });
    if (path === `/api/jobs/${jobId}/why-not`) { state.whyReads++; return route.fulfill({ json: { runs: [] } }); }
    if (path === `/api/jobs/${jobId}/case`) return route.fulfill({ json: {
      schemaVersion: 'case-1.0', jobId, status: pending ? 'running' : 'completed', updatedAt: createdAt,
      graph: { ...state.graph, id: `case-${jobId}` }, records: [record()], conflicts: [],
      provenance: Object.fromEntries([...state.graph.sources, ...state.graph.nodes, ...state.graph.edges].map(item => [item.id, [{ record: 1, localId: item.id }]])),
    } });
    if (path === `/api/jobs/${jobId}/records/1`) {
      state.recordReads++;
      return route.fulfill({ json: { record: record(), graph: archivedSummary ? undefined : state.graph, summary: archivedSummary ?? state.graph.summary, limitations: [], documents: archivedSummary ? [{ id: 'archive-log', name: '선내 조사 기록', text: archivedSummary, totalChars: archivedSummary.length, offset: 0 }] : state.graph.sources.map(source => ({ id: source.id, name: source.title, text: source.excerpt, totalChars: source.excerpt?.length ?? 0, offset: 0 })), claims: [], relationClaims: [] } });
    }
    return route.fulfill({ status: 404, json: { error: `Missing overview fixture: ${path}` } });
  });
  return state;
}

test('overview shows recorded associations immediately without waiting for proof or starting model work', async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/analysis/${jobId}`);
  const overview = overviewRegion(page);
  await expect(overview).toBeVisible();
  const tabs = page.getByRole('navigation', { name: 'Graph views', exact: true });
  await expect(tabs.getByRole('button')).toHaveText(['OVERVIEW', 'BOARD', 'LANES']);
  await expect(tabs.getByRole('button', { name: 'Overview', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(overview.locator('[data-graph-node]')).toHaveCount(baseGraph.nodes.length);
  await expect(overview.getByRole('button', { name: /^Relation:/ })).toHaveCount(baseGraph.edges.length);
  await expect(overview.getByRole('button', { name: 'organization: 해운 회사', exact: true })).toBeVisible();
  await expect(overview.getByRole('button', { name: 'Relation: AIS 조우, 조우선 A to 조우선 B', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Build evidence', exact: true })).toHaveCount(0);
  await expect(page.locator('.cg-footer, .aw-canvas-footer, .gw-bottom')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('overview-associations-desktop.png'), fullPage: true });
  expect(state.whyReads).toBeGreaterThan(0); expect(state.recordReads).toBe(0); expect(state.mutations).toEqual([]); expect(state.errors).toEqual([]);
});

test('uncertain and denied transfers remain visible with their qualification and original source details', async ({ page }) => {
  const graph = structuredClone(baseGraph); graph.edges = graph.edges.filter(item => item.id !== 'transfer');
  const state = await fixture(page, graph);
  await page.goto(`/analysis/${jobId}`);
  const overview = overviewRegion(page);
  await expect(overview.getByRole('button', { name: /^Relation:/ })).toHaveCount(graph.edges.length);
  await expect(overview.locator('.cg-edge--denied')).toContainText('부인');
  await expect(overview.locator('.cg-edge--uncertain')).toContainText('불확실');
  await expect(overview.locator('.cg-edge--retracted')).toContainText('철회');
  await expect(overview.getByRole('button', { name: /^Relation: 추정 · 환적 가능성/ })).toBeVisible();
  await expect(reportRegion(page)).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('overview-qualified-associations.png'), fullPage: true });
  await overview.getByRole('button', { name: 'Relation: 환적, 부인선 A to 부인선 B', exact: true }).click();
  const inspector = page.getByRole('region', { name: 'Selected graph item', exact: true });
  await expect(inspector).toContainText('환적 주장을 부인했다.');
  await inspector.getByRole('button', { name: '출처 log 보기', exact: true }).click();
  await expect(page.getByLabel('분석 기록 상세', { exact: true })).toContainText(graph.sources[0].excerpt!);
  expect(state.mutations).toEqual([]); expect(state.errors).toEqual([]);
});

test('isolated entities connect only to their real source documents', async ({ page }) => {
  const graph = structuredClone(baseGraph); graph.edges = []; graph.nodes = graph.nodes.slice(0, 2);
  const state = await fixture(page, graph);
  await page.goto(`/analysis/${jobId}`);
  const overview = overviewRegion(page);
  await expect(overview.locator('[data-graph-node]')).toHaveCount(3);
  await expect(overview.getByRole('button', { name: /^Relation: 자료에 등장,/ })).toHaveCount(2);
  await expect(overview).toContainText('아직 기록된 관계는 없습니다.');
  await expect(overview.getByRole('button', { name: /^Relation: 환적,/ })).toHaveCount(0);
  await overview.getByRole('button', { name: 'Source: 선박 작업 기록', exact: true }).click();
  await expect(page.getByLabel('분석 기록 상세', { exact: true })).toContainText(graph.sources[0].excerpt!);
  expect(state.mutations).toEqual([]); expect(state.errors).toEqual([]);
});

test('a case without evidence gives a concise report that states the limitation', async ({ page }) => {
  const graph: GraphDocument = { ...baseGraph, nodes: [], edges: [], findings: [], sources: [], summary: '아직 연결된 근거가 없습니다.' };
  const state = await fixture(page, graph);
  await page.goto(`/analysis/${jobId}`);
  const overview = overviewRegion(page);
  const report = reportRegion(page);
  await expect(report).toBeVisible();
  await expect(report).toContainText(/자료|근거/);
  await expect(report).toContainText(/확인|판단|답할/);
  expect((await report.innerText()).length).toBeLessThan(450);
  await expect(overview.locator('.co-answer-map, .co-goal, .co-issue, .co-evidence, .co-gaps')).toHaveCount(0);
  await expect(overview.getByRole('button')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('overview-no-evidence-report.png'), fullPage: true });
  expect(state.whyReads).toBeGreaterThan(0); expect(state.mutations).toEqual([]); expect(state.errors).toEqual([]);
});

test('a sourced textual answer without relationships becomes a short report with an original-source link', async ({ page }) => {
  const graph = quantityGraph();
  const state = await fixture(page, graph);
  await page.goto(`/analysis/${jobId}`);
  const report = reportRegion(page);
  await expect(report).toBeVisible();
  await expect(report).toContainText(quantityFinding);
  await expect(report).not.toContainText('질문에 답할 수 있는 관계를 찾지 못했습니다.');
  await expect(overviewRegion(page).locator('.co-answer-map')).toHaveCount(0);
  expect((await report.innerText()).length).toBeLessThan(650);
  expect(state.recordReads).toBe(0);
  await page.screenshot({ path: test.info().outputPath('overview-report-desktop.png'), fullPage: true });
  await report.getByRole('button', { name: '출처 보기: 선내 조사 기록', exact: true }).first().click();
  await expect(page.getByLabel('분석 기록 상세', { exact: true })).toContainText(quantityFinding);
  expect(state.whyReads).toBeGreaterThan(0); expect(state.mutations).toEqual([]); expect(state.errors).toEqual([]);
});

test('an archived textual result without a saved graph remains available as a cited report', async ({ page }) => {
  const graph: GraphDocument = { ...quantityGraph(), nodes: [], edges: [], findings: [], sources: [], limitations: [], summary: '전체 자료를 통합한 분석입니다.' };
  const state = await fixture(page, graph, false, quantityFinding);
  await page.goto(`/analysis/${jobId}`);
  const report = reportRegion(page);
  await expect(report).toContainText(quantityFinding);
  await expect(report).not.toContainText(graph.summary);
  await report.getByRole('button', { name: '기록 1 열기', exact: true }).first().click();
  await expect(page.getByLabel('분석 기록 상세', { exact: true })).toContainText(quantityFinding);
  expect(state.recordReads).toBeGreaterThan(0);
  expect(state.whyReads).toBeGreaterThan(0); expect(state.mutations).toEqual([]); expect(state.errors).toEqual([]);
});

test('an unfinished analysis keeps its progress message instead of a final report', async ({ page }) => {
  const state = await fixture(page, quantityGraph(), true);
  await page.goto(`/analysis/${jobId}`);
  const overview = overviewRegion(page);
  await expect(overview.locator('.co-empty')).toContainText('질문에 맞는 결과를 찾고 있습니다.');
  await expect(reportRegion(page)).toHaveCount(0);
  expect(state.recordReads).toBe(0);
  expect(state.whyReads).toBe(0); expect(state.mutations).toEqual([]); expect(state.errors).toEqual([]);
});

test('association relationships and background context open their original details in both graph views', async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/analysis/${jobId}`);
  const overview = overviewRegion(page);
  await overview.getByRole('button', { name: 'Relation: 환적, 새벽호 to 해오름호', exact: true }).click();
  const inspector = page.getByRole('region', { name: 'Selected graph item', exact: true });
  await expect(inspector).toContainText('새벽호는 해오름호로 화물을 환적했다.');
  await page.screenshot({ path: test.info().outputPath('overview-details.png'), fullPage: true });
  await inspector.getByRole('button', { name: '출처 log 보기', exact: true }).click();
  await expect(page.getByLabel('분석 기록 상세', { exact: true })).toContainText(baseGraph.sources[0].excerpt!);
  const tabs = page.getByRole('navigation', { name: 'Graph views', exact: true });
  await tabs.getByRole('button', { name: 'Board', exact: true }).click();
  const board = page.getByRole('region', { name: `${baseGraph.title}: board view`, exact: true });
  await expect(board.getByRole('button', { name: /^Relation:/ })).toHaveCount(baseGraph.edges.length);
  await expect(board.getByRole('button', { name: 'organization: 해운 회사', exact: true })).toBeVisible();
  await tabs.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(overview.getByRole('button', { name: /^Relation:/ })).toHaveCount(baseGraph.edges.length);
  await expect(overview).toContainText('해운 회사');
  expect(state.mutations).toEqual([]); expect(state.errors).toEqual([]);
});

test('search finds background associations and clearing it restores all recorded relationships', async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/analysis/${jobId}`);
  const overview = overviewRegion(page);
  const search = page.getByRole('searchbox', { name: 'Search graph', exact: true });
  await expect(overview.getByRole('button', { name: /^Relation:/ })).toHaveCount(baseGraph.edges.length);
  await search.fill('해운 회사');
  await expect(overview.getByRole('button', { name: /^Relation:/ })).toHaveCount(1);
  await expect(overview.getByRole('button', { name: 'organization: 해운 회사', exact: true })).toBeVisible();
  await search.fill('존재하지 않는 검색어');
  await expect(overview.locator('.co-empty')).toContainText(/검색/);
  await expect(reportRegion(page)).toHaveCount(0);
  await search.clear();
  await expect(overview.getByRole('button', { name: /^Relation:/ })).toHaveCount(baseGraph.edges.length);
  expect(state.mutations).toEqual([]); expect(state.errors).toEqual([]);
});

test('a short report stays readable on mobile and a search miss is not a new conclusion', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page, quantityGraph());
  await page.goto(`/analysis/${jobId}`);
  const overview = overviewRegion(page);
  const report = reportRegion(page);
  await expect(report).toContainText(quantityFinding);
  const widths = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth }));
  expect(widths.page).toBeLessThanOrEqual(widths.viewport + 1);
  const content = await overview.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }));
  expect(content.content).toBeLessThanOrEqual(content.width + 1);
  await page.screenshot({ path: test.info().outputPath('overview-report-mobile.png'), fullPage: true });
  const search = page.getByRole('searchbox', { name: 'Search graph', exact: true });
  await search.fill('자료에 없는 검색어');
  await expect(report).toHaveCount(0);
  await expect(overview.locator('.co-empty')).toContainText(/검색/);
  await search.clear();
  await expect(report).toContainText(quantityFinding);
  expect(state.whyReads).toBeGreaterThan(0); expect(state.mutations).toEqual([]); expect(state.errors).toEqual([]);
});

test('long case questions keep report text and controls inside narrow mobile viewports', async ({ page }) => {
  const question = '2026년 10월 새벽호의 선내 조사 자료를 근거로 확인된 화물의 종류와 수량을 짧게 정리하고, 직접 확인할 수 없는 사항은 구분해서 설명해줘';
  const graph = { ...quantityGraph(), question, title: question };
  graph.sources[0].title = `선내 조사 기록 · ${'vessel-cargo-inspection-'.repeat(8)}2026.txt`;
  const state = await fixture(page, graph);
  await page.goto(`/analysis/${jobId}`);
  await expect(reportRegion(page)).toContainText(quantityFinding);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.reload();
    const report = reportRegion(page);
    await expect(report).toContainText(quantityFinding);
    await page.evaluate(() => document.fonts.ready);
    const geometry = await page.evaluate(() => {
      const selectors = ['.gw-main', '.gw-toolbar', '.gw-search', '.claim-overview', '.co-report', '.co-report-heading', '.co-report-heading > p', '.co-report-conclusion', '.co-report-evidence p', '.co-report-limitation', '.co-report-sources', '.co-report-sources button'];
      return selectors.flatMap(selector => [...document.querySelectorAll<HTMLElement>(selector)].map(element => {
        const { left, right } = element.getBoundingClientRect();
        return { selector, left, right, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
      }));
    });
    for (const element of geometry) {
      expect(element.left, `${width}px ${element.selector} left`).toBeGreaterThanOrEqual(-1);
      expect(element.right, `${width}px ${element.selector} right`).toBeLessThanOrEqual(width + 1);
      expect(element.scrollWidth, `${width}px ${element.selector} internal width`).toBeLessThanOrEqual(element.clientWidth + 1);
    }
    await expect(page.getByRole('searchbox', { name: 'Search graph', exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`overview-long-question-${width}.png`), fullPage: true });
  }
  expect(state.whyReads).toBeGreaterThan(0); expect(state.recordReads).toBe(0); expect(state.mutations).toEqual([]); expect(state.errors).toEqual([]);
});

test('answer graph remains readable on mobile without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page);
  await page.goto(`/analysis/${jobId}`);
  const overview = overviewRegion(page);
  const source = overview.getByRole('button', { name: 'vessel: 새벽호', exact: true });
  const target = overview.getByRole('button', { name: 'vessel: 해오름호', exact: true });
  await expect(source).toBeVisible(); await expect(target).toBeVisible();
  const widths = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth }));
  expect(widths.page).toBeLessThanOrEqual(widths.viewport + 1);
  const content = await overview.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }));
  expect(content.content).toBeLessThanOrEqual(content.width + 1);
  await page.screenshot({ path: test.info().outputPath('overview-mobile.png'), fullPage: true });
  await source.click();
  await expect(page.getByRole('region', { name: 'Selected graph item', exact: true })).toContainText('새벽호');
  expect(state.whyReads).toBeGreaterThan(0); expect(state.mutations).toEqual([]); expect(state.errors).toEqual([]);
});
