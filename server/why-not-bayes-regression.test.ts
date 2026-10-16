import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WhyBinding, WhySnapshot } from '../src/types/why-not.ts';
import { confidenceGrade, sourceGradeCoefficient } from '../src/lib/confidence-grade.ts';
import { contentHash } from './why-not-contract.ts';
import { evaluateWhyNot } from './why-not-engine.ts';
import { whyFixture } from './why-not-fixture.ts';

const likelihood = (ratio: number): NonNullable<WhyBinding['likelihood']> => ({ ratio, basis: 'EXPERT_ESTIMATE', reason: '검증에 명시한 목표 우도비' });
const near = (actual: number | null, expected: number) => { assert.notEqual(actual, null); assert.ok(Math.abs(actual! - expected) < 1e-12, `${actual} != ${expected}`); };
function fixture(count = 1, prior = .5): WhySnapshot {
  const snapshot = whyFixture(count);
  snapshot.evidence.forEach(source => { source.sourceGrade = 'A'; });
  snapshot.bindings.forEach(binding => { binding.likelihood = likelihood(2); });
  snapshot.policy.bayes = { target: 'GOAL', priors: [{ nodeId: snapshot.rootId, probability: prior, reason: '자료를 보기 전 목표의 기준값' }], conditionalIndependence: [] };
  return snapshot;
}
const confidence = (snapshot: WhySnapshot) => evaluateWhyNot(snapshot).confidence.bayesian!;
function alternativeObservations(count: number): WhySnapshot {
  const snapshot = fixture(count);
  snapshot.nodes = snapshot.nodes.filter(node => node.id === snapshot.rootId || node.id === 'r0');
  snapshot.nodes[0].children = ['r0'];
  snapshot.nodes[1].children = snapshot.bindings.map(binding => binding.id);
  snapshot.bindings.forEach(binding => { binding.requirementId = 'r0'; });
  return snapshot;
}
function partialOverlap(snapshot: WhySnapshot, left: number, right: number) {
  const a = snapshot.bindings[left]; const b = snapshot.bindings[right];
  snapshot.duplicates.push({ parentId: 'r0', left: a.id, right: b.id, verdict: 'PARTIAL_OVERLAP', reason: '같은 관측의 일부 내용을 공유하며 공동 우도비가 없습니다.', leftQuote: a.quote, rightQuote: b.quote });
}

test('filling a missing requirement with new informative evidence raises confidence once', () => {
  const snapshot = fixture(2);
  const additionalBinding = snapshot.bindings.pop()!;
  additionalBinding.likelihood = likelihood(3);
  const additionalEvidence = snapshot.evidence.pop()!;
  snapshot.nodes.find(node => node.id === 'r1')!.children = [];
  const before = evaluateWhyNot(snapshot);
  assert.ok(before.gaps.some(gap => gap.type === 'EVIDENCE_MISSING' && gap.requirementIds.includes('r1')));
  near(before.confidence.bayesian!.score, 2 / 3);
  snapshot.bindings.push(additionalBinding);
  snapshot.evidence.push(additionalEvidence);
  snapshot.nodes.find(node => node.id === 'r1')!.children.push(additionalBinding.id);
  const after = evaluateWhyNot(snapshot);
  assert.ok(!after.gaps.some(gap => gap.type === 'EVIDENCE_MISSING' && gap.requirementIds.includes('r1')));
  near(after.confidence.bayesian!.score, 6 / 7);
  snapshot.bindings.push({ ...structuredClone(additionalBinding), id: 'repeated-supplement' });
  snapshot.nodes.find(node => node.id === 'r1')!.children.push('repeated-supplement');
  near(confidence(snapshot).score, 6 / 7);
});

test('an independently supported supplement resolves an insufficient alternative and raises the saved goal score', () => {
  const snapshot = fixture();
  snapshot.bindings[0].verdict = 'INSUFFICIENT';
  snapshot.bindings[0].likelihood = likelihood(1);
  snapshot.evidence[0].sourceGrade = 'D';
  const before = evaluateWhyNot(snapshot);
  near(before.confidence.bayesian!.score, .5);
  assert.ok(before.gaps.some(gap => gap.reasonCode === 'INSUFFICIENT'));

  const addition = fixture(2);
  const binding = addition.bindings[1];
  binding.requirementId = 'r0';
  binding.likelihood = { ...likelihood(4), hypothesisId: snapshot.rootId };
  const source = addition.evidence[1]; source.sourceGrade = 'B';
  snapshot.bindings.push(binding); snapshot.evidence.push(source);
  snapshot.nodes.find(node => node.id === 'r0')!.children.push(binding.id);
  const after = evaluateWhyNot(snapshot);

  near(after.confidence.bayesian!.score, 3.4 / 4.4);
  assert.equal(after.chainStatus, 'COMPLETE_CHAIN_FOUND');
  assert.equal(after.confidence.bayesian!.status, 'ASSESSED');
  assert.equal(after.accepted, true);
  assert.equal(after.confidence.bayesian!.bindings.find(trace => trace.bindingId === binding.id)!.status, 'USED');
  assert.ok(after.gaps.filter(gap => gap.reasonCode === 'INSUFFICIENT').every(gap => gap.blockingScope === 'ALTERNATIVE'));
  assert.equal(snapshot.bindings[0].verdict, 'INSUFFICIENT');
  assert.equal(snapshot.bindings[0].likelihood!.ratio, 1);
});

test('a completed insufficient verdict may be neutral, but cannot supply positive likelihood or bypass processing', () => {
  const snapshot = fixture(); snapshot.bindings[0].verdict = 'INSUFFICIENT';
  snapshot.bindings[0].likelihood = likelihood(1);
  let result = confidence(snapshot);
  near(result.score, .5); assert.equal(result.status, 'ASSESSED');
  assert.equal(result.bindings[0].status, 'USED');
  assert.ok(!result.unknownReasons.some(reason => reason.includes('LR 방향')));

  snapshot.bindings[0].likelihood = likelihood(4);
  result = confidence(snapshot);
  near(result.score, .5); assert.equal(result.bindings[0].status, 'UNASSESSED');

  snapshot.bindings[0].likelihood = likelihood(1);
  snapshot.evidence[0].processingStatus = 'PENDING';
  result = confidence(snapshot);
  near(result.score, .5); assert.equal(result.bindings[0].status, 'UNASSESSED');
});

test('distinct observations are not discarded just because their source URL matches', () => {
  const snapshot = fixture(2);
  snapshot.evidence.forEach(source => { source.url = 'https://example.org/independent-records'; source.sourceGrade = 'D'; });
  snapshot.bindings[1].likelihood = likelihood(3);
  const result = confidence(snapshot);
  // The URL is metadata, not a duplicate or verified dependency decision.
  near(result.score, (1.4 * 1.8) / (1 + 1.4 * 1.8));
  assert.ok(result.bindings.every(trace => trace.status === 'USED'));
  assert.equal(result.bindings.filter(trace => trace.adjustedLikelihoodRatio! > 1).length, 2);
});

test('a new refuting observation lowers confidence instead of rewarding every supplement', () => {
  const snapshot = fixture(2);
  snapshot.bindings[0].likelihood = likelihood(3);
  snapshot.bindings[1].verdict = 'REFUTED';
  snapshot.bindings[1].likelihood = likelihood(.25);
  snapshot.evidence[1].sourceGrade = 'B';
  const result = confidence(snapshot);
  const adjustedRefutation = .8 * .25 + .2;
  near(result.score, (3 * adjustedRefutation) / (1 + 3 * adjustedRefutation));
  assert.ok(result.score < .75);
  assert.equal(result.bindings.find(trace => trace.bindingId === 'b1')!.status, 'USED');
});

test('fixed A–F grades define reliability independently of free source and material coefficients', () => {
  for (const [grade, r] of [['A', 1], ['B', .8], ['C', .6], ['D', .4], ['E', .2], ['F', 0]] as const) {
    const snapshot = fixture(); snapshot.evidence[0].sourceGrade = grade;
    snapshot.evidence[0].sourceCoefficient = .001; snapshot.bindings[0].materialCoefficient = 0;
    snapshot.bindings[0].likelihood = likelihood(4);
    const result = confidence(snapshot); const adjusted = r * 4 + (1 - r);
    assert.equal(sourceGradeCoefficient(grade), r);
    near(result.bindings[0].adjustedLikelihoodRatio, adjusted);
    near(result.posterior, adjusted / (1 + adjusted));
  }
});

test('linear reliability formula .9 prior, LR .1 and B reliability gives adjusted LR .28', () => {
  const snapshot = fixture(1, .9); snapshot.evidence[0].sourceGrade = 'B';
  snapshot.bindings[0].likelihood = likelihood(.1); snapshot.bindings[0].verdict = 'REFUTED';
  const result = confidence(snapshot);
  assert.equal(result.method, 'LINEAR_RELIABILITY_BAYES');
  near(result.bindings[0].adjustedLikelihoodRatio, .28);
  near(result.score, (9 * .28) / (1 + 9 * .28));
  assert.equal(result.grade, 'B');
});

test('missing historical inputs give one neutral goal prior .5, even for many AND conditions', () => {
  const snapshot = whyFixture(4);
  const result = confidence(snapshot);
  near(result.posterior, .5); assert.equal(result.grade, 'C');
  assert.ok(result.bindings.every(binding => binding.rawLikelihoodRatio === 1 && binding.likelihoodBasis === 'BASELINE'));
  assert.ok(result.assumptions.some(reason => reason.includes('.5')));
});

test('goal odds multiply unique goal likelihoods once, without another AND/OR/NOT multiplication', () => {
  const snapshot = fixture(2); snapshot.bindings[1].likelihood = likelihood(3);
  for (const operator of ['AND', 'OR', 'NOT_SUPPORT'] as const) {
    snapshot.nodes[0].operator = operator;
    snapshot.nodes[0].negativeOf = operator === 'NOT_SUPPORT' ? '부정 입증 대상' : null;
    near(confidence(snapshot).score, 6 / 7);
  }
});

test('missing source and F grade are exactly neutral, including maximum finite LR', () => {
  for (const grade of [null, 'F'] as const) {
    const snapshot = fixture(1, .37); snapshot.evidence[0].sourceGrade = grade;
    snapshot.bindings[0].likelihood = likelihood(Number.MAX_VALUE);
    const result = confidence(snapshot);
    assert.equal(result.bindings[0].sourceCoefficient, 0);
    assert.equal(result.bindings[0].adjustedLikelihoodRatio, 1);
    near(result.score, .37);
  }
});

test('zero LR is allowed and stable; prior one with zero LR remains an explicit contradiction', () => {
  const snapshot = fixture(); snapshot.bindings[0].likelihood = likelihood(0); snapshot.bindings[0].verdict = 'REFUTED';
  let result = confidence(snapshot); assert.equal(result.score, 0); assert.equal(result.grade, 'F');
  assert.equal(result.bindings[0].adjustedLikelihoodRatio, 0);
  assert.ok(!JSON.stringify(result).includes('Infinity'));
  snapshot.policy.bayes!.priors[0].probability = 1;
  result = confidence(snapshot);
  assert.equal(result.status, 'PARTIAL'); assert.equal(result.posterior, null);
  assert.deepEqual(result.range, [0, 1]); assert.equal(result.scoreBasis, 'CONSERVATIVE_LOWER_BOUND');
  assert.ok(result.unknownReasons.some(reason => reason.includes('분모가 0')));
});

test('an exact repeated observation never multiplies its likelihood twice', () => {
  const snapshot = fixture(); const before = confidence(snapshot);
  snapshot.bindings.push({ ...structuredClone(snapshot.bindings[0]), id: 'copy' });
  snapshot.nodes.find(node => node.id === 'r0')!.children.push('copy');
  const after = confidence(snapshot);
  assert.equal(after.score, before.score);
  assert.equal(after.bindings.find(binding => binding.bindingId === 'copy')!.status, 'DUPLICATE');
});

test('shared observations contribute once globally and to every node that actually references them', () => {
  for (const firstId of ['b0', 'z-binding']) {
    const snapshot = fixture(2);
    snapshot.bindings[0].id = firstId;
    snapshot.nodes.find(node => node.id === 'r0')!.children = [firstId];
    snapshot.bindings[1] = { ...structuredClone(snapshot.bindings[0]), id: 'b1', requirementId: 'r1' };
    snapshot.nodes.find(node => node.id === 'r1')!.threshold = .6;
    const result = evaluateWhyNot(snapshot); const bayes = result.confidence.bayesian!;
    near(bayes.score, 2 / 3);
    for (const id of ['root', 'r0', 'r1']) near(bayes.trace.find(trace => trace.nodeId === id)!.posterior, 2 / 3);
    assert.equal(bayes.bindings.filter(trace => trace.status === 'USED').length, 1);
    assert.equal(bayes.bindings.filter(trace => trace.status === 'DUPLICATE').length, 1);
    assert.ok(!result.gaps.some(gap => gap.reasonCode === 'SUBCLAIM_THRESHOLD'));
    assert.equal(result.accepted, true);
  }
});

test('different observations from a verified common lineage are not mislabeled duplicates or multiplied', () => {
  const snapshot = fixture(2); const url = 'https://example.org/original';
  snapshot.evidence[0].url = url; snapshot.evidence[1].text += ` 인용 ${url}`;
  snapshot.evidence[1].contentHash = contentHash(snapshot.evidence[1].text);
  snapshot.provenance = [{ from: 'e1', to: 'e0', verified: true, quote: url, likelihood: { kind: 'NO_NEW_INFORMATION', value: null, reason: '동일 출처 인용' } }];
  const result = confidence(snapshot);
  assert.equal(result.status, 'PARTIAL'); near(result.score, .5);
  assert.ok(result.bindings.every(binding => binding.status !== 'DUPLICATE'));
  assert.ok(result.unknownReasons.some(reason => reason.includes('출처 계보')));
});

test('known partial overlap is neutral without a joint likelihood despite an independence declaration', () => {
  const snapshot = alternativeObservations(3);
  snapshot.bindings[0].likelihood = likelihood(12); snapshot.evidence[0].sourceGrade = 'C';
  snapshot.bindings[1].likelihood = likelihood(6); snapshot.evidence[1].sourceGrade = 'C';
  snapshot.bindings[2].likelihood = likelihood(4); snapshot.evidence[2].sourceGrade = 'B';
  partialOverlap(snapshot, 0, 1);
  snapshot.policy.bayes!.conditionalIndependence = [{ requirementId: snapshot.rootId, bindingIds: snapshot.bindings.map(binding => binding.id), reason: '사용자가 입력한 독립성 가정' }];
  const result = confidence(snapshot);
  near(result.score, 3.4 / 4.4);
  assert.equal(result.status, 'PARTIAL');
  for (const id of ['b0', 'b1']) {
    const trace = result.bindings.find(trace => trace.bindingId === id)!;
    assert.equal(trace.status, 'UNASSESSED'); assert.equal(trace.adjustedLikelihoodRatio, 1);
    assert.match(trace.reason, /PARTIAL_OVERLAP/);
  }
  assert.notEqual(result.bindings[0].observationId, result.bindings[1].observationId);
  assert.equal(result.bindings.find(trace => trace.bindingId === 'b2')!.status, 'USED');
  assert.ok(result.unknownReasons.some(reason => reason.includes('부분 중복')));
});

test('a connected partial-overlap component is held consistently without merging its observations', () => {
  const snapshot = alternativeObservations(4);
  snapshot.bindings[1].likelihood = likelihood(1);
  snapshot.bindings[3].likelihood = likelihood(4);
  partialOverlap(snapshot, 0, 1); partialOverlap(snapshot, 1, 2);
  for (const current of [snapshot, { ...structuredClone(snapshot), duplicates: [...snapshot.duplicates].reverse() }]) {
    const result = confidence(current);
    near(result.score, 4 / 5);
    assert.ok(result.bindings.slice(0, 3).every(trace => trace.status === 'UNASSESSED'));
    assert.equal(new Set(result.bindings.slice(0, 3).map(trace => trace.observationId)).size, 3);
    assert.equal(result.bindings[3].status, 'USED');
  }
});

test('an entirely neutral overlap component does not block a separate informative observation', () => {
  const snapshot = alternativeObservations(3);
  snapshot.bindings[0].likelihood = likelihood(1); snapshot.bindings[1].likelihood = likelihood(1);
  partialOverlap(snapshot, 0, 1);
  const result = confidence(snapshot);
  near(result.score, 2 / 3);
  assert.equal(result.status, 'ASSESSED');
  assert.ok(!result.unknownReasons.some(reason => reason.includes('부분 중복')));
});

test('old multi-condition likelihoods are not silently reinterpreted as root-goal likelihoods', () => {
  const snapshot = fixture(2); delete snapshot.policy.bayes;
  let result = confidence(snapshot); near(result.score, .5);
  assert.ok(result.assumptions.some(reason => reason.includes('재해석하지')));
  snapshot.policy.bayes = { target: 'GOAL', priors: [], conditionalIndependence: [] };
  result = confidence(snapshot); near(result.score, .8);
});

test('grade thresholds use unrounded score with exact lower-band boundaries', () => {
  for (const [score, grade] of [[0, 'F'], [Number.MIN_VALUE, 'E'], [.2, 'E'], [.200000001, 'D'], [.4, 'D'], [.400000001, 'C'], [.6, 'C'], [.600000001, 'B'], [.8, 'B'], [.800000001, 'A'], [1, 'A']] as const) assert.equal(confidenceGrade(score), grade);
});

test('finite extreme ratios and boundary priors do not overflow the returned score', () => {
  for (const [prior, ratio, verdict, expected] of [[.5, Number.MAX_VALUE, 'SUPPORTED', 1], [.5, Number.MIN_VALUE, 'REFUTED', 0], [0, Number.MAX_VALUE, 'SUPPORTED', 0], [1, Number.MIN_VALUE, 'REFUTED', 1]] as const) {
    const snapshot = fixture(1, prior); snapshot.bindings[0].likelihood = likelihood(ratio); snapshot.bindings[0].verdict = verdict;
    const result = confidence(snapshot); assert.ok(Number.isFinite(result.score)); near(result.score, expected);
  }
});

test('finite positive odds remain inside the representable open interval rather than rounding to certainty', () => {
  for (const [ratio, verdict, expected] of [[100, 'SUPPORTED', 1 - Number.EPSILON / 2], [Number.MIN_VALUE, 'REFUTED', Number.MIN_VALUE]] as const) {
    const snapshot = alternativeObservations(10);
    snapshot.bindings.forEach(binding => { binding.likelihood = likelihood(ratio); binding.verdict = verdict; });
    const result = confidence(snapshot);
    assert.equal(result.score, expected);
    assert.ok(result.score > 0 && result.score < 1);
    assert.ok(result.baselineScore! > 0 && result.baselineScore! < 1);
    for (const trace of result.trace) assert.ok(trace.posterior! > 0 && trace.posterior! < 1);
    assert.ok(!JSON.stringify(result).includes('Infinity'));
  }
  const exactZero = fixture(); exactZero.bindings[0].verdict = 'REFUTED'; exactZero.bindings[0].likelihood = likelihood(0);
  assert.equal(confidence(exactZero).score, 0);
  assert.equal(confidence(fixture(1, 0)).score, 0);
  assert.equal(confidence(fixture(1, 1)).score, 1);
});

test('negative likelihood ratios still fail the saved snapshot contract', () => {
  const snapshot = fixture(); snapshot.bindings[0].likelihood = likelihood(-.1);
  assert.throws(() => evaluateWhyNot(snapshot), /binding.likelihood.ratio/);
});

test('off/on compares raw and source-adjusted likelihoods over the same goal observations', () => {
  const snapshot = fixture(); snapshot.bindings[0].likelihood = likelihood(5); snapshot.evidence[0].sourceGrade = 'B';
  let result = confidence(snapshot);
  near(result.baselineScore, 5 / 6); near(result.score, 4.2 / 5.2);
  snapshot.evidence[0].sourceGrade = 'F'; result = confidence(snapshot);
  near(result.baselineScore, 5 / 6); near(result.score, .5);
  snapshot.bindings[0].likelihood = likelihood(1); result = confidence(snapshot);
  near(result.baselineScore, .5); near(result.score, .5);
});
