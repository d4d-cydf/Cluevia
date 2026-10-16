import type { WhyAction, WhyBinding, WhyConfidence, WhyEventRule, WhyGap, WhyResult, WhySnapshot, WhyWitness } from '../src/types/why-not.ts';
import { contentHash, parseWhySnapshot } from './why-not-contract.ts';
import { evaluateBayesianConfidence } from './why-not-bayes.ts';

const stable = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const distinct = (values: string[]) => [...new Set(values)].sort(stable);
const key = (value: unknown) => contentHash(JSON.stringify(value)).slice(0, 24);
type Range = [number, number];

const naturalEventFields = new Set(['actor', 'location', 'origin', 'destination', 'person', 'organization', 'place']);
const writingSystems = [/\p{Script=Latin}/u, /\p{Script=Hangul}/u, /\p{Script=Han}/u, /\p{Script=Hiragana}/u, /\p{Script=Katakana}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u, /\p{Script=Arabic}/u, /\p{Script=Hebrew}/u];
function differentWritingSystems(left: string, right: string): boolean {
  const a = writingSystems.filter(script => script.test(left));
  const b = writingSystems.filter(script => script.test(right));
  return a.length > 0 && b.length > 0 && !a.some(script => b.includes(script));
}

/** Compare the complete witness, never just a sequence of pairwise intersections. */
export function checkWhyEvent(rule: WhyEventRule, bindings: WhyBinding[]) {
  const observed = bindings.map(b => ({ binding: b.id, requirement: b.requirementId, fields: Object.fromEntries(b.metadata.fields.map(f => [f.key, f.value])), start: b.metadata.start, end: b.metadata.end }));
  let unknown = false;
  for (const field of rule.fields) {
    const expected = rule.expected.find(e => e.key === field)?.value;
    const values = observed.map(item => Object.hasOwn(item.fields, field) ? item.fields[field] : undefined);
    if (values.some(value => value === undefined)) unknown = true;
    const known = values.filter((value): value is string => value !== undefined);
    // Literal quotations cannot be translated in metadata. Different scripts in
    // natural-language labels need entity review, not a fabricated match or a
    // definite mismatch. Dates, identifiers and later constraints still apply.
    const labels = expected === undefined ? known : [...known, expected];
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
      if (labels[i] === labels[j]) continue;
      if (naturalEventFields.has(field.toLowerCase()) && differentWritingSystems(labels[i], labels[j])) unknown = true;
      else return { ruleId: rule.id, result: 'MISMATCH' as const, expected: rule, observed };
    }
  }
  if (rule.requireTime || rule.kind === 'ORDERED_EVENTS') {
    if (observed.some(item => !item.start)) unknown = true;
    const times = observed.filter(item => item.start).map(item => ({ ...item, from: Date.parse(item.start!), to: Date.parse(item.end ?? item.start!) }));
    if (rule.kind === 'SAME_EVENT' && times.length && Math.max(...times.map(t => t.from)) > Math.min(...times.map(t => t.to))) return { ruleId: rule.id, result: 'MISMATCH' as const, expected: rule, observed };
    if (rule.kind === 'ORDERED_EVENTS') for (let i = 1; i < rule.order.length; i++) {
      const before = times.filter(t => t.requirement === rule.order[i - 1]); const after = times.filter(t => t.requirement === rule.order[i]);
      if (!before.length || !after.length) unknown = true;
      else if (Math.max(...before.map(t => t.to)) > Math.min(...after.map(t => t.from))) return { ruleId: rule.id, result: 'MISMATCH' as const, expected: rule, observed };
    }
  }
  if (!bindings.length) unknown = true;
  return { ruleId: rule.id, result: unknown ? 'UNKNOWN' as const : 'MATCH' as const, expected: rule, observed };
}

/** DNF is only a Boolean scoring representation. Witness/requirement records remain intact. */
function simplify(terms: string[][]): string[][] {
  const unique = [...new Map(terms.map(t => { const term = distinct(t); return [JSON.stringify(term), term]; })).values()].sort((a, b) => a.length - b.length || stable(JSON.stringify(a), JSON.stringify(b)));
  return unique.filter((term, i) => !unique.slice(0, i).some(other => other.every(atom => term.includes(atom))));
}
export function evaluateWhyFormula(terms: string[][], probabilities: Map<string, number>, maxStates: number): number | null {
  const memo = new Map<string, number>(); let states = 0; let limited = false;
  function visit(formula: string[][]): number {
    if (!formula.length) return 0;
    if (formula.some(term => !term.length)) return 1;
    const label = JSON.stringify(formula);
    const cached = memo.get(label); if (cached !== undefined) return cached;
    if (++states > maxStates) { limited = true; return 0; }
    const atom = formula[0][0]; const p = probabilities.get(atom)!;
    const yes = simplify(formula.map(term => term.filter(id => id !== atom)));
    const no = simplify(formula.filter(term => !term.includes(atom)));
    const result = p * visit(yes) + (1 - p) * visit(no);
    memo.set(label, result); return result;
  }
  const result = visit(simplify(terms));
  return limited ? null : Math.max(0, Math.min(1, result));
}

function confidenceFor(terms: string[][], atoms: WhyConfidence['atoms'], snapshot: WhySnapshot, threshold: number | null): WhyConfidence {
  terms = simplify(terms);
  const used = distinct(terms.flat()); const values = atoms.filter(a => used.includes(a.id));
  const base: WhyConfidence = { supportScore: null, range: null, threshold, sufficient: null, atoms: values, trace: [], method: 'UNASSESSED', reason: '적격 증거 체인이 없습니다.' };
  if (!terms.length) return base;
  if (values.some(a => a.score === null)) return { ...base, reason: '출처 또는 자료 품질 점수·공유 관측의 일관된 평가가 필요합니다.' };
  const probabilities = new Map(values.map(a => [a.id, a.score!]));
  const sourceDependency = hasKnownSourceDependency(values, snapshot);
  const independent = !sourceDependency && (used.length <= 1 || snapshot.policy.independence.some(group => used.every(id => group.atomIds.includes(id))));
  let range: Range;
  if (independent) {
    const score = evaluateWhyFormula(terms, probabilities, snapshot.policy.maxStates);
    if (score === null) return { ...base, reason: 'SCORE_STATE_LIMIT: 공유 변수 계산 예산에 도달했습니다.' };
    range = [score, score]; base.supportScore = score; base.method = 'SHARED_ATOMS';
    base.reason = used.length > 1 ? '명시적으로 입력한 독립성 가정 아래 공유 관측을 한 번씩 계산한 제품 지지 점수입니다.' : '공유 관측을 중복 가산하지 않은 제품 지지 점수입니다.';
  } else {
    // Bonferroni/Fréchet bounds for a union of conjunctions; valid but not necessarily tight.
    const bounds = terms.map(term => [Math.max(0, term.reduce((sum, id) => sum + probabilities.get(id)!, 0) - term.length + 1), Math.min(...term.map(id => probabilities.get(id)!))] as Range);
    range = [Math.max(...bounds.map(b => b[0])), Math.min(1, bounds.reduce((sum, b) => sum + b[1], 0))];
    base.method = 'CONSERVATIVE_BOUNDS';
    base.reason = sourceDependency
      ? '추가 정보가 없다고 확인한 출처 계보가 있어 독립성 선언을 적용하지 않았습니다. 공유 관측을 구분할 때까지 보수적 범위만 표시하며, 진실 확률이 아닙니다.'
      : '독립성이 확인되지 않아 보수적 범위를 표시합니다. 통계적으로 보정된 진실 확률이 아닙니다.';
  }
  base.range = range;
  base.sufficient = threshold === null ? null : range[0] >= threshold ? true : range[1] < threshold ? false : null;
  return base;
}

/** A verified reprint chain defeats an independence assertion, but does not
 * establish that every quotation in those documents is the same observation.
 * Keep distinct atoms and conservative bounds until their shared parts are reviewed. */
function hasKnownSourceDependency(atoms: WhyConfidence['atoms'], snapshot: WhySnapshot): boolean {
  if (atoms.length < 2) return false;
  const parent = new Map(snapshot.evidence.map(evidence => [evidence.id, evidence.id]));
  const root = (id: string): string => {
    const next = parent.get(id)!;
    if (next === id) return id;
    const result = root(next); parent.set(id, result); return result;
  };
  for (const link of snapshot.provenance) {
    if (link.verified && (link.likelihood.kind === 'NO_NEW_INFORMATION' || link.likelihood.kind === 'ESTIMATED_LR' && link.likelihood.value === 1)) parent.set(root(link.from), root(link.to));
  }
  const bindings = new Map(snapshot.bindings.map(binding => [binding.id, binding]));
  const sources = atoms.map(atom => distinct(atom.bindingIds.map(id => bindings.get(id)!.evidenceId)));
  return sources.some((left, index) => sources.slice(index + 1).some(right => left.some(a => right.some(b => a !== b && root(a) === root(b)))));
}

export function traceWhySources(snapshot: WhySnapshot): WhyResult['provenance'] {
  const sources = new Map(snapshot.evidence.map(e => [e.id, e])); const traces: WhyResult['provenance'] = []; let visits = 0;
  for (const source of snapshot.evidence) {
    const walk = (id: string, path: string[], seen: Set<string>, likelihoods: WhyResult['provenance'][number]['likelihoods']) => {
      const evidence = sources.get(id)!;
      const identity = evidence.url ? new URL(evidence.url) : null;
      if (identity) identity.hash = '';
      const identities = [evidence.contentHash, identity?.href].filter((s): s is string => !!s);
      const finish = (stop: string) => traces.push({ evidenceId: source.id, visited: [...path, id], stop, likelihoods });
      if (identities.some(i => seen.has(i))) { finish('CYCLE_DETECTED'); return; }
      if (visits >= snapshot.policy.maxVisits) { finish('FETCH_LIMIT'); return; }
      visits++;
      if (evidence.originalVerified && evidence.sourceCoefficient === 1 && snapshot.policy.trustedSourceTypes.some(t => t.type === evidence.sourceType)) { finish('TRUSTED_ORIGIN_REACHED'); return; }
      if (path.length >= snapshot.policy.maxDepth) { finish('DEPTH_LIMIT'); return; }
      const links = snapshot.provenance.filter(p => p.from === id).sort((a, b) => stable(a.to, b.to));
      if (!links.length) { finish('NO_REFERENCE'); return; }
      for (const link of links) {
        const next = [...likelihoods, link.likelihood];
        if (!link.verified) { traces.push({ evidenceId: source.id, visited: [...path, id, link.to], stop: 'UNVERIFIED_REFERENCE', likelihoods: next }); continue; }
        if (link.likelihood.kind === 'NO_NEW_INFORMATION' || link.likelihood.value === 1) { traces.push({ evidenceId: source.id, visited: [...path, id, link.to], stop: 'NO_NEW_INFORMATION', likelihoods: next }); continue; }
        walk(link.to, [...path, id], new Set([...seen, ...identities]), next);
      }
    };
    walk(source.id, [], new Set(), []);
  }
  return traces;
}

export function evaluateWhyNot(input: WhySnapshot): WhyResult {
  const snapshot = parseWhySnapshot(input);
  const nodes = new Map(snapshot.nodes.map(n => [n.id, n])); const bindings = new Map(snapshot.bindings.map(b => [b.id, b])); const evidence = new Map(snapshot.evidence.map(e => [e.id, e]));
  const gaps: WhyGap[] = []; const limits: string[] = []; let incomplete = !snapshot.coverage.complete || snapshot.bindings.some(b => b.verdict === 'UNREVIEWED' || evidence.get(b.evidenceId)!.processingStatus !== 'READY');
  const addGap = (gap: Omit<WhyGap, 'id' | 'witnessIds' | 'causeGapIds' | 'blockingScope'> & Partial<Pick<WhyGap, 'witnessIds' | 'causeGapIds' | 'blockingScope'>>) => {
    const normalized: WhyGap = { ...gap, id: `gap-${key([gap.type, gap.claimId, gap.requirementIds, gap.evidenceIds, gap.reasonCode, gap.expected, gap.observed])}`, witnessIds: gap.witnessIds ?? [], causeGapIds: gap.causeGapIds ?? [], blockingScope: gap.blockingScope ?? 'ROOT' };
    const prior = gaps.find(g => g.id === normalized.id);
    if (prior) { prior.witnessIds = distinct([...prior.witnessIds, ...normalized.witnessIds]); return prior.id; }
    gaps.push(normalized); return normalized.id;
  };
  const descendants = new Map<string, Set<string>>();
  function below(id: string): Set<string> {
    if (descendants.has(id)) return descendants.get(id)!;
    const set = bindings.has(id) ? new Set([id]) : new Set(nodes.get(id)!.children.flatMap(child => [...below(child)])); descendants.set(id, set); return set;
  }
  below(snapshot.rootId);
  type Candidate = { bindingIds: string[]; chosenBranches: Record<string, string[]> };
  const memo = new Map<string, Candidate[]>();
  function existing(id: string): Candidate[] {
    const cached = memo.get(id); if (cached) return cached;
    const b = bindings.get(id);
    if (b) return evidence.get(b.evidenceId)!.processingStatus === 'READY' && b.quote.trim() ? [{ bindingIds: [id], chosenBranches: {} }] : [];
    const n = nodes.get(id)!;
    if (!n.children.length) return [];
    const children = n.children.map(child => existing(child));
    let found: Candidate[] = [];
    if (n.operator === 'OR') {
      for (let i = 0; i < children.length; i++) for (const c of children[i]) {
        if (found.length >= snapshot.policy.maxCandidates) { incomplete = true; limits.push(`CANDIDATE_LIMIT:${id}`); break; }
        found.push({ bindingIds: c.bindingIds, chosenBranches: { ...c.chosenBranches, [id]: [n.children[i]] } });
      }
    } else if (children.every(c => c.length)) {
      found = [{ bindingIds: [], chosenBranches: { [id]: n.children } }];
      for (const options of children) {
        const next: Candidate[] = [];
        outer: for (const left of found) for (const right of options) {
          if (next.length >= snapshot.policy.maxCandidates) { incomplete = true; limits.push(`CANDIDATE_LIMIT:${id}`); break outer; }
          const chosenBranches = { ...left.chosenBranches };
          for (const [nodeId, chosen] of Object.entries(right.chosenBranches)) chosenBranches[nodeId] = distinct([...(chosenBranches[nodeId] ?? []), ...chosen]);
          next.push({ bindingIds: distinct([...left.bindingIds, ...right.bindingIds]), chosenBranches });
        }
        found = next;
      }
    }
    memo.set(id, found); return found;
  }
  const candidates = existing(snapshot.rootId);
  for (const n of snapshot.nodes.filter(n => n.kind === 'requirement' && !existing(n.id).length)) {
    const pending = [...below(n.id)].some(id => evidence.get(bindings.get(id)!.evidenceId)!.processingStatus !== 'READY');
    incomplete ||= pending;
    addGap({ type: 'EVIDENCE_MISSING', stage: '1-3', claimId: n.id, requirementIds: [n.id], evidenceIds: distinct([...below(n.id)].map(id => bindings.get(id)!.evidenceId)), reasonCode: pending ? 'EVIDENCE_PROCESSING' : 'NO_EXISTING_EVIDENCE', explanation: pending ? '자료 처리가 끝나지 않아 이 요구를 평가할 수 없습니다.' : `필수 자료가 없습니다: ${n.statement}`, expected: n.need, observed: null, evaluationState: pending ? 'PENDING' : 'COMPLETE' });
  }
  const insufficientGap = (b: WhyBinding, witnessIds: string[] = []) => addGap({ type: 'EVIDENCE_INSUFFICIENT', stage: '1-4', claimId: b.requirementId, requirementIds: [b.requirementId], evidenceIds: [b.evidenceId], witnessIds, reasonCode: b.verdict, explanation: b.reason, expected: nodes.get(b.requirementId)!.need, observed: { verdict: b.verdict, quote: b.quote, start: b.start, end: b.end, missingRequirements: b.missingRequirements }, evaluationState: b.verdict === 'UNREVIEWED' ? 'PENDING' : 'COMPLETE' });
  // An empty sibling in an AND can prevent every root witness. The retained
  // material still has a local verdict; report it without inventing a witness.
  for (const b of snapshot.bindings) if (b.verdict !== 'SUPPORTED' && evidence.get(b.evidenceId)!.processingStatus === 'READY' && b.quote.trim()) insufficientGap(b);
  const witnesses: WhyWitness[] = candidates.map(c => {
    const byRequirement: Record<string, string[]> = {};
    for (const id of c.bindingIds) { const requirement = bindings.get(id)!.requirementId; (byRequirement[requirement] ??= []).push(id); }
    return { ...c, id: `witness-${key(c)}`, bindingsByRequirement: byRequirement, evidenceIds: distinct(c.bindingIds.map(id => bindings.get(id)!.evidenceId)), status: 'ACTIVE', gapIds: [], eventResults: [] };
  });
  for (const w of witnesses) {
    for (const id of w.bindingIds) {
      const b = bindings.get(id)!;
      if (b.verdict === 'SUPPORTED') continue;
      const pending = b.verdict === 'UNREVIEWED'; incomplete ||= pending;
      if (pending && w.status !== 'REJECTED') w.status = 'PENDING'; else if (!pending) w.status = 'REJECTED';
      w.gapIds.push(insufficientGap(b, [w.id]));
    }
    if (w.status !== 'ACTIVE') continue;
    for (const n of snapshot.nodes.filter(n => n.eventRuleId && w.chosenBranches[n.id])) {
      const rule = snapshot.eventRules.find(r => r.id === n.eventRuleId)!;
      const result = checkWhyEvent(rule, w.bindingIds.filter(id => below(n.id).has(id)).map(id => bindings.get(id)!)); w.eventResults.push(result);
      if (result.result === 'MATCH') continue;
      const pending = result.result === 'UNKNOWN'; incomplete ||= pending;
      if (pending && w.status !== 'REJECTED') w.status = 'PENDING'; else if (!pending) w.status = 'REJECTED';
      w.gapIds.push(addGap({ type: pending ? 'EVIDENCE_INSUFFICIENT' : 'EVENT_MISMATCH', stage: '1-5', claimId: n.id, requirementIds: Object.keys(w.bindingsByRequirement), evidenceIds: w.evidenceIds, witnessIds: [w.id], reasonCode: pending ? 'EVENT_METADATA_UNKNOWN' : 'EVENT_CONSTRAINT_FAILED', explanation: pending ? '사건 연결에 필요한 메타데이터가 없어 판정을 보류합니다.' : '자료들의 식별 키·사건 시각이 지정한 연결 규칙과 일치하지 않습니다.', expected: result.expected, observed: result.observed, evaluationState: pending ? 'PENDING' : 'COMPLETE' }));
    }
  }
  // Representatives require direct equivalence with every member; similarity is not transitive.
  const groups: string[][] = [];
  const exactIdentity = (b: WhyBinding) => JSON.stringify([evidence.get(b.evidenceId)!.contentHash, b.start, b.end, b.quote]);
  const equivalent = (a: WhyBinding, b: WhyBinding) => exactIdentity(a) === exactIdentity(b) || (a.atomId !== null && a.atomId === b.atomId) || snapshot.duplicates.some(d => ['EXACT_DUPLICATE', 'SAME_OBSERVATION'].includes(d.verdict) && ((d.left === a.id && d.right === b.id) || (d.left === b.id && d.right === a.id)));
  for (const b of [...snapshot.bindings].sort((a, b) => stable(a.id, b.id))) {
    const group = groups.find(group => group.every(id => equivalent(bindings.get(id)!, b)));
    if (group) group.push(b.id); else groups.push([b.id]);
  }
  const atomByBinding = new Map<string, string>();
  for (const group of groups) {
    const explicit = distinct(group.flatMap(id => bindings.get(id)!.atomId ? [bindings.get(id)!.atomId!] : []));
    const atom = explicit.length === 1 ? explicit[0] : `atom-${key(exactIdentity(bindings.get(group[0])!))}`;
    group.forEach(id => atomByBinding.set(id, atom));
  }
  const provenance = traceWhySources(snapshot);
  for (const w of witnesses.filter(w => w.status === 'ACTIVE')) for (const evidenceId of w.evidenceIds) {
    const e = evidence.get(evidenceId)!; if (e.sourceGrade && !['D', 'E', 'F'].includes(e.sourceGrade)) continue;
    const pending = e.sourceGrade === null; incomplete ||= pending;
    if (pending && w.status !== 'REJECTED') w.status = 'PENDING'; else if (!pending) w.status = 'REJECTED';
    w.gapIds.push(addGap({ type: 'PROVENANCE_UNKNOWN', stage: '1-7', claimId: snapshot.rootId, requirementIds: Object.keys(w.bindingsByRequirement), evidenceIds: [evidenceId], witnessIds: [w.id], reasonCode: pending ? 'SOURCE_UNREVIEWED' : `SOURCE_GRADE_${e.sourceGrade}`, explanation: pending ? '출처 등급과 확인 근거가 아직 평가되지 않았습니다.' : '출처 D/E/F 자료는 현재 완성 체인의 필수 근거로 사용할 수 없습니다.', expected: '출처 확인 근거와 A/B/C 평가', observed: { grade: e.sourceGrade, reason: e.sourceReason, provenance: provenance.filter(p => p.evidenceId === evidenceId) }, evaluationState: pending ? 'PENDING' : 'COMPLETE' }));
  }
  const seen = new Map<string, string>();
  for (const w of witnesses.filter(w => w.status === 'ACTIVE')) {
    // Requirement identity is part of deduplication. Identical evidence for different roles stays distinct.
    const roles = Object.entries(w.bindingsByRequirement).sort(([a], [b]) => stable(a, b)).map(([r, ids]) => [r, distinct(ids.map(id => atomByBinding.get(id)!))]);
    const branches = Object.entries(w.chosenBranches).sort(([a], [b]) => stable(a, b)).map(([node, ids]) => [node, distinct(ids.map(id => atomByBinding.get(id) ?? id))]);
    const identity = JSON.stringify([roles, branches]);
    const prior = seen.get(identity);
    if (prior) { w.status = 'DUPLICATE'; w.duplicateOf = prior; } else seen.set(identity, w.id);
  }
  const active = witnesses.filter(w => w.status === 'ACTIVE');
  let bayesian = evaluateBayesianConfidence(snapshot, checkWhyEvent);
  const bayesExcludedNodes = new Set<string>();
  const usesBayes = snapshot.policy.bayes !== undefined || snapshot.bindings.some(binding => binding.likelihood !== undefined);
  if (usesBayes && bayesian.status !== 'ASSESSED') incomplete = true;
  const meets = (range: Range | null, threshold: number | null): boolean | null => !range || threshold === null ? null : range[0] >= threshold ? true : range[1] < threshold ? false : null;
  const allActiveBindings = distinct(active.flatMap(w => w.bindingIds));
  // A duplicate witness adds no independent support, but its coefficient may
  // conflict with the retained observation. Do not silently select the first rating.
  const eligibleBindings = distinct(witnesses.filter(w => w.status === 'ACTIVE' || w.status === 'DUPLICATE').flatMap(w => w.bindingIds));
  const atoms: WhyConfidence['atoms'] = distinct(allActiveBindings.map(id => atomByBinding.get(id)!)).map(id => {
    const bindingIds = eligibleBindings.filter(b => atomByBinding.get(b) === id);
    const scores = bindingIds.map(id => { const b = bindings.get(id)!; const e = evidence.get(b.evidenceId)!; return e.sourceCoefficient === null || b.materialCoefficient === null ? null : e.sourceCoefficient * b.materialCoefficient; });
    return { id, bindingIds, score: scores.some(s => s === null) || new Set(scores).size > 1 ? null : scores[0] };
  });
  // Subclaim thresholds constrain only paths that use that subclaim. A weak optional
  // OR branch must neither veto a separate proof nor inflate the accepted root score.
  let qualified = active;
  const thresholdGaps: string[] = [];
  const order: string[] = []; const visited = new Set<string>();
  const postorder = (id: string) => { if (visited.has(id) || !nodes.has(id)) return; visited.add(id); nodes.get(id)!.children.forEach(postorder); order.push(id); };
  postorder(snapshot.rootId);
  for (const id of order.filter(id => id !== snapshot.rootId && nodes.get(id)!.threshold !== null)) {
    const n = nodes.get(id)!; const affected = qualified.filter(w => w.chosenBranches[id]);
    if (!affected.length) continue;
    const local = confidenceFor(affected.map(w => distinct(w.bindingIds.filter(b => below(id).has(b)).map(b => atomByBinding.get(b)!))), atoms, snapshot, n.threshold);
    const bayesLocal = bayesian.trace.find(trace => trace.nodeId === id)!;
    const sufficient = usesBayes ? meets(bayesLocal.range, n.threshold) : local.sufficient;
    if (sufficient === true) continue;
    if (local.reason.startsWith('SCORE_STATE_LIMIT')) { incomplete = true; limits.push(`SCORE_STATE_LIMIT:${id}`); }
    thresholdGaps.push(addGap({ type: 'TRUST_WEAK', stage: '1-8', claimId: id, requirementIds: distinct(affected.flatMap(w => Object.keys(w.bindingsByRequirement))), evidenceIds: distinct(affected.flatMap(w => w.evidenceIds)), witnessIds: affected.map(w => w.id), reasonCode: 'SUBCLAIM_THRESHOLD', explanation: `이 하위 주장을 사용하는 경로가 지정한 기준을 충족하지 못했습니다. ${usesBayes ? bayesLocal.reason : local.reason}`, expected: n.threshold, observed: usesBayes ? bayesLocal.posterior ?? bayesLocal.range : local.supportScore ?? local.range, evaluationState: sufficient === null ? 'PENDING' : 'COMPLETE', blockingScope: 'SUBCLAIM' }));
    qualified = qualified.filter(w => !w.chosenBranches[id]);
    if (usesBayes) { bayesExcludedNodes.add(id); bayesian = evaluateBayesianConfidence(snapshot, checkWhyEvent, bayesExcludedNodes); }
  }
  for (const gap of gaps.filter(g => thresholdGaps.includes(g.id))) if (qualified.length) gap.blockingScope = 'ALTERNATIVE';
  const terms = qualified.map(w => distinct(w.bindingIds.map(id => atomByBinding.get(id)!)));
  const confidence = confidenceFor(terms, atoms, snapshot, snapshot.policy.threshold ?? nodes.get(snapshot.rootId)!.threshold);
  confidence.bayesian = bayesian;
  for (const n of snapshot.nodes) {
    const localTerms = (n.id === snapshot.rootId ? qualified : active).filter(w => w.chosenBranches[n.id]).map(w => distinct(w.bindingIds.filter(id => below(n.id).has(id)).map(id => atomByBinding.get(id)!))).filter(t => t.length);
    const local = confidenceFor(localTerms, atoms, snapshot, n.id === snapshot.rootId ? confidence.threshold : n.threshold);
    confidence.trace.push({ nodeId: n.id, operator: n.operator, expression: n.children.join(n.operator === 'OR' ? ' OR ' : ' AND '), supportScore: local.supportScore, range: local.range, threshold: local.threshold });
    if (local.reason.startsWith('SCORE_STATE_LIMIT')) { incomplete = true; limits.push(`SCORE_STATE_LIMIT:${n.id}`); }
    const rootRange = usesBayes ? bayesian.range : local.range;
    const rootSufficient = usesBayes ? bayesian.sufficient : local.sufficient;
    const bayesIncomplete = usesBayes && bayesian.status !== 'ASSESSED';
    if (n.id === snapshot.rootId && (localTerms.length || usesBayes) && (rootSufficient !== true || bayesIncomplete)) addGap({ type: 'TRUST_WEAK', stage: '1-8', claimId: n.id, requirementIds: snapshot.nodes.filter(r => r.kind === 'requirement' && [...below(r.id)].some(id => below(n.id).has(id))).map(r => r.id), evidenceIds: distinct(snapshot.bindings.filter(binding => below(n.id).has(binding.id)).map(binding => binding.evidenceId)), reasonCode: local.threshold === null ? 'POLICY_UNSET' : bayesIncomplete ? 'BAYES_ASSESSMENT_INCOMPLETE' : rootRange === null ? 'SCORE_UNKNOWN' : rootSufficient === null ? 'DEPENDENCY_UNRESOLVED' : 'BELOW_THRESHOLD', explanation: local.threshold === null ? '운영 임계값이 지정되지 않아 기준 충족을 판정하지 않습니다.' : usesBayes ? `${bayesIncomplete ? '일부 우도 평가 또는 자료 범위가 미완료여서 최종 판정을 보류합니다. ' : ''}${bayesian.reason} ${bayesian.unknownReasons.slice(0, 3).join(' ')}` : local.reason, expected: local.threshold, observed: usesBayes ? bayesian.posterior ?? bayesian.range : local.supportScore ?? local.range, evaluationState: bayesIncomplete || rootRange === null || local.threshold === null || rootSufficient === null ? 'PENDING' : 'COMPLETE', blockingScope: 'ROOT' });
  }
  for (const b of snapshot.bindings.filter(b => b.verdict === 'REFUTED')) {
    const relevantRules = snapshot.nodes.filter(n => n.eventRuleId && below(n.id).has(b.id)).map(n => snapshot.eventRules.find(r => r.id === n.eventRuleId)!);
    if (relevantRules.some(r => checkWhyEvent(r, [b]).result === 'MISMATCH')) continue;
    addGap({ type: 'EVIDENCE_INSUFFICIENT', stage: '1-4', claimId: b.requirementId, requirementIds: [b.requirementId], evidenceIds: [b.evidenceId], reasonCode: 'CONTRADICTORY_EVIDENCE', explanation: `같은 주장에 대한 반증을 검토해야 합니다: ${b.reason}`, expected: nodes.get(b.requirementId)!.statement, observed: b.quote, evaluationState: 'PENDING' });
  }
  if (!snapshot.coverage.complete) limits.push(`COVERAGE_INCOMPLETE:${snapshot.coverage.note}`);
  for (const gap of gaps) if (active.length && gap.type !== 'TRUST_WEAK' && gap.reasonCode !== 'CONTRADICTORY_EVIDENCE') gap.blockingScope = 'ALTERNATIVE';
  const chainStatus: WhyResult['chainStatus'] = active.length ? 'COMPLETE_CHAIN_FOUND' : incomplete ? 'UNDETERMINED' : 'NO_COMPLETE_CHAIN';
  if (chainStatus === 'NO_COMPLETE_CHAIN') addGap({ type: 'CHAIN_UNKNOWN', stage: 'FINAL', claimId: snapshot.rootId, requirementIds: distinct(gaps.flatMap(g => g.requirementIds)), evidenceIds: [], reasonCode: 'NO_ELIGIBLE_WITNESS', explanation: '현재 자료와 확정한 논리에서 적격한 완성 체인을 찾지 못했습니다.', expected: snapshot.goal, observed: 0, causeGapIds: gaps.map(g => g.id), evaluationState: 'COMPLETE' });
  const result: WhyResult = { evaluationStatus: incomplete ? 'INCOMPLETE' : 'COMPLETE', chainStatus, accepted: active.length > 0 && (usesBayes ? bayesian.sufficient === true && bayesian.status === 'ASSESSED' : confidence.sufficient === true) && !gaps.some(g => g.blockingScope === 'ROOT' || g.type === 'TRUST_WEAK' && g.blockingScope === 'SUBCLAIM'), witnesses, gaps, confidence, limits: distinct(limits), provenance, actions: [] };
  result.actions = makeWhyActions(snapshot, result);
  return result;
}

export function makeWhyActions(snapshot: WhySnapshot, result: WhyResult): WhyAction[] {
  const labels = {
    EVIDENCE_MISSING: ['SEARCH_EVIDENCE', '필요한 원문 찾기'], EVIDENCE_INSUFFICIENT: ['REQUEST_EVIDENCE', '판정과 부족한 자료 확인'],
    EVENT_MISMATCH: ['EXPLAIN_MISMATCH', '연결할 수 없는 이유 확인'], TRUST_WEAK: ['EXPLAIN_TRUST', '병목과 점수 가정 확인'],
    PROVENANCE_UNKNOWN: ['REQUEST_SOURCE', '원출처와 확인 근거 요청'], CHAIN_UNKNOWN: ['PROPOSE_CHAINS', '체인 완성 전략 비교'],
  } as const;
  return [...result.gaps].sort((a, b) => Number(a.blockingScope === 'ALTERNATIVE') - Number(b.blockingScope === 'ALTERNATIVE')).map(gap => {
    const requirements = snapshot.nodes.filter(n => gap.requirementIds.includes(n.id));
    const needs = requirements.flatMap(n => n.need ? [n.need] : []);
    const action: WhyAction = { id: `action-${gap.id}`, gapIds: [gap.id], type: labels[gap.type][0], title: labels[gap.type][1], reason: gap.explanation, requirementIds: gap.requirementIds, kinds: distinct(needs.flatMap(n => n.kinds)), fields: distinct(needs.flatMap(n => n.fields)), criteria: distinct(needs.flatMap(n => n.criteria)), query: [snapshot.goal, ...needs.flatMap(n => n.fields)].join(' ').slice(0, 1000), status: ['EVENT_MISMATCH', 'TRUST_WEAK', 'CHAIN_UNKNOWN'].includes(gap.type) ? 'PROPOSED' : 'WAITING_USER' };
    if (gap.type === 'CHAIN_UNKNOWN') action.strategies = [
      ['직접 원본 기록 확보', '필수 조건과 사건 식별자를 함께 확인할 원본 기록', '기록 보유자의 접근 권한 또는 제공이 필요합니다.'],
      ['사건 순서와 식별 키 대조', '각 필수 조건의 원문과 공통 식별자를 연결하는 대조 기록', '필요한 사건 기록의 존재와 연결 키 확인이 필요합니다.'],
      ['독립된 관측 자료 확인', '기존 출처를 재인용하지 않은 별도 관측 또는 상대 기관 기록', '독립 관측의 존재와 확보 가능성은 아직 확인하지 않았습니다.'],
    ].map(([title, strategy, availability]) => ({ title, requiredEvidence: [strategy, ...requirements.map(n => n.statement)], closedGapIds: [], remainingGaps: result.gaps.filter(g => g.type !== 'CHAIN_UNKNOWN').map(g => g.id), eventJoinRules: snapshot.eventRules.map(r => `${r.id}: ${r.kind}`), sourceIndependenceNeeds: '같은 관측의 재게시인지 확인하고 독립성 근거를 기록해야 합니다.', availability }));
    return action;
  });
}
