import { createHash } from 'node:crypto';
import type { WhyModelEstimation, WhySnapshot } from '../src/types/why-not.ts';

export class WhyNotError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.name = 'WhyNotError'; this.status = status; }
}
export const contentHash = (text: string) => createHash('sha256').update(text).digest('hex');
const fail = (path: string, message: string): never => { throw new WhyNotError(`${path}: ${message}`); };
const object = (v: unknown, p: string): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail(p, '객체가 필요합니다.');
const array = (v: unknown, p: string, max = 256): unknown[] => Array.isArray(v) && v.length <= max ? v : fail(p, `배열은 최대 ${max}개입니다.`);
const text = (v: unknown, p: string, max = 2000, empty = false): string => typeof v === 'string' && v.length <= max && (empty || v.trim().length > 0) ? v : fail(p, `문자열은 ${empty ? 0 : 1}–${max}자입니다.`);
const id = (v: unknown, p: string): string => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,100}$/.test(v) && !['__proto__', 'constructor', 'prototype'].includes(v) ? v : fail(p, 'ID 형식이 올바르지 않습니다.');
const pick = <T extends string>(v: unknown, values: readonly T[], p: string): T => values.includes(v as T) ? v as T : fail(p, `허용 값: ${values.join(', ')}`);
const bool = (v: unknown, p: string): boolean => typeof v === 'boolean' ? v : fail(p, 'boolean이 필요합니다.');
const number = (v: unknown, p: string, min: number, max: number, integer = false): number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && (!integer || Number.isSafeInteger(v)) ? v : fail(p, `${min}–${max} 범위의 ${integer ? '정수' : '숫자'}가 필요합니다.`);
const score = (v: unknown, p: string) => v === null ? null : number(v, p, 0, 1);
const nullable = (v: unknown, p: string, max = 2000) => v === null ? null : text(v, p, max);
const strings = (v: unknown, p: string, max = 32) => array(v, p, max).map((s, i) => text(s, `${p}[${i}]`, 1000));
const ids = (v: unknown, p: string) => array(v, p).map((s, i) => id(s, `${p}[${i}]`));
const unique = (values: string[], p: string) => { if (new Set(values).size !== values.length) fail(p, '중복 ID가 있습니다.'); };
function date(v: unknown, p: string) {
  if (v === null) return null;
  const s = text(v, p, 40);
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s.slice(0, 10) + 'T00:00:00Z').toISOString().slice(0, 10) !== s.slice(0, 10)) fail(p, '유효한 ISO 날짜가 필요합니다.');
  return s;
}

function estimation(value: unknown, path: string): WhyModelEstimation {
  const item = object(value, path);
  const anchors = array(item.anchors, `${path}.anchors`, 16).map(raw => {
    const anchor = object(raw, 'estimation.anchor');
    return { evidenceId: id(anchor.evidenceId, 'estimation.evidenceId'), quote: text(anchor.quote, 'estimation.quote', 5000), start: number(anchor.start, 'estimation.start', 0, 150000, true), end: number(anchor.end, 'estimation.end', 0, 150000, true) };
  });
  if (!anchors.length) fail(path, '모델 추정에는 실제 자료 인용이 필요합니다.');
  return { model: text(item.model, `${path}.model`, 200), effort: pick(item.effort, ['low'] as const, `${path}.effort`), estimatedAt: date(text(item.estimatedAt, `${path}.estimatedAt`, 40), `${path}.estimatedAt`)!, anchors };
}

export function parseWhySnapshot(value: unknown): WhySnapshot {
  const v = object(value, 'snapshot');
  if (v.version !== 'why-not-1.0') fail('version', '지원하지 않는 계약 버전입니다.');
  const policy = object(v.policy, 'policy');
  const coverage = object(v.coverage, 'coverage');
  const result: WhySnapshot = {
    version: 'why-not-1.0', treeVersion: id(v.treeVersion, 'treeVersion'), evidenceVersion: id(v.evidenceVersion, 'evidenceVersion'), decisionVersion: id(v.decisionVersion, 'decisionVersion'),
    goal: text(v.goal, 'goal'), rootId: id(v.rootId, 'rootId'),
    coverage: { complete: bool(coverage.complete, 'coverage.complete'), note: text(coverage.note, 'coverage.note', 2000, true) },
    policy: {
      version: id(policy.version, 'policy.version'), threshold: score(policy.threshold, 'policy.threshold'),
      maxCandidates: number(policy.maxCandidates, 'maxCandidates', 1, 2048, true), maxStates: number(policy.maxStates, 'maxStates', 1, 50000, true),
      maxDepth: number(policy.maxDepth, 'maxDepth', 1, 32, true), maxVisits: number(policy.maxVisits, 'maxVisits', 1, 512, true),
      independence: array(policy.independence, 'independence', 128).map((raw, i) => { const a = object(raw, `independence[${i}]`); return { atomIds: ids(a.atomIds, 'atomIds'), reason: text(a.reason, 'independence.reason') }; }),
      trustedSourceTypes: array(policy.trustedSourceTypes, 'trustedSourceTypes', 32).map(raw => { const a = object(raw, 'trustedSourceType'); return { type: text(a.type, 'type', 100), verification: text(a.verification, 'verification') }; }),
      ...(policy.bayes === undefined ? {} : (() => {
        const bayes = object(policy.bayes, 'policy.bayes');
        return { bayes: {
          ...(bayes.target === undefined ? {} : { target: pick(bayes.target, ['GOAL'] as const, 'bayes.target') }),
          ...(bayes.estimationNotes === undefined ? {} : { estimationNotes: strings(bayes.estimationNotes, 'bayes.estimationNotes', 128) }),
          priors: array(bayes.priors, 'bayes.priors', 128).map(raw => {
            const p = object(raw, 'prior'); const probability = score(p.probability, 'prior.probability');
            const basis = p.basis === undefined ? undefined : pick(p.basis, ['CALIBRATED', 'EXPERT_ESTIMATE', 'MODEL_ESTIMATE', 'UNASSESSED'] as const, 'prior.basis');
            if (basis === 'UNASSESSED' && probability !== null) fail('prior', '미평가 사전확률에 수치를 저장할 수 없습니다.');
            if (basis === 'MODEL_ESTIMATE' && (probability === null || probability < .01 || probability > .99 || p.estimation === undefined)) fail('prior', '모델 사전확률은 .01–.99 범위와 추정 이력이 필요합니다.');
            if (p.estimation !== undefined && basis !== 'MODEL_ESTIMATE') fail('prior', '모델 추정 이력은 MODEL_ESTIMATE에만 지정합니다.');
            return { nodeId: id(p.nodeId, 'prior.nodeId'), probability, reason: text(p.reason, 'prior.reason', 2000, probability === null), ...(basis === undefined ? {} : { basis }), ...(p.estimation === undefined ? {} : { estimation: estimation(p.estimation, 'prior.estimation') }) };
          }),
          conditionalIndependence: array(bayes.conditionalIndependence, 'bayes.conditionalIndependence', 128).map(raw => { const c = object(raw, 'conditionalIndependence'); return { requirementId: id(c.requirementId, 'conditionalIndependence.requirementId'), bindingIds: ids(c.bindingIds, 'conditionalIndependence.bindingIds'), reason: text(c.reason, 'conditionalIndependence.reason') }; }),
        } };
      })()),
    },
    nodes: array(v.nodes, 'nodes', 128).map((raw, i) => {
      const n = object(raw, `nodes[${i}]`); const need = n.need === null ? null : object(n.need, 'need');
      return { id: id(n.id, 'node.id'), kind: pick(n.kind, ['claim', 'requirement'], 'node.kind'), statement: text(n.statement, 'statement'), operator: pick(n.operator, ['AND', 'OR', 'NOT_SUPPORT'], 'operator'),
        children: ids(n.children, 'children'), inferenceRule: text(n.inferenceRule, 'inferenceRule'), negativeOf: nullable(n.negativeOf, 'negativeOf'), eventRuleId: n.eventRuleId === null ? null : id(n.eventRuleId, 'eventRuleId'), threshold: score(n.threshold, 'threshold'),
        need: need ? { kinds: strings(need.kinds, 'kinds'), fields: strings(need.fields, 'fields'), criteria: strings(need.criteria, 'criteria'), eventScope: text(need.eventScope, 'eventScope') } : null };
    }),
    evidence: array(v.evidence, 'evidence', 128).map((raw, i) => {
      const e = object(raw, `evidence[${i}]`); const body = text(e.text, 'evidence.text', 150000, true);
      if (e.contentHash !== contentHash(body)) fail('evidence.contentHash', '본문과 해시가 일치하지 않습니다.');
      const url = nullable(e.url, 'url', 2000);
      if (url) { let parsed: URL; try { parsed = new URL(url); } catch { return fail('url', '올바른 URL이 필요합니다.'); } if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) fail('url', '자격 증명이 없는 HTTP(S) URL이 필요합니다.'); }
      return { id: id(e.id, 'evidence.id'), name: text(e.name, 'name', 300), kind: pick(e.kind, ['DOCUMENT', 'STRUCTURED_RECORD', 'WEB_PAGE', 'OTHER'], 'kind'), text: body, contentHash: String(e.contentHash),
        record: e.record === null ? null : number(e.record, 'record', 1, 1000000, true), documentId: nullable(e.documentId, 'documentId', 200), url,
        processingStatus: pick(e.processingStatus, ['READY', 'PENDING', 'FAILED'], 'processingStatus'), sourceGrade: e.sourceGrade === null ? null : pick(e.sourceGrade, ['A', 'B', 'C', 'D', 'E', 'F'] as const, 'sourceGrade'),
        sourceCoefficient: score(e.sourceCoefficient, 'sourceCoefficient'), sourceReason: text(e.sourceReason, 'sourceReason', 2000, true), sourceType: nullable(e.sourceType, 'sourceType', 100), originalVerified: bool(e.originalVerified, 'originalVerified'), ...(e.sourceEstimation === undefined ? {} : { sourceEstimation: estimation(e.sourceEstimation, 'sourceEstimation') }) };
    }),
    bindings: array(v.bindings, 'bindings', 256).map((raw, i) => {
      const b = object(raw, `bindings[${i}]`); const m = object(b.metadata, 'metadata');
      return { id: id(b.id, 'binding.id'), evidenceId: id(b.evidenceId, 'evidenceId'), requirementId: id(b.requirementId, 'requirementId'), quote: text(b.quote, 'quote', 5000, true),
        start: number(b.start, 'start', 0, 150000, true), end: number(b.end, 'end', 0, 150000, true), verdict: pick(b.verdict, ['SUPPORTED', 'REFUTED', 'INSUFFICIENT', 'IRRELEVANT', 'UNREVIEWED'], 'verdict'),
        reason: text(b.reason, 'decision.reason'), missingRequirements: strings(b.missingRequirements, 'missingRequirements'), evaluator: text(b.evaluator, 'evaluator', 200), decisionVersion: id(b.decisionVersion, 'binding.decisionVersion'),
        materialCoefficient: score(b.materialCoefficient, 'materialCoefficient'), materialReason: text(b.materialReason, 'materialReason', 2000, true), atomId: b.atomId === null ? null : id(b.atomId, 'atomId'),
        ...(b.likelihood === undefined ? {} : (() => {
          const l = object(b.likelihood, 'binding.likelihood');
          const ratio = l.ratio === null ? null : number(l.ratio, 'binding.likelihood.ratio', 0, Number.MAX_VALUE);
          const basis = pick(l.basis, ['CALIBRATED', 'EXPERT_ESTIMATE', 'MODEL_ESTIMATE', 'UNASSESSED'] as const, 'binding.likelihood.basis');
          if (ratio !== null && basis === 'UNASSESSED') fail('binding.likelihood', '수치 우도비에는 보정 또는 전문가 추정 근거를 지정해주세요.');
          if (basis === 'MODEL_ESTIMATE' && (ratio === null || ratio < .01 || ratio > 100 || l.estimation === undefined)) fail('binding.likelihood', '모델 우도비는 .01–100 범위와 추정 이력이 필요합니다.');
          if (l.estimation !== undefined && basis !== 'MODEL_ESTIMATE') fail('binding.likelihood', '모델 추정 이력은 MODEL_ESTIMATE에만 지정합니다.');
          return { likelihood: { ratio, basis, reason: text(l.reason, 'binding.likelihood.reason', 2000, ratio === null), ...(l.hypothesisId === undefined ? {} : { hypothesisId: id(l.hypothesisId, 'likelihood.hypothesisId') }), ...(l.estimation === undefined ? {} : { estimation: estimation(l.estimation, 'likelihood.estimation') }) } };
        })()),
        metadata: { fields: array(m.fields, 'metadata.fields', 32).map(raw => { const f = object(raw, 'field'); return { key: text(f.key, 'field.key', 100), value: text(f.value, 'field.value', 300), quote: text(f.quote, 'field.quote', 5000) }; }), start: date(m.start, 'metadata.start'), end: date(m.end, 'metadata.end'), timeQuote: nullable(m.timeQuote, 'timeQuote', 5000) } };
    }),
    eventRules: array(v.eventRules, 'eventRules', 64).map(raw => { const r = object(raw, 'eventRule'); return { id: id(r.id, 'eventRule.id'), version: id(r.version, 'eventRule.version'), kind: pick(r.kind, ['SAME_EVENT', 'SAME_ENTITY', 'ORDERED_EVENTS'], 'eventRule.kind'), fields: strings(r.fields, 'eventRule.fields'), expected: array(r.expected, 'expected', 32).map(raw => { const e = object(raw, 'expected'); return { key: text(e.key, 'expected.key', 100), value: text(e.value, 'expected.value', 300) }; }), requireTime: bool(r.requireTime, 'requireTime'), order: ids(r.order, 'order') }; }),
    duplicates: array(v.duplicates, 'duplicates', 512).map(raw => { const d = object(raw, 'duplicate'); return { parentId: id(d.parentId, 'parentId'), left: id(d.left, 'left'), right: id(d.right, 'right'), verdict: pick(d.verdict, ['EXACT_DUPLICATE', 'SAME_OBSERVATION', 'PARTIAL_OVERLAP', 'DISTINCT', 'UNKNOWN'], 'duplicate.verdict'), reason: text(d.reason, 'duplicate.reason'), leftQuote: text(d.leftQuote, 'leftQuote', 5000), rightQuote: text(d.rightQuote, 'rightQuote', 5000) }; }),
    provenance: array(v.provenance, 'provenance', 512).map(raw => { const p = object(raw, 'provenance'); const lr = object(p.likelihood, 'likelihood'); return { from: id(p.from, 'from'), to: id(p.to, 'to'), verified: bool(p.verified, 'verified'), quote: text(p.quote, 'provenance.quote', 5000), likelihood: { kind: pick(lr.kind, ['ESTIMATED_LR', 'NO_NEW_INFORMATION', 'UNKNOWN'], 'likelihood.kind'), value: lr.value === null ? null : number(lr.value, 'likelihood.value', 0, 1e12), reason: text(lr.reason, 'likelihood.reason') } }; }),
  };
  unique([...result.nodes.map(n => n.id), ...result.bindings.map(b => b.id)], 'tree'); unique(result.evidence.map(e => e.id), 'evidence'); unique(result.eventRules.map(r => r.id), 'eventRules');
  if (result.evidence.reduce((sum, e) => sum + e.text.length, 0) > 500000) fail('evidence', '전체 원문은 최대 500,000자입니다.');
  const nodes = new Map(result.nodes.map(n => [n.id, n])); const bindings = new Map(result.bindings.map(b => [b.id, b])); const evidence = new Map(result.evidence.map(e => [e.id, e]));
  const checkEstimation = (item: WhyModelEstimation | undefined) => {
    for (const anchor of item?.anchors ?? []) if (!evidence.has(anchor.evidenceId) || evidence.get(anchor.evidenceId)!.text.slice(anchor.start, anchor.end) !== anchor.quote) fail('estimation', '모델 추정의 인용과 원문 위치가 일치하지 않습니다.');
  };
  result.policy.bayes?.priors.forEach(prior => checkEstimation(prior.estimation));
  for (const binding of result.bindings) {
    checkEstimation(binding.likelihood?.estimation);
    if (binding.likelihood?.hypothesisId && !nodes.has(binding.likelihood.hypothesisId)) fail('likelihood.hypothesisId', '추정 목표가 저장된 논리 노드를 참조해야 합니다.');
    if (binding.likelihood?.basis === 'MODEL_ESTIMATE' && !binding.likelihood.estimation!.anchors.some(anchor => anchor.evidenceId === binding.evidenceId && anchor.start >= binding.start && anchor.end <= binding.end)) fail('likelihood.estimation', '모델 우도비에 해당 자료 연결의 실제 인용이 필요합니다.');
  }
  for (const source of result.evidence) {
    checkEstimation(source.sourceEstimation);
    if (source.sourceEstimation && (!source.sourceEstimation.anchors.some(anchor => anchor.evidenceId === source.id) || source.sourceGrade === null || source.sourceGrade === 'A' && !source.originalVerified)) fail('sourceEstimation', '출처 추정의 원문 근거 또는 검증된 A등급 조건이 필요합니다.');
  }
  if (result.policy.bayes) {
    unique(result.policy.bayes.priors.map(p => p.nodeId), 'bayes.priors');
    for (const p of result.policy.bayes.priors) if (nodes.get(p.nodeId)?.kind !== 'requirement' && !(result.policy.bayes.target === 'GOAL' && p.nodeId === result.rootId)) fail('prior.nodeId', '사전확률은 검토 목표 또는 자료 요구의 가설에 지정해주세요.');
    for (const c of result.policy.bayes.conditionalIndependence) {
      unique(c.bindingIds, 'conditionalIndependence.bindingIds');
      const goal = result.policy.bayes.target === 'GOAL' && c.requirementId === result.rootId;
      if ((!goal && nodes.get(c.requirementId)?.kind !== 'requirement') || c.bindingIds.length < 2 || c.bindingIds.some(id => !bindings.has(id) || !goal && bindings.get(id)?.requirementId !== c.requirementId)) fail('conditionalIndependence', '동일 가설에 대한 실제 증거 연결 둘 이상이 필요합니다.');
    }
  }
  if (nodes.get(result.rootId)?.kind !== 'claim') fail('rootId', '루트 주장이 필요합니다.');
  for (const n of result.nodes) {
    unique(n.children, `${n.id}.children`);
    if (n.kind === 'claim' && !n.children.length) fail(n.id, '빈 주장은 허용하지 않습니다. 필요한 자료는 requirement로 남겨주세요.');
    if (n.kind === 'requirement' && (!n.need || !n.need.criteria.length)) fail(n.id, '증거 요구와 판정 기준이 필요합니다.');
    if (n.operator === 'NOT_SUPPORT' && !n.negativeOf) fail(n.id, '부정 입증 대상이 필요합니다.');
    if (n.eventRuleId && !result.eventRules.some(r => r.id === n.eventRuleId)) fail(n.id, '사건 규칙 참조가 없습니다.');
    for (const child of n.children) if (!nodes.has(child) && (!bindings.has(child) || bindings.get(child)!.requirementId !== n.id)) fail(n.id, `자식 ${child}의 연결이 올바르지 않습니다.`);
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  function visit(nodeId: string) {
    if (visiting.has(nodeId)) fail(nodeId, '논리 트리의 순환은 허용하지 않습니다.');
    if (visited.has(nodeId)) return;
    visiting.add(nodeId); nodes.get(nodeId)?.children.forEach(visit); visiting.delete(nodeId); visited.add(nodeId);
  }
  visit(result.rootId);
  if (result.nodes.some(n => !visited.has(n.id)) || result.bindings.some(b => !visited.has(b.id))) fail('tree', '모든 주장과 binding은 루트에 연결되어야 합니다.');
  for (const b of result.bindings) {
    const e = evidence.get(b.evidenceId);
    if (!e || nodes.get(b.requirementId)?.kind !== 'requirement' || !nodes.get(b.requirementId)!.children.includes(b.id)) fail(b.id, '자료 또는 requirement 참조가 올바르지 않습니다.');
    if (b.end < b.start || e!.text.slice(b.start, b.end) !== b.quote || (b.verdict !== 'UNREVIEWED' && !b.quote.trim())) fail(b.id, '판정 인용문과 원문 위치가 일치하지 않습니다.');
    if (b.materialCoefficient !== null && !b.materialReason.trim()) fail(b.id, '자료 품질 점수의 근거가 필요합니다.');
    unique(b.metadata.fields.map(f => f.key), `${b.id}.metadata`);
    for (const f of b.metadata.fields) if (!e!.text.includes(f.quote) || !f.quote.includes(f.value)) fail(b.id, '사건 필드 값은 실제 인용문에 있어야 합니다.');
    if (b.metadata.start || b.metadata.end) {
      if (!b.metadata.start || !b.metadata.timeQuote || !e!.text.includes(b.metadata.timeQuote) || !b.metadata.timeQuote.includes(b.metadata.start) || (b.metadata.end && (!b.metadata.timeQuote.includes(b.metadata.end) || Date.parse(b.metadata.end) < Date.parse(b.metadata.start)))) fail(b.id, '사건 시각과 기간을 확인할 원문 인용이 필요합니다.');
    }
  }
  for (const e of result.evidence) if ((e.sourceGrade !== null || e.sourceCoefficient !== null || e.originalVerified) && !e.sourceReason.trim()) fail(e.id, '출처 평가 근거가 필요합니다.');
  for (const r of result.eventRules) {
    unique(r.fields, `${r.id}.fields`); unique(r.expected.map(e => e.key), `${r.id}.expected`); unique(r.order, `${r.id}.order`);
    if (!r.fields.length) fail(r.id, '사건 연결에 사용할 식별 필드를 지정해주세요.');
    if (r.expected.some(e => !r.fields.includes(e.key))) fail(r.id, '기대값은 검사 필드에 포함되어야 합니다.');
    if (r.kind === 'ORDERED_EVENTS' && (r.order.length < 2 || r.order.some(i => nodes.get(i)?.kind !== 'requirement'))) fail(r.id, '선후 사건의 requirement 순서가 필요합니다.');
  }
  for (const d of result.duplicates) {
    const left = bindings.get(d.left); const right = bindings.get(d.right);
    if (!left || !right || left.id === right.id || left.requirementId !== d.parentId || right.requirementId !== d.parentId || !left.quote.includes(d.leftQuote) || !right.quote.includes(d.rightQuote)) fail('duplicate', '같은 부모의 실제 근거 구간이 필요합니다.');
  }
  for (const p of result.provenance) {
    const source = evidence.get(p.from); const target = evidence.get(p.to);
    if (!source || !target || !source.text.includes(p.quote)) fail('provenance', '자료와 계보 인용문을 확인해주세요.');
    if (p.verified && !(target!.url && p.quote.includes(target!.url)) && source!.contentHash !== target!.contentHash) fail('provenance', '검증된 인용에는 원출처 URL 또는 동일 내용 근거가 필요합니다.');
    if ((p.likelihood.kind === 'ESTIMATED_LR') !== (p.likelihood.value !== null)) fail('likelihood', '수치 LR과 미상·내용 중복 판정을 구분해주세요.');
  }
  return result;
}

export const initialWhyPolicy = (): WhySnapshot['policy'] => ({ version: 'unrated-v1', threshold: null, independence: [], trustedSourceTypes: [], maxCandidates: 512, maxStates: 20000, maxDepth: 8, maxVisits: 64 });
