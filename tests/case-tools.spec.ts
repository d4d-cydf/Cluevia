import { expect, test } from '@playwright/test';
import type { GraphDocument } from '../src/types/graph';
import type { GenerationJob } from '../src/services/api-client';
import type { CaseChatTurn } from '../src/types/case-chat';
import { mockCase } from './case-fixture';

const graph: GraphDocument = {
  schemaVersion: '1.0', id: 'case-tools-graph', title: '고객 기록', question: '고객과 주문', summary: '고객 A의 주문 B.', origin: 'codex', createdAt: '2026-10-10T00:00:00Z', limitations: [],
  groups: [{ id: 'items', label: 'Items', color: '#336677' }], sources: [{ id: 'source', title: 'orders.csv', excerpt: '고객 A가 주문 B를 접수했다. ' + 'UNBROKEN_SOURCE_TEXT'.repeat(70) }],
  nodes: [{ id: 'A', label: '고객 A', type: 'Customer', group: 'items', description: '고객 A', properties: {}, sourceIds: ['source'] }, { id: 'B', label: '주문 B', type: 'Order', group: 'items', description: '주문 B', properties: {}, sourceIds: ['source'] }],
  edges: [{ id: 'AB', source: 'A', target: 'B', label: '주문함', description: '고객 A가 주문 B를 접수했다.', status: 'reported', sourceIds: ['source'] }], events: [], findings: [],
};
const job: GenerationJob = { id: 'case-tools-job', question: graph.question, status: 'completed', stage: 'saving', message: '완료', createdAt: graph.createdAt, updatedAt: graph.createdAt, graphIds: [graph.id], graphId: graph.id, totalChunks: 1, completedChunks: 1 };
const errors = new Map<object, string[]>();
test.beforeEach(async ({ page }) => {
  errors.set(page, []); page.on('pageerror', error => errors.get(page)!.push(error.message));
  await page.route('**/api/system/status', route => route.fulfill({ json: { authenticated: true, authRequired: false, provider: { available: true, authenticated: true, message: 'Ready', kind: 'codex' }, ontology: { entities: 2, relationships: 1, documents: 1, graphs: 1 }, activeJobs: [] } }));
  await page.route('**/api/jobs', route => route.fulfill({ json: { jobs: [job] } }));
  await page.route('**/api/graphs', route => route.fulfill({ json: { graphs: [{ ...graph, nodeCount: 2, edgeCount: 1 }] } }));
  await page.route(`**/api/jobs/${job.id}`, route => route.fulfill({ json: { job } }));
  await mockCase(page, job.id, () => [graph]);
});
test.afterEach(({ page }) => expect(errors.get(page)).toEqual([]));

test('case sources start closed, long excerpts wrap, and the case panel collapses independently', async ({ page }) => {
  await page.goto(`/analysis/${job.id}`);
  await expect(page.getByLabel('케이스 결과 대화', { exact: true })).toBeVisible();
  const sources = page.locator('.gw-sources');
  await expect(sources).not.toHaveAttribute('open', '');
  await sources.locator('summary').click();
  const dimensions = await sources.locator('article').evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.width + 1);
  await page.getByRole('button', { name: '케이스 패널 접기', exact: true }).click();
  await expect(page.getByLabel('Case evidence', { exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Customer: 고객 A', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '사이드바 열기', exact: true }).click();
  await expect(page.getByLabel('케이스 사이드바', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Case evidence', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: '사이드바 닫기', exact: true }).click();
  await page.reload();
  await expect(page.getByLabel('Case evidence', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: '케이스 패널 열기', exact: true }).click();
  await expect(page.getByLabel('케이스 결과 대화', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await sources.locator('summary').click();
  const widths = await page.evaluate(() => [document.documentElement.clientWidth, document.documentElement.scrollWidth]);
  expect(widths[1]).toBeLessThanOrEqual(widths[0] + 1);
});

test('dragging a graph node updates connected arrow geometry and remembers the position', async ({ page }) => {
  await page.goto(`/analysis/${job.id}`);
  const node = page.getByRole('button', { name: 'Customer: 고객 A', exact: true });
  await expect(node).toBeVisible();
  const before = await node.evaluate(element => parseFloat(element.style.left));
  const path = page.locator('.cg-edge-line').first(); const previousPath = await path.getAttribute('d');
  const bounds = (await node.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2 + 90, bounds.y + bounds.height / 2 + 50, { steps: 8 }); await page.mouse.up();
  await expect.poll(() => node.evaluate(element => parseFloat(element.style.left))).toBeGreaterThan(before + 50);
  await expect(path).not.toHaveAttribute('d', previousPath!);
  const after = await node.evaluate(element => element.style.left);
  await page.reload(); await expect(node).toBeVisible();
  await expect.poll(() => node.evaluate(element => element.style.left)).toBe(after);
});

test('completed case chat submits selected graph context and opens cited records without changing the graph', async ({ page }) => {
  let turns: CaseChatTurn[] = []; let sent: unknown;
  await page.route(`**/api/jobs/${job.id}/chat`, route => {
    if (route.request().method() === 'POST') {
      sent = route.request().postDataJSON();
      const turn: CaseChatTurn = { id: 'chat-test', question: '어떤 주문인가?', createdAt: graph.createdAt, status: 'running', recordsUsed: [1], totalRecords: 1 };
      turns = [{ ...turn, status: 'completed', answer: '기록에 따르면 고객 A가 주문 B를 접수했습니다.', citations: [{ record: 1, quote: '고객 A가 주문 B를 접수했다.' }] }];
      return route.fulfill({ status: 202, json: { turn } });
    }
    return route.fulfill({ json: { turns, model: 'gpt-6.1-sol', effort: 'xhigh' } });
  });
  await page.goto(`/analysis/${job.id}`);
  const chat = page.getByLabel('케이스 결과 대화', { exact: true });
  await expect(chat).toContainText('gpt-6.1-sol · xhigh');
  await chat.getByLabel(/선택한 항목 함께 보기/).check();
  await chat.getByLabel('케이스에 질문', { exact: true }).fill('어떤 주문인가?');
  await chat.getByRole('button', { name: '질문 보내기 →', exact: true }).click();
  await expect(chat).toContainText('기록에 따르면 고객 A가 주문 B를 접수했습니다.');
  expect(sent).toEqual({ question: '어떤 주문인가?', selection: { kind: 'node', id: 'A' } });
  await chat.getByText('답변의 근거 · 1', { exact: true }).click();
  await chat.getByRole('button', { name: '기록 1 열기 ↗', exact: true }).click();
  await expect(page.getByLabel('분석 기록 상세', { exact: true })).toContainText('고객 기록');
  await expect(page.getByRole('button', { name: 'Order: 주문 B', exact: true })).toBeVisible();
  await page.reload(); await expect(chat).toContainText('기록에 따르면 고객 A가 주문 B를 접수했습니다.');
});

test('case deletion requires confirmation, removes the selected case, and leaves other cases available', async ({ page }) => {
  let removed = false; let deletes = 0;
  const other = { ...job, id: 'other-job', question: '다른 케이스', graphIds: [], graphId: undefined, completedChunks: 0, totalChunks: 0 };
  await page.route('**/api/jobs', route => route.fulfill({ json: { jobs: removed ? [other] : [job, other] } }));
  await page.route('**/api/graphs', route => route.fulfill({ json: { graphs: removed ? [] : [{ ...graph, nodeCount: 2, edgeCount: 1 }] } }));
  await page.route(`**/api/jobs/${job.id}`, route => {
    if (route.request().method() === 'DELETE') { removed = true; deletes++; return route.fulfill({ json: { deleted: true, graphIds: [graph.id] } }); }
    return route.fulfill({ json: { job } });
  });
  await page.goto(`/analysis/${job.id}`);
  await page.getByRole('button', { name: '사이드바 열기', exact: true }).click();
  const remove = page.getByRole('button', { name: `${job.question} 영구 삭제`, exact: true });
  page.once('dialog', dialog => dialog.dismiss()); await remove.click(); expect(deletes).toBe(0);
  page.once('dialog', dialog => dialog.accept()); await remove.click();
  await expect(page).toHaveURL('/'); await expect(remove).toHaveCount(0);
  await expect(page.locator('.case-sidebar-entry').filter({ hasText: '다른 케이스' })).toBeVisible();
  expect(deletes).toBe(1);
});
