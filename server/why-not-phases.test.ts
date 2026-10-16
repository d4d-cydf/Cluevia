import assert from 'node:assert/strict';
import { test } from 'node:test';
import { whyFixture } from './why-not-fixture.ts';
import { contentHash } from './why-not-contract.ts';
import { snapshotFromWhyBaseline, applyWhyReview } from './why-not-phases.ts';

function baseline() {
  const saved = whyFixture(1);
  const raw = { rootId: saved.rootId, nodes: saved.nodes.map(node => ({ ...node, children: node.kind === 'requirement' ? [] : node.children })), eventRules: [], bindings: [{ evidenceId: 'e0', requirementId: 'r0', quote: saved.bindings[0].quote }] };
  return { saved, raw, snapshot: snapshotFromWhyBaseline(raw, saved.goal, saved.evidence, 'phase-one') };
}
function review(snapshot = baseline().snapshot) {
  return { decisions: snapshot.bindings.map(binding => ({ bindingId: binding.id, verdict: 'SUPPORTED', reason: '실제 인용문에 요구한 사실이 명시되어 있습니다.', missingRequirements: [], metadata: { fields: [], start: null, end: null, timeQuote: null } })), duplicates: [] };
}

test('baseline stores exact quote links but no sufficiency or duplicate judgement', () => {
  const { snapshot, saved } = baseline();
  assert.equal(snapshot.bindings[0].verdict, 'UNREVIEWED');
  assert.equal(snapshot.bindings[0].quote, saved.bindings[0].quote);
  assert.equal(snapshot.bindings[0].evaluator, 'graph-baseline');
  assert.deepEqual(snapshot.duplicates, []);
  assert.deepEqual(snapshot.bindings[0].metadata.fields, []);
});

test('baseline rejects invented quotations and hidden diagnostic fields', () => {
  const { raw, saved } = baseline();
  assert.throws(() => snapshotFromWhyBaseline({ ...raw, bindings: [{ ...raw.bindings[0], quote: '없는 원문' }] }, saved.goal, saved.evidence, 'version'), /실제 원문/);
  assert.throws(() => snapshotFromWhyBaseline({ ...raw, bindings: [{ ...raw.bindings[0], verdict: 'SUPPORTED' }] }, saved.goal, saved.evidence, 'version'), /허용되지/);
  assert.throws(() => snapshotFromWhyBaseline({ ...raw, duplicates: [] }, saved.goal, saved.evidence, 'version'), /허용되지/);
});

test('review updates fixed decisions without moving nodes, quotations, evidence or their IDs', () => {
  const { snapshot } = baseline(); const before = structuredClone(snapshot);
  const reviewed = applyWhyReview(snapshot, review(snapshot), 'phase-two');
  assert.deepEqual(reviewed.nodes, before.nodes); assert.deepEqual(reviewed.evidence, before.evidence);
  assert.equal(reviewed.bindings[0].id, before.bindings[0].id); assert.equal(reviewed.bindings[0].quote, before.bindings[0].quote);
  assert.equal(reviewed.bindings[0].verdict, 'SUPPORTED'); assert.equal(snapshot.bindings[0].verdict, 'UNREVIEWED');
});

test('review refuses rewritten graph fields, quotations, missing or repeated target decisions', () => {
  const { snapshot } = baseline(); const raw = review(snapshot);
  assert.throws(() => applyWhyReview(snapshot, { ...raw, nodes: [] }, 'next'), /허용되지/);
  assert.throws(() => applyWhyReview(snapshot, { ...raw, decisions: [{ ...raw.decisions[0], quote: '변경' }] }, 'next'), /허용되지/);
  assert.throws(() => applyWhyReview(snapshot, { decisions: [], duplicates: [] }, 'next'), /누락/);
  assert.throws(() => applyWhyReview(snapshot, { ...raw, decisions: [raw.decisions[0], raw.decisions[0]] }, 'next'), /한 번/);
});

test('supplement preserves existing manual assessments and permits review only of the new bindings', () => {
  const previous = whyFixture(1); previous.bindings[0].evaluator = 'manual-reviewer';
  const text = '새 원본의 E1 완료 확인';
  const source = { ...previous.evidence[0], id: 'new-source', text, contentHash: contentHash(text) };
  const raw = { rootId: previous.rootId, nodes: [], eventRules: [], bindings: [{ evidenceId: source.id, requirementId: 'r0', quote: text }] };
  const snapshot = snapshotFromWhyBaseline(raw, previous.goal, [source], 'supplement-one', previous);
  const newBinding = snapshot.bindings[1];
  const response = { decisions: [review(snapshot).decisions[1]], duplicates: [] };
  const reviewed = applyWhyReview(snapshot, response, 'supplement-two', { bindingIds: [newBinding.id] });
  assert.deepEqual(reviewed.bindings[0], previous.bindings[0]);
  assert.equal(reviewed.bindings[1].verdict, 'SUPPORTED');
  assert.throws(() => applyWhyReview(snapshot, review(snapshot), 'bad', { bindingIds: [newBinding.id] }), /지정한/);
});

test('duplicate review cannot invent references or rewrite an existing saved duplicate decision', () => {
  const { snapshot } = baseline();
  const response = { ...review(snapshot), duplicates: [{ parentId: 'r0', left: snapshot.bindings[0].id, right: 'missing', verdict: 'SAME_OBSERVATION', reason: '위조 참조' }] };
  assert.throws(() => applyWhyReview(snapshot, response, 'bad'), /실제 검토 자료/);
});
