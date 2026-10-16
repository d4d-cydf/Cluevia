import assert from 'node:assert/strict';
import { test } from 'node:test';
import { whyFixture } from './why-not-fixture.ts';
import { parseWhySnapshot } from './why-not-contract.ts';
import { evaluateWhyNot } from './why-not-engine.ts';
import { applyWhyEstimation, estimationContext, estimationSchema } from './why-not-estimation.ts';

const run = { model: 'claude-sonnet-4-6', estimatedAt: '2026-10-11T01:00:00Z' };
function fixture() {
  const snapshot = whyFixture(1);
  const anchors = [{ evidenceId: 'e0', quote: snapshot.bindings[0].quote }];
  const response = { prior: { probability: .2, reason: '목표의 문맥을 바탕으로 한 보정되지 않은 모델 추정입니다.', anchors }, bindings: [{ bindingId: 'b0', ratio: 4, reason: '저장된 직접 관측의 상대 가능도에 대한 모델 추정입니다.', anchors }], sources: [{ evidenceId: 'e0', grade: 'D', reason: '인용 기사로 보이나 원자료 검증이 확인되지 않았습니다.', anchors }] };
  return { snapshot, response };
}

test('Claude estimates remain MODEL_ESTIMATE with exact anchors and survive snapshot parsing', () => {
  const { snapshot, response } = fixture();
  const next = applyWhyEstimation(snapshot, response, run);
  const parsed = parseWhySnapshot(next);
  assert.equal(parsed.policy.bayes!.priors.find(prior => prior.nodeId === parsed.rootId)!.basis, 'MODEL_ESTIMATE');
  assert.equal(parsed.bindings[0].likelihood!.basis, 'MODEL_ESTIMATE');
  assert.equal(parsed.bindings[0].likelihood!.hypothesisId, parsed.rootId);
  assert.deepEqual(parsed.bindings[0].likelihood!.estimation!.anchors[0], { ...response.bindings[0].anchors[0], start: 0, end: snapshot.bindings[0].quote.length });
  assert.equal(parsed.bindings[0].likelihood!.estimation!.effort, 'low');
  assert.equal(parsed.evidence[0].sourceGrade, 'B');
  assert.ok(Math.abs(evaluateWhyNot(parsed).confidence.bayesian!.score - 17 / 37) < 1e-12);
  assert.deepEqual(next.nodes, snapshot.nodes); assert.equal(next.bindings[0].quote, snapshot.bindings[0].quote);
  assert.equal(snapshot.bindings[0].likelihood, undefined);
});

test('unknown source grades can be classified without claiming the origin was verified', () => {
  const { snapshot, response } = fixture(); snapshot.evidence[0].sourceGrade = null; snapshot.evidence[0].sourceCoefficient = null;
  const next = applyWhyEstimation(snapshot, response, run);
  assert.equal(next.evidence[0].sourceGrade, 'D'); assert.equal(next.evidence[0].sourceCoefficient, .4);
  assert.equal(next.evidence[0].originalVerified, false); assert.equal(next.evidence[0].sourceEstimation!.model, run.model);
});

test('invalid individual estimates retain neutral inputs while other valid estimates are saved', () => {
  const { snapshot, response } = fixture(); snapshot.evidence[0].sourceGrade = null;
  response.prior.probability = 1; response.sources[0].grade = 'A';
  const next = applyWhyEstimation(snapshot, response, run);
  assert.equal(next.policy.bayes!.priors.length, 0);
  assert.equal(next.bindings[0].likelihood!.ratio, 4);
  assert.equal(next.evidence[0].sourceGrade, null);
  assert.equal(next.policy.bayes!.estimationNotes!.length, 2);
  response.prior.probability = .2; response.bindings[0].anchors[0].quote = '제공되지 않은 인용';
  const badQuote = applyWhyEstimation(snapshot, response, run);
  assert.equal(badQuote.bindings[0].likelihood, undefined);
  assert.ok(badQuote.policy.bayes!.estimationNotes!.some(note => note.includes('실제 자료')));
});

test('manual or calibrated numbers and source grades are never replaced by model output', () => {
  const { snapshot, response } = fixture();
  snapshot.policy.bayes = { target: 'GOAL', priors: [{ nodeId: 'root', probability: .7, reason: '수동 설정' }], conditionalIndependence: [] };
  snapshot.bindings[0].likelihood = { ratio: 8, basis: 'CALIBRATED', reason: '검증 자료의 비교 모형' };
  const next = applyWhyEstimation(snapshot, response, run);
  assert.deepEqual(next.policy.bayes!.priors, snapshot.policy.bayes.priors);
  assert.deepEqual(next.bindings[0].likelihood, snapshot.bindings[0].likelihood);
  assert.equal(next.evidence[0].sourceGrade, snapshot.evidence[0].sourceGrade);
  assert.equal(estimationContext(next).hasTargets, false);
});

test('unknown IDs and graph rewriting attempts cannot be accepted as estimates', () => {
  const { snapshot, response } = fixture();
  assert.throws(() => applyWhyEstimation(snapshot, { ...response, nodes: [] }, run), /허용되지/);
  response.bindings[0].bindingId = 'invented';
  assert.throws(() => applyWhyEstimation(snapshot, response, run), /자료 연결 ID/);
});

test('legacy condition-specific manual LR keeps its hypothesis when a new goal prior is estimated', () => {
  const snapshot = whyFixture(2);
  snapshot.bindings[0].likelihood = { ratio: 100, basis: 'EXPERT_ESTIMATE', reason: '조건 r0에만 적용한 수동 평가' };
  const anchors = [{ evidenceId: 'e1', quote: snapshot.bindings[1].quote }];
  const next = applyWhyEstimation(snapshot, { prior: { probability: .5, reason: '목표 모델 추정', anchors }, bindings: [{ bindingId: 'b1', ratio: 1, reason: '중립적인 목표 근거', anchors }], sources: [] }, run);
  assert.equal(next.bindings[0].likelihood!.ratio, 100);
  assert.equal(next.bindings[0].likelihood!.hypothesisId, 'r0');
  assert.equal(evaluateWhyNot(next).confidence.bayesian!.score, .5);
});

test('only bound ungraded sources are selected for low-effort source classification', () => {
  const { snapshot } = fixture(); snapshot.evidence[0].sourceGrade = null;
  snapshot.evidence.push({ ...snapshot.evidence[0], id: 'unbound' });
  assert.deepEqual(estimationContext(snapshot).targets.sourceIds, ['e0']);
  assert.deepEqual(estimationContext(snapshot).targets.evidenceIds, ['e0']);
});

test('source schema requires every requested classification and permits an explicit explained null', () => {
  const { snapshot } = fixture(); snapshot.evidence[0].sourceGrade = null;
  const schema = estimationSchema(estimationContext(snapshot));
  const sources = schema.properties.sources as { minItems: number; maxItems: number; items: { properties: { evidenceId: { enum: string[] }; grade: { enum: (string | null)[] }; reason: { minLength: number } } } };
  assert.equal(sources.minItems, 1); assert.equal(sources.maxItems, 1); assert.deepEqual(sources.items.properties.evidenceId.enum, ['e0']);
  assert.ok(sources.items.properties.grade.enum.includes(null)); assert.equal(sources.items.properties.reason.minLength, 1);
});

test('an unclassified source retains the model reason instead of silently erasing it', () => {
  const { snapshot, response } = fixture(); snapshot.evidence[0].sourceGrade = null; snapshot.evidence[0].sourceCoefficient = null;
  const next = applyWhyEstimation(snapshot, { ...response, sources: [{ evidenceId: 'e0', grade: null, reason: '실제 게시 주체와 사건 참여 여부를 확인할 정보가 부족합니다.', anchors: [] }] }, run);
  assert.equal(next.evidence[0].sourceGrade, null); assert.equal(next.evidence[0].sourceCoefficient, null);
  assert.match(next.evidence[0].sourceReason, /게시 주체와 사건 참여/); assert.ok(next.policy.bayes!.estimationNotes!.some(note => note.includes('출처 등급 보류')));
});

test('omitted source responses stay unknown with an explicit omission reason, without discarding a valid LR', () => {
  const { snapshot, response } = fixture(); snapshot.evidence[0].sourceGrade = null; snapshot.evidence[0].sourceCoefficient = null;
  const next = applyWhyEstimation(snapshot, { ...response, sources: [] }, run);
  assert.equal(next.bindings[0].likelihood!.ratio, 4); assert.equal(next.evidence[0].sourceGrade, null);
  assert.match(next.evidence[0].sourceReason, /누락/); assert.ok(next.policy.bayes!.estimationNotes!.some(note => note.includes('누락')));
});
