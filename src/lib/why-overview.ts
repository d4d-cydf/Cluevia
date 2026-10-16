import type { EvidenceVerdict, LogicOperator, WhyBinding, WhyGap, WhyNode, WhyResult, WhySnapshot } from '../types/why-not.ts';

export type WhyOverviewStatus = 'supported' | 'refuted' | 'insufficient' | 'unreviewed' | 'pending' | 'gap';

export interface WhyOverviewNode {
  id: string;
  kind: 'conclusion' | 'claim' | 'requirement' | 'evidence';
  title: string;
  subtitle: string;
  status: WhyOverviewStatus;
  originalNodeId?: string;
  evidenceId?: string;
  record?: number | null;
  gapIds: string[];
  depth: number;
  operator?: LogicOperator;
  searchMatch: boolean;
}

export interface WhyOverviewEdge {
  id: string;
  source: string;
  target: string;
  kind: 'logic' | 'binding';
  operator?: LogicOperator;
  verdict?: EvidenceVerdict;
  bindingId?: string;
  reason: string;
  quote?: string;
  gapIds: string[];
}

export interface WhyOverviewModel {
  rootId: string;
  question: string;
  nodes: WhyOverviewNode[];
  edges: WhyOverviewEdge[];
  coverage: {
    totalNodes: number;
    shownNodes: number;
    hiddenNodes: number;
    totalEdges: number;
    hiddenEdges: number;
    complete: boolean;
    note: string;
  };
  warnings: string[];
  queryMatched: boolean;
}

const logicalId = (id: string) => `why:${id}`;
const materialId = (id: string) => `evidence:${id}`;
const unique = (values: string[]) => [...new Set(values)];
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();

function bindingStatus(bindings: WhyBinding[]): WhyOverviewStatus {
  const verdicts = new Set(bindings.map(binding => binding.verdict));
  if (!verdicts.size || verdicts.size === 1 && verdicts.has('UNREVIEWED')) return 'unreviewed';
  if (verdicts.size === 1 && verdicts.has('SUPPORTED')) return 'supported';
  if (verdicts.size === 1 && verdicts.has('REFUTED')) return 'refuted';
  // A shared document can support one requirement and contradict another. Its
  // individual binding edges retain both decisions; it never gets one green vote.
  return 'insufficient';
}

function logicalStatus(node: WhyNode, snapshot: WhySnapshot, result: WhyResult | undefined, bindings: WhyBinding[], primaryGaps: WhyGap[]): WhyOverviewStatus {
  if (node.id === snapshot.rootId) {
    if (result?.accepted) return 'supported';
    if (!result) return 'unreviewed';
    if (result.evaluationStatus === 'INCOMPLETE') return 'pending';
    return result.gaps.length || result.chainStatus === 'NO_COMPLETE_CHAIN' ? 'gap' : 'insufficient';
  }
  if (primaryGaps.some(gap => gap.evaluationState === 'PENDING')) {
    return primaryGaps.every(gap => gap.reasonCode === 'UNREVIEWED') ? 'unreviewed' : 'pending';
  }
  if (primaryGaps.length) {
    return primaryGaps.every(gap => gap.type === 'EVIDENCE_INSUFFICIENT' || gap.type === 'TRUST_WEAK') ? 'insufficient' : 'gap';
  }
  const materials = bindings.map(binding => snapshot.evidence.find(item => item.id === binding.evidenceId));
  if (materials.some(material => material?.processingStatus === 'PENDING')) return 'pending';
  if (materials.some(material => material?.processingStatus === 'FAILED')) return 'gap';
  if (node.kind === 'requirement') {
    const status = bindingStatus(bindings);
    // A refuting source calls for review of the requirement; it does not prove a
    // parent claim false, including a claim using NOT_SUPPORT.
    return status === 'refuted' ? 'insufficient' : status;
  }
  const trace = result?.confidence.trace.find(item => item.nodeId === node.id);
  const inActiveWitness = result?.witnesses.some(witness => witness.status === 'ACTIVE' && Object.hasOwn(witness.chosenBranches, node.id));
  if (inActiveWitness && trace?.threshold !== null && trace?.threshold !== undefined && (trace.range?.[0] ?? trace.supportScore ?? -1) >= trace.threshold) return 'supported';
  return 'unreviewed';
}

/** Project recorded logic and evidence membership, without evaluating new claims.
 * Every displayed edge is an original child link or an attached binding. Deep
 * paths stay intact and shared evidence keeps one node with separate decisions.
 */
export function buildWhyOverview(snapshot: WhySnapshot, result?: WhyResult, options: { query?: string; maxNodes?: number } = {}): WhyOverviewModel {
  const sourceNodes = new Map(snapshot.nodes.map(node => [node.id, node]));
  const sourceEvidence = new Map(snapshot.evidence.map(evidence => [evidence.id, evidence]));
  const sourceBindings = new Map(snapshot.bindings.map(binding => [binding.id, binding]));
  const rootId = logicalId(snapshot.rootId);
  const warnings: string[] = [];
  const gaps = result?.gaps ?? [];
  const depth = new Map<string, number>([[rootId, 0]]);
  const firstParent = new Map<string, string>();
  const order: string[] = [];
  const queue = [snapshot.rootId];
  const visited = new Set<string>();
  const edges: WhyOverviewEdge[] = [];
  const edgeIds = new Set<string>();
  const attachedBindings = new Map<string, WhyBinding[]>();
  const materialBindings = new Map<string, WhyBinding[]>();
  const addEdge = (edge: WhyOverviewEdge) => { if (!edgeIds.has(edge.id)) { edgeIds.add(edge.id); edges.push(edge); } };
  const discover = (id: string, parent: string) => {
    if (!depth.has(id)) { depth.set(id, depth.get(parent)! + 1); firstParent.set(id, parent); order.push(id); }
  };
  if (sourceNodes.has(snapshot.rootId)) order.push(rootId);
  else warnings.push('결론 노드를 찾을 수 없어 논리 연결을 표시할 수 없습니다.');

  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    if (visited.has(id)) continue;
    visited.add(id);
    const parent = sourceNodes.get(id);
    if (!parent) continue;
    const target = logicalId(parent.id);
    for (const childId of parent.children) {
      const child = sourceNodes.get(childId);
      if (child) {
        const source = logicalId(childId);
        discover(source, target);
        addEdge({ id: `logic:${JSON.stringify([childId, parent.id])}`, source, target, kind: 'logic', operator: parent.operator, reason: parent.inferenceRule, gapIds: gaps.filter(gap => gap.claimId === parent.id || gap.claimId === childId).map(gap => gap.id) });
        queue.push(childId);
        continue;
      }
      const binding = sourceBindings.get(childId);
      if (!binding || binding.requirementId !== parent.id || parent.kind !== 'requirement' || !sourceEvidence.has(binding.evidenceId)) {
        warnings.push('일부 연결의 원래 노드 또는 자료가 없어 해당 연결을 표시하지 않았습니다.');
        continue;
      }
      const source = materialId(binding.evidenceId);
      discover(source, target);
      if (!attachedBindings.get(parent.id)?.some(item => item.id === binding.id)) attachedBindings.set(parent.id, [...(attachedBindings.get(parent.id) ?? []), binding]);
      if (!materialBindings.get(binding.evidenceId)?.some(item => item.id === binding.id)) materialBindings.set(binding.evidenceId, [...(materialBindings.get(binding.evidenceId) ?? []), binding]);
      addEdge({ id: `binding:${binding.id}`, source, target, kind: 'binding', verdict: binding.verdict, bindingId: binding.id, reason: binding.reason, quote: binding.quote,
        gapIds: gaps.filter(gap => gap.evidenceIds.includes(binding.evidenceId) && (gap.claimId === parent.id || gap.requirementIds.includes(parent.id))).map(gap => gap.id) });
    }
  }

  const allNodes = order.map((id): WhyOverviewNode => {
    const isMaterial = id.startsWith('evidence:');
    if (isMaterial) {
      const evidence = sourceEvidence.get(id.slice('evidence:'.length))!;
      const bindings = materialBindings.get(evidence.id) ?? [];
      const status = evidence.processingStatus === 'PENDING' ? 'pending' : evidence.processingStatus === 'FAILED' ? 'gap' : bindingStatus(bindings);
      return { id, kind: 'evidence', title: evidence.name, subtitle: evidence.url ?? bindings[0]?.quote ?? evidence.sourceReason, status, evidenceId: evidence.id, record: evidence.record,
        gapIds: gaps.filter(gap => gap.evidenceIds.includes(evidence.id)).map(gap => gap.id), depth: depth.get(id)!, searchMatch: false };
    }
    const node = sourceNodes.get(id.slice('why:'.length))!;
    const primaryGaps = gaps.filter(gap => gap.claimId === node.id);
    return { id, kind: node.id === snapshot.rootId ? 'conclusion' : node.kind, title: node.statement,
      subtitle: node.id === snapshot.rootId && result ? result.confidence.reason : node.inferenceRule,
      status: logicalStatus(node, snapshot, result, attachedBindings.get(node.id) ?? [], primaryGaps), originalNodeId: node.id,
      gapIds: gaps.filter(gap => gap.claimId === node.id || gap.requirementIds.includes(node.id)).map(gap => gap.id), depth: depth.get(id)!, operator: node.operator, searchMatch: false };
  }).sort((left, right) => left.depth - right.depth);

  const terms = normalize(options.query ?? '').split(' ').filter(Boolean);
  const matched = new Set<string>();
  for (const node of allNodes) {
    const body = node.evidenceId ? sourceEvidence.get(node.evidenceId)?.text ?? '' : '';
    node.searchMatch = terms.length > 0 && terms.every(term => normalize(`${node.title} ${node.subtitle} ${body}`).includes(term));
    if (node.searchMatch) matched.add(node.id);
  }
  const requestedLimit = options.maxNodes ?? 24;
  const limit = requestedLimit === Infinity ? allNodes.length : Number.isFinite(requestedLimit) ? Math.max(1, Math.floor(requestedLimit)) : 24;
  const selected = new Set<string>();
  if (allNodes.length) selected.add(rootId);
  const pathToSelection = (id: string) => {
    const path: string[] = [];
    const seen = new Set<string>();
    let current: string | undefined = id;
    while (current && !selected.has(current) && !seen.has(current)) {
      seen.add(current); path.push(current); current = firstParent.get(current);
    }
    return path.reverse();
  };
  const includePath = (id: string, budget: number) => {
    const path = pathToSelection(id);
    if (selected.size + path.length <= budget) path.forEach(item => selected.add(item));
  };
  if (!terms.length) {
    // A wide root must not consume the whole board with bare requirements.
    // Reserve some space for real material paths, in recorded order (not by
    // verdict), then fill nearby context. No path is flattened to save space.
    if (allNodes.length > limit) {
      const materialBudget = Math.max(1, Math.ceil(limit / 2));
      for (const node of allNodes.filter(node => node.kind === 'evidence')) includePath(node.id, materialBudget);
    }
    for (const node of allNodes) includePath(node.id, limit);
  } else {
    for (const node of allNodes.filter(node => matched.has(node.id))) {
      includePath(node.id, limit);
    }
    if (matched.size && ![...matched].some(id => selected.has(id))) warnings.push('검색한 자료의 연결 경로가 표시 범위를 넘습니다. 전체 그래프에서 확인할 수 있습니다.');
  }
  if (!snapshot.coverage.complete) warnings.push(snapshot.coverage.note || '아직 모든 자료의 분석이 완료되지 않았습니다.');
  if (result?.evaluationStatus === 'INCOMPLETE') warnings.push('일부 자료 또는 판정이 아직 완료되지 않았습니다.');
  if (result?.limits.length) warnings.push('평가 범위에 제한이 있어 전체 자료의 판단으로 확대할 수 없습니다.');
  const nodes = allNodes.filter(node => selected.has(node.id));
  const shownEdges = edges.filter(edge => selected.has(edge.source) && selected.has(edge.target));
  return { rootId, question: snapshot.goal, nodes, edges: shownEdges, queryMatched: !terms.length || matched.size > 0,
    coverage: { totalNodes: allNodes.length, shownNodes: nodes.length, hiddenNodes: allNodes.length - nodes.length, totalEdges: edges.length, hiddenEdges: edges.length - shownEdges.length,
      complete: snapshot.coverage.complete && result?.evaluationStatus !== 'INCOMPLETE', note: snapshot.coverage.note }, warnings: unique(warnings) };
}
