import { expect, test } from '@playwright/test';
import { mockClarification, startUnscopedAnalysis } from './clarification-fixture';
import type { Page } from '@playwright/test';
import type { OntologyDefinition, PropertyDefinition } from '../src/types/ontology';

const property = (apiName: string, displayName: string, baseType: PropertyDefinition['baseType']): PropertyDefinition => ({ apiName, displayName, baseType, description: `${displayName} 값`, required: true, visibility: 'normal', renderHints: [], typeClasses: [] });
const definition: OntologyDefinition = {
  schemaVersion: '1.0', id: 'retail-ontology', version: 1, apiName: 'Retail', displayName: '고객 주문 온톨로지', description: '고객과 주문의 관계를 관리합니다.', status: 'active',
  objectTypes: [
    { apiName: 'Customer', displayName: '고객', pluralDisplayName: '고객 목록', description: '주문을 접수한 고객', identityScope: 'ontology', primaryKey: 'customerId', titleProperty: 'name', properties: [property('customerId', '고객 번호', 'string'), property('name', '이름', 'string')], color: '#337e87', icon: 'person', visibility: 'normal', status: 'active', implementsInterfaces: [], groups: [] },
    { apiName: 'Order', displayName: '주문', pluralDisplayName: '주문 목록', description: '고객이 요청한 주문', identityScope: 'ontology', primaryKey: 'orderId', titleProperty: 'orderId', properties: [property('orderId', '주문 번호', 'string'), { ...property('amount', '주문 금액', 'decimal'), constraints: { minimum: 0 } }], color: '#805e91', icon: 'document', visibility: 'normal', status: 'active', implementsInterfaces: [], groups: [] },
  ],
  linkTypes: [{ apiName: 'placesOrder', displayName: '주문함', inverseDisplayName: '주문 고객', description: '고객과 고객이 접수한 주문', sourceType: 'Customer', targetType: 'Order', sourceCardinality: 'one', targetCardinality: 'many', visibility: 'normal', status: 'active' }],
  sharedProperties: [], interfaces: [], valueTypes: [], groups: [], functions: [],
  actionTypes: [{ apiName: 'cancelOrder', displayName: '주문 취소', description: '주문 취소 동작의 초안', executable: false, status: 'draft', parameters: [property('reason', '취소 사유', 'string')], objectTypes: ['Order'] }],
  processing: { textStrategy: 'codex', jevEligibleLinkTypes: [], rationale: '주문 내역의 의미와 금액을 Codex로 분석합니다.' }, sourceMappings: [],
};
const status = { authenticated: true, authRequired: false, provider: { kind: 'hybrid', ontologyPlanning: true, available: true, authenticated: true, message: '온톨로지 설계 준비됨', codex: { available: true, authenticated: true, message: 'Codex 준비됨' }, jev: { configured: true, model: 'jev-1.13.0' } }, activeJobs: [], ontology: { entities: 0, relationships: 0, documents: 0, graphs: 0 } };
async function setup(page: Page) {
  await mockClarification(page);
  await page.route('**/api/system/status', route => route.fulfill({ json: status }));
  await page.route('**/api/graphs', route => route.fulfill({ json: { graphs: [] } }));
  await page.route('**/api/ontology', route => route.fulfill({ json: { summary: { ...status.ontology, types: [] }, schema: { version: '1.0', entityTypes: [], relationTypes: [] }, definitions: [definition] } }));
  await page.route('**/api/ontology/entities?*', route => route.fulfill({ json: { entities: [] } }));
}

test('prompt-only completion links the generated domain schema from the analysis workspace without a fabricated graph', async ({ page }) => {
  await setup(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const job = { id: 'schema-job', question: '고객 주문 온톨로지를 설계해줘', status: 'running', stage: 'designing', message: '온톨로지를 설계하고 있습니다.', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z' };
  await page.route('**/api/jobs', route => route.request().method() === 'GET' ? route.fulfill({ json: { jobs: [job] } }) : route.fulfill({ status: 202, json: { job } }));
  await page.route('**/api/jobs/schema-job', route => route.fulfill({ json: { job: { ...job, status: 'completed', stage: 'saving', schemaOnly: true, ontologyId: definition.id, ontologyVersion: 1, ontologyName: definition.displayName, graphIds: [], message: '온톨로지를 저장했습니다.' } } }));
  await page.goto('/');
  await page.getByLabel('What do you want to find out?', { exact: true }).fill(job.question);
  await startUnscopedAnalysis(page);
  await expect(page.getByLabel('AI analysis activity', { exact: true })).toContainText('온톨로지 설계');
  await expect(page).toHaveURL('/analysis/schema-job');
  await expect(page.getByRole('button', { name: /^Customer:/ })).toHaveCount(0);
  await page.getByRole('link', { name: /^온톨로지 열기/ }).click();
  await expect(page).toHaveURL('/ontology?definition=retail-ontology');
  await expect(page.getByRole('heading', { name: definition.displayName, exact: true })).toBeVisible();
  await expect(page.getByText('주문 금액', { exact: true })).toBeVisible();
  await expect(page.getByText('decimal', { exact: true })).toBeVisible();
  await expect(page.getByText('정의된 관계 유형이 없습니다.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^선박/ })).toHaveCount(0);
  await expect(page.getByText('아직 저장된 객체가 없습니다.', { exact: true })).toBeVisible();
  await page.getByText('액션·함수 선언', { exact: false }).click();
  await expect(page.getByText('초안 · 실행 미지원', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '주문 취소', exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  const widths = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
  expect(widths.content).toBeLessThanOrEqual(widths.width + 1);
  expect(errors).toEqual([]);
});

test('definition filters scope entity requests and new analyses require Codex even with a Jev key', async ({ page }) => {
  await setup(page);
  const queries: URL[] = [];
  await page.route('**/api/ontology/entities?*', route => { queries.push(new URL(route.request().url())); return route.fulfill({ json: { entities: [] } }); });
  await page.goto('/ontology');
  await page.getByRole('combobox', { name: '온톨로지 선택', exact: true }).selectOption(definition.id);
  await page.getByRole('button', { name: '고객', exact: true }).click();
  await expect.poll(() => queries.some(url => url.searchParams.get('ontologyId') === definition.id && url.searchParams.get('type') === 'Customer')).toBe(true);
  await page.route('**/api/system/status', route => route.fulfill({ json: { ...status, provider: { ...status.provider, codex: { available: true, authenticated: false, message: '온톨로지 설계에는 Codex 로그인이 필요합니다.' } } } }));
  let requests = 0;
  await page.route('**/api/jobs', route => { if (route.request().method() === 'GET') return route.fulfill({ json: { jobs: [] } }); requests++; return route.fulfill({ status: 500, json: { error: 'Unexpected request' } }); });
  await page.goto('/');
  await expect(page.getByText('분석 엔진 연결 필요', { exact: true })).toBeVisible();
  await page.getByLabel('What do you want to find out?', { exact: true }).fill('주문 자료를 분석해줘');
  await page.getByRole('button', { name: 'START INVESTIGATION', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Codex 로그인이 필요합니다.');
  expect(requests).toBe(0);
});

test('source-only upload starts with a default extraction question', async ({ page }) => {
  await setup(page);
  const source = 'customerId,name\nC1,Alex';
  const job = { id: 'source-job', question: '첨부 자료의 객체와 관계를 근거에 따라 정리해줘.', status: 'running', stage: 'designing', message: '온톨로지를 설계하고 있습니다.', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z' };
  let submission: unknown;
  await page.route('**/api/documents/upload', route => route.fulfill({ status: 201, json: { document: { id: 'customers-upload', name: 'customers.csv', bytes: source.length, characters: source.length, chunkCount: 1, createdAt: job.createdAt } } }));
  await page.route('**/api/jobs', route => { if (route.request().method() === 'GET') return route.fulfill({ json: { jobs: [job] } }); submission = route.request().postDataJSON(); return route.fulfill({ status: 202, json: { job } }); });
  await page.route('**/api/jobs/source-job', route => route.fulfill({ json: { job } }));
  await page.goto('/');
  await page.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'customers.csv', mimeType: 'text/csv', buffer: Buffer.from(source) });
  await startUnscopedAnalysis(page);
  await expect(page.getByLabel('AI analysis activity', { exact: true })).toContainText('온톨로지 설계');
  expect(submission).toEqual({ question: job.question, documents: [], uploadIds: ['customers-upload'] });
  await expect(page).toHaveURL('/analysis/source-job');
  await expect(page.getByLabel('분석 세션 설명', { exact: true })).toContainText(job.question);
});
