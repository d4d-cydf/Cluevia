import type { WhyEvidence, WhySnapshot } from '../src/types/why-not.ts';
import { initialWhyPolicy, parseWhySnapshot, WhyNotError } from './why-not-contract.ts';

const str = { type: 'string' }; const nullable = { type: ['string', 'null'] };
const strings = { type: 'array', items: str };
const obj = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const metadata = obj({ fields: { type: 'array', items: obj({ key: str, value: str, quote: str }) }, start: nullable, end: nullable, timeQuote: nullable });

/** Only graph structure and verbatim evidence pointers. No diagnostic decisions. */
export const whyBaselineSchema = obj({
  rootId: str,
  nodes: { type: 'array', maxItems: 24, items: obj({ id: str, kind: { enum: ['claim', 'requirement'] }, statement: str, operator: { enum: ['AND', 'OR', 'NOT_SUPPORT'] }, children: strings, inferenceRule: str, negativeOf: nullable, eventRuleId: nullable, need: { anyOf: [{ type: 'null' }, obj({ kinds: strings, fields: strings, criteria: strings, eventScope: str })] } }) },
  eventRules: { type: 'array', maxItems: 12, items: obj({ id: str, kind: { enum: ['SAME_EVENT', 'SAME_ENTITY', 'ORDERED_EVENTS'] }, fields: strings, expected: { type: 'array', items: obj({ key: str, value: str }) }, requireTime: { type: 'boolean' }, order: strings }) },
  bindings: { type: 'array', maxItems: 40, items: obj({ evidenceId: str, requirementId: str, quote: str }) },
});

/** Reviews saved binding IDs; cannot create or rewrite graph or quotations. */
export const whyReviewSchema = obj({
  decisions: { type: 'array', maxItems: 40, items: obj({ bindingId: str, verdict: { enum: ['SUPPORTED', 'REFUTED', 'INSUFFICIENT', 'IRRELEVANT'] }, reason: str, missingRequirements: strings, metadata }) },
  duplicates: { type: 'array', maxItems: 80, items: obj({ parentId: str, left: str, right: str, verdict: { enum: ['SAME_OBSERVATION', 'PARTIAL_OVERLAP', 'DISTINCT', 'UNKNOWN'] }, reason: str }) },
});

function record(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new WhyNotError(`${label} 응답에 허용되지 않은 변경이 있습니다.`, 502);
  return value as Record<string, unknown>;
}
function list(value: unknown, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new WhyNotError(`${label} 응답 형식이 올바르지 않습니다.`, 502);
  return value;
}

export function snapshotFromWhyBaseline(raw: unknown, goal: string, sources: WhyEvidence[], version: string, previous?: WhySnapshot): WhySnapshot {
  const draft = record(raw, ['rootId', 'nodes', 'eventRules', 'bindings'], '기본 그래프');
  const rawNodes = list(draft.nodes, 24, '노드'); const rawRules = list(draft.eventRules, 12, '사건 규칙');
  if (previous && (draft.rootId !== previous.rootId || rawNodes.length || rawRules.length || goal !== previous.goal)) throw new WhyNotError('자료 보완은 기존 목표와 논리 구조를 변경할 수 없습니다.', 502);
  const nodes = previous ? structuredClone(previous.nodes) : rawNodes.map(node => ({ ...structuredClone(node as WhySnapshot['nodes'][number]), threshold: null }));
  if (!previous && nodes.some(node => node.kind === 'requirement' && (!Array.isArray(node.children) || node.children.length))) throw new WhyNotError('자료 요구에 임의의 증거 ID를 붙일 수 없습니다.', 502);
  const bindings = structuredClone(previous?.bindings ?? []);
  for (const rawBinding of list(draft.bindings, 40, '자료 연결')) {
    const binding = record(rawBinding, ['evidenceId', 'requirementId', 'quote'], '기본 자료 연결');
    const source = sources.find(source => source.id === binding.evidenceId);
    const node = nodes.find(node => node.id === binding.requirementId && node.kind === 'requirement');
    if (!source || !node || typeof binding.quote !== 'string' || !binding.quote.trim() || !source.text.includes(binding.quote)) throw new WhyNotError('기본 그래프의 인용이 실제 원문과 일치하지 않습니다.', 502);
    if (bindings.some(old => old.requirementId === node.id && old.evidenceId === source.id && old.quote === binding.quote)) continue;
    const id = `binding-${version.slice(-12)}-${bindings.length + 1}`;
    const start = source.text.indexOf(binding.quote);
    bindings.push({ id, evidenceId: source.id, requirementId: node.id, quote: binding.quote, start, end: start + binding.quote.length,
      verdict: 'UNREVIEWED', reason: '기본 그래프에 연결된 원문이며 적합성 판정은 아직 수행하지 않았습니다.', missingRequirements: [], evaluator: 'graph-baseline', decisionVersion: version,
      materialCoefficient: null, materialReason: '', atomId: null, likelihood: { ratio: null, basis: 'UNASSESSED', reason: '목표 우도비 통계가 아직 입력되지 않았습니다.' },
      metadata: { fields: [], start: null, end: null, timeQuote: null } });
    node.children.push(id);
  }
  return parseWhySnapshot({ version: 'why-not-1.0', treeVersion: previous?.treeVersion ?? version, evidenceVersion: version, decisionVersion: version, goal, rootId: previous?.rootId ?? draft.rootId,
    nodes, bindings, evidence: [...(previous?.evidence ?? []), ...sources], eventRules: previous?.eventRules ?? rawRules.map(rule => ({ ...(rule as object), version })),
    duplicates: structuredClone(previous?.duplicates ?? []), provenance: structuredClone(previous?.provenance ?? []), policy: previous?.policy ?? { ...initialWhyPolicy(), bayes: { target: 'GOAL', priors: [], conditionalIndependence: [] } },
    coverage: { complete: false, note: '기본 구조와 실제 인용만 저장했습니다. 자료 판정과 공백 진단은 다음 단계에서 수행합니다.' } });
}

export function applyWhyReview(snapshot: WhySnapshot, raw: unknown, version: string, options: { bindingIds?: string[] } = {}): WhySnapshot {
  const review = record(raw, ['decisions', 'duplicates'], '자료 검토');
  const next = structuredClone(snapshot);
  const targets = new Set(options.bindingIds ?? next.bindings.map(binding => binding.id));
  if ([...targets].some(id => !next.bindings.some(binding => binding.id === id))) throw new WhyNotError('검토 대상은 저장된 자료 연결이어야 합니다.', 502);
  const seen = new Set<string>();
  for (const rawDecision of list(review.decisions, 40, '판정')) {
    const decision = record(rawDecision, ['bindingId', 'verdict', 'reason', 'missingRequirements', 'metadata'], '자료 판정');
    const binding = next.bindings.find(binding => binding.id === decision.bindingId);
    if (!binding || !targets.has(binding.id) || seen.has(binding.id)) throw new WhyNotError('판정은 지정한 자료 연결을 정확히 한 번씩 참조해야 합니다.', 502);
    seen.add(binding.id);
    Object.assign(binding, { verdict: decision.verdict, reason: decision.reason, missingRequirements: decision.missingRequirements, metadata: decision.metadata, evaluator: 'model-review', decisionVersion: version });
  }
  if (seen.size !== targets.size) throw new WhyNotError('저장된 자료 연결의 판정 일부가 누락되었습니다.', 502);
  for (const rawDuplicate of list(review.duplicates, 80, '중복 판정')) {
    const duplicate = record(rawDuplicate, ['parentId', 'left', 'right', 'verdict', 'reason'], '중복 판정');
    const left = next.bindings.find(binding => binding.id === duplicate.left); const right = next.bindings.find(binding => binding.id === duplicate.right);
    if (!left || !right || left.id === right.id || !targets.has(left.id) && !targets.has(right.id) || left.requirementId !== duplicate.parentId || right.requirementId !== duplicate.parentId) throw new WhyNotError('중복 판정은 같은 조건의 실제 검토 자료를 참조해야 합니다.', 502);
    if (next.duplicates.some(old => old.parentId === duplicate.parentId && (old.left === left.id && old.right === right.id || old.left === right.id && old.right === left.id))) throw new WhyNotError('저장된 중복 판정을 덮어쓰거나 반복할 수 없습니다.', 502);
    next.duplicates.push({ parentId: left.requirementId, left: left.id, right: right.id, verdict: duplicate.verdict as WhySnapshot['duplicates'][number]['verdict'], reason: duplicate.reason as string, leftQuote: left.quote, rightQuote: right.quote });
  }
  next.decisionVersion = version;
  next.coverage = { complete: false, note: '검색으로 선택한 원문 발췌 및 사용자 보완 범위입니다. 전체 자료의 부재를 단정하지 않습니다.' };
  return parseWhySnapshot(next);
}
