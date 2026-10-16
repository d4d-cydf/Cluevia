import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { GraphDocument } from '../src/types/graph';
import type { ReportList, ReportRun } from '../src/types/report';

const jobId = 'report-case';
const at = '2026-10-11T01:00:00Z';
const graph: GraphDocument = { schemaVersion: '1.0', id: 'report-graph', title: '선박 관측 기록', question: '두 선박이 환적했는가?', summary: '접근 기록만으로 환적 여부를 확정할 수 없습니다.', origin: 'codex', createdAt: at,
  groups: [{ id: 'vessels', label: 'Vessels', color: '#956f49' }],
  nodes: [{ id: 'a', type: 'Vessel', label: '선박 A', group: 'vessels', description: '', sourceIds: ['source'], properties: {} }, { id: 'b', type: 'Vessel', label: '선박 B', group: 'vessels', description: '', sourceIds: ['source'], properties: {} }],
  edges: [{ id: 'near', source: 'a', target: 'b', label: '근접 관측', description: '같은 해역에서 관측됨', status: 'reported', sourceIds: ['source'] }],
  events: [], findings: [], limitations: ['화물 이동은 확인되지 않음'], sources: [{ id: 'source', title: '관측 원자료', excerpt: '선박 A와 B가 근접했다.' }] };

function completed(id = 'report-1', inputHash = 'current'): ReportRun {
  return { id, jobId, status: 'completed', stage: 'completed', createdAt: at, updatedAt: at, model: 'fixture-model', effort: 'low', inputHash,
    snapshot: { question: graph.question, caseTitle: graph.title, analysisUpdatedAt: at, whyRunId: 'why-saved', graph,
      confidence: { score: 77.3, baselineScore: 83.3, grade: 'B', accepted: false, status: 'INCOMPLETE', note: '자료와 모형에 따른 지지 점수이며 참일 확률이 아닙니다.' },
      gaps: [{ id: 'missing-transfer', type: 'EVIDENCE_MISSING', title: '화물 이동 자료 누락', explanation: '접근 기록에는 실제 화물 이동이 없습니다.', evaluationState: 'COMPLETE', blockingScope: 'ROOT', requirements: ['화물이 이동했다는 직접 관측'], recommendations: ['하역 영상이나 선적 기록 확인'] }],
      citations: [{ id: 'cite-1', evidenceId: 'e1', sourceName: '관측 원자료', url: 'https://example.org/source', quote: '선박 A와 B가 근접했다. <script>window.reportInjected=true</script>', sourceGrade: 'B', record: 1 }],
      coverage: { sources: 1, citations: 1, nodes: 2, edges: 1, notes: ['제공된 관측 범위에 한정'] } },
    content: { title: '근접은 확인되었지만, 환적은 미확인', subtitle: '선박 A와 B의 관측 기록 검토', conclusion: [{ text: '두 선박의 근접은 확인되지만 환적을 입증하는 자료는 부족합니다.', citationIds: ['cite-1'] }], sections: [{ heading: '기록이 보여주는 범위', paragraphs: [{ text: '근접 관측과 화물 이동은 구분하여 판단해야 합니다.', citationIds: ['cite-1'] }] }], gapAnalysis: [{ gapId: 'missing-transfer', analysis: '선박의 접근만으로 화물 이동을 추정할 수 없습니다.', recommendation: '같은 시점의 작업 영상과 화물 기록을 확보합니다.' }], limitations: ['해당 해역의 모든 움직임을 관측한 것은 아닙니다.'], nextSteps: ['작업 시각과 선적 기록을 대조합니다.'] } };
}

async function fixture(page: Page, reports: ReportRun[] = [], canGenerate = true) {
  const state = { list: { reports, canGenerate, blockingReason: canGenerate ? null : '자료 분석과 Cluevia 진단이 완료되면 보고서를 만들 수 있습니다.', currentInputHash: 'current' } as ReportList, reads: 0, posts: [] as { path: string; body: unknown }[], errors: [] as string[] };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/api/**', route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (path === `/api/jobs/${jobId}/reports` && request.method() === 'GET') { state.reads++; return route.fulfill({ json: state.list }); }
    if (request.method() !== 'GET') {
      state.posts.push({ path, body: request.postDataJSON() });
      if (path === `/api/jobs/${jobId}/reports`) {
        const report: ReportRun = { ...completed(`report-new-${state.posts.length}`, state.list.currentInputHash!), status: 'running', stage: 'preparing', content: undefined };
        state.list.reports = [report, ...state.list.reports]; return route.fulfill({ status: 202, json: { report } });
      }
      if (path === `/api/jobs/${jobId}/reports/cancel`) { const active = state.list.reports.find(report => report.status === 'running')!; active.status = 'cancelled'; return route.fulfill({ json: { report: active } }); }
      return route.fulfill({ status: 500, json: { error: `Unexpected mutation ${path}` } });
    }
    const job = { id: jobId, question: graph.question, status: 'completed', stage: 'saving', message: '완료', createdAt: at, updatedAt: at, graphIds: [graph.id], graphId: graph.id, completedChunks: 1, totalChunks: 1 };
    if (path === '/api/system/status') return route.fulfill({ json: { authenticated: true, authRequired: false, provider: { available: true, authenticated: true, message: 'Ready', kind: 'claude' }, ontology: { entities: 2, relationships: 1, documents: 1, graphs: 1 }, activeJobs: [] } });
    if (path === '/api/jobs') return route.fulfill({ json: { jobs: [job] } });
    if (path === '/api/graphs') return route.fulfill({ json: { graphs: [graph] } });
    if (path === `/api/jobs/${jobId}`) return route.fulfill({ json: { job } });
    if (path === `/api/jobs/${jobId}/case`) return route.fulfill({ json: { schemaVersion: 'case-1.0', jobId, status: job.status, updatedAt: at, graph, records: [], conflicts: [], provenance: {} } });
    if (path.endsWith('/chat')) return route.fulfill({ json: { turns: [], model: 'fixture', effort: 'low' } });
    if (path.endsWith('/decisions')) return route.fulfill({ json: { decisions: [] } });
    if (path.endsWith('/why-not')) return route.fulfill({ json: { runs: [] } });
    if (path.endsWith('/why-not/layout')) return route.fulfill({ json: { jobId, revision: 0, positions: {}, updatedAt: null } });
    if (path.endsWith('/confidence')) return route.fulfill({ json: { state: 'unassessed', confidence: null, reason: '', unknownReasons: [], inputs: [], assumptions: [], coverageNote: '', accepted: false } });
    return route.fulfill({ status: 404, json: { error: `Missing fixture ${path}` } });
  });
  return state;
}
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Case report', exact: true });
async function open(page: Page) { await page.getByRole('button', { name: 'Report', exact: true }).click(); await expect(dialog(page)).toBeVisible(); }

test('Report opens read-only, explains unavailable generation and restores focus on Escape', async ({ page }) => {
  const state = await fixture(page, [], false);
  await page.goto(`/analysis/${jobId}`); expect(state.reads).toBe(0);
  await open(page);
  await expect(dialog(page).getByRole('button', { name: 'Generate report' })).toBeDisabled();
  await expect(dialog(page)).toContainText('자료 분석과 Cluevia 진단이 완료되면');
  await expect(dialog(page).getByRole('button', { name: '보고서 닫기' })).toBeFocused();
  for (let index = 0; index < 5; index++) { await page.keyboard.press('Tab'); expect(await dialog(page).evaluate(element => element.contains(document.activeElement))).toBe(true); }
  await page.keyboard.press('Escape'); await expect(dialog(page)).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Report', exact: true })).toBeFocused();
  expect(state.reads).toBeGreaterThan(0); expect(state.posts).toEqual([]); expect(state.errors).toEqual([]);
  await expect(page.getByRole('button', { name: 'EXPORT', exact: true })).toBeVisible();
});

test('explicit generation follows real stages, continues when closed and opens saved citations safely', async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/analysis/${jobId}`); await open(page);
  await dialog(page).getByRole('button', { name: 'Generate report' }).click();
  await expect(dialog(page).getByRole('status', { name: '보고서 생성 상태' })).toContainText('자료와 분석 결과를 정리');
  await expect(dialog(page).locator('[data-report-draft]')).toBeVisible();
  expect(state.posts).toEqual([{ path: `/api/jobs/${jobId}/reports`, body: {} }]);
  state.list.reports[0].stage = 'writing';
  await expect(dialog(page).getByRole('status', { name: '보고서 생성 상태' })).toContainText('보고서를 작성', { timeout: 7000 });
  await expect(dialog(page).locator('.report-paper-mark i').first()).toHaveCSS('animation-name', 'none');
  await expect(dialog(page).locator('.report-draft-paragraph i').first()).toHaveCSS('animation-name', 'none');
  await page.screenshot({ path: test.info().outputPath('case-report-writing.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await expect(dialog(page)).not.toBeVisible();
  const saved = completed(state.list.reports[0].id); state.list.reports = [saved];
  await open(page);
  await expect(dialog(page).getByRole('heading', { name: saved.content!.title })).toBeVisible();
  await expect(dialog(page).getByRole('status', { name: '보고서 생성 상태' })).toHaveCount(0);
  await expect(dialog(page).locator('[data-report-draft]')).toHaveCount(0);
  await dialog(page).getByRole('button', { name: '출처 1 보기' }).first().click();
  await expect(dialog(page).locator('[data-report-source="1"]')).toBeFocused();
  await expect(dialog(page).locator('[data-report-source="1"]')).toContainText('<script>window.reportInjected=true</script>');
  expect(await page.evaluate(() => 'reportInjected' in window)).toBe(false);
  await expect(dialog(page).getByRole('link', { name: 'Open source' })).toHaveAttribute('href', 'https://example.org/source');
  await expect(dialog(page)).toContainText('접근 기록에는 실제 화물 이동이 없습니다.');
  await expect(dialog(page).locator('.report-graph svg')).toBeVisible();
  expect(state.posts).toHaveLength(1); expect(state.errors).toEqual([]);
});

test('stale history remains immutable while a new report is cancelled or fails and can retry', async ({ page }) => {
  const previous = completed('report-old', 'old');
  const state = await fixture(page, [previous]);
  await page.goto(`/analysis/${jobId}`); await open(page);
  await expect(dialog(page)).toContainText('이 보고서 작성 후 자료 또는 분석이 변경되었습니다.');
  await dialog(page).getByRole('button', { name: 'Generate again' }).click();
  await expect(dialog(page).getByRole('heading', { name: previous.content!.title })).toBeVisible();
  await expect(dialog(page).locator('[data-report-draft]')).toHaveCount(0);
  expect(state.posts[0].body).toEqual({ force: true });
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog(page)).toContainText('이전 보고서는 그대로 보관되어 있습니다.');
  await expect(dialog(page).locator('[data-report-id]')).toHaveAttribute('data-report-id', previous.id);
  await dialog(page).getByRole('button', { name: 'Generate again' }).click();
  const failed = state.list.reports[0]; failed.status = 'failed'; failed.error = '인용 검증 실패';
  await expect(dialog(page)).toContainText('인용 검증 실패', { timeout: 7000 });
  await expect(dialog(page).getByRole('button', { name: 'Generate again' })).toBeEnabled();
  expect(state.list.reports.find(report => report.id === previous.id)).toEqual(previous);
  expect(state.errors).toEqual([]);
});

test('saved versions and HTML or Markdown exports contain the selected report with safe citations', async ({ page }) => {
  const older = completed('report-old', 'old'); older.content!.title = '첫 번째 저장 보고서';
  const state = await fixture(page, [completed(), older]);
  await page.goto(`/analysis/${jobId}`); await open(page);
  await dialog(page).getByLabel('Report version').selectOption(older.id);
  await expect(dialog(page).getByRole('heading', { name: older.content!.title })).toBeVisible();
  for (const label of ['HTML', 'Markdown']) {
    const download = page.waitForEvent('download'); await dialog(page).getByRole('button', { name: label, exact: true }).click();
    const file = await download; const contents = await readFile((await file.path())!, 'utf8');
    expect(contents).toContain(older.content!.title); expect(contents).toContain('https://example.org/source');
    if (label === 'HTML') { expect(contents).toContain('<svg'); expect(contents).not.toContain('<script>window.reportInjected'); }
    expect(file.suggestedFilename()).toMatch(label === 'HTML' ? /\.html$/ : /\.md$/);
  }
  await expect(dialog(page).getByRole('button', { name: 'Print / PDF' })).toBeVisible();
  expect(state.posts).toEqual([]); expect(state.errors).toEqual([]);
});

test('mobile report is readable in the current theme without horizontal page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page, [completed()]);
  await page.goto(`/analysis/${jobId}`); await open(page);
  await expect(dialog(page).getByRole('heading', { name: completed().content!.title })).toBeVisible();
  const bounds = (await dialog(page).boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(391);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  expect(await dialog(page).locator('.report-scroll').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('case-report-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: test.info().outputPath('case-report-desktop.png'), fullPage: true });
  expect(state.errors).toEqual([]);
});
