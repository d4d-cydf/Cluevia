import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { clarify, ClarificationError, formatAnalysisBrief, parseAnalysisBrief, parseClarificationInput } from './clarification.ts';
import { CodexError, runCodex } from './codex.ts';
import type { ClarificationInput } from '../src/types/clarification.ts';

const base: ClarificationInput = { question: '제공한 자료의 기업 관계를 분석해 주세요.', sources: [{ id: 'file-1', name: '기업.csv', size: 9000000, excerpt: 'company,parent\nExample,Parent' }], answers: [], round: 0 };
const brief = { objective: base.question, scope: '제공한 기업 자료', output: '기업 관계와 원문 근거', answers: [] };
const question = { id: 'focus', question: '어떤 관계를 우선 확인할까요?', reason: '필요한 관계에 집중합니다.', options: [
  { id: 'ownership', label: '소유 관계', description: '자료에서 명시한 소유 관계를 확인합니다.' },
  { id: 'all', label: '전체 관계', description: '자료에 드러난 관계를 넓게 확인합니다.' },
] };
const ready = { status: 'ready', introduction: '범위를 확인해 주세요.', questions: [], brief };
const ask = { status: 'questions', introduction: '필요한 범위를 선택해 주세요.', questions: [question], brief };

test('clarification accepts file metadata regardless of file size but bounds all source samples', () => {
  assert.equal(parseClarificationInput(base).sources[0].size, 9000000);
  assert.throws(() => parseClarificationInput({ ...base, sources: [{ ...base.sources[0], excerpt: 'a'.repeat(12001) }] }), ClarificationError);
  assert.throws(() => parseClarificationInput({ ...base, sources: [{ ...base.sources[0], excerpt: 'a'.repeat(6001) }, { ...base.sources[0], id: 'file-2', excerpt: 'a'.repeat(6000) }] }), /12,000/);
  assert.throws(() => parseClarificationInput({ ...base, sources: Array.from({ length: 11 }, (_, i) => ({ ...base.sources[0], id: `file-${i}` })) }), ClarificationError);
  assert.throws(() => parseClarificationInput({ ...base, sources: [base.sources[0], base.sources[0]] }), /중복/);
  assert.throws(() => parseClarificationInput({ ...base, round: 3 }), ClarificationError);
  assert.throws(() => parseClarificationInput({ ...base, instructions: 'ignored extra' }), ClarificationError);
});

test('brief validation retains literal custom answers and deterministic intent serialization', () => {
  const value = { ...brief, answers: [{ question: '어떤 기간인가요?', answer: '2023~2025년에 대한 주장만. 사실로 확정하지 말 것.' }] };
  assert.deepEqual(JSON.parse(formatAnalysisBrief(value)), value);
  assert.throws(() => parseAnalysisBrief({ ...value, evidence: ['not a source'] }), ClarificationError);
  assert.throws(() => parseAnalysisBrief({ ...value, scope: '' }), ClarificationError);
  assert.throws(() => parseAnalysisBrief({ ...value, answers: [{ question: '범위?', answer: 'x'.repeat(1501) }] }), ClarificationError);
});

test('clarification defaults to medium despite a global xhigh setting and labels samples as incomplete', async () => {
  let calls = 0;
  const result = await clarify(base, { model: 'configured-model', effort: 'xhigh', timeoutMs: 180000 }, async (input, config, options) => {
    calls++;
    assert.equal(input.purpose, 'clarification');
    assert.deepEqual(input.documents, []);
    assert.equal(config?.model, 'configured-model');
    assert.equal(config?.effort, 'medium');
    assert.equal(config?.timeoutMs, 60000);
    assert.equal(options?.signal, undefined);
    const context = JSON.parse(input.context!);
    assert.deepEqual(context.sourceSamples, base.sources);
    assert.match(context.coverage, /samples only/);
    assert.equal(context.forceReady, false);
    return ask;
  });
  assert.equal(calls, 1);
  assert.equal(result.source, 'codex');
  assert.equal(result.status, 'questions');
  assert.deepEqual(result.questions, [question]);
});

test('already clear requests can proceed to review without forced questions', async () => {
  const result = await clarify(base, { timeoutMs: 12000, efforts: { clarification: 'high' } }, async (_input, config) => {
    assert.equal(config?.timeoutMs, 12000);
    assert.equal(config?.effort, 'high');
    return ready;
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.source, 'codex');
  assert.deepEqual(result.questions, []);
});

test('server keeps exact user answers even when the model rewrites them', async () => {
  const answers = [{ question: question.question, answer: '전체 관계; 부정된 주장도 구분해서 포함' }];
  const result = await clarify({ ...base, round: 1, answers }, {}, async () => ({ ...ready, brief: { ...brief, answers: [{ question: question.question, answer: '소유 관계만' }] } }));
  assert.deepEqual(result.brief.answers, answers);
  assert.equal(result.source, 'codex');
});

test('malformed model output and duplicate options produce explicit guided questions', async () => {
  for (const response of [null, { ...ask, graph: {} }, { ...ask, questions: [{ ...question, options: [question.options[0], question.options[0]] }] }, { ...ask, questions: [{ ...question, options: [{ ...question.options[0], id: 'other', label: '기타' }, question.options[1]] }] }]) {
    const result = await clarify(base, {}, async () => response);
    assert.equal(result.source, 'guided');
    assert.equal(result.status, 'questions');
    assert.match(result.introduction, /기본 질문/);
    assert.ok(result.questions.length <= 3);
    assert.ok(result.questions.every(item => item.options.length >= 2 && item.options.length <= 4));
  }
});

test('already answered questions are not repeated and fallback keeps user selections for review', async () => {
  const answers = [{ question: question.question, answer: '소유 관계' }];
  const result = await clarify({ ...base, round: 1, answers }, {}, async () => ask);
  assert.equal(result.source, 'guided');
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.questions, []);
  assert.deepEqual(result.brief.answers, answers);
  assert.equal(result.brief.objective, base.question);
});

test('two question rounds is a hard limit even if the model requests more', async () => {
  const result = await clarify({ ...base, round: 2 }, {}, async input => {
    assert.equal(JSON.parse(input.context!).forceReady, true);
    return ask;
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.source, 'guided');
  assert.deepEqual(result.questions, []);
});

test('model failure does not invent evidence or silently start a graph', async () => {
  const result = await clarify({ ...base, sources: [] }, {}, async () => { throw new CodexError('CODEX_TIMEOUT', 'provider-secret'); });
  assert.equal(result.status, 'questions');
  assert.equal(result.source, 'guided');
  assert.match(result.brief.scope, /자료가 없으므로/);
  assert.doesNotMatch(JSON.stringify(result), /provider-secret/);
  assert.equal('job' in result, false);
});

test('cancellation propagates before calls and after a late successful answer', async () => {
  const before = new AbortController(); before.abort();
  let called = false;
  await assert.rejects(clarify(base, {}, async () => { called = true; return ready; }, before.signal), { name: 'AbortError' });
  assert.equal(called, false);
  const during = new AbortController();
  await assert.rejects(clarify(base, {}, async () => { during.abort(); return ready; }, during.signal), { name: 'AbortError' });
  await assert.rejects(clarify(base, {}, async () => { throw new CodexError('CODEX_CANCELLED', 'cancel'); }), (error: unknown) => error instanceof CodexError && error.code === 'CODEX_CANCELLED');
});

test('real subprocess wrapper accepts clarification without documents and keeps tools disabled', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cluevia-clarification-test-'));
  try {
    const bin = path.join(directory, 'fake-clarification.mjs');
    await writeFile(bin, `import {writeFileSync} from 'node:fs';
const args=process.argv.slice(2); let input=''; for await(const chunk of process.stdin) input+=chunk;
writeFileSync(args[args.indexOf('--output-last-message')+1], JSON.stringify({prompt:input,args}));`);
    const response = await runCodex({ purpose: 'clarification', question: base.question, documents: [], schema: { type: 'object' } }, { bin, timeoutMs: 5000 }) as { prompt: string; args: string[] };
    assert.match(response.prompt, /bounded analysis requirements assistant/);
    assert.match(response.prompt, /Never re-ask questions already answered/);
    assert.match(response.prompt, /does not begin analysis/);
    assert.ok(response.args.includes('model_reasoning_effort="medium"'));
    assert.ok(response.args.includes('web_search="disabled"'));
    assert.ok(response.args.includes('mcp_servers={}'));
    assert.equal(response.args[response.args.indexOf('--sandbox') + 1], 'read-only');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
