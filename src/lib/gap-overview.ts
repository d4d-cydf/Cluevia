import type { GraphDecorations, GraphDocument, GraphEdge, GraphNode } from '../types/graph.ts';
import type { GapType, WhyBinding, WhyRun } from '../types/why-not.ts';
import { buildWhyOverview } from './why-overview.ts';

export const gapOverviewLabels: Record<GapType, string> = {
  EVIDENCE_MISSING: '필요한 자료',
  EVIDENCE_INSUFFICIENT: '근거 불충분',
  EVENT_MISMATCH: '사건 불일치',
  TRUST_WEAK: '지지 수준 검토',
  PROVENANCE_UNKNOWN: '원출처 확인',
  CHAIN_UNKNOWN: '입증 경로 미완성',
};

/** Context for opening the saved review, never a new claim or a new decision. */
export interface GapOverviewContext {
  kind: 'goal' | 'claim' | 'requirement' | 'evidence' | 'logic' | 'binding' | 'gap' | 'source';
  gapIds: string[];
  claimId?: string;
  requirementIds: string[];
  evidenceIds: string[];
  bindingIds: string[];
  witnessIds: string[];
  sourceIds: string[];
}

export interface GapOverviewModel {
  /** Display only. Do not save this document as extracted factual relationships. */
  graph: GraphDocument;
  decorations: GraphDecorations;
  goalId: string;
  gapByNode: Record<string, string>;
  gapByEdge: Record<string, string>;
  contextById: Record<string, GapOverviewContext>;
  warnings: string[];
}

const unique = <T,>(values: T[]) => [...new Set(values)];
const normal = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ');
const context = (kind: GapOverviewContext['kind'], values: Partial<GapOverviewContext> = {}): GapOverviewContext => ({
  kind, gapIds: [], requirementIds: [], evidenceIds: [], bindingIds: [], witnessIds: [], sourceIds: [], ...values,
});

/**
 * Project saved evidence and its diagnostic layer. Evidence-only mode omits
 * extracted associations; the default additive mode preserves every existing
 * object. Logic/binding edges come from actual snapshot membership; red edges
 * describe review scope, not events or proof of the question. No URL/name
 * similarity is used to identify evidence.
 */
export function buildGapOverview(graph: GraphDocument, run?: WhyRun | null, options: { checking?: boolean; stale?: boolean; evidenceOnly?: boolean; showGaps?: boolean } = {}): GapOverviewModel {
  const originalNodes = options.evidenceOnly ? [] : graph.nodes;
  const originalEdges = options.evidenceOnly ? [] : graph.edges;
  const used = new Set([...graph.nodes, ...graph.edges, ...graph.groups].map(item => item.id));
  const id = (kind: string, original: string) => {
    let candidate = `gap-overview:${kind}:${original}`;
    while (used.has(candidate)) candidate = `_${candidate}`;
    used.add(candidate);
    return candidate;
  };
  const goalId = id('goal', graph.id);
  const groupId = id('group', 'review');
  const gapGroupId = id('group', 'gaps');
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const gapByNode: Record<string, string> = {};
  const gapByEdge: Record<string, string> = {};
  const contextById: Record<string, GapOverviewContext> = {};
  const snapshot = run?.baseSnapshot ?? run?.snapshot;
  // Failed/in-flight attempts may have no result. Never synthesize their gaps.
  const showGaps = options.showGaps !== false;
  const result = showGaps ? run?.result : undefined;
  const gaps = showGaps ? result?.gaps ?? [] : [];
  const warnings: string[] = [];
  const checking = options.checking === true || run?.status === 'running';
  const differentGoal = !!snapshot && normal(snapshot.goal) !== normal(graph.question);
  const stale = options.stale === true || differentGoal;
  const decorations: GraphDecorations = {
    centerNodeId: goalId,
    runKey: run ? `${run.id}:${run.preparation?.preparedAt ?? run.updatedAt}` : 'unassessed',
    nodes: { [goalId]: { kind: 'goal', state: !showGaps ? 'idle' : checking ? 'checking' : !stale && result?.accepted ? 'resolved' : 'found' } },
    edges: {},
  };
  const goalDescription = '분석 질문과 저장된 필수 조건·자료의 연결입니다. Cluevia를 켜면 준비된 공백 표시를 확인할 수 있습니다.';
  nodes.push({ id: goalId, label: graph.question || '분석 목표', type: 'Goal', group: groupId, description: goalDescription,
    sourceIds: [], properties: { displayOnly: 'true', role: 'review-goal', ...(snapshot ? { evaluatedGoal: snapshot.goal } : {}) } });
  contextById[goalId] = context('goal', { gapIds: gaps.map(gap => gap.id), claimId: snapshot?.rootId });
  if (stale) warnings.push('이전 검토 결과를 표시하고 있습니다. 현재 질문·자료의 판단으로 적용하지 마세요.');
  if (result?.evaluationStatus === 'INCOMPLETE') warnings.push('미확정 자료와 판정이 남아 있습니다. 확인 대기 공백은 해소된 것으로 취급하지 않습니다.');
  warnings.push(...(result?.limits ?? []));

  const logicalIds = new Map<string, string>();
  const evidenceIds = new Map<string, string>();
  const bindingIds = new Map<string, string>();
  const validBindings: WhyBinding[] = [];
  const evidenceSources = new Map<string, string[]>();
  const addEdge = (kind: string, original: string, source: string, target: string, label: string, description: string, edgeContext: GapOverviewContext, sourceIds: string[] = []) => {
    const edgeId = id(kind, original);
    edges.push({ id: edgeId, source, target, label, description, status: 'inferred', sourceIds });
    contextById[edgeId] = edgeContext;
    return edgeId;
  };

  if (snapshot) {
    // The immutable baseline supplies every ordinary node and edge. Review
    // results only add the diagnostic layer; they never rebuild this diagram.
    const proof = buildWhyOverview(snapshot, undefined, { maxNodes: Infinity });
    warnings.push(...proof.warnings);
    const sourceNodes = new Map(snapshot.nodes.map(node => [node.id, node]));
    const sourceEvidence = new Map(snapshot.evidence.map(evidence => [evidence.id, evidence]));
    const sourceBindings = new Map((run?.snapshot ?? snapshot).bindings.map(binding => [binding.id, binding]));
    const projectedIds = new Map<string, string>();

    for (const node of proof.nodes) {
      const isRoot = node.originalNodeId === snapshot.rootId;
      const displayId = isRoot && !differentGoal ? goalId : id(node.kind, node.originalNodeId ?? node.evidenceId!);
      projectedIds.set(node.id, displayId);
      if (node.originalNodeId) logicalIds.set(node.originalNodeId, displayId);
      if (node.evidenceId) evidenceIds.set(node.evidenceId, displayId);
      const evidence = node.evidenceId ? sourceEvidence.get(node.evidenceId) : undefined;
      // Source identity must be explicit. A shared URL does not establish the
      // same original observation, and is deliberately insufficient here.
      const sourceIds = evidence ? graph.sources.filter(source =>
        (evidence.documentId !== null && source.id === evidence.documentId)
        || (!!source.contentHash && source.contentHash === evidence.contentHash)).map(source => source.id) : [];
      if (evidence) evidenceSources.set(evidence.id, sourceIds);
      const nodeContext = context(isRoot && !differentGoal ? 'goal' : node.kind === 'conclusion' ? 'claim' : node.kind, {
        gapIds: gaps.filter(gap => node.evidenceId ? gap.evidenceIds.includes(node.evidenceId) : gap.claimId === node.originalNodeId || gap.requirementIds.includes(node.originalNodeId!)).map(gap => gap.id), claimId: node.originalNodeId,
        requirementIds: node.kind === 'requirement' ? [node.originalNodeId!] : [],
        evidenceIds: node.evidenceId ? [node.evidenceId] : [], sourceIds,
      });
      if (displayId === goalId) {
        contextById[goalId] = { ...nodeContext, gapIds: gaps.map(gap => gap.id) };
        nodes[0].properties.statement = node.title;
        continue;
      }
      nodes.push({ id: displayId, label: node.title, type: node.kind === 'evidence' ? 'Evidence' : node.kind === 'requirement' ? 'Condition' : 'Claim',
        group: groupId, description: node.subtitle, sourceIds,
        properties: { displayOnly: 'true', role: node.kind, ...(node.operator ? { operator: node.operator } : {}),
          ...(evidence ? { evidenceId: evidence.id, ...(evidence.record !== null ? { record: String(evidence.record) } : {}) } : {}) } });
      contextById[displayId] = nodeContext;
    }

    // A user may have changed the review goal. Keep its real root separate from
    // the current question instead of claiming it evaluates the current goal.
    if (differentGoal && logicalIds.has(snapshot.rootId)) addEdge('scope', snapshot.rootId, goalId, logicalIds.get(snapshot.rootId)!, '저장된 다른 검토 목표',
      '이전 검토의 목표를 표시합니다. 현재 질문에 대한 근거나 사실 관계가 아닙니다.', context('goal', { claimId: snapshot.rootId }));

    for (const edge of proof.edges) {
      const source = projectedIds.get(edge.source);
      const target = projectedIds.get(edge.target);
      if (!source || !target) continue;
      const binding = edge.bindingId ? sourceBindings.get(edge.bindingId) : undefined;
      if (binding) {
        validBindings.push(binding);
        const sourceIds = evidenceSources.get(binding.evidenceId) ?? [];
        const edgeId = addEdge('binding', binding.id, source, target, '자료 연결',
          `인용: ${edge.quote ?? binding.quote}`, context('binding', { gapIds: [], claimId: binding.requirementId,
            requirementIds: [binding.requirementId], evidenceIds: [binding.evidenceId], bindingIds: [binding.id], sourceIds }), sourceIds);
        bindingIds.set(binding.id, edgeId);
        contextById[source].bindingIds.push(binding.id);
        contextById[target].bindingIds.push(binding.id);
      } else {
        const targetNode = proof.nodes.find(node => node.id === edge.target);
        const targetOriginal = targetNode?.originalNodeId;
        const sourceOriginal = proof.nodes.find(node => node.id === edge.source)?.originalNodeId;
        const requirementIds = unique([sourceOriginal, targetOriginal].filter((value): value is string => !!value && sourceNodes.get(value)?.kind === 'requirement'));
        addEdge('logic', edge.id, source, target,
          edge.operator === 'OR' ? '조건 중 하나' : edge.operator === 'NOT_SUPPORT' ? '부정 입증에 모두 필요' : '모두 필요한 조건',
          edge.reason || '저장된 논리의 조건 연결입니다. 실제 사건 관계가 아닙니다.', context('logic', { gapIds: edge.gapIds, claimId: targetOriginal, requirementIds }));
      }
    }

    // A source/content bridge is contextual only, never a support shortcut
    // from an object to the goal or from a document to the goal.
    for (const [evidenceId, displayId] of evidenceIds) {
      const sourceIds = evidenceSources.get(evidenceId) ?? [];
      if (!sourceIds.length) continue;
      for (const node of originalNodes) {
        const sharedSources = sourceIds.filter(sourceId => node.sourceIds.includes(sourceId));
        if (!sharedSources.length) continue;
        const sameId = sharedSources.includes(sourceEvidence.get(evidenceId)?.documentId ?? '');
        addEdge('source', JSON.stringify([evidenceId, node.id]), node.id, displayId, sameId ? '같은 원자료' : '같은 자료 내용',
          `${sameId ? '원자료 식별자' : '자료 내용 해시'}가 일치하는 연결입니다. 이 대상이 결론을 지지한다는 판정이 아닙니다.`,
          context('source', { evidenceIds: [evidenceId], sourceIds: sharedSources }), sharedSources);
      }
    }
  }

  const gapIds = new Map(gaps.map(gap => [gap.id, id('gap', gap.id)]));
  for (const [index, gap] of gaps.entries()) {
    const nodeId = gapIds.get(gap.id)!;
    const witnessBindings = new Set(result?.witnesses.filter(witness => gap.witnessIds.includes(witness.id)).flatMap(witness => witness.bindingIds) ?? []);
    let relatedBindings = validBindings.filter(binding =>
      (gap.requirementIds.includes(binding.requirementId) || gap.claimId === binding.requirementId)
      && gap.evidenceIds.includes(binding.evidenceId)
      && (!gap.witnessIds.length || witnessBindings.has(binding.id)));
    // Insufficient-evidence gaps carry the exact reviewed span. Two decisions
    // about one document/requirement must not become one invented binding.
    if (gap.type === 'EVIDENCE_INSUFFICIENT') {
      const observed = gap.observed;
      if (typeof observed === 'string') relatedBindings = relatedBindings.filter(binding => binding.quote === observed);
      else if (observed && typeof observed === 'object') {
        const span = observed as Record<string, unknown>;
        relatedBindings = relatedBindings.filter(binding =>
          (typeof span.quote !== 'string' || binding.quote === span.quote)
          && (typeof span.start !== 'number' || binding.start === span.start)
          && (typeof span.end !== 'number' || binding.end === span.end)
          && (typeof span.verdict !== 'string' || binding.verdict === span.verdict));
      }
    }
    const sourceIds = unique(gap.evidenceIds.flatMap(evidenceId => evidenceSources.get(evidenceId) ?? []));
    const gapContext = context('gap', { gapIds: [gap.id], claimId: gap.claimId,
      requirementIds: [...gap.requirementIds], evidenceIds: [...gap.evidenceIds],
      bindingIds: relatedBindings.map(binding => binding.id), witnessIds: [...gap.witnessIds], sourceIds });
    const state = gap.evaluationState === 'PENDING' ? '확인 대기' : '검토 필요';
    const scope = gap.blockingScope === 'ALTERNATIVE' ? '대안 경로' : gap.blockingScope === 'SUBCLAIM' ? '하위 주장' : '결론';
    nodes.push({ id: nodeId, label: gapOverviewLabels[gap.type], type: 'Gap', group: gapGroupId,
      description: `${state} · ${scope}\n${gap.explanation}`, sourceIds,
      properties: { displayOnly: 'true', gapId: gap.id, gapType: gap.type, evaluationState: gap.evaluationState,
        blockingScope: gap.blockingScope, reasonCode: gap.reasonCode, stage: gap.stage } });
    contextById[nodeId] = gapContext;
    gapByNode[nodeId] = gap.id;
    // Renderer uses this only as a short arrival animation. It is not progress.
    const revealIndex = Math.min(index, 12);
    const animation = run?.preparation?.animation.find(step => step.gapId === gap.id);
    const timing = animation ? { delayMs: animation.delayMs, durationMs: animation.durationMs } : {};
    decorations.nodes[nodeId] = { kind: 'gap', gapType: gap.type, state: 'found', revealIndex, ...timing };
    const diagnosticEdge = (target: string, relation: string, label: string) => {
      const edgeId = addEdge('diagnostic', JSON.stringify([gap.id, relation, target]), nodeId, target, label,
        `${gap.explanation}\n진단 범위 연결이며 대상 사이의 사실 관계나 지지 판정이 아닙니다.`, gapContext, sourceIds);
      gapByEdge[edgeId] = gap.id;
      decorations.edges[edgeId] = { gapType: gap.type, revealIndex, ...timing };
    };
    // ROOT blocking scope means a local failure affects the conclusion, not
    // that the failure occurred at the goal. Prefer the recorded local cause;
    // only a diagnosis with no more specific references may point at the root.
    // Provenance gaps list the whole witness's requirements, so use only the
    // bindings of the source actually being reviewed for their local anchors.
    const requirements = gap.type === 'PROVENANCE_UNKNOWN'
      ? relatedBindings.map(binding => binding.requirementId)
      : gap.requirementIds;
    const hasLocalCause = gap.requirementIds.some(originalId => originalId !== snapshot?.rootId)
      || gap.evidenceIds.length > 0 || gap.causeGapIds.length > 0;
    const relatedNodes = unique([gap.claimId, ...requirements])
      .filter(originalId => originalId !== snapshot?.rootId || !hasLocalCause);
    for (const originalId of relatedNodes) {
      const target = logicalIds.get(originalId);
      if (target) diagnosticEdge(target, 'condition', originalId === snapshot?.rootId ? '검토 대상 주장' : '검토 대상 조건');
      else if (!target && snapshot) warnings.push(`공백 ${gap.id}의 조건 참조 ${originalId}를 현재 논리에서 찾지 못했습니다.`);
    }
    for (const evidenceId of unique(gap.evidenceIds)) {
      const target = evidenceIds.get(evidenceId);
      if (target) diagnosticEdge(target, 'evidence', '검토 대상 자료');
      else warnings.push(`공백 ${gap.id}의 자료 참조 ${evidenceId}를 현재 연결에서 찾지 못했습니다.`);
    }
    for (const witnessId of gap.witnessIds) {
      if (!result?.witnesses.some(witness => witness.id === witnessId)) warnings.push(`공백 ${gap.id}의 경로 참조 ${witnessId}를 찾지 못했습니다.`);
    }
    for (const causeId of unique(gap.causeGapIds)) {
      const target = gapIds.get(causeId);
      if (target && target !== nodeId) diagnosticEdge(target, 'cause', '연결된 공백 사유');
      else if (!target) warnings.push(`공백 ${gap.id}의 원인 참조 ${causeId}를 찾지 못했습니다.`);
    }
    for (const binding of relatedBindings) {
      const displayId = bindingIds.get(binding.id);
      if (displayId) contextById[displayId].gapIds = unique([...contextById[displayId].gapIds, gap.id]);
    }
  }

  return { graph: { ...graph, id: `${graph.id}:gap-overview`, nodes: [...originalNodes, ...nodes], edges: [...originalEdges, ...edges],
    ...(options.evidenceOnly ? { events: [], findings: [] } : {}),
    groups: [...(options.evidenceOnly ? [] : graph.groups), { id: groupId, label: 'Evidence', color: '#a28a6d' }, ...(gaps.length ? [{ id: gapGroupId, label: 'Gaps', color: '#b86f67' }] : [])] },
    decorations, goalId, gapByNode, gapByEdge, contextById, warnings: unique(warnings) };
}
