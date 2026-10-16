import type { WhySnapshot, WhyBinding, WhyNode } from '../src/types/why-not.ts';
import { contentHash, initialWhyPolicy } from './why-not-contract.ts';

export function whyFixture(count = 2): WhySnapshot {
  const requirement = (i: number): WhyNode => ({ id: `r${i}`, kind: 'requirement', statement: `필수 조건 ${i}`, operator: 'OR', children: [`b${i}`], inferenceRule: '해당 조건의 직접 관측이 필요하다.', negativeOf: null, eventRuleId: null, threshold: null, need: { kinds: ['원본 기록'], fields: ['event'], criteria: ['완료 사실이 원문에 명시됨'], eventScope: 'E1 사건' } });
  const bindings: WhyBinding[] = Array.from({ length: count }, (_, i) => ({ id: `b${i}`, evidenceId: `e${i}`, requirementId: `r${i}`, quote: `E1 완료 ${i}`, start: 0, end: 7, verdict: 'SUPPORTED', reason: '원문에 완료가 명시됨', missingRequirements: [], evaluator: 'fixture-reviewer', decisionVersion: 'v1', materialCoefficient: 1, materialReason: '직접 완료 기록', atomId: `a${i}`, metadata: { fields: [{ key: 'event', value: 'E1', quote: `E1 완료 ${i}` }], start: null, end: null, timeQuote: null } }));
  bindings.forEach(b => b.end = b.quote.length);
  return {
    version: 'why-not-1.0', treeVersion: 'v1', evidenceVersion: 'v1', decisionVersion: 'v1', goal: '사건 E1의 모든 조건이 완료되었는가?', rootId: 'root',
    nodes: [{ id: 'root', kind: 'claim', statement: 'E1 완료 확인', operator: 'AND', children: bindings.map(b => b.requirementId), inferenceRule: '모든 조건 필요', negativeOf: null, eventRuleId: null, threshold: null, need: null }, ...bindings.map((_, i) => requirement(i))],
    evidence: bindings.map((b, i) => ({ id: `e${i}`, name: `원본 ${i}`, kind: 'DOCUMENT', text: b.quote, contentHash: contentHash(b.quote), record: null, documentId: null, url: null, processingStatus: 'READY', sourceGrade: 'B', sourceCoefficient: .8, sourceReason: '테스트용 확인 근거', sourceType: 'record', originalVerified: false })),
    bindings, eventRules: [], duplicates: [], provenance: [], coverage: { complete: true, note: '고정 테스트 전체' }, policy: { ...initialWhyPolicy(), threshold: .5, independence: [{ atomIds: bindings.map(b => b.atomId!), reason: '테스트에서 독립 변수를 가정' }] },
  };
}
