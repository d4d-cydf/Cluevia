import type { BayesianBindingTrace, BayesianConfidence, BayesianNodeTrace, WhyBinding, WhyEventRule, WhySnapshot } from '../src/types/why-not.ts';
import { confidenceGrade, sourceGradeCoefficient } from '../src/lib/confidence-grade.ts';
import { contentHash } from './why-not-contract.ts';

type EventCheck = (rule: WhyEventRule, bindings: WhyBinding[]) => { result: 'MATCH' | 'MISMATCH' | 'UNKNOWN' };
const unique = <T,>(values: T[]) => [...new Set(values)];
const finiteLog = (value: number) => value === 0 ? null : Math.log(value);
function update(prior: number, ratios: number[]): { posterior: number | null; logLR: number | null } {
  const zero = ratios.includes(0);
  const sum = zero ? -Infinity : ratios.reduce((total, ratio) => total + Math.log(ratio), 0);
  const logLR = Number.isFinite(sum) ? sum : null;
  if (prior === 1 && zero) return { posterior: null, logLR }; // zero-probability conditioning event: 0 / 0
  if (prior === 0 || prior === 1) return { posterior: prior, logLR };
  if (zero) return { posterior: 0, logLR };
  const logOdds = Math.log(prior) - Math.log1p(-prior) + sum;
  const posterior = logOdds >= 0 ? 1 / (1 + Math.exp(-logOdds)) : Math.exp(logOdds) / (1 + Math.exp(logOdds));
  // Positive finite odds cannot reach certainty. Preserve that fact when the
  // logistic expression rounds to 1 or underflows to 0 in binary64 arithmetic.
  return { posterior: Math.max(Number.MIN_VALUE, Math.min(1 - Number.EPSILON / 2, posterior)), logLR };
}

/** Root-goal odds, with user-defined linear reliability discounting.
 * Missing statistics use labelled neutral baselines; they are not measurements. */
export function evaluateBayesianConfidence(snapshot: WhySnapshot, checkEvent: EventCheck, excludedNodes = new Set<string>()): BayesianConfidence {
  const nodes = new Map(snapshot.nodes.map(node => [node.id, node]));
  const evidence = new Map(snapshot.evidence.map(source => [source.id, source]));
  const bindings = new Map(snapshot.bindings.map(binding => [binding.id, binding]));
  const unknownReasons: string[] = [];
  const assumptions = [
    '목표 H의 사후 오즈 = 사전 오즈 × 중복 제거한 보정 LR의 곱입니다.',
    '보정 LR = r × LR + (1 − r). 출처 등급은 A=1, B=.8, C=.6, D=.4, E=.2, F=0이며 자료 계수는 곱하지 않습니다.',
    '통계가 없으면 사전확률 .5, LR 1을 계산 기준값으로 사용합니다. 이는 추정한 역사적 통계가 아닙니다.',
    '같은 목표에 대한 별도 관측의 LR 곱은 H와 ¬H 각각의 조건부 독립성을 가정합니다. 명시한 근거가 없으면 검증되지 않은 제품 모형 가정입니다.',
    '목표 점수를 AND/OR 노드마다 다시 곱하지 않습니다. NOT_SUPPORT도 확률 여집합으로 뒤집지 않습니다.',
  ];
  assumptions.push(...(snapshot.policy.bayes?.estimationNotes ?? []));
  const note = (reason: string) => { if (!unknownReasons.includes(reason)) unknownReasons.push(reason); };
  const assume = (reason: string) => { if (!assumptions.includes(reason)) assumptions.push(reason); };
  const below = new Map<string, string[]>();
  function descendants(id: string): string[] {
    if (below.has(id)) return below.get(id)!;
    const found = bindings.has(id) ? [id] : unique(nodes.get(id)!.children.flatMap(descendants));
    below.set(id, found); return found;
  }
  const rootIds = descendants(snapshot.rootId);
  const requirements = snapshot.nodes.filter(node => node.kind === 'requirement');
  const single = requirements.length === 1;
  const goalCalibrated = snapshot.policy.bayes?.target === 'GOAL';
  const compatible = goalCalibrated || single;
  const suppliedPrior = goalCalibrated
    ? snapshot.policy.bayes?.priors.find(prior => prior.nodeId === snapshot.rootId)
    : single ? snapshot.policy.bayes?.priors.find(prior => prior.nodeId === requirements[0].id) : undefined;
  const prior = suppliedPrior?.probability ?? .5;
  const priorBasis = suppliedPrior?.probability === undefined || suppliedPrior.probability === null ? 'BASELINE' as const : 'PROVIDED' as const;
  if (priorBasis === 'BASELINE') assume('목표 사전확률의 통계가 없어 .5 기준값을 사용했습니다.');
  if (!compatible && snapshot.bindings.some(binding => binding.likelihood?.ratio !== null && binding.likelihood !== undefined)) assume('이전 조건별 LR을 전체 목표의 LR로 재해석하지 않았습니다. 목표 기준으로 재검토할 때까지 LR 1을 사용합니다.');
  const excluded = new Set([...excludedNodes].flatMap(descendants));
  const rules = snapshot.nodes.filter(node => node.eventRuleId).map(node => ({ node, rule: snapshot.eventRules.find(rule => rule.id === node.eventRuleId)! }));
  const traces: BayesianBindingTrace[] = snapshot.bindings.map(binding => {
    const source = evidence.get(binding.evidenceId)!;
    const hypothesisCompatible = !binding.likelihood?.hypothesisId || binding.likelihood.hypothesisId === snapshot.rootId || single && binding.likelihood.hypothesisId === requirements[0].id;
    const provided = compatible && hypothesisCompatible && binding.likelihood?.ratio !== null && binding.likelihood?.ratio !== undefined && binding.likelihood.basis !== 'UNASSESSED';
    const lr = provided ? binding.likelihood!.ratio! : 1;
    const directionValid = binding.verdict === 'SUPPORTED' ? lr >= 1 : binding.verdict === 'REFUTED' ? lr <= 1 : lr === 1;
    const r = sourceGradeCoefficient(source.sourceGrade);
    const adjusted = r === 0 ? 1 : r * lr + (1 - r);
    const trace: BayesianBindingTrace = { bindingId: binding.id, evidenceId: binding.evidenceId, requirementId: binding.requirementId, observationId: null,
      rawLikelihoodRatio: lr, basis: provided ? binding.likelihood!.basis : 'UNASSESSED', likelihoodBasis: provided ? 'PROVIDED' : 'BASELINE', sourceCoefficient: r,
      materialCoefficient: binding.materialCoefficient, weight: r, adjustedLikelihoodRatio: adjusted, adjustedLogLikelihoodRatio: finiteLog(adjusted), status: 'USED',
      reason: `등급 ${source.sourceGrade ?? '미상'}의 고정 r=${r}: ${r} × ${lr} + (1 − ${r}) = ${adjusted}. 자료 계수는 사용하지 않습니다.` };
    if (!provided) assume(`${binding.id}: 우도비 통계가 없어 중립 LR 1을 사용했습니다.`);
    if (source.sourceGrade === null) assume(`${binding.id}: 출처 등급 미상은 r=0으로 두어 증거 영향만 중립화했습니다.`);
    if (binding.verdict === 'IRRELEVANT' || excluded.has(binding.id) || !rootIds.includes(binding.id)) {
      trace.status = 'EXCLUDED'; trace.reason = '현재 목표의 관련 자료 또는 적격 경로가 아니어서 업데이트에서 제외합니다.';
    } else if (rules.some(({ node, rule }) => descendants(node.id).includes(binding.id) && checkEvent(rule, [binding]).result === 'MISMATCH')) {
      trace.status = 'EXCLUDED'; trace.reason = '지정한 사건과 일치하지 않아 업데이트에서 제외합니다.';
    } else if (r > 0 && (source.processingStatus !== 'READY' || provided && !directionValid)) {
      trace.status = 'UNASSESSED'; trace.adjustedLikelihoodRatio = 1; trace.adjustedLogLikelihoodRatio = 0;
      trace.reason = '자료 처리 또는 판정과 LR 방향을 확인하기 전에는 이 입력의 효과를 LR 1로 보류합니다.'; note(`${binding.id}: ${trace.reason}`);
    }
    return trace;
  });
  const byBinding = new Map(traces.map(trace => [trace.bindingId, trace]));
  const parent = new Map(snapshot.evidence.map(source => [source.id, source.id]));
  const sourceRoot = (id: string): string => { const next = parent.get(id)!; if (next === id) return id; const root = sourceRoot(next); parent.set(id, root); return root; };
  for (const link of snapshot.provenance) if (link.verified && (link.likelihood.kind === 'NO_NEW_INFORMATION' || link.likelihood.kind === 'ESTIMATED_LR' && link.likelihood.value === 1)) parent.set(sourceRoot(link.from), sourceRoot(link.to));
  const sameObservation = (left: WhyBinding, right: WhyBinding) => {
    const a = evidence.get(left.evidenceId)!; const b = evidence.get(right.evidenceId)!;
    return a.contentHash === b.contentHash && left.start === right.start && left.end === right.end && left.quote === right.quote
      || left.atomId !== null && left.atomId === right.atomId
      || left.evidenceId !== right.evidenceId && sourceRoot(left.evidenceId) === sourceRoot(right.evidenceId) && left.quote === right.quote
        && !snapshot.duplicates.some(item => item.verdict === 'DISTINCT' && (item.left === left.id && item.right === right.id || item.right === left.id && item.left === right.id))
      || snapshot.duplicates.some(item => ['EXACT_DUPLICATE', 'SAME_OBSERVATION'].includes(item.verdict) && (item.left === left.id && item.right === right.id || item.right === left.id && item.left === right.id));
  };
  const groups: string[][] = [];
  for (const trace of traces.filter(trace => trace.status !== 'EXCLUDED').sort((a, b) => a.bindingId.localeCompare(b.bindingId))) {
    const matching = groups.filter(group => group.some(id => sameObservation(bindings.get(trace.bindingId)!, bindings.get(id)!)));
    const merged = [trace.bindingId, ...matching.flat()].sort();
    for (const group of matching) groups.splice(groups.indexOf(group), 1);
    groups.push(merged);
  }
  for (const group of groups) {
    const values = group.map(id => byBinding.get(id)!);
    const observationId = `observation-${contentHash(JSON.stringify(group)).slice(0, 20)}`;
    values.forEach(value => { value.observationId = observationId; });
    if (new Set(values.map(value => value.adjustedLikelihoodRatio)).size > 1 || values.some(value => value.status === 'UNASSESSED')) {
      values.forEach(value => { value.status = 'UNASSESSED'; value.adjustedLikelihoodRatio = 1; value.adjustedLogLikelihoodRatio = 0; value.reason = '같은 관측의 서로 다른 평가를 선택하지 않고 중립 LR 1로 보류합니다.'; });
      note(`${group.join(', ')}: 같은 관측의 LR 또는 등급 평가를 먼저 일치시켜야 합니다.`);
    } else values.slice(1).forEach(value => { value.status = 'DUPLICATE'; value.reason = '같은 관측은 한 번만 계산합니다.'; });
  }
  // Partial overlap and verified shared lineage are known dependencies, even if
  // an independence declaration was supplied. Keep their observation identities
  // distinct, but do not multiply marginal LRs without a joint likelihood.
  const dependent = groups.map((_, index) => index);
  const dependencyRoot = (index: number): number => {
    if (dependent[index] !== index) dependent[index] = dependencyRoot(dependent[index]);
    return dependent[index];
  };
  const overlapLinks: number[] = [];
  for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
    const left = groups[i]; const right = groups[j];
    const overlap = snapshot.duplicates.some(item => item.verdict === 'PARTIAL_OVERLAP' && (left.includes(item.left) && right.includes(item.right) || left.includes(item.right) && right.includes(item.left)));
    const lineage = left.some(a => right.some(b => { const x = bindings.get(a)!.evidenceId; const y = bindings.get(b)!.evidenceId; return x !== y && sourceRoot(x) === sourceRoot(y); }));
    if (!overlap && !lineage) continue;
    dependent[dependencyRoot(j)] = dependencyRoot(i);
    if (overlap) overlapLinks.push(i);
  }
  const components = new Map<number, string[]>();
  groups.forEach((group, index) => {
    const root = dependencyRoot(index); components.set(root, [...(components.get(root) ?? []), ...group]);
  });
  const overlapRoots = new Set(overlapLinks.map(dependencyRoot));
  for (const [root, ids] of components) {
    if (!groups.some((_, index) => index !== root && dependencyRoot(index) === root)) continue;
    if (!ids.some(id => byBinding.get(id)!.adjustedLikelihoodRatio !== 1)) continue;
    const overlap = overlapRoots.has(root);
    const reason = overlap ? '부분 중복(PARTIAL_OVERLAP)으로 연결된 관측은 공동 LR이 없어 중립으로 보류합니다.' : '검증된 동일 출처 계보의 서로 다른 관측은 공동 LR이 없어 중립으로 보류합니다.';
    for (const id of ids) { const value = byBinding.get(id)!; value.status = 'UNASSESSED'; value.adjustedLikelihoodRatio = 1; value.adjustedLogLikelihoodRatio = 0; value.reason = reason; }
    note(overlap ? `${ids.join(', ')}: 부분 중복 관측의 의존성이 남아 있어 해당 묶음의 업데이트를 보류했습니다.` : '동일 출처 계보의 관측 의존성이 남아 있어 해당 묶음의 업데이트를 보류했습니다.');
  }
  const used = traces.filter(trace => trace.status === 'USED');
  if (used.filter(trace => trace.adjustedLikelihoodRatio !== 1).length > 1 && !snapshot.policy.bayes?.conditionalIndependence.length) assume('별도 관측의 조건부 독립성은 명시적 검증값이 없는 제품 계산 가정입니다.');
  const updated = update(prior, used.map(trace => trace.adjustedLikelihoodRatio!));
  const rawUsed = used.filter(trace => {
    const binding = bindings.get(trace.bindingId)!;
    return evidence.get(binding.evidenceId)!.processingStatus === 'READY' && (trace.rawLikelihoodRatio === 1 || binding.verdict === 'SUPPORTED' && trace.rawLikelihoodRatio! >= 1 || binding.verdict === 'REFUTED' && trace.rawLikelihoodRatio! <= 1);
  });
  const baseline = update(prior, rawUsed.map(trace => trace.rawLikelihoodRatio!));
  if (baseline.posterior === null) note('보정 전 비교에서 사전확률 1과 원래 LR 0이 충돌하여 비교 점수는 0–1 범위의 하한 0으로 표시합니다.');
  if (updated.posterior === null) note('사전확률 1과 보정 LR 0이 충돌하여 조건부 확률의 분모가 0입니다. 0–1 범위의 하한을 표시합니다.');
  const range: [number, number] = updated.posterior === null ? [0, 1] : [updated.posterior, updated.posterior];
  const score = updated.posterior ?? range[0];
  const threshold = snapshot.policy.threshold ?? nodes.get(snapshot.rootId)!.threshold;
  const sufficient = threshold === null ? null : range[0] >= threshold ? true : range[1] < threshold ? false : null;
  const nodeTrace: BayesianNodeTrace[] = snapshot.nodes.map(node => {
    const ids = descendants(node.id);
    const localObservations = new Set(ids.map(id => byBinding.get(id)!.observationId).filter(id => id !== null));
    const local = node.id === snapshot.rootId ? updated : update(prior, used.filter(trace => trace.observationId !== null && localObservations.has(trace.observationId)).map(trace => trace.adjustedLikelihoodRatio!));
    return { nodeId: node.id, operator: node.operator, prior, priorBasis, posterior: local.posterior, range: local.posterior === null ? [0, 1] : [local.posterior, local.posterior], logLikelihoodRatio: local.logLR, bindingIds: ids,
      reason: node.id === snapshot.rootId ? '동일 목표 H에 대한 전체 고유 관측의 선형 보정 LR로 계산합니다.' : '이 연결 아래의 관측만 반영한 목표 H의 참고 점수이며, 별도 하위 가설의 확률이 아닙니다.' };
  });
  return { method: 'LINEAR_RELIABILITY_BAYES', status: unknownReasons.length || !snapshot.coverage.complete ? 'PARTIAL' : 'ASSESSED',
    score, baselineScore: baseline.posterior ?? 0, grade: confidenceGrade(score), scoreBasis: updated.posterior === null ? 'CONSERVATIVE_LOWER_BOUND' : 'POSTERIOR', posterior: updated.posterior, range, threshold, sufficient,
    reason: updated.posterior === null ? '모순된 경계 입력 때문에 보수적 하한을 표시합니다.' : '고정 출처 등급과 목표 기준 사전확률·우도비로 계산한 모형 점수입니다. 기본값과 미확인 가정은 별도로 표시합니다.',
    unknownReasons, assumptions, trace: nodeTrace, bindings: traces };
}
