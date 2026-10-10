import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { ClarificationInput, ClarificationResult } from '../src/types/clarification';

/** Keep unrelated workflow tests offline while exercising the explicit preflight bypass. */
export async function mockClarification(page: Page): Promise<void> {
  await page.route('**/api/analysis/clarify', route => {
    const input = route.request().postDataJSON() as ClarificationInput;
    const result: ClarificationResult = {
      status: 'questions', source: 'guided', introduction: '분석을 시작하기 전에 범위를 확인합니다.',
      questions: [{ id: 'test-scope', question: '분석 범위를 더 좁힐까요?', reason: '원래 요청을 유지하거나 구체적인 대상을 선택할 수 있습니다.', options: [
        { id: 'all', label: '전체 요청 유지', description: '현재 요청과 자료 전체를 기준으로 분석합니다.' },
        { id: 'specific', label: '특정 대상에 집중', description: '대상과 범위를 더 구체적으로 정합니다.' },
      ] }],
      brief: { objective: input.question, scope: '현재 요청과 제공된 자료', output: '근거에 따른 객체·관계 그래프', answers: input.answers },
    };
    return route.fulfill({ json: result });
  });
}

/** Preserves legacy job payloads by deliberately choosing analysis without a confirmed brief. */
export async function startUnscopedAnalysis(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'START INVESTIGATION', exact: true }).click();
  const preflight = page.getByRole('region', { name: '분석 범위 확인', exact: true });
  await expect(preflight.getByText('전체 요청 유지', { exact: true })).toBeVisible();
  await preflight.getByRole('button', { name: '질문 없이 현재 요청으로 분석', exact: true }).click();
}
