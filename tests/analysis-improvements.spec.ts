import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { GraphDocument } from '../src/types/graph';
import { mockCase } from './case-fixture';

function graph(count: number): GraphDocument {
  return { schemaVersion: '1.0', id: 'improvement-graph', title: 'Synthetic case', question: 'Review the supplied records', summary: 'Synthetic graph', origin: 'codex', createdAt: '2026-01-01T00:00:00Z', groups: [{ id: 'items', label: 'Items', color: '#337e87' }], sources: [{ id: 'source', title: 'Synthetic source', excerpt: 'Aster denied ownership of Nova.' }],
    nodes: Array.from({ length: count }, (_, index) => ({ id: `N-${index}`, label: `Object ${index}`, type: 'Item', group: 'items', description: 'Synthetic test object', sourceIds: ['source'], properties: {} })),
    edges: Array.from({ length: count - 1 }, (_, index) => ({ id: `E-${index}`, source: `N-${index}`, target: `N-${index + 1}`, label: 'connected', description: 'Synthetic relationship', status: 'reported', sourceIds: ['source'] })), events: [], findings: [], limitations: [] };
}
async function setup(page: Page, value: GraphDocument) {
  const job = { id: 'job-improvements', status: 'completed', stage: 'saving', message: '완료', question: value.question, createdAt: value.createdAt, updatedAt: value.createdAt, completedChunks: 1, totalChunks: 1, emptyChunks: 0, graphIds: [value.id], graphId: value.id, graphCount: 1, resumable: false };
  await page.route('**/api/system/status', route => route.fulfill({ json: { authenticated: true, authRequired: false, provider: { available: false, authenticated: false, message: 'Browser fixture' }, activeJobs: [], ontology: { entities: 0, relationships: 0, documents: 0, graphs: 0 } } }));
  await page.route('**/api/jobs', route => route.fulfill({ json: { jobs: [job] } }));
  await page.route(`**/api/jobs/${job.id}`, route => route.fulfill({ json: { job } }));
  await mockCase(page, job.id, () => [value]);
  await page.goto(`/analysis/${job.id}`);
}

test('thousand-object case renders a bounded subset while search and export retain the last object', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await setup(page, graph(1000));
  await expect(page.getByLabel('대규모 그래프 탐색')).toContainText('전체 1,000개');
  expect(await page.locator('[data-graph-node]').count()).toBeLessThanOrEqual(200);
  await page.getByRole('searchbox', { name: 'Search graph' }).fill('Object 999');
  await page.getByRole('button', { name: 'Object 999 · Item', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Selected graph item' })).toContainText('Object 999');
  await expect(page.locator('[data-graph-node="N-999"]')).toBeVisible();
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'EXPORT', exact: true }).click();
  const stream = await (await download).createReadStream(); const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(JSON.parse(Buffer.concat(chunks).toString()).graph.nodes).toHaveLength(1000);
  expect(errors).toEqual([]);
});

test('denied relationship exposes attribution and persists analyst review through the API', async ({ page }) => {
  const value = graph(2);
  value.edges[0].claim = { stance: 'denied', attributedTo: 'Aster', validFrom: null, validTo: null, publishedAt: '2026-01-01', derivedFrom: null };
  let payload: { status: string; note: string } | undefined;
  await page.route('**/api/jobs/job-improvements/claims/*/review', async route => {
    payload = route.request().postDataJSON(); return route.fulfill({ json: { review: { ...payload, updatedAt: value.createdAt } } });
  });
  await setup(page, value);
  await page.getByRole('button', { name: /^Relation: connected/ }).click();
  const panel = page.getByRole('region', { name: '관계 주장과 검토' });
  await expect(panel).toContainText('부인'); await expect(panel).toContainText('Aster');
  await panel.getByRole('combobox').selectOption('disputed');
  await panel.getByRole('textbox').fill('원문은 소유 사실을 부인하고 있습니다.');
  await panel.getByRole('button', { name: '검토 저장' }).click();
  await expect(panel.getByRole('status')).toContainText('저장했습니다');
  expect(payload).toEqual({ status: 'disputed', note: '원문은 소유 사실을 부인하고 있습니다.' });
  await page.getByRole('button', { name: 'Item: Object 0', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await page.getByRole('button', { name: /^Relation: connected/ }).click();
  await expect(panel.getByRole('combobox')).toHaveValue('disputed');
  await expect(panel.getByRole('textbox')).toHaveValue('원문은 소유 사실을 부인하고 있습니다.');
});
