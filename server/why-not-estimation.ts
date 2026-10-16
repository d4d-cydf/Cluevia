import type { WhyModelEstimation, WhySnapshot } from '../src/types/why-not.ts';
import { parseWhySnapshot, WhyNotError } from './why-not-contract.ts';
import { sourceGradeCoefficient } from '../src/lib/confidence-grade.ts';

const str = { type: 'string' };
const obj = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const anchorsSchema = { type: 'array', maxItems: 16, items: obj({ evidenceId: str, quote: str }) };
export const whyEstimationSchema = obj({
  prior: obj({ probability: { type: ['number', 'null'], minimum: .01, maximum: .99 }, reason: str, anchors: anchorsSchema }),
  bindings: { type: 'array', maxItems: 40, items: obj({ bindingId: str, ratio: { type: ['number', 'null'], minimum: .01, maximum: 100 }, reason: str, anchors: anchorsSchema }) },
  sources: { type: 'array', maxItems: 40, items: obj({ evidenceId: str, grade: { enum: ['A', 'B', 'C', 'D', 'E', 'F', null] }, reason: str, anchors: anchorsSchema }) },
});
const supplied = (value: number | null | undefined, basis?: string) => value !== null && value !== undefined && basis !== 'UNASSESSED';
function currentPrior(snapshot: WhySnapshot) {
  const requirements = snapshot.nodes.filter(node => node.kind === 'requirement');
  return snapshot.policy.bayes?.priors.find(prior => prior.nodeId === snapshot.rootId)
    ?? (requirements.length === 1 ? snapshot.policy.bayes?.priors.find(prior => prior.nodeId === requirements[0].id) : undefined);
}
export function estimationContext(snapshot: WhySnapshot) {
  const prior = currentPrior(snapshot);
  const bindings = snapshot.bindings.filter(binding => !supplied(binding.likelihood?.ratio, binding.likelihood?.basis));
  const boundEvidence = new Set(snapshot.bindings.map(binding => binding.evidenceId));
  const sources = snapshot.evidence.filter(source => source.sourceGrade === null && boundEvidence.has(source.id));
  const needsPrior = !supplied(prior?.probability, prior?.basis);
  const evidenceIds = [...new Set([...bindings.map(binding => binding.evidenceId), ...sources.map(source => source.id), ...(needsPrior ? [...boundEvidence] : [])])];
  return { goal: snapshot.goal, rootId: snapshot.rootId, nodes: snapshot.nodes,
    prior: { eligible: needsPrior, current: prior ?? null },
    bindings: bindings.map(binding => ({ id: binding.id, evidenceId: binding.evidenceId, requirementId: binding.requirementId, quote: binding.quote, verdict: binding.verdict, reason: binding.reason })),
    sources: sources.map(({ id, name, kind, url, originalVerified, sourceReason }) => ({ id, name, kind, url, originalVerified, sourceReason })),
    targets: { prior: needsPrior, bindingIds: bindings.map(binding => binding.id), sourceIds: sources.map(source => source.id), evidenceIds },
    hasTargets: evidenceIds.length > 0 && (needsPrior || bindings.length > 0 || sources.length > 0), bounds: { prior: [.01, .99], ratio: [.01, 100] } };
}
/** Require an explicit answer, including a reasoned null, for every requested
 * source. Classification remains a model judgment, never a domain-name rule. */
export function estimationSchema(context: ReturnType<typeof estimationContext>) {
  const schema = structuredClone(whyEstimationSchema);
  const ids = context.targets.sourceIds;
  if (ids.length <= 40) schema.properties.sources = { type: 'array', minItems: ids.length, maxItems: ids.length,
    items: obj({ evidenceId: ids.length ? { type: 'string', enum: ids } : str,
      grade: { enum: ['A', 'B', 'C', 'D', 'E', 'F', null] }, reason: { type: 'string', minLength: 1 }, anchors: anchorsSchema }) };
  return schema;
}
function object(value: unknown, allowed: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new WhyNotError(`${label}: 허용되지 않은 추정 응답입니다.`, 502);
  return value as Record<string, unknown>;
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > 40) throw new WhyNotError(`${label}: 추정 배열 형식이 올바르지 않습니다.`, 502);
  return value;
}
function reason(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new WhyNotError('추정 이유가 없거나 너무 깁니다.', 502);
  return value;
}

/** Fills unknown model inputs only; invalid individual estimates remain neutral.
 * Unknown IDs/structural mutations fail instead of silently targeting other data. */
export function applyWhyEstimation(snapshot: WhySnapshot, raw: unknown, options: { model: string; estimatedAt?: string }): WhySnapshot {
  const response = object(raw, ['prior', 'bindings', 'sources'], 'Confidence 추정');
  const next = structuredClone(snapshot); const context = estimationContext(snapshot);
  const notes: string[] = [];
  const estimatedAt = options.estimatedAt ?? new Date().toISOString();
  if (typeof options.model !== 'string' || !options.model.trim() || options.model.length > 200 || !Number.isFinite(Date.parse(estimatedAt))) throw new WhyNotError('추정 실행 메타데이터가 올바르지 않습니다.', 502);
  function provenance(value: unknown): WhyModelEstimation {
    if (!Array.isArray(value) || !value.length || value.length > 16) throw new WhyNotError('실제 자료의 추정 인용이 필요합니다.', 502);
    const anchors = value.map(rawAnchor => {
      const anchor = object(rawAnchor, ['evidenceId', 'quote'], '추정 인용');
      const source = next.evidence.find(source => source.id === anchor.evidenceId);
      if (!source || typeof anchor.quote !== 'string' || !anchor.quote.trim() || anchor.quote.length > 5000 || !source.text.includes(anchor.quote)) throw new WhyNotError('추정 인용이 실제 자료와 일치하지 않습니다.', 502);
      const start = source.text.indexOf(anchor.quote);
      return { evidenceId: source.id, quote: anchor.quote, start, end: start + anchor.quote.length };
    });
    return { model: options.model, effort: 'low', estimatedAt, anchors };
  }
  function apply(label: string, update: () => void) {
    try { update(); } catch (error) { notes.push(`${label}: ${error instanceof Error ? error.message : '추정 검증 실패'} 중립 기본값을 유지합니다.`); }
  }
  const policy: NonNullable<WhySnapshot['policy']['bayes']> = next.policy.bayes ?? { priors: [], conditionalIndependence: [] };
  const existingPrior = currentPrior(snapshot);
  // Preserve the hypothesis of legacy manual values before activating goal estimates.
  if (policy.target !== 'GOAL' && snapshot.nodes.filter(node => node.kind === 'requirement').length > 1) {
    for (const binding of next.bindings) if (supplied(binding.likelihood?.ratio, binding.likelihood?.basis) && !binding.likelihood!.hypothesisId) binding.likelihood!.hypothesisId = binding.requirementId;
  }
  policy.target = 'GOAL'; next.policy.bayes = policy;
  if (!context.targets.prior && existingPrior && existingPrior.nodeId !== next.rootId) policy.priors.push({ ...structuredClone(existingPrior), nodeId: next.rootId });
  const prior = object(response.prior, ['probability', 'reason', 'anchors'], '목표 사전확률');
  if (context.targets.prior && prior.probability !== null) apply('목표 사전확률', () => {
    if (typeof prior.probability !== 'number' || !Number.isFinite(prior.probability) || prior.probability < .01 || prior.probability > .99) throw new WhyNotError('모델 사전확률 범위는 .01–.99입니다.', 502);
    const entry = { nodeId: next.rootId, probability: prior.probability, reason: reason(prior.reason), basis: 'MODEL_ESTIMATE' as const, estimation: provenance(prior.anchors) };
    policy.priors = [...policy.priors.filter(old => old.nodeId !== next.rootId), entry];
  });
  const seenBindings = new Set<string>();
  for (const rawBinding of array(response.bindings, '우도비')) {
    const item = object(rawBinding, ['bindingId', 'ratio', 'reason', 'anchors'], '우도비');
    const binding = next.bindings.find(binding => binding.id === item.bindingId);
    if (!binding || seenBindings.has(binding.id)) throw new WhyNotError('우도비 추정에 없거나 중복된 자료 연결 ID가 있습니다.', 502);
    seenBindings.add(binding.id);
    if (!context.targets.bindingIds.includes(binding.id) || item.ratio === null) continue;
    apply(binding.id, () => {
      if (typeof item.ratio !== 'number' || !Number.isFinite(item.ratio) || item.ratio < .01 || item.ratio > 100) throw new WhyNotError('모델 우도비 범위는 .01–100입니다.', 502);
      if (binding.verdict === 'SUPPORTED' && item.ratio < 1 || binding.verdict === 'REFUTED' && item.ratio > 1 || !['SUPPORTED', 'REFUTED'].includes(binding.verdict) && item.ratio !== 1) throw new WhyNotError('판정과 맞지 않는 우도비는 적용하지 않습니다.', 502);
      const estimation = provenance(item.anchors);
      if (!estimation.anchors.some(anchor => anchor.evidenceId === binding.evidenceId && anchor.start >= binding.start && anchor.end <= binding.end)) throw new WhyNotError('이 자료 연결의 정확한 인용이 필요합니다.', 502);
      binding.likelihood = { ratio: item.ratio, reason: reason(item.reason), basis: 'MODEL_ESTIMATE', hypothesisId: next.rootId, estimation };
    });
  }
  const seenSources = new Set<string>();
  for (const rawSource of array(response.sources, '출처')) {
    const item = object(rawSource, ['evidenceId', 'grade', 'reason', 'anchors'], '출처');
    const source = next.evidence.find(source => source.id === item.evidenceId);
    if (!source || seenSources.has(source.id)) throw new WhyNotError('출처 추정에 없거나 중복된 자료 ID가 있습니다.', 502);
    seenSources.add(source.id);
    if (!context.targets.sourceIds.includes(source.id)) continue;
    if (item.grade === null) {
      apply(source.id, () => {
        source.sourceReason = `출처 등급 보류: ${reason(item.reason)}`.slice(0, 2000);
        notes.push(`${source.id}: ${source.sourceReason}`);
      });
      continue;
    }
    apply(source.id, () => {
      if (typeof item.grade !== 'string' || !['A', 'B', 'C', 'D', 'E', 'F'].includes(item.grade)) throw new WhyNotError('출처 등급은 A–F입니다.', 502);
      if (item.grade === 'A' && !source.originalVerified) throw new WhyNotError('A등급은 저장된 원자료 검증 근거가 필요합니다.', 502);
      const estimation = provenance(item.anchors);
      if (!estimation.anchors.some(anchor => anchor.evidenceId === source.id)) throw new WhyNotError('출처 추정에 해당 원문의 인용이 필요합니다.', 502);
      const sourceReason = reason(item.reason);
      source.sourceGrade = item.grade as NonNullable<typeof source.sourceGrade>;
      source.sourceCoefficient = sourceGradeCoefficient(source.sourceGrade); source.sourceReason = sourceReason; source.sourceEstimation = estimation;
    });
  }
  for (const id of context.targets.sourceIds) if (!seenSources.has(id)) {
    const source = next.evidence.find(source => source.id === id)!;
    source.sourceReason = '모델 응답에서 이 자료의 출처 등급 평가가 누락되었습니다. 미평가 상태를 유지합니다.';
    notes.push(`${id}: ${source.sourceReason}`);
  }
  policy.estimationNotes = notes;
  return parseWhySnapshot(next);
}
