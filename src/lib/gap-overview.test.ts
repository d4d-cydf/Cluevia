import assert from 'node:assert/strict';
import test from 'node:test';
import { whyFixture } from '../../server/why-not-fixture.ts';
import { evaluateWhyNot } from '../../server/why-not-engine.ts';
import type { GraphDocument } from '../types/graph.ts';
import type { GapType, WhyGap, WhyRun, WhySnapshot } from '../types/why-not.ts';
import { buildGapOverview } from './gap-overview.ts';

function sourceGraph(question = whyFixture(1).goal): GraphDocument {
  return { schemaVersion: '1.0', id: 'case', title: '기록된 관계', question, summary: '', origin: 'imported', createdAt: '2026-10-10T00:00:00Z', limitations: [],
    groups: [{ id: 'vessels', label: 'Vessels', color: '#8c755a' }],
    sources: [{ id: 'source-1', title: '원자료', url: 'https://example.com/report' }],
    nodes: [
      { id: 'a', label: '선박 A', type: 'Vessel', group: 'vessels', description: '', sourceIds: ['source-1'], properties: {} },
      { id: 'b', label: '선박 B', type: 'Vessel', group: 'vessels', description: '', sourceIds: ['source-1'], properties: {} },
    ], edges: [{ id: 'reported-relation', source: 'a', target: 'b', label: '관여 가능성', description: '자료에 기록된 불확실한 연관', status: 'inferred', sourceIds: ['source-1'],
      claim: { stance: 'uncertain', attributedTo: '자료상 주장', validFrom: null, validTo: null, publishedAt: null, derivedFrom: null } }], events: [], findings: [] };
}

function completeRun(snapshot = whyFixture(1)): WhyRun {
  return { id: 'run-1', jobId: 'job-1', previousId: null, status: 'completed', stage: '완료',
    createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:01Z', snapshot, result: evaluateWhyNot(snapshot) };
}

function gap(type: GapType, overrides: Partial<WhyGap> = {}): WhyGap {
  return { id: `gap-${type}`, type, stage: '1-4', claimId: 'r0', requirementIds: ['r0'], witnessIds: [], evidenceIds: ['e0'],
    reasonCode: 'TEST_RECORDED_GAP', explanation: '저장된 공백 사유입니다.', expected: null, observed: null,
    blockingScope: 'ROOT', causeGapIds: [], evaluationState: 'COMPLETE', ...overrides };
}

test('ordinary associations, source references and uncertainty remain untouched by the diagnostic layer', () => {
  const graph = sourceGraph();
  const snapshot = whyFixture(1); snapshot.bindings[0].verdict = 'INSUFFICIENT';
  const run = completeRun(snapshot);
  const before = JSON.stringify({ graph, run });
  const model = buildGapOverview(graph, run);
  assert.equal(model.graph.nodes[0], graph.nodes[0]);
  assert.equal(model.graph.nodes[1], graph.nodes[1]);
  assert.equal(model.graph.edges[0], graph.edges[0]);
  assert.equal(model.graph.sources, graph.sources);
  assert.equal(model.graph.edges[0].claim?.stance, 'uncertain');
  assert.equal(model.graph.nodes.find(node => node.id === model.goalId)?.label, graph.question);
  assert.equal(model.decorations.centerNodeId, model.goalId);
  assert.equal(Object.keys(model.gapByNode).length, run.result!.gaps.length);
  assert.equal(JSON.stringify({ graph, run }), before);
});

test('a running review has only a real checking goal until a result exists', () => {
  const run: WhyRun = { ...completeRun(), status: 'running', stage: '논리 설계', snapshot: undefined, result: undefined };
  const graph = sourceGraph();
  const model = buildGapOverview(graph, run);
  assert.equal(model.decorations.nodes[model.goalId].state, 'checking');
  assert.equal(model.graph.nodes.length, graph.nodes.length + 1);
  assert.equal(model.graph.edges.length, graph.edges.length);
  assert.deepEqual(model.gapByNode, {});
  assert.deepEqual(model.decorations.edges, {});
  const empty = buildGapOverview(graph);
  assert.equal(empty.decorations.nodes[empty.goalId].state, 'found');
  assert.equal(buildGapOverview(graph, null, { checking: true }).decorations.nodes[model.goalId].state, 'checking');
});

test('Evidence-only mode keeps every recorded condition, binding and gap without association nodes or shortcuts', () => {
  const snapshot = whyFixture(2); snapshot.bindings[0].verdict = 'INSUFFICIENT';
  snapshot.evidence[0].documentId = 'source-1';
  const graph = sourceGraph(); const run = completeRun(snapshot);
  const model = buildGapOverview(graph, run, { evidenceOnly: true });
  assert.equal(model.graph.nodes.some(node => graph.nodes.some(original => node.id === original.id)), false);
  assert.equal(model.graph.edges.some(edge => graph.edges.some(original => edge.id === original.id)), false);
  assert.equal(Object.values(model.contextById).filter(item => item.kind === 'binding').length, snapshot.bindings.length);
  assert.equal(Object.values(model.contextById).filter(item => item.kind === 'requirement').length, 2);
  assert.equal(Object.values(model.contextById).filter(item => item.kind === 'evidence').length, snapshot.evidence.length);
  assert.equal(Object.keys(model.gapByNode).length, run.result!.gaps.length);
  assert.equal(Object.values(model.contextById).some(item => item.kind === 'source'), false);
  assert.equal(model.graph.sources, graph.sources);
  const ids = new Set(model.graph.nodes.map(node => node.id));
  assert.equal(model.graph.edges.every(edge => ids.has(edge.source) && ids.has(edge.target)), true);
});

test('the disabled diagnostic layer preserves the identical Why base graph and neutral goal', () => {
  const snapshot = whyFixture(2); snapshot.bindings[0].verdict = 'INSUFFICIENT';
  const graph = sourceGraph(); const run = completeRun(snapshot);
  const baseline = buildGapOverview(graph, run, { evidenceOnly: true, showGaps: false });
  const active = buildGapOverview(graph, run, { evidenceOnly: true, showGaps: true });
  assert.equal(baseline.goalId, active.goalId);
  assert.equal(baseline.graph.id, active.graph.id);
  assert.equal(baseline.decorations.nodes[baseline.goalId].state, 'idle');
  assert.deepEqual(baseline.gapByNode, {});
  assert.deepEqual(baseline.decorations.edges, {});
  assert.deepEqual(baseline.graph.nodes.map(node => node.id), active.graph.nodes.filter(node => !active.gapByNode[node.id]).map(node => node.id));
  assert.deepEqual(baseline.graph.edges, active.graph.edges.filter(edge => !active.gapByEdge[edge.id]));
  assert.equal(baseline.graph.nodes.some(node => node.id === 'a'), false);
});

test('saved animation timing is applied to both warning nodes and their links', () => {
  const snapshot = whyFixture(1); snapshot.bindings[0].verdict = 'INSUFFICIENT';
  const run = completeRun(snapshot); const first = run.result!.gaps[0];
  run.preparation = { version: 'cluevia-preparation-1', ready: true, baselineScore: 50, score: 50, grade: 'C', preparedAt: '2026-10-10T00:00:02Z', animation: [{ gapId: first.id, delayMs: 125, durationMs: 820 }], gapFill: [] };
  const model = buildGapOverview(sourceGraph(), run, { evidenceOnly: true });
  const node = Object.keys(model.gapByNode).find(id => model.gapByNode[id] === first.id)!;
  assert.equal(model.decorations.nodes[node].delayMs, 125);
  assert.equal(model.decorations.nodes[node].durationMs, 820);
  for (const [id, gapId] of Object.entries(model.gapByEdge)) if (gapId === first.id) {
    assert.equal(model.decorations.edges[id].delayMs, 125);
    assert.equal(model.decorations.edges[id].durationMs, 820);
  }
  assert.equal(model.decorations.runKey, `${run.id}:${run.preparation.preparedAt}`);
});

test('all six stored gap types remain distinct diagnostic links, including pending alternatives', () => {
  const run = completeRun();
  const types: GapType[] = ['EVIDENCE_MISSING', 'EVIDENCE_INSUFFICIENT', 'EVENT_MISMATCH', 'TRUST_WEAK', 'PROVENANCE_UNKNOWN', 'CHAIN_UNKNOWN'];
  run.result!.gaps = types.map((type, index) => gap(type, { evaluationState: index % 2 ? 'PENDING' : 'COMPLETE', blockingScope: index % 2 ? 'ALTERNATIVE' : 'ROOT' }));
  run.result!.evaluationStatus = 'INCOMPLETE'; run.result!.accepted = false;
  const model = buildGapOverview(sourceGraph(), run);
  assert.equal(Object.keys(model.gapByNode).length, 6);
  assert.deepEqual(new Set(Object.values(model.decorations.edges).map(edge => edge.gapType)), new Set(types));
  for (const [nodeId, gapId] of Object.entries(model.gapByNode)) {
    const original = run.result!.gaps.find(item => item.id === gapId)!;
    const node = model.graph.nodes.find(item => item.id === nodeId)!;
    assert.equal(node.properties.evaluationState, original.evaluationState);
    assert.equal(node.properties.blockingScope, original.blockingScope);
    assert.equal(model.decorations.nodes[nodeId].state, 'found');
    const localLinks = model.graph.edges.filter(edge => edge.source === nodeId);
    assert.ok(localLinks.length > 0);
    assert.equal(localLinks.some(edge => edge.target === model.goalId), false);
    for (const link of localLinks) {
      assert.equal(link.status, 'inferred');
      assert.equal(link.claim, undefined);
      assert.match(link.description, /사실 관계나 지지 판정이 아닙니다/);
      assert.equal(model.gapByEdge[link.id], original.id);
    }
    assert.equal(model.contextById[nodeId].gapIds[0], original.id);
  }
  assert.match(model.warnings.join(' '), /미확정/);
});

test('ROOT impact and an aggregate root claim do not create goal links when local causes are recorded', () => {
  const snapshot = whyFixture(2);
  const run = completeRun(snapshot);
  run.result!.gaps = [
    gap('PROVENANCE_UNKNOWN', { claimId: 'root', requirementIds: ['r0', 'r1'], evidenceIds: ['e0'] }),
    gap('TRUST_WEAK', { claimId: 'root', requirementIds: ['r1'], evidenceIds: ['e1'] }),
    gap('CHAIN_UNKNOWN', { claimId: 'root', requirementIds: ['r0'], evidenceIds: [], causeGapIds: ['gap-PROVENANCE_UNKNOWN'] }),
  ];
  const model = buildGapOverview(sourceGraph(), run, { evidenceOnly: true });
  const targets = (gapId: string) => model.graph.edges.filter(edge => model.gapByEdge[edge.id] === gapId).map(edge => model.contextById[edge.target]);
  assert.equal(model.graph.edges.some(edge => model.gapByEdge[edge.id] && edge.target === model.goalId), false);
  assert.deepEqual(targets('gap-PROVENANCE_UNKNOWN').map(item => item.kind), ['requirement', 'evidence']);
  assert.deepEqual(targets('gap-PROVENANCE_UNKNOWN').flatMap(item => item.requirementIds), ['r0']);
  assert.deepEqual(targets('gap-TRUST_WEAK').flatMap(item => item.requirementIds), ['r1']);
  assert.ok(targets('gap-CHAIN_UNKNOWN').some(item => item.gapIds.includes('gap-PROVENANCE_UNKNOWN')));
  const baseline = buildGapOverview(sourceGraph(), run, { evidenceOnly: true, showGaps: false });
  assert.deepEqual(model.graph.edges.filter(edge => !model.gapByEdge[edge.id]), baseline.graph.edges);
});

test('a diagnosis of only the actual root can link to that claim without creating a mandatory goal path', () => {
  const run = completeRun();
  run.result!.gaps = [gap('TRUST_WEAK', { claimId: 'root', requirementIds: [], evidenceIds: [] })];
  const model = buildGapOverview(sourceGraph(), run);
  const links = model.graph.edges.filter(edge => model.gapByEdge[edge.id]);
  assert.equal(links.length, 1);
  assert.equal(links[0].target, model.goalId);
  assert.equal(links[0].label, '검토 대상 주장');
  const changedGoal = buildGapOverview(sourceGraph('다른 질문'), run);
  const oldRoot = changedGoal.graph.edges.find(edge => changedGoal.gapByEdge[edge.id])!;
  assert.notEqual(oldRoot.target, changedGoal.goalId);
  assert.equal(changedGoal.contextById[oldRoot.target].claimId, 'root');
});

test('actual deep child and binding links are preserved without direct support shortcuts', () => {
  const snapshot = whyFixture(1);
  snapshot.nodes[0].children = ['middle'];
  snapshot.nodes.push({ ...snapshot.nodes[0], id: 'middle', statement: '중간 주장', children: ['r0'] });
  const model = buildGapOverview(sourceGraph(), completeRun(snapshot));
  const evidenceId = Object.keys(model.contextById).find(id => model.contextById[id].kind === 'evidence')!;
  const requirementId = Object.keys(model.contextById).find(id => model.contextById[id].kind === 'requirement')!;
  const middleId = Object.keys(model.contextById).find(id => model.contextById[id].kind === 'claim')!;
  assert.equal(model.graph.edges.some(edge => edge.source === evidenceId && edge.target === requirementId), true);
  assert.equal(model.graph.edges.some(edge => edge.source === requirementId && edge.target === middleId), true);
  assert.equal(model.graph.edges.some(edge => edge.source === middleId && edge.target === model.goalId), true);
  assert.equal(model.graph.edges.some(edge => edge.source === evidenceId && edge.target === model.goalId), false);
  assert.equal(model.graph.edges.some(edge => edge.source === requirementId && edge.target === model.goalId), false);
});

test('insufficiency selection identifies the exact recorded binding rather than every decision on the same document', () => {
  const snapshot = whyFixture(1);
  snapshot.bindings[0].verdict = 'INSUFFICIENT';
  snapshot.bindings.push({ ...snapshot.bindings[0], id: 'b-other', verdict: 'SUPPORTED', reason: '별도의 판정' });
  snapshot.nodes[1].children.push('b-other');
  const run = completeRun(snapshot);
  const original = run.result!.gaps.find(item => item.type === 'EVIDENCE_INSUFFICIENT')!;
  const model = buildGapOverview(sourceGraph(), run);
  const gapNode = Object.keys(model.gapByNode).find(id => model.gapByNode[id] === original.id)!;
  assert.deepEqual(model.contextById[gapNode].bindingIds, ['b0']);
  assert.deepEqual(model.contextById[gapNode].requirementIds, original.requirementIds);
  assert.deepEqual(model.contextById[gapNode].evidenceIds, original.evidenceIds);
  assert.deepEqual(model.contextById[gapNode].witnessIds, original.witnessIds);
  assert.equal(model.graph.nodes.filter(node => node.properties.evidenceId === 'e0').length, 1);
  const bindings = Object.values(model.contextById).filter(item => item.kind === 'binding');
  assert.equal(bindings.length, 2);
  assert.equal(model.graph.edges.filter(edge => edge.label === '자료 연결').length, 2);
});

test('the baseline is independent of review decisions and contains no hidden diagnostic metadata', () => {
  const snapshot = whyFixture(2);
  snapshot.bindings[0].verdict = 'INSUFFICIENT';
  snapshot.bindings[0].reason = 'REVIEW_ONLY_REASON';
  const run = completeRun(snapshot);
  run.baseSnapshot = structuredClone(snapshot);
  run.baseSnapshot.bindings.forEach(binding => { binding.verdict = 'UNREVIEWED'; binding.reason = ''; });
  const before = buildGapOverview(sourceGraph(), run, { evidenceOnly: true, showGaps: false });
  assert.ok(Object.values(before.contextById).every(item => item.gapIds.length === 0));
  assert.ok(before.graph.nodes.every(node => !Object.hasOwn(node.properties, 'reviewState')));
  assert.ok(!JSON.stringify(before).includes('REVIEW_ONLY_REASON'));
  assert.deepEqual(before.warnings, []);
  run.snapshot!.nodes[1].statement = 'REVIEW MUST NOT REPLACE THE BASELINE';
  const after = buildGapOverview(sourceGraph(), run, { evidenceOnly: true, showGaps: true });
  assert.deepEqual(before.graph.nodes, after.graph.nodes.filter(node => !after.gapByNode[node.id]));
  assert.deepEqual(before.graph.edges, after.graph.edges.filter(edge => !after.gapByEdge[edge.id]));
  assert.ok(!JSON.stringify(after.graph.nodes).includes('REVIEW MUST NOT REPLACE THE BASELINE'));
});

test('unattached or wrong-parent bindings cannot become evidence support links', () => {
  const snapshot = whyFixture(2);
  snapshot.nodes[0].children = ['r0'];
  snapshot.nodes[1].children = ['b1'];
  const run = { ...completeRun(), snapshot, result: undefined };
  const model = buildGapOverview(sourceGraph(), run);
  assert.equal(Object.values(model.contextById).some(item => item.kind === 'binding'), false);
  assert.equal(Object.values(model.contextById).some(item => item.kind === 'evidence'), false);
  assert.match(model.warnings.join(' '), /원래 노드 또는 자료/);
});

test('provenance bridges require an explicit source identity, never the same URL or display name', () => {
  const graph = sourceGraph();
  const snapshot = whyFixture(1);
  snapshot.evidence[0].url = graph.sources[0].url!;
  snapshot.evidence[0].name = graph.sources[0].title;
  let model = buildGapOverview(graph, completeRun(snapshot));
  assert.equal(Object.values(model.contextById).some(item => item.kind === 'source'), false);
  snapshot.evidence[0].documentId = 'source-1';
  model = buildGapOverview(graph, completeRun(snapshot));
  const bridges = model.graph.edges.filter(edge => model.contextById[edge.id]?.kind === 'source');
  assert.equal(bridges.length, 2);
  assert.equal(bridges.every(edge => edge.label === '같은 원자료' && edge.sourceIds[0] === 'source-1'), true);
  assert.equal(bridges.some(edge => edge.target === model.goalId || edge.source === model.goalId), false);
  assert.equal(bridges.every(edge => /지지한다는 판정이 아닙니다/.test(edge.description)), true);
  snapshot.evidence[0].documentId = null;
  graph.sources[0].contentHash = snapshot.evidence[0].contentHash;
  model = buildGapOverview(graph, completeRun(snapshot));
  assert.equal(Object.values(model.contextById).filter(item => item.kind === 'source').length, 2);
});

test('an old assessment of a different goal cannot silently evaluate the current question', () => {
  const run = completeRun();
  const graph = sourceGraph('새로운 질문인가?');
  const model = buildGapOverview(graph, run);
  assert.equal(model.graph.nodes.find(node => node.id === model.goalId)?.label, graph.question);
  assert.equal(model.decorations.nodes[model.goalId].state, 'found');
  const oldRoot = Object.entries(model.contextById).find(([, value]) => value.kind === 'claim' && value.claimId === run.snapshot!.rootId)!;
  assert.notEqual(oldRoot[0], model.goalId);
  assert.equal(model.graph.edges.some(edge => edge.target === oldRoot[0] && edge.source === model.goalId && edge.label === '저장된 다른 검토 목표'), true);
  assert.match(model.warnings.join(' '), /이전 검토/);
  assert.equal(model.graph.edges.filter(edge => edge.target === model.goalId).length, 0);
});

test('missing gap references remain visible and cannot create dangling links', () => {
  const run = completeRun();
  run.result!.gaps = [gap('CHAIN_UNKNOWN', { claimId: 'absent-claim', requirementIds: ['absent-requirement'], evidenceIds: ['absent-evidence'], witnessIds: ['absent-witness'], causeGapIds: ['absent-gap'] })];
  run.result!.limits = ['진단 방문 한도에 도달했습니다.'];
  const model = buildGapOverview(sourceGraph(), run);
  assert.equal(Object.keys(model.gapByNode).length, 1);
  const ids = new Set(model.graph.nodes.map(node => node.id));
  assert.equal(model.graph.edges.every(edge => ids.has(edge.source) && ids.has(edge.target)), true);
  const gapId = Object.keys(model.gapByNode)[0];
  assert.equal(model.graph.edges.some(edge => edge.source === gapId), false, 'unresolved references must not fall back to the goal');
  assert.deepEqual(model.contextById[gapId].evidenceIds, ['absent-evidence']);
  assert.equal(model.contextById[gapId].bindingIds.length, 0);
  assert.match(model.warnings.join(' '), /absent-claim/);
  assert.match(model.warnings.join(' '), /absent-evidence/);
  assert.match(model.warnings.join(' '), /absent-witness/);
  assert.match(model.warnings.join(' '), /absent-gap/);
  assert.match(model.warnings.join(' '), /방문 한도/);
});

test('causal gap links are diagnostic, shared evidence stays unique, and all arrivals have a bounded stagger', () => {
  const run = completeRun();
  run.result!.gaps = Array.from({ length: 70 }, (_, index) => gap('TRUST_WEAK', { id: `gap-${index}`, evaluationState: 'PENDING', causeGapIds: index ? ['gap-0'] : [] }));
  const graph = sourceGraph();
  graph.nodes.push({ ...graph.nodes[0], id: 'gap-overview:goal:case' });
  const model = buildGapOverview(graph, run);
  assert.equal(Object.keys(model.gapByNode).length, 70);
  assert.equal(model.graph.nodes.filter(node => node.properties.evidenceId === 'e0').length, 1);
  assert.notEqual(model.goalId, 'gap-overview:goal:case');
  assert.equal(new Set(model.graph.nodes.map(node => node.id)).size, model.graph.nodes.length);
  assert.equal(new Set(model.graph.edges.map(edge => edge.id)).size, model.graph.edges.length);
  assert.equal(Object.values(model.decorations.nodes).every(node => (node.revealIndex ?? 0) <= 12), true);
  assert.equal(Object.values(model.decorations.edges).every(edge => (edge.revealIndex ?? 0) <= 12), true);
  assert.equal(model.graph.edges.filter(edge => edge.label === '연결된 공백 사유').length, 69);
});

test('unknown coefficients, pending evidence and NOT_SUPPORT are never converted to a false or supported conclusion', () => {
  const snapshot: WhySnapshot = whyFixture(1);
  snapshot.nodes[0].operator = 'NOT_SUPPORT';
  snapshot.nodes[0].negativeOf = '원래 주장';
  snapshot.nodes[0].statement = '원래 주장은 성립하지 않는다';
  snapshot.evidence[0].sourceCoefficient = null;
  snapshot.evidence[0].processingStatus = 'PENDING';
  const run = completeRun(snapshot);
  const model = buildGapOverview(sourceGraph(), run);
  assert.notEqual(model.decorations.nodes[model.goalId].state, 'resolved');
  assert.notEqual(model.decorations.nodes[model.goalId].state, 'checking', 'pending evaluation is not a running model call');
  assert.equal(model.graph.edges.some(edge => edge.label === '부정 입증에 모두 필요'), true);
  assert.equal(Object.keys(model.gapByNode).length, run.result!.gaps.length);
  assert.equal(model.graph.nodes.some(node => node.properties.evaluationState === 'PENDING'), true);
  assert.equal(run.snapshot!.evidence[0].sourceCoefficient, null);
});
