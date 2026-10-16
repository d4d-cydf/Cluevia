import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
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

async function openLibrary(page: Page) {
  const open = page.getByRole('button', { name: '사이드바 열기', exact: true });
  if (await open.isVisible()) await open.click();
  const mode = page.getByRole('button', { name: '케이스 보관함으로 전환', exact: true });
  if (await mode.isVisible()) await mode.click();
  await expect(page.getByRole('navigation', { name: '내 케이스', exact: true })).toBeVisible();
}

test('case details open over the graph and the single sidebar switches between conversation and cases', async ({ page }) => {
  await page.goto(`/analysis/${job.id}`);
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  const companion = page.getByLabel('Case evidence', { exact: true });
  await expect(page.getByLabel('케이스 결과 대화', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '케이스 패널 접기', exact: true })).toHaveCount(0);
  const sources = page.locator('.gw-sources');
  await expect(sources).toBeHidden();
  await expect(page.locator('.gw-footer')).toHaveCount(0);
  const info = page.getByRole('button', { name: '케이스 정보 보기', exact: true });
  await info.click();
  await page.getByRole('button', { name: '출처 · 1', exact: true }).click();
  await expect(sources).toBeVisible();
  expect(await companion.locator('.gw-sources').count()).toBe(0);
  const dimensions = await sources.locator('article').evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.width + 1);
  await page.getByRole('button', { name: '상세 닫기', exact: true }).click();
  await expect(sources).toBeHidden();
  await expect(info).toBeFocused();
  await expect(companion).toBeVisible();
  await expect(page.getByRole('button', { name: 'Customer: 고객 A', exact: true })).toBeVisible();
  await openLibrary(page);
  const sidebar = page.getByLabel('케이스 사이드바', { exact: true });
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByRole('button', { name: '케이스 목록 닫기', exact: true })).toHaveCount(0);
  await expect(companion).toBeHidden();
  await sidebar.getByRole('button', { name: '현재 케이스로 전환', exact: true }).click();
  await expect(companion).toBeVisible();
  await page.getByRole('button', { name: '사이드바 닫기', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await info.click();
  await page.getByRole('button', { name: '출처 · 1', exact: true }).click();
  await expect(sources).toBeVisible();
  const widths = await page.evaluate(() => [document.documentElement.clientWidth, document.documentElement.scrollWidth]);
  expect(widths[1]).toBeLessThanOrEqual(widths[0] + 1);
});

test('dragging a graph node updates connected arrow geometry and remembers the position', async ({ page }) => {
  await page.goto(`/analysis/${job.id}`);
  await page.getByRole('button', { name: 'Board', exact: true }).click();
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
  await page.reload(); await page.getByRole('button', { name: 'Board', exact: true }).click(); await expect(node).toBeVisible();
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
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  const chat = page.getByLabel('케이스 결과 대화', { exact: true });
  await expect(chat).toContainText('gpt-6.1-sol · xhigh');
  await page.screenshot({ path: test.info().outputPath('chat-empty-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Customer: 고객 A', exact: true }).click();
  await chat.getByLabel(/선택한 항목 함께 보기/).check();
  await chat.getByLabel('케이스에 질문', { exact: true }).fill('어떤 주문인가?');
  await chat.getByRole('button', { name: '질문 보내기 →', exact: true }).click();
  await expect(chat).toContainText('기록에 따르면 고객 A가 주문 B를 접수했습니다.');
  expect(sent).toEqual({ question: '어떤 주문인가?', selection: { kind: 'node', id: 'A' } });
  await chat.getByLabel('답변의 근거 · 1', { exact: true }).click();
  await chat.getByRole('button', { name: '기록 1 열기 ↗', exact: true }).click();
  await expect(page.getByLabel('분석 기록 상세', { exact: true })).toContainText('고객 기록');
  await expect(page.getByRole('button', { name: 'Order: 주문 B', exact: true })).toBeVisible();
  await page.reload(); await expect(chat).toContainText('기록에 따르면 고객 A가 주문 B를 접수했습니다.');
  await page.screenshot({ path: test.info().outputPath('chat-answer-desktop.png'), fullPage: true });
});

test('a mobile chat citation closes the sidebar and reveals its source record', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const turn: CaseChatTurn = { id: 'mobile-citation', question: '어떤 주문인가?', createdAt: graph.createdAt, status: 'completed', recordsUsed: [1], totalRecords: 1, answer: '고객 A가 주문 B를 접수했습니다.', citations: [{ record: 1, quote: '고객 A가 주문 B를 접수했다.' }] };
  await page.route(`**/api/jobs/${job.id}/chat`, route => route.fulfill({ json: { turns: [turn], model: 'citation-model', effort: 'medium' } }));
  await page.goto(`/analysis/${job.id}`);
  const sidebar = page.getByLabel('케이스 사이드바', { exact: true });
  const chat = page.getByLabel('케이스 결과 대화', { exact: true });
  await expect(sidebar).toBeHidden();
  await page.getByRole('button', { name: '사이드바 열기', exact: true }).click();
  await expect(chat).toContainText(turn.answer!);
  await chat.getByLabel('케이스에 질문', { exact: true }).fill('추가로 확인할 자료가 있을까?');
  await page.screenshot({ path: test.info().outputPath('chat-answer-mobile-draft.png'), fullPage: true });
  await chat.getByLabel('답변의 근거 · 1', { exact: true }).click();
  await chat.getByRole('button', { name: '기록 1 열기 ↗', exact: true }).click();
  await expect(sidebar).toBeHidden();
  const detail = page.getByLabel('분석 기록 상세', { exact: true });
  await expect(detail).toBeVisible();
  await expect(detail).toContainText('고객 A가 주문 B를 접수했다.');
  await expect(detail).toBeInViewport();
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
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await openLibrary(page);
  const remove = page.getByRole('button', { name: `${job.question} 영구 삭제`, exact: true });
  page.once('dialog', dialog => dialog.dismiss()); await remove.click(); expect(deletes).toBe(0);
  page.once('dialog', dialog => dialog.accept()); await remove.click();
  await expect(page).toHaveURL('/'); await expect(remove).toHaveCount(0);
  await expect(page.locator('.case-sidebar-entry').filter({ hasText: '다른 케이스' })).toBeVisible();
  expect(deletes).toBe(1);
});

test('case sidebar preserves the chat draft, selected context and history position across mode changes', async ({ page }) => {
  let reads = 0;
  const turns: CaseChatTurn[] = Array.from({ length: 24 }, (_, index) => ({
    id: `history-${index}`, question: `이전 질문 ${index + 1}`, status: 'completed', createdAt: graph.createdAt,
    answer: `기록 ${index + 1}의 근거와 한계를 설명합니다. `.repeat(18), recordsUsed: [1], totalRecords: 1,
  }));
  await page.route(`**/api/jobs/${job.id}/chat`, route => {
    reads++;
    return route.fulfill({ json: { turns, model: 'history-model', effort: 'medium' } });
  });
  await page.goto(`/analysis/${job.id}`);
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  const chat = page.getByLabel('케이스 결과 대화', { exact: true });
  await expect(chat.locator('.case-chat-turns article')).toHaveCount(turns.length);
  await page.getByRole('button', { name: 'Customer: 고객 A', exact: true }).click();
  const input = chat.getByLabel('케이스에 질문', { exact: true });
  const selection = chat.getByLabel(/선택한 항목 함께 보기/);
  await input.fill('아직 보내지 않은 다음 질문');
  await selection.check();
  await chat.evaluate(element => element.setAttribute('data-chat-instance', 'original'));
  const history = chat.locator('.case-chat-turns');
  const originalScroll = await history.evaluate(element => { element.scrollTop = 640; return element.scrollTop; });
  expect(originalScroll).toBeGreaterThan(500);
  const originalReads = reads;
  await openLibrary(page);
  await expect(chat).toBeHidden();
  await page.getByRole('button', { name: '현재 케이스로 전환', exact: true }).click();
  await expect(chat).toBeVisible();
  await expect(chat).toHaveAttribute('data-chat-instance', 'original');
  await expect(input).toHaveValue('아직 보내지 않은 다음 질문');
  await expect(selection).toBeChecked();
  await expect.poll(() => history.evaluate(element => element.scrollTop)).toBe(originalScroll);
  expect(reads).toBe(originalReads, 'switching sidebar mode must not remount and refetch completed chat');
});

test('long case conversations scroll inside the sidebar while the composer remains in view', async ({ page }) => {
  const turns: CaseChatTurn[] = Array.from({ length: 20 }, (_, index) => ({
    id: `long-turn-${index}`, question: `대화 기록 ${index + 1}`, status: 'completed', createdAt: graph.createdAt,
    answer: '보관된 원문에서 확인된 내용과 아직 확인하지 못한 부분을 구분합니다. '.repeat(24), recordsUsed: [1], totalRecords: 1,
  }));
  await page.route(`**/api/jobs/${job.id}/chat`, route => route.fulfill({ json: { turns, model: 'history-model', effort: 'medium' } }));
  await page.goto(`/analysis/${job.id}`);
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  const sidebar = page.getByLabel('케이스 사이드바', { exact: true });
  const chat = page.getByLabel('케이스 결과 대화', { exact: true });
  const history = chat.locator('.case-chat-turns');
  const input = chat.getByLabel('케이스에 질문', { exact: true });
  const send = chat.getByRole('button', { name: '질문 보내기 →', exact: true });
  await expect(history.locator('article')).toHaveCount(turns.length);
  async function checkFit() {
    const panel = (await sidebar.boundingBox())!;
    const composer = (await input.boundingBox())!;
    const action = (await send.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(Math.abs(panel.y + panel.height - viewport.height)).toBeLessThanOrEqual(2);
    expect(composer.y).toBeGreaterThanOrEqual(panel.y);
    expect(action.y + action.height).toBeLessThanOrEqual(panel.y + panel.height);
    await expect(input).toBeInViewport(); await expect(send).toBeInViewport();
    const dimensions = await history.evaluate(element => ({ height: element.clientHeight, content: element.scrollHeight, overflow: getComputedStyle(element).overflowY }));
    expect(dimensions.height).toBeGreaterThan(80);
    expect(dimensions.content).toBeGreaterThan(dimensions.height * 2);
    expect(['auto', 'scroll']).toContain(dimensions.overflow);
    const pageScroll = await page.evaluate(() => window.scrollY);
    const originalComposerY = composer.y;
    await history.evaluate(element => { element.scrollTop = element.scrollHeight; });
    expect(await history.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    expect(Math.abs((await input.boundingBox())!.y - originalComposerY)).toBeLessThan(1);
    expect(await page.evaluate(() => window.scrollY)).toBe(pageScroll);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  }
  await checkFit();
  await page.screenshot({ path: test.info().outputPath('chat-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(chat).toBeHidden();
  await page.getByRole('button', { name: '사이드바 열기', exact: true }).click();
  await expect(chat).toBeVisible();
  await checkFit();
  await page.screenshot({ path: test.info().outputPath('chat-mobile.png'), fullPage: true });
});

test('chat automatically recovers after a transient polling error and preserves a new draft during submission', async ({ page }) => {
  let requests = 0;
  let posted = false;
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const turn: CaseChatTurn = { id: 'recovery-turn', question: '첫 번째 질문', status: 'running', createdAt: new Date().toISOString(), recordsUsed: [1], totalRecords: 1 };
  await page.route(`**/api/jobs/${job.id}/chat`, async route => {
    if (route.request().method() === 'POST') {
      posted = true;
      await delayed;
      return route.fulfill({ status: 202, json: { turn } });
    }
    if (posted) requests++;
    if (requests === 2) return route.fulfill({ status: 503, json: { error: '일시적인 연결 오류' } });
    const turns = !posted ? [] : [{ ...turn, ...(requests >= 3 ? { status: 'completed', answer: '연결 복구 후 확인한 답변입니다.' } : {}) }];
    return route.fulfill({ json: { turns, model: 'test-model', effort: 'high' } });
  });
  await page.goto(`/analysis/${job.id}`);
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  const chat = page.getByLabel('케이스 결과 대화', { exact: true });
  await expect(chat).toContainText('test-model');
  const input = chat.getByLabel('케이스에 질문', { exact: true });
  await input.fill(turn.question);
  await chat.getByRole('button', { name: '질문 보내기 →' }).click();
  await expect.poll(() => posted).toBe(true);
  await input.fill('다음에 물어볼 질문');
  release();
  await expect(chat.locator('.case-chat-thinking')).toBeVisible();
  await expect(input).toHaveValue('다음에 물어볼 질문');
  await expect(chat.getByRole('alert')).toContainText('일시적인 연결 오류');
  await expect(chat.locator('.case-chat-thinking')).toHaveCount(0);
  await expect(chat).toContainText('연결 복구 후 확인한 답변입니다.', { timeout: 10000 });
  await expect(chat.getByRole('alert')).toHaveCount(0);
  await expect(input).toHaveValue('다음에 물어볼 질문');
  await expect(chat.getByRole('button', { name: '질문 보내기 →' })).toBeEnabled();
});

test('chat keyboard submission preserves line breaks and never submits during text composition', async ({ page }) => {
  const sent: unknown[] = [];
  const turn: CaseChatTurn = { id: 'keyboard-turn', question: '첫째 줄\n둘째 줄', status: 'running', createdAt: graph.createdAt, recordsUsed: [1], totalRecords: 1 };
  await page.route(`**/api/jobs/${job.id}/chat`, route => {
    if (route.request().method() === 'POST') {
      sent.push(route.request().postDataJSON());
      return route.fulfill({ status: 202, json: { turn } });
    }
    return route.fulfill({ json: { turns: sent.length ? [turn] : [], model: 'keyboard-model', effort: 'medium' } });
  });
  await page.goto(`/analysis/${job.id}`);
  const chat = page.getByLabel('케이스 결과 대화', { exact: true });
  await expect(chat).toContainText('keyboard-model');
  const input = chat.getByLabel('케이스에 질문', { exact: true });
  await input.fill('첫째 줄'); await input.press('End'); await input.press('Enter'); await input.pressSequentially('둘째 줄');
  await expect(input).toHaveValue(turn.question);
  expect(sent).toHaveLength(0);
  await input.dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true });
  expect(sent).toHaveLength(0);
  await input.press('Control+Enter');
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toEqual({ question: turn.question, selection: null });
  await expect(chat.getByRole('button', { name: '답변 생성 중…' })).toBeDisabled();
});

test('chat displays real retrieved context while waiting and replaces it when the answer arrives', async ({ page }) => {
  let completed = false;
  const turn: CaseChatTurn = { id: 'thinking-turn', question: '어떤 주문인지 확인해줘', status: 'running', createdAt: new Date(Date.now() - 7000).toISOString(), recordsUsed: [1], totalRecords: 3, indexedRecords: 3 };
  await page.route(`**/api/jobs/${job.id}/chat`, route => route.fulfill({ json: {
    turns: [{ ...turn, ...(completed ? { status: 'completed', answer: '기록에서 고객 A의 주문 B를 확인했습니다.', citations: [{ record: 1, quote: '고객 A가 주문 B를 접수했다.' }] } : {}) }], model: 'test-model', effort: 'medium',
  } }));
  await page.goto(`/analysis/${job.id}`);
  const chat = page.getByLabel('케이스 결과 대화', { exact: true });
  const thinking = chat.locator('.case-chat-thinking');
  await expect(thinking).toBeVisible();
  await expect(thinking).toContainText('Thinking');
  await expect(thinking).toContainText('자료를 확인하고 답변을 준비하고 있습니다.');
  await expect(thinking).toContainText('관련 기록 1개를 참고하고 있습니다.');
  await expect(chat.getByRole('button', { name: '답변 생성 중…', exact: true })).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath('chat-thinking-desktop.png'), fullPage: true });
  const elapsed = await thinking.locator('time').textContent();
  await thinking.getByLabel('답변 준비 과정', { exact: true }).click();
  await expect(thinking.locator('.case-chat-thinking-copy')).toBeHidden();
  await expect.poll(() => thinking.locator('time').textContent()).not.toBe(elapsed);
  await expect(thinking.locator('.case-chat-thinking-copy')).toBeHidden();
  completed = true;
  await expect(chat).toContainText('기록에서 고객 A의 주문 B를 확인했습니다.');
  await expect(thinking).toHaveCount(0);
  await chat.getByLabel('답변의 근거 · 1', { exact: true }).click();
  await expect(chat).toContainText('답변에 제공한 원문 1 / 3개');
  await expect(chat).toContainText('미제공 기록으로 부재를 단정하지 않습니다.');
});

test('growing into graph exploration preserves the canvas, zoom and dragged positions', async ({ page }) => {
  let completed = 1;
  let growing: GraphDocument = { ...graph, nodes: [...graph.nodes, ...Array.from({ length: 198 }, (_, index) => ({ ...graph.nodes[0], id: `extra-${index}`, label: `Extra ${index}` }))] };
  await page.addInitScript(({ key }) => localStorage.setItem(key, JSON.stringify({ A: { x: 500, y: 300 }, B: { x: 730, y: 300 } })), { key: `cluevia.positions.case-${job.id}.board` });
  await mockCase(page, job.id, () => [growing], () => ({ total: 3, completed }));
  await page.route(`**/api/jobs/${job.id}`, route => route.fulfill({ json: { job: { ...job, status: 'running', stage: 'extracting', totalChunks: 3, completedChunks: completed } } }));
  await page.goto(`/analysis/${job.id}`);
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  const a = page.locator('[data-graph-node="A"]');
  await expect(a).toHaveCSS('left', '500px');
  await a.click();
  await page.getByRole('button', { name: '상세 닫기', exact: true }).click();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const zoom = await page.getByLabel('Zoom level', { exact: true }).textContent();
  const canvas = page.locator('[data-canvas-scroll]');
  await canvas.evaluate(element => element.setAttribute('data-instance-proof', 'original'));
  growing = { ...growing, nodes: [...growing.nodes, { ...graph.nodes[0], id: 'C', label: '새 근거 C' }], edges: [...growing.edges, { ...graph.edges[0], id: 'AC', target: 'C' }] };
  completed = 2;
  await expect(page.getByLabel('대규모 그래프 탐색', { exact: true })).toBeVisible();
  await expect(canvas).toHaveAttribute('data-instance-proof', 'original');
  await expect(page.getByLabel('Zoom level', { exact: true })).toHaveText(zoom!);
  await expect(a).toHaveCSS('left', '500px');
  await expect(a).toHaveCSS('top', '300px');
  await expect(a).toHaveAttribute('aria-pressed', 'true');
  const c = page.locator('[data-graph-node="C"]');
  await expect(c).toBeVisible();
  const point = await c.evaluate(element => ({ x: parseFloat(element.style.left), y: parseFloat(element.style.top) }));
  // The first adjacent slot is occupied by a manually positioned node B.
  expect(Math.abs(point.x - 730) >= 210 || Math.abs(point.y - 300) >= 105).toBe(true);
});
