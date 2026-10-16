import type { AnalysisBrief, ClarificationAnswer, ClarificationInput, ClarificationQuestion, ClarificationResult } from '../src/types/clarification.ts';
import { CodexError, effectiveCodexConfig, runCodex } from './codex.ts';
import type { CodexConfig } from './codex.ts';

export class ClarificationError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.name = 'ClarificationError'; this.status = status; }
}

const MAX_EXCERPT_CHARACTERS = 12000;
function fail(path: string, description: string): never { throw new ClarificationError(`${path}: ${description}`); }
function object(value: unknown, path: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, '객체가 필요합니다.');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key))) fail(path, '정의되지 않은 필드가 있습니다.');
  return result;
}
function text(value: unknown, path: string, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) fail(path, `1–${max}자 이내로 입력해 주세요.`);
  return value.trim();
}
function array(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(path, `${max}개 이하의 배열이 필요합니다.`);
  return value;
}
function identifier(value: unknown, path: string): string {
  const name = text(value, path, 80);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(name)) fail(path, '영문·숫자로 시작하는 식별자가 필요합니다.');
  return name;
}
function normalized(value: string): string { return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, ''); }
function answers(value: unknown): ClarificationAnswer[] {
  const result = array(value, 'answers', 6).map((item, index) => {
    const raw = object(item, `answers[${index}]`, ['question', 'answer']);
    return { question: text(raw.question, '답변의 질문', 300), answer: text(raw.answer, '답변', 1500) };
  });
  if (new Set(result.map(item => normalized(item.question))).size !== result.length) fail('answers', '같은 질문의 답변이 중복되었습니다.');
  return result;
}

/** Small samples only. Full evidence is uploaded and analyzed after the user confirms. */
export function parseClarificationInput(value: unknown): ClarificationInput {
  const raw = object(value, 'clarification', ['question', 'sources', 'answers', 'round']);
  const question = text(raw.question, '질문', 2000);
  const sources = array(raw.sources ?? [], 'sources', 10).map((item, index) => {
    const source = object(item, `sources[${index}]`, ['id', 'name', 'size', 'excerpt']);
    if (typeof source.size !== 'number' || !Number.isSafeInteger(source.size) || source.size < 0) fail('source.size', '올바른 파일 크기가 필요합니다.');
    return { id: identifier(source.id, 'source.id'), name: text(source.name, '파일 이름', 300), size: source.size, excerpt: text(source.excerpt, '자료 미리보기', MAX_EXCERPT_CHARACTERS, true) };
  });
  if (new Set(sources.map(source => source.id)).size !== sources.length) fail('sources', '자료 ID가 중복되었습니다.');
  if (sources.reduce((total, source) => total + source.excerpt.length, 0) > MAX_EXCERPT_CHARACTERS) fail('sources', '미리보기 전체는 12,000자 이하여야 합니다.');
  const round = raw.round ?? 0;
  if (!Number.isInteger(round) || typeof round !== 'number' || round < 0 || round > 2) fail('round', '질문 단계는 0–2 사이여야 합니다.');
  return { question, sources, answers: answers(raw.answers ?? []), round };
}

export function parseAnalysisBrief(value: unknown): AnalysisBrief {
  const raw = object(value, 'analysisBrief', ['objective', 'scope', 'output', 'answers', 'filters', 'ontologyTemplateId']);
  let filters: AnalysisBrief['filters'];
  if (raw.filters !== undefined) {
    const value = object(raw.filters, 'filters', ['sourceNames', 'dateField', 'dateFrom', 'dateTo']);
    filters = { sourceNames: array(value.sourceNames, 'sourceNames', 10).map(name => text(name, 'sourceName', 300)), dateField: text(value.dateField, 'dateField', 150, true), dateFrom: text(value.dateFrom, 'dateFrom', 10, true), dateTo: text(value.dateTo, 'dateTo', 10, true) };
    for (const day of [filters.dateFrom, filters.dateTo]) if (day && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day)) fail('filters', '실제 날짜를 선택해주세요.');
    if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) fail('filters', '종료일은 시작일 이후여야 합니다.');
    if ((filters.dateFrom || filters.dateTo) && !filters.dateField) fail('filters', '기간을 적용할 원본 날짜 열을 지정해주세요.');
  }
  return { ...(raw.ontologyTemplateId ? { ontologyTemplateId: identifier(raw.ontologyTemplateId, 'ontologyTemplateId') } : {}), ...(filters ? { filters } : {}), objective: text(raw.objective, '분석 목적', 2000), scope: text(raw.scope, '분석 범위', 2000), output: text(raw.output, '원하는 결과', 1000), answers: answers(raw.answers ?? []) };
}

/** Stable serialization keeps requirements separate from citations and source facts. */
export function formatAnalysisBrief(brief: AnalysisBrief): string {
  const valid = parseAnalysisBrief(brief);
  return JSON.stringify({ objective: valid.objective, scope: valid.scope, output: valid.output, answers: valid.answers, ...(valid.filters ? { filters: valid.filters } : {}), ...(valid.ontologyTemplateId ? { ontologyTemplateId: valid.ontologyTemplateId } : {}) });
}

const stringSchema = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const answerSchema = { type: 'object', additionalProperties: false, required: ['question', 'answer'], properties: { question: stringSchema(300), answer: stringSchema(1500) } };
const briefSchema = { type: 'object', additionalProperties: false, required: ['objective', 'scope', 'output', 'answers'], properties: { objective: stringSchema(2000), scope: stringSchema(2000), output: stringSchema(1000), answers: { type: 'array', maxItems: 6, items: answerSchema } } };
export const clarificationSchema = { type: 'object', additionalProperties: false, required: ['status', 'introduction', 'questions', 'brief'], properties: {
  status: { type: 'string', enum: ['questions', 'ready'] }, introduction: stringSchema(600), brief: briefSchema,
  questions: { type: 'array', maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['id', 'question', 'reason', 'options'], properties: {
    id: stringSchema(80), question: stringSchema(300), reason: stringSchema(300),
    options: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['id', 'label', 'description'], properties: { id: stringSchema(80), label: stringSchema(100), description: stringSchema(300) } } },
  } } },
} };

function parseResponse(value: unknown, input: ClarificationInput): ClarificationResult {
  const raw = object(value, '응답', ['status', 'introduction', 'questions', 'brief']);
  if (raw.status !== 'questions' && raw.status !== 'ready') fail('status', 'questions 또는 ready가 필요합니다.');
  const completed = new Set(input.answers.map(answer => normalized(answer.question)));
  const questions: ClarificationQuestion[] = array(raw.questions, 'questions', 3).map((item, index) => {
    const question = object(item, `questions[${index}]`, ['id', 'question', 'reason', 'options']);
    const options = array(question.options, 'options', 4).map(item => {
      const option = object(item, 'option', ['id', 'label', 'description']);
      const id = identifier(option.id, 'option.id');
      const label = text(option.label, '선택지', 100);
      if (['기타', 'other', 'others'].includes(normalized(label)) || id.toLowerCase() === 'other') fail('option', '기타 선택지는 화면에서 제공합니다.');
      return { id, label, description: text(option.description, '선택지 설명', 300) };
    });
    if (options.length < 2 || new Set(options.map(option => option.id)).size !== options.length || new Set(options.map(option => normalized(option.label))).size !== options.length) fail('options', '서로 다른 선택지가 2–4개 필요합니다.');
    const result = { id: identifier(question.id, 'question.id'), question: text(question.question, '확인 질문', 300), reason: text(question.reason, '질문 이유', 300), options };
    if (completed.has(normalized(result.question))) fail('question', '이미 답변한 질문입니다.');
    return result;
  });
  if (new Set(questions.map(question => question.id)).size !== questions.length || new Set(questions.map(question => normalized(question.question))).size !== questions.length) fail('questions', '확인 질문이 중복되었습니다.');
  if ((raw.status === 'questions' && (!questions.length || input.round >= 2 || input.answers.length + questions.length > 6)) || (raw.status === 'ready' && questions.length)) fail('questions', '확인 질문 단계가 올바르지 않습니다.');
  const brief = parseAnalysisBrief(raw.brief);
  // The model summarizes intent; user answers remain verbatim and authoritative.
  brief.answers = input.answers.map(answer => ({ ...answer }));
  return { status: raw.status, introduction: text(raw.introduction, '안내', 600), questions, brief, source: 'codex' };
}

const guidedQuestions: ClarificationQuestion[] = [
  { id: 'goal', question: '이번 분석에서 가장 먼저 확인하려는 것은 무엇인가요?', reason: '분석 목적에 맞춰 객체와 관계를 정리합니다.', options: [
    { id: 'connections', label: '주요 대상 사이의 관계', description: '사람·조직·사건 등 핵심 대상이 어떻게 연결되는지 확인합니다.' },
    { id: 'timeline', label: '사건과 변화의 흐름', description: '자료에 드러난 사건, 시점, 변화의 순서를 확인합니다.' },
    { id: 'claims', label: '주장과 근거 비교', description: '어떤 근거가 주장을 뒷받침하거나 반박하는지 확인합니다.' },
  ] },
  { id: 'scope', question: '어느 범위에 초점을 맞출까요?', reason: '필요한 대상과 범위를 명시하면 관련 없는 관계가 줄어듭니다.', options: [
    { id: 'request', label: '요청에서 명시한 범위', description: '처음 요청한 대상과 조건에 집중합니다. 명시되지 않은 범위는 임의로 좁히지 않습니다.' },
    { id: 'overview', label: '제공 자료의 전체 개요', description: '제공된 자료 전체에서 주요 객체와 연결 구조를 넓게 정리합니다.' },
    { id: 'focus', label: '핵심 대상 주변의 연결', description: '요청에서 지정한 핵심 대상을 중심으로 직접 관련된 관계를 정리합니다.' },
  ] },
  { id: 'output', question: '어떤 깊이의 결과가 필요한가요?', reason: '원하는 상세도에 맞춰 그래프의 복잡도를 조절합니다.', options: [
    { id: 'summary', label: '핵심 관계를 빠르게 파악', description: '중요한 객체와 연결, 핵심 근거를 중심으로 정리합니다.' },
    { id: 'detailed', label: '세부 관계와 근거까지 확인', description: '요청 범위 안의 세부 관계와 원문 근거를 자세히 정리합니다.' },
    { id: 'contradictions', label: '불확실성과 모순에 집중', description: '상충하는 주장과 확인되지 않은 부분을 구분해 정리합니다.' },
  ] },
];

function guided(input: ClarificationInput): ClarificationResult {
  const completed = new Set(input.answers.map(answer => normalized(answer.question)));
  // After any answers, preserve them for review instead of asking generic paraphrases.
  const questions = input.round >= 2 || input.answers.length ? [] : guidedQuestions.filter(question => !completed.has(normalized(question.question))).slice(0, Math.min(3, 6 - input.answers.length));
  return {
    status: questions.length ? 'questions' : 'ready', source: 'guided',
    introduction: questions.length ? 'AI의 추가 질문을 준비하지 못해 기본 질문을 보여드립니다. 원하는 방향을 선택해 주세요.' : 'AI 요약을 준비하지 못해 원래 요청과 답변을 그대로 정리했습니다. 범위를 확인한 후 분석을 시작해 주세요.',
    questions,
    brief: {
      objective: input.question,
      scope: input.sources.length ? '제공된 자료에서 원래 요청과 아래 답변에 해당하는 범위를 분석합니다. 추가 기간·지역·대상 제한은 임의로 적용하지 않습니다.' : '제공된 자료가 없으므로 요구에 맞는 온톨로지 초안만 설계합니다. 실제 객체와 관계는 자료를 추가한 뒤 생성할 수 있습니다.',
      output: '요청과 아래 답변에 맞는 객체·관계 그래프 및 원문 근거를 정리합니다. 근거가 없는 사실은 생성하지 않습니다.',
      answers: input.answers.map(answer => ({ ...answer })),
    },
  };
}

/** No job, upload scan, graph mutation or provider tool use occurs in this step. */
export async function clarify(input: ClarificationInput, config: CodexConfig, runner: typeof runCodex = runCodex, signal?: AbortSignal): Promise<ClarificationResult> {
  const valid = parseClarificationInput(input);
  signal?.throwIfAborted();
  try {
    const response = await runner({
      purpose: 'clarification', question: valid.question, documents: [], schema: clarificationSchema,
      context: JSON.stringify({
        stage: 'requirements_only', round: valid.round, maxQuestionRounds: 2,
        forceReady: valid.round >= 2 || valid.answers.length >= 6,
        originalRequest: valid.question, answers: valid.answers,
        sourceSamples: valid.sources,
        coverage: 'Source excerpts are samples only, not a complete review. Do not infer absence from omitted text. No source data is being filtered or uploaded during this clarification.',
        urlReading: 'Standalone HTTP(S) URLs in supplied text will be opened and their readable public article bodies collected before ontology design and extraction. Do not limit the scope to URL strings or ask the user to paste article text preemptively. Reading may fail; blocked or unavailable pages will be reported, never guessed from a URL. This step does not open links or verify their content.',
      }),
    }, { ...effectiveCodexConfig(config, 'clarification'), timeoutMs: Math.min(config.timeoutMs ?? 60000, 60000) }, { signal });
    signal?.throwIfAborted();
    return parseResponse(response, valid);
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    if ((error instanceof CodexError && error.code === 'CODEX_CANCELLED') || (error instanceof Error && error.name === 'AbortError')) throw error;
    return guided(valid);
  }
}
