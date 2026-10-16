import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateWhyNot } from '../../server/why-not-engine.ts';
import { whyFixture } from '../../server/why-not-fixture.ts';
import type { WhyNode } from '../types/why-not.ts';
import { buildWhyOverview } from './why-overview.ts';

function deepFixture() {
  const snapshot = whyFixture(1);
  const claim = (id: string, child: string): WhyNode => ({ ...snapshot.nodes[0], id, statement: `${id} 하위 주장`, children: [child] });
  snapshot.nodes[0].children = ['claim-a'];
  snapshot.nodes.push(claim('claim-a', 'claim-b'), claim('claim-b', 'r0'));
  return snapshot;
}

test('a conclusion board preserves each logical link and actual evidence binding', () => {
  const snapshot = whyFixture(2);
  const model = buildWhyOverview(snapshot, evaluateWhyNot(snapshot));
  assert.equal(model.rootId, 'why:root');
  assert.equal(model.question, snapshot.goal);
  assert.deepEqual(model.nodes.map(node => node.kind), ['conclusion', 'requirement', 'requirement', 'evidence', 'evidence']);
  assert.equal(model.nodes[0].status, 'supported');
  assert.deepEqual(model.edges.map(edge => [edge.source, edge.target, edge.kind]), [
    ['why:r0', 'why:root', 'logic'], ['why:r1', 'why:root', 'logic'],
    ['evidence:e0', 'why:r0', 'binding'], ['evidence:e1', 'why:r1', 'binding'],
  ]);
  const materialEdge = model.edges.find(edge => edge.bindingId === 'b0')!;
  assert.equal(materialEdge.quote, snapshot.bindings[0].quote);
  assert.equal(materialEdge.verdict, 'SUPPORTED');
  assert.equal(materialEdge.reason, snapshot.bindings[0].reason);
  assert.equal(model.coverage.totalNodes, 5);
  assert.equal(model.coverage.hiddenNodes, 0);
});

test('deep claims stay connected through their real path with no direct evidence-to-conclusion shortcut', () => {
  const snapshot = deepFixture();
  const model = buildWhyOverview(snapshot, evaluateWhyNot(snapshot));
  assert.deepEqual(model.nodes.map(node => [node.id, node.depth]), [
    ['why:root', 0], ['why:claim-a', 1], ['why:claim-b', 2], ['why:r0', 3], ['evidence:e0', 4],
  ]);
  assert.equal(model.edges.length, 4);
  assert.equal(model.edges.some(edge => edge.source === 'evidence:e0' && edge.target === 'why:root'), false);
  assert.equal(model.edges.find(edge => edge.target === 'why:root')?.source, 'why:claim-a');
});

test('one document is shared across requirements while each conflicting binding stays separate', () => {
  const snapshot = whyFixture(2);
  snapshot.bindings[1].evidenceId = 'e0';
  snapshot.bindings[1].verdict = 'REFUTED';
  snapshot.evidence[0].record = 7;
  const model = buildWhyOverview(snapshot);
  assert.equal(model.nodes.filter(node => node.kind === 'evidence').length, 1);
  const material = model.nodes.find(node => node.evidenceId === 'e0')!;
  assert.equal(material.record, 7);
  assert.equal(material.status, 'insufficient');
  assert.deepEqual(model.edges.filter(edge => edge.kind === 'binding').map(edge => edge.verdict), ['SUPPORTED', 'REFUTED']);
  assert.equal(model.edges.filter(edge => edge.source === material.id).length, 2);
});

test('an empty proof is a gap, never a refuted conclusion', () => {
  const snapshot = whyFixture(1);
  snapshot.nodes[1].children = [];
  snapshot.bindings = [];
  snapshot.evidence = [];
  const result = evaluateWhyNot(snapshot);
  const model = buildWhyOverview(snapshot, result);
  assert.equal(model.nodes[0].status, 'gap');
  assert.equal(model.nodes.find(node => node.originalNodeId === 'r0')?.status, 'gap');
  assert.equal(model.nodes.some(node => node.status === 'refuted'), false);
  assert.equal(model.edges.length, 1);
  assert.equal(model.nodes[0].gapIds.includes(result.gaps.find(gap => gap.type === 'CHAIN_UNKNOWN')!.id), true);
});

test('NOT_SUPPORT keeps the negative claim wording and needs explicit affirmative evidence', () => {
  const snapshot = whyFixture(1);
  snapshot.nodes[0].operator = 'NOT_SUPPORT';
  snapshot.nodes[0].negativeOf = 'E1 완료';
  snapshot.nodes[0].statement = 'E1은 완료되지 않았다';
  let model = buildWhyOverview(snapshot, evaluateWhyNot(snapshot));
  assert.equal(model.nodes[0].title, 'E1은 완료되지 않았다');
  assert.equal(model.nodes[0].status, 'supported');
  assert.equal(model.edges[0].operator, 'NOT_SUPPORT');
  snapshot.bindings[0].verdict = 'REFUTED';
  model = buildWhyOverview(snapshot, evaluateWhyNot(snapshot));
  assert.notEqual(model.nodes[0].status, 'supported');
  assert.notEqual(model.nodes[0].status, 'refuted');
  assert.equal(model.nodes.find(node => node.kind === 'evidence')?.status, 'refuted');
  assert.equal(model.edges.find(edge => edge.kind === 'binding')?.verdict, 'REFUTED');
});

test('pending material and unreviewed decisions remain visibly unfinished', () => {
  const snapshot = whyFixture(1);
  snapshot.evidence[0].processingStatus = 'PENDING';
  let model = buildWhyOverview(snapshot, evaluateWhyNot(snapshot));
  assert.equal(model.nodes[0].status, 'pending');
  assert.equal(model.nodes.find(node => node.kind === 'evidence')?.status, 'pending');
  assert.equal(model.coverage.complete, false);
  snapshot.evidence[0].processingStatus = 'READY';
  snapshot.bindings[0].verdict = 'UNREVIEWED';
  model = buildWhyOverview(snapshot, evaluateWhyNot(snapshot));
  assert.equal(model.nodes.find(node => node.kind === 'evidence')?.status, 'unreviewed');
  assert.notEqual(model.nodes[0].status, 'supported');
});

test('the initial cap reports omitted nodes and never leaves a dangling edge', () => {
  const snapshot = whyFixture(18);
  const model = buildWhyOverview(snapshot);
  assert.equal(model.nodes.length, 24);
  assert.equal(model.coverage.totalNodes, 37);
  assert.equal(model.coverage.hiddenNodes, 13);
  assert.equal(model.coverage.hiddenEdges, 13);
  assert.equal(model.nodes.some(node => node.kind === 'evidence'), true, 'a wide board reserves room for actual material connections');
  const shownIds = new Set(model.nodes.map(node => node.id));
  assert.equal(model.edges.every(edge => shownIds.has(edge.source) && shownIds.has(edge.target)), true);
  const full = buildWhyOverview(snapshot, undefined, { maxNodes: Infinity });
  assert.equal(full.nodes.length, 37);
  assert.equal(full.coverage.hiddenNodes, 0);
});

test('search retains the root and every real ancestor of a matching evidence node', () => {
  const snapshot = deepFixture();
  snapshot.evidence[0].name = '특정 원본 자료';
  const model = buildWhyOverview(snapshot, undefined, { query: '특정 원본', maxNodes: 5 });
  assert.equal(model.queryMatched, true);
  assert.equal(model.nodes.length, 5);
  assert.equal(model.edges.length, 4);
  assert.equal(model.nodes.filter(node => node.searchMatch).length, 1);
  const limited = buildWhyOverview(snapshot, undefined, { query: '특정 원본', maxNodes: 4 });
  assert.deepEqual(limited.nodes.map(node => node.id), ['why:root']);
  assert.equal(limited.edges.length, 0);
  assert.match(limited.warnings.join(' '), /연결 경로/);
});

test('search misses retain conclusion context and do not fabricate a new answer', () => {
  const snapshot = whyFixture(2);
  const model = buildWhyOverview(snapshot, undefined, { query: '존재하지 않는 검색어' });
  assert.equal(model.queryMatched, false);
  assert.deepEqual(model.nodes.map(node => node.id), ['why:root']);
  assert.equal(model.nodes[0].title, snapshot.nodes[0].statement);
  assert.equal(model.nodes[0].status, 'unreviewed');
  assert.equal(model.edges.length, 0);
});

test('unattached bindings and unreachable nodes cannot manufacture support links', () => {
  const snapshot = whyFixture(2);
  snapshot.nodes[0].children = ['r0'];
  snapshot.nodes[1].children = [];
  const model = buildWhyOverview(snapshot);
  assert.deepEqual(model.nodes.map(node => node.id), ['why:root', 'why:r0']);
  assert.equal(model.edges.length, 1);
  assert.equal(model.nodes.some(node => node.kind === 'evidence'), false);
});

test('missing or mismatched child references produce warnings instead of invented relations', () => {
  const snapshot = whyFixture(2);
  snapshot.nodes[1].children = ['b1', 'missing'];
  const model = buildWhyOverview(snapshot);
  assert.equal(model.edges.some(edge => edge.bindingId === 'b0'), false);
  assert.equal(model.edges.filter(edge => edge.bindingId === 'b1').length, 1);
  assert.match(model.warnings.join(' '), /원래 노드 또는 자료/);
  assert.equal(model.nodes.some(node => node.id === 'why:missing'), false);
});

test('the same child under two parents keeps both links rather than becoming two copies', () => {
  const snapshot = deepFixture();
  snapshot.nodes[0].children.push('r0');
  const model = buildWhyOverview(snapshot);
  assert.equal(model.nodes.filter(node => node.originalNodeId === 'r0').length, 1);
  assert.equal(model.edges.filter(edge => edge.source === 'why:r0').length, 2);
  assert.equal(model.nodes.find(node => node.originalNodeId === 'r0')?.depth, 1);
});

test('gap references and coverage limitations stay available without mutating analysis data', () => {
  const snapshot = whyFixture(1);
  snapshot.coverage = { complete: false, note: '다른 자료가 아직 처리 중입니다.' };
  snapshot.bindings[0].verdict = 'INSUFFICIENT';
  const result = evaluateWhyNot(snapshot);
  const before = JSON.stringify({ snapshot, result });
  const model = buildWhyOverview(snapshot, result);
  const localGap = result.gaps.find(gap => gap.claimId === 'r0')!;
  assert.equal(model.nodes.find(node => node.evidenceId === 'e0')!.gapIds.includes(localGap.id), true);
  assert.equal(model.edges.find(edge => edge.bindingId === 'b0')!.gapIds.includes(localGap.id), true);
  assert.equal(model.coverage.complete, false);
  assert.equal(model.warnings.includes(snapshot.coverage.note), true);
  assert.equal(JSON.stringify({ snapshot, result }), before);
});
