import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkWhyEvent, evaluateWhyFormula, evaluateWhyNot, traceWhySources } from './why-not-engine.ts';
import { contentHash, parseWhySnapshot } from './why-not-contract.ts';
import { whyFixture } from './why-not-fixture.ts';
import type { WhyEventRule, WhySnapshot } from '../src/types/why-not.ts';

function empty(s: WhySnapshot, i: number) { s.nodes.find(n => n.id === `r${i}`)!.children = []; s.bindings = s.bindings.filter(b => b.id !== `b${i}`); }
const eventRule: WhyEventRule = { id: 'event', version: 'v1', kind: 'SAME_EVENT', fields: ['event'], expected: [{ key: 'event', value: 'E1' }], requireTime: false, order: [] };
function duplicate(s: WhySnapshot, original: number, suffix: string) {
  const e = { ...s.evidence[original], id: `copy-${suffix}` }; const b = { ...structuredClone(s.bindings[original]), id: `copy-binding-${suffix}`, evidenceId: e.id, atomId: null };
  s.evidence.push(e); s.bindings.push(b); s.nodes.find(n => n.id === b.requirementId)!.children.push(b.id); return b;
}
test('T01–03: missing required AND evidence cannot pass; OR alternative can pass', () => {
  const s = whyFixture(); empty(s, 1);
  const and = evaluateWhyNot(s); assert.equal(and.chainStatus, 'NO_COMPLETE_CHAIN'); assert.equal(and.confidence.supportScore, null);
  assert.ok(and.gaps.some(g => g.type === 'EVIDENCE_MISSING')); assert.ok(and.gaps.find(g => g.type === 'CHAIN_UNKNOWN')!.causeGapIds.length);
  s.nodes[0].operator = 'OR'; const or = evaluateWhyNot(s); assert.equal(or.chainStatus, 'COMPLETE_CHAIN_FOUND'); assert.equal(or.accepted, true); assert.equal(or.gaps[0].blockingScope, 'ALTERNATIVE');
  empty(s, 0); assert.equal(evaluateWhyNot(s).confidence.supportScore, null);
});
for (const verdict of ['REFUTED', 'INSUFFICIENT', 'IRRELEVANT', 'UNREVIEWED'] as const) test(`T04–06: ${verdict} never passes merely because evidence exists`, () => {
  const s = whyFixture(1); s.bindings[0].verdict = verdict; s.bindings[0].reason = '예정 기록 또는 실제 판정 근거';
  const r = evaluateWhyNot(s); assert.equal(r.accepted, false); assert.equal(r.chainStatus, verdict === 'UNREVIEWED' ? 'UNDETERMINED' : 'NO_COMPLETE_CHAIN');
  const gaps = r.gaps.filter(g => g.reasonCode === verdict);
  assert.equal(gaps.length, 1); assert.deepEqual(gaps[0].witnessIds, [r.witnesses[0].id]);
});
test('a missing AND condition does not hide the inadequate URL evidence on another condition', () => {
  const s = whyFixture(); empty(s, 1);
  const url = 'https://example.org/article';
  s.evidence[0].text = url; s.evidence[0].contentHash = contentHash(url);
  Object.assign(s.bindings[0], { quote: url, start: 0, end: url.length, verdict: 'INSUFFICIENT', reason: 'URL만 제공되어 본문의 주장을 확인할 수 없습니다.', missingRequirements: ['원문 본문'], metadata: { fields: [], start: null, end: null, timeQuote: null } });
  const result = evaluateWhyNot(s);
  assert.ok(result.gaps.some(gap => gap.type === 'EVIDENCE_MISSING' && gap.claimId === 'r1'));
  const insufficient = result.gaps.filter(gap => gap.type === 'EVIDENCE_INSUFFICIENT');
  assert.equal(insufficient.length, 1);
  assert.equal(insufficient[0].claimId, 'r0');
  assert.equal(insufficient[0].explanation, s.bindings[0].reason);
  assert.equal(insufficient[0].blockingScope, 'ROOT');
  assert.deepEqual(insufficient[0].witnessIds, []);
  assert.deepEqual(result.witnesses, []);
  assert.equal(result.accepted, false);
  assert.equal(result.chainStatus, 'NO_COMPLETE_CHAIN');
  assert.equal(result.confidence.supportScore, null);
  assert.equal(result.confidence.range, null);
  assert.deepEqual(result.confidence.atoms, []);
  s.coverage.complete = false;
  const partial = evaluateWhyNot(s);
  assert.equal(partial.chainStatus, 'UNDETERMINED');
  assert.equal(partial.confidence.supportScore, null);
  assert.ok(partial.gaps.some(gap => gap.type === 'EVIDENCE_INSUFFICIENT'));
});
test('local insufficiency on an incomplete optional OR branch does not veto a supported route', () => {
  const s = whyFixture(3); empty(s, 1);
  s.nodes[0].operator = 'OR'; s.nodes[0].children = ['r0', 'optional'];
  s.nodes.push({ ...s.nodes[0], id: 'optional', statement: '별도 입증 경로', operator: 'AND', children: ['r1', 'r2'] });
  s.bindings.find(binding => binding.id === 'b2')!.verdict = 'INSUFFICIENT';
  const result = evaluateWhyNot(s);
  assert.equal(result.chainStatus, 'COMPLETE_CHAIN_FOUND');
  assert.equal(result.accepted, true);
  assert.equal(result.confidence.supportScore, .8);
  assert.equal(result.witnesses.length, 1);
  assert.deepEqual(result.witnesses[0].bindingIds, ['b0']);
  const insufficient = result.gaps.filter(gap => gap.reasonCode === 'INSUFFICIENT');
  assert.equal(insufficient.length, 1);
  assert.equal(insufficient[0].blockingScope, 'ALTERNATIVE');
  assert.deepEqual(insufficient[0].witnessIds, []);
  assert.ok(result.gaps.some(gap => gap.type === 'EVIDENCE_MISSING' && gap.blockingScope === 'ALTERNATIVE'));
});
test('T05: pending alternative remains incomplete even when another OR branch passes', () => {
  const s = whyFixture(); s.nodes[0].operator = 'OR'; s.evidence[1].processingStatus = 'PENDING';
  const result = evaluateWhyNot(s); assert.equal(result.chainStatus, 'COMPLETE_CHAIN_FOUND'); assert.equal(result.evaluationStatus, 'INCOMPLETE');
});
test('T07: timezone offsets compare absolute instants', () => {
  const s = whyFixture(); s.bindings[0].metadata.start = '2026-10-10T09:00:00+09:00'; s.bindings[1].metadata.start = '2026-10-10T00:00:00Z';
  assert.equal(checkWhyEvent({ ...eventRule, requireTime: true }, s.bindings).result, 'MATCH');
});
test('T08–09: missing metadata is UNKNOWN; conflicting keys retain expected and observed', () => {
  const s = whyFixture(); s.nodes[0].eventRuleId = eventRule.id; s.eventRules = [eventRule]; s.bindings[1].metadata.fields = [];
  const unknown = evaluateWhyNot(s); assert.equal(unknown.chainStatus, 'UNDETERMINED'); assert.ok(!unknown.gaps.some(g => g.type === 'EVENT_MISMATCH'));
  s.bindings[1].metadata.fields = [{ key: 'event', value: '2', quote: '2' }]; s.evidence[1].text += ' 2'; s.evidence[1].contentHash = contentHash(s.evidence[1].text);
  const mismatch = evaluateWhyNot(s).gaps.find(g => g.type === 'EVENT_MISMATCH')!; assert.ok(mismatch.expected); assert.ok(mismatch.observed);
});
test('natural-language labels in different scripts stay UNKNOWN instead of asserting entity equality or conflict', () => {
  const s = whyFixture(2);
  const rule: WhyEventRule = { ...eventRule, fields: ['actor', 'location'], expected: [{ key: 'actor', value: '북한군' }, { key: 'location', value: '러시아 쿠르스크' }] };
  s.bindings[0].metadata.fields = [{ key: 'actor', value: 'North Korean troops', quote: 'North Korean troops' }, { key: 'location', value: 'Kursk', quote: 'Kursk' }];
  s.bindings[1].metadata.fields = [{ key: 'actor', value: 'North Korean military units', quote: 'North Korean military units' }, { key: 'location', value: 'Kursk region', quote: 'Kursk region' }];
  for (const binding of s.bindings) assert.equal(checkWhyEvent(rule, [binding]).result, 'UNKNOWN');
  // A different-language name is not automatically the same entity, either.
  s.bindings[0].metadata.fields[0].value = 'Other troops';
  assert.equal(checkWhyEvent(rule, s.bindings.slice(0, 1)).result, 'UNKNOWN');
  s.bindings[0].metadata.fields = [{ key: 'actor', value: '북한군', quote: '북한군' }, { key: 'location', value: '러시아 쿠르스크', quote: '러시아 쿠르스크' }];
  assert.equal(checkWhyEvent(rule, s.bindings.slice(0, 1)).result, 'MATCH');
});
test('a cross-script comparison does not hide conflicting same-script observations in the same field', () => {
  const s = whyFixture(2);
  s.bindings[0].metadata.fields = [{ key: 'location', value: 'Kursk', quote: 'Kursk' }];
  s.bindings[1].metadata.fields = [{ key: 'location', value: 'Moscow', quote: 'Moscow' }];
  const rule: WhyEventRule = { ...eventRule, fields: ['location'], expected: [{ key: 'location', value: '쿠르스크' }] };
  assert.equal(checkWhyEvent(rule, s.bindings.slice(0, 1)).result, 'UNKNOWN');
  assert.equal(checkWhyEvent(rule, s.bindings).result, 'MISMATCH');
});
test('unknown translated labels never suppress definite date or identifier mismatches', () => {
  const binding = whyFixture(1).bindings[0];
  binding.metadata.fields = [{ key: 'actor', value: 'North Korean troops', quote: 'North Korean troops' }, { key: 'date', value: '2024-10', quote: '2024-10' }];
  const rule: WhyEventRule = { ...eventRule, fields: ['actor', 'date'], expected: [{ key: 'actor', value: '북한군' }, { key: 'date', value: '2024-12' }] };
  assert.equal(checkWhyEvent(rule, [binding]).result, 'MISMATCH');
  binding.metadata.fields = [{ key: 'entity_id', value: '가-123', quote: '가-123' }];
  assert.equal(checkWhyEvent({ ...rule, fields: ['entity_id'], expected: [{ key: 'entity_id', value: 'A-123' }] }, [binding]).result, 'MISMATCH');
});
test('foreign-language deployment evidence does not prove an unfilled December combat requirement', () => {
  const s = whyFixture(3); empty(s, 1); empty(s, 2);
  s.goal = '2024년 12월 쿠르스크 전투 참여';
  const quote = 'North Korean troops are in Kursk.';
  s.evidence[0].text = quote; s.evidence[0].contentHash = contentHash(quote);
  Object.assign(s.bindings[0], { quote, start: 0, end: quote.length, likelihood: { ratio: 3, basis: 'EXPERT_ESTIMATE', reason: '배치 관측의 제한적인 목표 관련성', hypothesisId: s.rootId }, metadata: { fields: [{ key: 'actor', value: 'North Korean troops', quote }, { key: 'location', value: 'Kursk', quote }], start: null, end: null, timeQuote: null } });
  s.nodes.find(node => node.id === 'r0')!.eventRuleId = 'deployment';
  s.eventRules = [{ ...eventRule, id: 'deployment', fields: ['actor', 'location', 'date'], expected: [{ key: 'actor', value: '북한군' }, { key: 'location', value: '러시아 쿠르스크' }, { key: 'date', value: '2024-12' }], requireTime: true }];
  s.policy.bayes = { target: 'GOAL', priors: [], conditionalIndependence: [] };
  const result = evaluateWhyNot(s);
  assert.equal(checkWhyEvent(s.eventRules[0], s.bindings).result, 'UNKNOWN');
  assert.equal(result.confidence.bayesian!.bindings[0].status, 'USED');
  assert.equal(result.accepted, false);
  assert.ok(result.gaps.some(gap => gap.type === 'EVIDENCE_MISSING' && gap.requirementIds.includes('r1')));
  assert.ok(result.gaps.some(gap => gap.type === 'EVIDENCE_MISSING' && gap.requirementIds.includes('r2')));
  assert.ok(!result.gaps.some(gap => gap.type === 'EVENT_MISMATCH'));

  s.evidence[0].text += '\n2024-10'; s.evidence[0].contentHash = contentHash(s.evidence[0].text);
  s.bindings[0].metadata.fields.push({ key: 'date', value: '2024-10', quote: '2024-10' });
  const mismatched = evaluateWhyNot(s);
  assert.equal(mismatched.confidence.bayesian!.bindings[0].status, 'EXCLUDED');
  assert.equal(mismatched.confidence.bayesian!.score, .5);
  assert.equal(mismatched.accepted, false);
});
test('T10: global interval intersection rejects pairwise-neighbor overlap', () => {
  const s = whyFixture(3); const days = [['01', '03'], ['02', '05'], ['04', '06']];
  s.bindings.forEach((b, i) => { b.metadata.start = `2026-10-${days[i][0]}`; b.metadata.end = `2026-10-${days[i][1]}`; });
  assert.equal(checkWhyEvent({ ...eventRule, requireTime: true }, s.bindings).result, 'MISMATCH');
});
test('ORDERED_EVENTS checks both order and missing predecessor', () => {
  const s = whyFixture(); s.bindings[0].metadata.start = '2026-10-02'; s.bindings[1].metadata.start = '2026-10-01';
  const r: WhyEventRule = { ...eventRule, kind: 'ORDERED_EVENTS', order: ['r0', 'r1'] };
  assert.equal(checkWhyEvent(r, s.bindings).result, 'MISMATCH'); assert.equal(checkWhyEvent(r, s.bindings.slice(1)).result, 'UNKNOWN');
});
test('T11: duplicate clones shrink witnesses and never increase score', () => {
  const s = whyFixture(1); const score = evaluateWhyNot(s).confidence.supportScore; duplicate(s, 0, 'x');
  const result = evaluateWhyNot(s); assert.equal(result.confidence.supportScore, score); assert.equal(result.witnesses.filter(w => w.status === 'ACTIVE').length, 1); assert.ok(result.witnesses.some(w => w.duplicateOf));
});
test('duplicate observations retain every eligible rating and conflicting or unknown coefficients remain unassessed', () => {
  for (const coefficient of [.2, null]) {
    const s = whyFixture(1); duplicate(s, 0, 'different-rating');
    s.evidence[1].sourceCoefficient = coefficient;
    const result = evaluateWhyNot(s);
    assert.equal(result.confidence.supportScore, null); assert.equal(result.confidence.range, null);
    assert.equal(result.confidence.atoms.length, 1);
    assert.deepEqual(result.confidence.atoms[0].bindingIds, ['b0', 'copy-binding-different-rating']);
    assert.equal(result.confidence.atoms[0].score, null);
    assert.equal(result.accepted, false);
  }
});
test('verified no-new-information lineage overrides an independence declaration without merging distinct atoms', () => {
  for (const likelihood of [
    { kind: 'NO_NEW_INFORMATION' as const, value: null, reason: '확인한 재인용이며 새로운 관측이 없습니다.' },
    { kind: 'ESTIMATED_LR' as const, value: 1, reason: '명시한 모형에서 추가 정보가 없습니다.' },
  ]) {
    const s = whyFixture(); s.nodes[0].operator = 'OR';
    s.evidence[1].url = 'https://example.org/original';
    s.evidence[0].text += ` ${s.evidence[1].url}`; s.evidence[0].contentHash = contentHash(s.evidence[0].text);
    s.provenance = [{ from: 'e0', to: 'e1', verified: true, quote: s.evidence[1].url, likelihood }];
    const result = evaluateWhyNot(s);
    assert.equal(result.confidence.supportScore, null);
    assert.deepEqual(result.confidence.range, [.8, 1]);
    assert.equal(result.confidence.atoms.length, 2);
    assert.equal(result.confidence.method, 'CONSERVATIVE_BOUNDS');
    assert.match(result.confidence.reason, /출처 계보.*독립성 선언/);
    s.provenance[0].verified = false;
    assert.equal(evaluateWhyNot(s).confidence.supportScore, .96);
  }
});
test('transitive verified reprint dependencies cannot gain independent support through an unused intermediate source', () => {
  const s = whyFixture(); s.nodes[0].operator = 'OR';
  const intermediate = { ...s.evidence[0], id: 'middle', text: '확인한 중간 재인용 https://example.org/original', url: 'https://example.org/middle' };
  intermediate.contentHash = contentHash(intermediate.text); s.evidence.push(intermediate);
  s.evidence[1].url = 'https://example.org/original';
  s.evidence[0].text += ` ${intermediate.url}`; s.evidence[0].contentHash = contentHash(s.evidence[0].text);
  const likelihood = { kind: 'NO_NEW_INFORMATION' as const, value: null, reason: '원 관측의 재인용' };
  s.provenance = [{ from: 'e0', to: 'middle', verified: true, quote: intermediate.url, likelihood }, { from: 'middle', to: 'e1', verified: true, quote: s.evidence[1].url, likelihood }];
  const result = evaluateWhyNot(s);
  assert.equal(result.confidence.supportScore, null); assert.deepEqual(result.confidence.range, [.8, 1]);
});
test('T12: evidence reused across requirements retains both roles with one shared atom', () => {
  const s = whyFixture(); s.bindings[1] = { ...s.bindings[0], id: 'b1', requirementId: 'r1' };
  const result = evaluateWhyNot(s); assert.equal(result.confidence.supportScore, .8); assert.deepEqual(Object.keys(result.witnesses[0].bindingsByRequirement), ['r0', 'r1']);
});
test('T13: one URL does not collapse different observations', () => {
  const s = whyFixture(); s.evidence.forEach(e => e.url = 'https://example.org/ledger'); assert.equal(evaluateWhyNot(s).confidence.atoms.length, 2);
});
test('T14: reasoned similarity does not merge non-equivalent A and C transitively', () => {
  const s = whyFixture(3); s.nodes = [s.nodes[0], s.nodes[1]]; s.nodes[0].children = ['r0']; s.nodes[1].children = ['b0', 'b1', 'b2']; s.bindings.forEach(b => { b.requirementId = 'r0'; b.atomId = null; });
  s.duplicates = [[0, 1], [1, 2]].map(([a, b]) => ({ parentId: 'r0', left: `b${a}`, right: `b${b}`, verdict: 'SAME_OBSERVATION', reason: '직접 쌍 검토', leftQuote: s.bindings[a].quote, rightQuote: s.bindings[b].quote }));
  assert.equal(evaluateWhyNot(s).confidence.atoms.length, 2);
});
test('T15–18: LR=1, LR<1, unknown, cycles and visit limits remain distinct', () => {
  const s = whyFixture(); s.evidence[1].url = 'https://example.org/original'; s.evidence[0].text += ' https://example.org/original'; s.evidence[0].contentHash = contentHash(s.evidence[0].text);
  s.provenance = [{ from: 'e0', to: 'e1', verified: true, quote: 'https://example.org/original', likelihood: { kind: 'ESTIMATED_LR', value: 1, reason: '내용 추가 없음' } }];
  assert.equal(traceWhySources(s)[0].stop, 'NO_NEW_INFORMATION');
  s.provenance[0].likelihood.value = .3; let trace = traceWhySources(s)[0]; assert.equal(trace.likelihoods[0].value, .3); assert.equal(trace.stop, 'NO_REFERENCE');
  s.provenance[0].likelihood = { kind: 'UNKNOWN', value: null, reason: '산정 자료 없음' }; assert.equal(traceWhySources(s)[0].likelihoods[0].value, null);
  s.evidence[1].url = s.evidence[0].url = 'https://example.org/original'; assert.equal(traceWhySources(s)[0].stop, 'CYCLE_DETECTED');
  s.evidence[0].url = null; s.policy.maxVisits = 1; assert.equal(traceWhySources(s)[0].stop, 'FETCH_LIMIT');
});
for (const grade of ['D', 'E'] as const) test(`T19–20: ${grade} source cannot complete a required chain`, () => {
  const s = whyFixture(1); s.evidence[0].sourceGrade = grade; s.evidence[0].sourceCoefficient = 1;
  assert.equal(evaluateWhyNot(s).chainStatus, 'NO_COMPLETE_CHAIN'); s.evidence[0].sourceGrade = 'A'; s.bindings[0].verdict = 'INSUFFICIENT'; assert.equal(evaluateWhyNot(s).accepted, false);
});
test('T21–22: independent AND/OR and shared-atom formula have exact scores', () => {
  const p = new Map([['a', .8], ['b', .6], ['c', .7]]);
  assert.equal(evaluateWhyFormula([['a', 'b']], p, 100), .48); assert.ok(Math.abs(evaluateWhyFormula([['a'], ['b']], p, 100)! - .92) < 1e-10);
  assert.ok(Math.abs(evaluateWhyFormula([['a', 'b'], ['a', 'c']], p, 100)! - .704) < 1e-10);
  assert.equal(evaluateWhyFormula([['a', 'b'], ['a', 'c']], p, 1), null);
});
test('T23: NOT_SUPPORT needs affirmative negative evidence; absence is not its complement', () => {
  const s = whyFixture(1); s.nodes[0].operator = 'NOT_SUPPORT'; s.nodes[0].negativeOf = 'E1 발행'; empty(s, 0); assert.equal(evaluateWhyNot(s).chainStatus, 'NO_COMPLETE_CHAIN');
});
test('NOT_SUPPORT combines affirmative evidence for a negative claim with AND, never a complement', () => {
  const s = whyFixture(); s.nodes[0].operator = 'NOT_SUPPORT'; s.nodes[0].negativeOf = 'E1 발행';
  s.evidence[1].sourceCoefficient = .6;
  assert.equal(evaluateWhyNot(s).confidence.supportScore, .48);
});
test('T24: weak score is TRUST_WEAK, never chain absence', () => {
  const s = whyFixture(1); s.policy.threshold = .9; const r = evaluateWhyNot(s);
  assert.equal(r.chainStatus, 'COMPLETE_CHAIN_FOUND'); assert.equal(r.accepted, false); assert.ok(r.gaps.some(g => g.type === 'TRUST_WEAK')); assert.ok(!r.gaps.some(g => g.type === 'CHAIN_UNKNOWN'));
});
test('T25–26: truncated rejected candidates never establish exhaustive absence', () => {
  const s = whyFixture(1); duplicate(s, 0, 'x'); s.bindings[0].verdict = 'INSUFFICIENT'; s.policy.maxCandidates = 1;
  const r = evaluateWhyNot(s); assert.equal(r.chainStatus, 'UNDETERMINED'); assert.ok(r.limits.some(l => l.startsWith('CANDIDATE_LIMIT')));
});
test('T28: unconfirmed independence yields conservative bounds and pending judgment', () => {
  const s = whyFixture(); s.evidence[1].sourceCoefficient = .6; s.policy.independence = [];
  const r = evaluateWhyNot(s); assert.deepEqual(r.confidence.range!.map(v => Number(v.toFixed(4))), [.4, .6]); assert.equal(r.confidence.supportScore, null); assert.equal(r.confidence.sufficient, null);
});
test('T29: three explicit strategies do not invent acquired evidence or close gaps', () => {
  const s = whyFixture(1); empty(s, 0); const strategies = evaluateWhyNot(s).actions.find(a => a.type === 'PROPOSE_CHAINS')!.strategies!;
  assert.equal(strategies.length, 3); assert.ok(strategies.every(s => !s.closedGapIds.length && s.remainingGaps.length));
});
test('T30: malformed trees, fabricated quotes, reasonless scores and invalid dates fail closed', () => {
  for (const mutate of [(s: WhySnapshot) => { s.nodes[0].children = []; }, (s: WhySnapshot) => { s.nodes[1].children.push('root'); }, (s: WhySnapshot) => { s.bindings[0].quote = 'invented'; }, (s: WhySnapshot) => { s.bindings[0].reason = ''; }, (s: WhySnapshot) => { s.evidence[0].sourceReason = ''; }, (s: WhySnapshot) => { s.bindings[0].metadata.start = '2026-02-30'; }]) {
    const s = whyFixture(); mutate(s); assert.throws(() => parseWhySnapshot(s));
  }
});
test('contradictory OR evidence remains a review blocker beside a positive witness', () => {
  const s = whyFixture(1); duplicate(s, 0, 'conflict').verdict = 'REFUTED'; const r = evaluateWhyNot(s);
  assert.equal(r.chainStatus, 'COMPLETE_CHAIN_FOUND'); assert.equal(r.accepted, false); assert.ok(r.gaps.some(g => g.reasonCode === 'CONTRADICTORY_EVIDENCE' && g.blockingScope === 'ROOT'));
});
test('source coefficient one needs verified origin and registered type to stop tracing', () => {
  const s = whyFixture(1); s.evidence[0].sourceCoefficient = 1; s.policy.trustedSourceTypes = [{ type: 'record', verification: '운영 검증 기준' }];
  assert.equal(traceWhySources(s)[0].stop, 'NO_REFERENCE'); s.evidence[0].originalVerified = true; assert.equal(traceWhySources(s)[0].stop, 'TRUSTED_ORIGIN_REACHED');
});
test('optional subclaim thresholds exclude that path without vetoing a separate OR proof', () => {
  const s = whyFixture(); s.nodes[0].operator = 'OR'; s.nodes[1].threshold = .9;
  const result = evaluateWhyNot(s); assert.equal(result.accepted, true); assert.equal(result.confidence.supportScore, .8); assert.equal(result.gaps.find(g => g.reasonCode === 'SUBCLAIM_THRESHOLD')!.blockingScope, 'ALTERNATIVE');
  s.nodes[0].operator = 'AND'; const required = evaluateWhyNot(s); assert.equal(required.accepted, false); assert.equal(required.chainStatus, 'COMPLETE_CHAIN_FOUND');
});
