import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { GraphDocument, GraphEdge, GraphNode } from '../types/graph.ts';
import { buildClaimOverview, overviewRelationState } from './claim-overview.ts';

const at = '2026-10-11T00:00:00.000Z';
function node(id: string, type = 'vessel'): GraphNode {
  return { id, label: `${id.toUpperCase()}호`, type, group: type, description: '', sourceIds: ['log'], properties: {} };
}
function edge(id: string, overrides: Partial<GraphEdge> = {}): GraphEdge {
  return { id, source: 'a', target: 'b', label: '환적', description: 'A호에서 B호로 화물을 환적했다.', status: 'reported', sourceIds: ['log'],
    claim: { stance: 'asserted', attributedTo: null, validFrom: null, validTo: null, publishedAt: null, derivedFrom: null }, ...overrides };
}
function graph(): GraphDocument {
  return { schemaVersion: '1.0', id: 'case', title: '선박 분석', question: '환적한 배 찾아줘', summary: '', origin: 'codex', createdAt: at,
    limitations: [], groups: [], sources: [{ id: 'log', title: '작업 일지', excerpt: 'A호가 B호로 화물을 환적했다.' }],
    nodes: [node('a'), node('b'), node('c'), node('d'), node('port', 'port')], edges: [edge('transfer')], events: [], findings: [] };
}

test('question relevance orders recorded associations without hiding background context', () => {
  const input = graph();
  input.edges.unshift(edge('ownership', { target: 'port', label: '소유', description: 'A호의 소유 회사 정보' }),
    edge('encounter', { source: 'c', target: 'd', label: 'AIS 조우', description: '두 선박이 근접 운항했다.' }));
  const result = buildClaimOverview(input);
  assert.equal(result.status, 'found'); assert.equal(result.total, 3);
  assert.deepEqual(result.edges.map(item => item.id), ['transfer', 'ownership', 'encounter']);
  assert.deepEqual(new Set(result.nodes.map(item => item.id)), new Set(input.nodes.map(item => item.id)));
  assert.equal(result.edges[0], input.edges[2]);
  assert.doesNotMatch(result.message, /입증|검증 완료|사실로 확정/);
});

test('inferred, uncertain, denied, retracted and disputed relations stay visible with original state', () => {
  for (const state of ['uncertain', 'denied', 'retracted', 'inferred', 'disputed', 'needs-review'] as const) {
    const input = graph();
    if (state === 'inferred') input.edges[0].status = state;
    else if (state === 'disputed' || state === 'needs-review') input.edges[0].review = { status: state, note: '', updatedAt: at };
    else input.edges[0].claim!.stance = state;
    const result = buildClaimOverview(input);
    assert.equal(result.edges.length, 1, state);
    assert.equal(result.edges[0], input.edges[0], 'stored claims must not be rewritten');
    assert.equal(overviewRelationState(result.edges[0], new Set(['log'])), state);
    assert.equal(result.report, null);
    assert.match(result.message, /원래 상태/);
  }
});

test('legacy uncertain prose and missing source references are marked rather than discarded', () => {
  for (const text of ['환적 가능성', '환적을 하지 않았다.', '환적 여부는 미확인이다.', 'The vessels did not transship cargo.', 'Potential transshipment between vessels.']) {
    const input = graph(); input.edges[0].description = text;
    const result = buildClaimOverview(input);
    assert.equal(result.edges.length, 1);
    assert.equal(overviewRelationState(result.edges[0], new Set(['log'])), 'uncertain', text);
  }
  const input = graph(); input.edges[0].sourceIds = ['missing'];
  assert.equal(buildClaimOverview(input).edges.length, 1);
  assert.equal(overviewRelationState(input.edges[0], new Set(['log'])), 'source-missing');
});

test('month May, not-only emphasis and unrelated caveats retain the reported state', () => {
  const input = graph();
  for (const description of ['The cargo transfer took place on May 5, 2020.', 'A was not only inspected; A transferred cargo to B.', 'A호에서 B호로 화물을 환적했다. 항구의 소유권은 미확인이다.']) {
    input.edges[0].description = description;
    assert.equal(overviewRelationState(input.edges[0], new Set(['log'])), 'reported', description);
  }
});

test('event and location paths remain original edges, without invented direct relations', () => {
  const input = graph();
  input.edges = [edge('first', { target: 'port', label: '입항' }), edge('second', { source: 'port', target: 'b', label: '관측' })];
  const result = buildClaimOverview(input);
  assert.deepEqual(result.edges, input.edges);
  assert.equal(result.edges.some(item => item.source === 'a' && item.target === 'b'), false);
  input.edges.push(edge('dangling', { target: 'missing' }));
  assert.equal(buildClaimOverview(input).edges.length, 2);
});

test('contradictory and reverse claims remain separate, including their time and direction', () => {
  const input = graph(); const denial = edge('denial'); denial.claim!.stance = 'denied';
  const reverse = edge('reverse', { source: 'b', target: 'a' }); reverse.claim!.stance = 'denied';
  denial.claim!.validFrom = '2021-01-01'; input.edges.push(denial, reverse);
  const result = buildClaimOverview(input);
  assert.deepEqual(result.edges, input.edges);
  assert.equal(result.edges[1].claim!.validFrom, '2021-01-01');
  assert.equal(result.edges[2].source, 'b');
});

test('search matches context, qualifications and isolated objects without changing total counts', () => {
  const input = graph(); input.edges.push(edge('owner', { target: 'port', label: '소유' }));
  assert.deepEqual(buildClaimOverview(input, { query: '소유' }).edges.map(item => item.id), ['owner']);
  assert.deepEqual(buildClaimOverview(input, { query: 'C호' }).nodes.map(item => item.id), ['c']);
  const miss = buildClaimOverview(input, { query: '없는 대상' });
  assert.equal(miss.empty, false); assert.equal(miss.total, 2); assert.deepEqual(miss.nodes, []); assert.match(miss.message, /검색/);
  input.edges[0].claim!.stance = 'denied';
  assert.deepEqual(buildClaimOverview(input, { query: '부인' }).edges.map(item => item.id), ['transfer']);
});

test('real GFW material exposes possible transshipments without promoting their original assertions', () => {
  const input = JSON.parse(readFileSync(new URL('../../public/examples/gfw-galapagos.json', import.meta.url), 'utf8')) as GraphDocument;
  input.question = '환적한 배 찾아줘';
  const result = buildClaimOverview(input);
  assert.equal(result.edges.length, input.edges.length);
  assert.ok(result.edges.some(item => item.status === 'inferred'));
  for (const item of result.edges) assert.equal(item, input.edges.find(original => original.id === item.id));
});

test('isolated sourced entities form an object map without manufacturing relationships', () => {
  const input = graph(); input.edges = []; input.findings = [{ text: '환적한 배를 찾아야 합니다.', nodeIds: ['a', 'b'], sourceIds: ['log'] }];
  const result = buildClaimOverview(input);
  assert.equal(result.empty, false); assert.deepEqual(result.nodes, input.nodes); assert.deepEqual(result.edges, []);
  assert.equal(result.sourceCount, 1); assert.match(result.message, /기록된 관계는 없습니다/);
});

test('a sourced textual answer becomes a short report without manufacturing graph relations', () => {
  const input = graph(); input.question = 'A호에서 발견된 화물 수량은?'; input.edges = [];
  input.summary = '1/1개 기록의 객체와 관계를 통합했습니다.';
  const text = 'A호 선내 조사에서 상어 7,639마리와 지느러미 537포대가 확인되었습니다.';
  input.sources[0].excerpt = text;
  input.findings = [{ text: `기록 1 · ${text}`, sourceIds: ['log'], nodeIds: ['a'] }];
  const answer = buildClaimOverview(input);
  assert.deepEqual(answer.edges, []);
  assert.deepEqual(answer.report?.conclusion, { text, sourceIds: ['log'] });
  assert.deepEqual(answer.report?.evidence, []);
  assert.equal(answer.report?.limitation, null);
  assert.doesNotMatch(JSON.stringify(answer.report), /객체와 관계|찾지 못|기록 1/);
});

test('uncertain findings keep the original qualification and sourced evidence', () => {
  const input = graph(); input.edges = [];
  input.findings = [{ text: 'A호와 B호가 근접 운항했습니다. 환적 여부는 불확실하며 직접적인 화물 이전 기록은 없습니다.', sourceIds: ['log'], nodeIds: ['a', 'b'] }];
  input.sources[0].excerpt = input.findings[0].text;
  input.limitations = ['근접 운항만으로 실제 환적을 입증할 수 없습니다.'];
  const report = buildClaimOverview(input).report!;
  assert.equal(report.conclusion.text, input.findings[0].text);
  assert.deepEqual(report.conclusion.sourceIds, ['log']);
  assert.equal(report.limitation, input.limitations[0]);
  assert.equal(report.evidence.length, 0);
});

test('unrelated findings and unsigned summaries do not pretend to answer the question', () => {
  const input = graph(); input.question = 'A호에서 발견된 화물 수량은?'; input.edges = [];
  input.sources[0].excerpt = 'B호의 항적 기록입니다.';
  input.findings = [
    { text: 'B호에는 상어 500마리가 있습니다.', sourceIds: ['log'], nodeIds: ['b'] },
    { text: 'A호는 해운 회사에서 소유하고 있습니다.', sourceIds: ['log'], nodeIds: ['a'] },
    { text: 'A호에는 상어 100마리가 있습니다.', sourceIds: ['nonexistent'], nodeIds: ['a'] },
  ];
  input.summary = 'A호에는 상어 1,000마리가 있습니다.';
  const report = buildClaimOverview(input).report!;
  assert.deepEqual(report.conclusion.sourceIds, []);
  assert.doesNotMatch(JSON.stringify(report), /500|100|1,000|소유/);
  assert.match(report.conclusion.text, /찾지 못|기록된 관계는 없습니다/);
});

test('a source excerpt can provide the actual textual answer without a generated finding', () => {
  const input = graph(); input.question = 'A호에서 발견된 화물 수량은?'; input.edges = [];
  input.sources[0].excerpt = 'A호에서 화물 12톤이 확인되었습니다.';
  const report = buildClaimOverview(input).report!;
  assert.equal(report.conclusion.text, input.sources[0].excerpt);
  assert.deepEqual(report.conclusion.sourceIds, ['log']);
});

test('unrelated quantities and dates cannot supply an answer just because they contain digits', () => {
  for (const [question, excerpt] of [
    ['상어 몇 마리야?', '올해 매출은 7000원입니다.'],
    ['상어 수량은?', '고등어의 수량은 30마리입니다.'],
    ['발사 날짜는 언제야?', '회사 설립 날짜는 2020년 5월 1일입니다.'],
    ['몇 개인가?', '상어는 12마리입니다.'],
  ]) {
    const input = graph(); input.question = question; input.nodes = []; input.edges = [];
    input.sources[0].excerpt = excerpt;
    const report = buildClaimOverview(input).report!;
    assert.deepEqual(report.conclusion.sourceIds, [], question);
    assert.deepEqual(report.evidence, [], question);
    assert.notEqual(report.conclusion.text, excerpt, question);
  }
  const input = graph(); input.question = '상어 몇 마리야?'; input.nodes = []; input.edges = [];
  input.sources[0].excerpt = '상어는 12마리입니다.';
  assert.deepEqual(buildClaimOverview(input).report?.conclusion, { text: input.sources[0].excerpt, sourceIds: ['log'] });
});

test('archived non-graph records can supply their actual answer with a record citation', () => {
  const input = graph(); input.question = '사건이 일어난 날짜는?'; input.nodes = []; input.edges = []; input.sources = [];
  input.summary = '0/1개 기록의 객체와 관계를 통합했습니다.';
  const report = buildClaimOverview(input, { records: [{ number: 3, summary: '사건은 2017년 8월 13일 발생했습니다.', limitations: [], documents: [{ id: 'original', name: '사건 보고', text: '사건 발생일: 2017-08-13' }] }] }).report!;
  assert.deepEqual(report.conclusion, { text: '사건은 2017년 8월 13일 발생했습니다.', sourceIds: [], recordNumber: 3 });
  const withoutMaterial = buildClaimOverview(input, { records: [{ number: 3, summary: '사건은 2017년 8월 13일 발생했습니다.', limitations: [], documents: [] }] }).report!;
  assert.deepEqual(withoutMaterial.conclusion.sourceIds, []);
  assert.equal(withoutMaterial.conclusion.recordNumber, undefined);
  assert.doesNotMatch(withoutMaterial.conclusion.text, /2017/);
});

test('answer graphs, pending analysis and search misses never show a completed fallback report', () => {
  const input = graph();
  assert.equal(buildClaimOverview(input).report, null);
  assert.equal(buildClaimOverview(input, { query: '없는 배' }).report, null);
  input.edges = [];
  assert.equal(buildClaimOverview(input, { pending: true }).report, null);
  assert.equal(buildClaimOverview(input, { query: '없는 배' }).report, null);
});

test('reports remain brief without clipping a final qualification', () => {
  const input = graph(); input.edges = [];
  const long = 'A호와 B호의 환적에 관해 제시된 설명에는 주변 정황에 관한 내용과 여러 시점의 관측 결과가 함께 포함되어 있습니다. '.repeat(5);
  const qualification = '그러나 실제 환적 여부는 아직 불확실합니다.';
  input.findings = [
    { text: long + qualification, sourceIds: ['log'], nodeIds: ['a', 'b'] },
    { text: 'A호와 B호의 환적을 뒷받침하는 작업 일지는 발견되지 않았습니다.', sourceIds: ['log'], nodeIds: ['a', 'b'] },
    { text: '환적 시점의 화물 수량은 자료에 기재되어 있지 않습니다.', sourceIds: ['log'], nodeIds: [] },
  ];
  input.sources[0].excerpt = '관련 기록 없음';
  input.limitations = ['환적 여부를 확인하려면 화물 이전을 기록한 작업 일지가 필요합니다.'];
  const report = buildClaimOverview(input).report!;
  assert.ok(report.evidence.length <= 2);
  const text = [report.conclusion.text, ...report.evidence.map(item => item.text), report.limitation ?? ''].join('');
  assert.ok(text.length <= 600);
  assert.ok(text.includes(qualification));
  assert.doesNotMatch(text, /…|\.\.\./);
});
