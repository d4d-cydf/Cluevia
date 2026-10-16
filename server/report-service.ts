import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { GraphDocument } from '../src/types/graph.ts';
import type { ReportCitation, ReportContent, ReportList, ReportRun, ReportSnapshot } from '../src/types/report.ts';
import type { WhyRun } from '../src/types/why-not.ts';
import { buildGapOverview, gapOverviewLabels } from '../src/lib/gap-overview.ts';
import { safeSourceUrl } from '../src/lib/graph-document.ts';
import { buildAnalysisCase, getAnalysisRecord, getRecordDocument } from './analysis-case.ts';
import { analysisRevision } from './why-not-service.ts';
import { contentHash, parseWhySnapshot } from './why-not-contract.ts';
import { evaluateWhyNot } from './why-not-engine.ts';
import { CodexError, effectiveCodexConfig, runCodex } from './codex.ts';
import type { CodexConfig, CodexInput } from './codex.ts';
import type { GenerationJob } from './jobs.ts';

export class ReportError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.name = 'ReportError'; this.status = status; }
}
const str = { type: 'string' };
const strings = { type: 'array', maxItems: 40, items: str };
const objectSchema = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const paragraph = objectSchema({ text: str, citationIds: { type: 'array', maxItems: 12, items: str } });
export const reportSchema = objectSchema({
  title: str, subtitle: str,
  conclusion: { type: 'array', minItems: 1, maxItems: 8, items: paragraph },
  sections: { type: 'array', maxItems: 12, items: objectSchema({ heading: str, paragraphs: { type: 'array', minItems: 1, maxItems: 12, items: paragraph } }) },
  gapAnalysis: { type: 'array', maxItems: 512, items: objectSchema({ gapId: str, analysis: str, recommendation: str }) },
  limitations: strings, nextSteps: strings,
});

function record(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw new ReportError(`${label} 형식이 올바르지 않습니다.`, 502);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, maximum = 6000, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw new ReportError(`${label} 길이 또는 내용 형식이 올바르지 않습니다.`, 502);
  return value.trim();
}
function array(value: unknown, label: string, maximum: number, minimum = 0): unknown[] {
  if (!Array.isArray(value) || value.length > maximum || value.length < minimum) throw new ReportError(`${label} 항목 수가 올바르지 않습니다.`, 502);
  return value;
}

/** Validates report structure and reference integrity, not the truth of prose. */
export function parseReportContent(value: unknown, snapshot: ReportSnapshot, suppliedCitationIds: Set<string>): ReportContent {
  if (JSON.stringify(value)?.length > 500000) throw new ReportError('보고서 응답이 너무 큽니다.', 502);
  const raw = record(value, ['title', 'subtitle', 'conclusion', 'sections', 'gapAnalysis', 'limitations', 'nextSteps'], '보고서');
  const readParagraph = (value: unknown) => {
    const item = record(value, ['text', 'citationIds'], '문단');
    const citationIds = array(item.citationIds, '인용', 12).map(id => text(id, '인용 ID', 100));
    if (new Set(citationIds).size !== citationIds.length || citationIds.some(id => !suppliedCitationIds.has(id))) throw new ReportError('보고서가 제공되지 않은 인용을 참조했습니다.', 502);
    return { text: text(item.text, '문단'), citationIds };
  };
  const gapIds = new Set(snapshot.gaps.map(gap => gap.id)); const covered = new Set<string>();
  const content: ReportContent = {
    title: text(raw.title, '제목', 200), subtitle: text(raw.subtitle, '부제', 600, true),
    conclusion: array(raw.conclusion, '결론', 8, 1).map(readParagraph),
    sections: array(raw.sections, '본문', 12).map(value => { const section = record(value, ['heading', 'paragraphs'], '절'); return { heading: text(section.heading, '소제목', 200), paragraphs: array(section.paragraphs, '본문 문단', 12, 1).map(readParagraph) }; }),
    gapAnalysis: array(raw.gapAnalysis, '공백 분석', 512).map(value => {
      const gap = record(value, ['gapId', 'analysis', 'recommendation'], '공백 설명'); const gapId = text(gap.gapId, '공백 ID', 100);
      if (!gapIds.has(gapId) || covered.has(gapId)) throw new ReportError('보고서가 없거나 중복된 공백을 참조했습니다.', 502);
      covered.add(gapId); return { gapId, analysis: text(gap.analysis, '공백 분석', 4000), recommendation: text(gap.recommendation, '보완 방향', 3000) };
    }),
    limitations: array(raw.limitations, '한계', 40).map(value => text(value, '한계', 2000)),
    nextSteps: array(raw.nextSteps, '다음 단계', 40).map(value => text(value, '다음 단계', 2000)),
  };
  if (covered.size !== gapIds.size) throw new ReportError('일부 공백에 대한 설명이 누락되었습니다.', 502);
  const prose = [content.title, content.subtitle, ...content.conclusion.map(item => item.text), ...content.sections.flatMap(section => [section.heading, ...section.paragraphs.map(item => item.text)]), ...content.gapAnalysis.flatMap(gap => [gap.analysis, gap.recommendation]), ...content.limitations, ...content.nextSteps];
  // Links belong to the trusted citation registry, never to generated prose.
  if (prose.some(value => /(?:https?:\/\/|www\.)\S+|<\/?[a-z][^>]*>|\]\s*\(/iu.test(value))) throw new ReportError('본문에 임의의 링크나 HTML을 넣을 수 없습니다. 제공된 인용 ID를 사용해주세요.', 502);
  if (suppliedCitationIds.size && ![...content.conclusion, ...content.sections.flatMap(section => section.paragraphs)].some(item => item.citationIds.length)) throw new ReportError('제공된 근거를 인용한 문단이 없습니다.', 502);
  return content;
}

function validateDisplayGraph(graph: GraphDocument): GraphDocument {
  const ids = (items: { id: string }[]) => { const values = new Set(items.map(item => item.id)); if (values.size !== items.length) throw new ReportError('저장 그래프에 중복 ID가 있습니다.', 409); return values; };
  const nodes = ids(graph.nodes); const groups = ids(graph.groups); const sources = ids(graph.sources); ids(graph.edges);
  if (graph.nodes.length > 10000 || graph.edges.length > 20000 || graph.nodes.some(node => !groups.has(node.group) || node.sourceIds.some(id => !sources.has(id))) || graph.edges.some(edge => !nodes.has(edge.source) || !nodes.has(edge.target) || edge.sourceIds.some(id => !sources.has(id)))) throw new ReportError('저장된 근거 그래프의 참조를 확인해주세요.', 409);
  for (const source of graph.sources) if (source.url) { const safe = safeSourceUrl(source.url); if (safe) source.url = safe; else delete source.url; }
  return graph;
}

/** The full snapshot is persisted; only complete items within these explicit
 * budgets are sent to the model. Every saved gap remains in the model context. */
function reportInput(snapshot: ReportSnapshot): { input: CodexInput; citationIds: Set<string> } {
  const notes = [...snapshot.coverage.notes];
  const selected: ReportCitation[] = []; let citationChars = 0;
  // Spread the finite citation budget across sources instead of exhausting it
  // on many quotations from the first source.
  const grouped = new Map<string, ReportCitation[]>();
  for (const citation of snapshot.citations) grouped.set(citation.evidenceId, [...(grouped.get(citation.evidenceId) ?? []), citation]);
  for (let index = 0; index < Math.max(0, ...[...grouped.values()].map(group => group.length)); index++) for (const group of grouped.values()) {
    const citation = group[index]; if (!citation) continue;
    const size = JSON.stringify(citation).length + 2;
    if (citationChars + size <= 100000) { selected.push(citation); citationChars += size; }
  }
  if (selected.length < snapshot.citations.length) notes.push(`전체 인용 ${snapshot.citations.length}개 중 ${selected.length}개를 보고서 작성에 제공했습니다. 인용 전체는 저장된 보고서 자료에 보존됩니다.`);
  const context = { question: snapshot.question, caseTitle: snapshot.caseTitle, whyRunId: snapshot.whyRunId, confidence: snapshot.confidence,
    coverage: { ...snapshot.coverage, notes }, gaps: snapshot.gaps,
    citations: selected.map(({ quote: _quote, ...citation }) => citation),
    assessments: [] as NonNullable<ReportSnapshot['assessments']>,
    associationSummary: snapshot.associationSummary ? { ...snapshot.associationSummary, nodes: [] as NonNullable<ReportSnapshot['associationSummary']>['nodes'], edges: [] as NonNullable<ReportSnapshot['associationSummary']>['edges'] } : undefined,
    graph: { nodes: [] as { id: string; label: string; type: string }[], edges: [] as { id: string; source: string; target: string; label: string }[] } };
  if (snapshot.gaps.length > 512 || JSON.stringify(context).length > 85000) throw new ReportError('공백 설명의 양이 보고서 작성 한도를 넘었습니다. 저장된 공백을 정리한 뒤 다시 작성해주세요.', 409);
  let available = 95000 - JSON.stringify(context).length;
  const selectedIds = new Set(selected.map(citation => citation.id));
  for (const item of snapshot.assessments ?? []) { const size = JSON.stringify(item).length + 1; if (selectedIds.has(item.citationId) && size <= available) { context.assessments.push(item); available -= size; } }
  if (context.assessments.length < (snapshot.assessments?.length ?? 0)) notes.push(`작성 문맥에는 자료 판정 ${(context.assessments.length)}/${snapshot.assessments!.length}개를 제공했습니다. 생략한 판정을 지지 또는 확인 완료로 해석하지 않습니다.`);
  if (context.associationSummary && snapshot.associationSummary) {
    for (const item of snapshot.associationSummary.nodes) { const size = JSON.stringify(item).length + 1; if (size <= available) { context.associationSummary.nodes.push(item); available -= size; } }
    const included = new Set(context.associationSummary.nodes.map(node => node.id));
    for (const edge of snapshot.associationSummary.edges) { const item = { ...edge, citationIds: edge.citationIds.filter(id => selectedIds.has(id)) }; const size = JSON.stringify(item).length + 1; if (included.has(item.source) && included.has(item.target) && size <= available) { context.associationSummary.edges.push(item); available -= size; } }
    if (context.associationSummary.nodes.length < snapshot.associationSummary.totalNodes || context.associationSummary.edges.length < snapshot.associationSummary.totalEdges) notes.push(`추출 관계 문맥은 객체 ${context.associationSummary.nodes.length}/${snapshot.associationSummary.totalNodes}개·관계 ${context.associationSummary.edges.length}/${snapshot.associationSummary.totalEdges}개입니다. 전체 조사로 해석하지 않습니다.`);
  }
  for (const node of snapshot.graph.nodes) { const item = { id: node.id, label: node.label, type: node.type }; const size = JSON.stringify(item).length + 1; if (size <= available) { context.graph.nodes.push(item); available -= size; } }
  const nodeIds = new Set(context.graph.nodes.map(node => node.id));
  for (const edge of snapshot.graph.edges) { const item = { id: edge.id, source: edge.source, target: edge.target, label: edge.label }; const size = JSON.stringify(item).length + 1; if (nodeIds.has(item.source) && nodeIds.has(item.target) && size <= available) { context.graph.edges.push(item); available -= size; } }
  if (context.graph.nodes.length < snapshot.graph.nodes.length || context.graph.edges.length < snapshot.graph.edges.length) notes.push(`작성 문맥에는 노드 ${context.graph.nodes.length}/${snapshot.graph.nodes.length}개·연결 ${context.graph.edges.length}/${snapshot.graph.edges.length}개를 제공했습니다. 저장된 전체 그래프는 생략하지 않았습니다.`);
  const documents: CodexInput['documents'] = []; let batch: ReportCitation[] = []; let batchSize = 2;
  const flush = () => { if (batch.length) documents.push({ id: `report-citations-${documents.length + 1}`, name: '저장된 원문 인용', text: JSON.stringify(batch) }); batch = []; batchSize = 2; };
  for (const citation of selected) { const size = JSON.stringify(citation).length + 1; if (batchSize + size > 45000) flush(); batch.push(citation); batchSize += size; } flush();
  snapshot.coverage.notes = [...notes];
  return { input: { purpose: 'case-report', question: snapshot.question, documents, context: JSON.stringify(context), schema: reportSchema }, citationIds: new Set(selected.map(citation => citation.id)) };
}

export class ReportService {
  private db: DatabaseSync; private config: CodexConfig; private run: typeof runCodex; private getWhyRun: (jobId: string) => WhyRun | undefined;
  private active = new Map<string, { id: string; controller: AbortController; task: Promise<void> }>();
  private deleting = new Set<string>(); private closing = false;
  constructor(db: DatabaseSync, config: CodexConfig, runner: typeof runCodex = runCodex, getWhyRun: (jobId: string) => WhyRun | undefined) {
    this.db = db; this.config = effectiveCodexConfig({ ...config, effort: 'high', efforts: { ...config.efforts, 'case-report': 'high' } }, 'case-report'); this.run = runner; this.getWhyRun = getWhyRun;
    db.exec('CREATE TABLE IF NOT EXISTS case_reports (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE, created_at TEXT NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS case_reports_job ON case_reports(job_id,created_at)');
    for (const row of db.prepare("SELECT payload FROM case_reports WHERE json_extract(payload,'$.status')='running'").all()) this.save({ ...JSON.parse(String(row.payload)), status: 'failed', error: '서버 재시작으로 보고서 작성이 중단되었습니다. 저장된 이전 보고서는 보존됩니다.' });
  }
  private save(report: ReportRun) { report.updatedAt = new Date().toISOString(); this.db.prepare('UPDATE case_reports SET payload=? WHERE id=?').run(JSON.stringify(report), report.id); }
  private get(id: string): ReportRun | undefined { const row = this.db.prepare('SELECT payload FROM case_reports WHERE id=?').get(id); return row ? JSON.parse(String(row.payload)) as ReportRun : undefined; }
  private snapshot(job: GenerationJob): ReportSnapshot {
    if (job.status !== 'completed') throw new ReportError('자료 분석이 완료된 뒤 보고서를 작성할 수 있습니다.', 409);
    const why = this.getWhyRun(job.id);
    if (!why || why.status !== 'completed' || !why.preparation?.ready || !why.snapshot) throw new ReportError('근거 그래프와 공백 검토가 준비된 뒤 보고서를 작성할 수 있습니다.', 409);
    if (!why.analysisRevision) throw new ReportError('이전 형식의 검토입니다. 공백 검토에서 새 버전 평가 후 보고서를 생성해주세요.', 409);
    if (why.analysisRevision !== analysisRevision(job)) throw new ReportError('현재 분석 자료에 맞는 근거 검토가 준비될 때까지 기다려주세요.', 409);
    const assessment = parseWhySnapshot(why.snapshot);
    if (assessment.goal.normalize('NFKC').trim() !== job.question.normalize('NFKC').trim()) throw new ReportError('현재 질문에 맞는 근거 검토가 필요합니다.', 409);
    const result = evaluateWhyNot(assessment);
    const baseSnapshot = why.baseSnapshot ? parseWhySnapshot(why.baseSnapshot) : assessment;
    const analysisCase = buildAnalysisCase(this.db, job); const sourceGraph = analysisCase.graph;
    const graph = validateDisplayGraph(buildGapOverview(sourceGraph, { ...why, snapshot: assessment, baseSnapshot, result }, { evidenceOnly: true, showGaps: true }).graph);
    const nodes = new Map(assessment.nodes.map(node => [node.id, node])); const evidence = new Map(assessment.evidence.map(source => [source.id, source]));
    const citations = new Map<string, ReportCitation>();
    for (const binding of assessment.bindings) {
      const source = evidence.get(binding.evidenceId)!; const id = `citation-${contentHash(JSON.stringify([source.id, binding.quote])).slice(0, 24)}`;
      citations.set(id, { id, evidenceId: source.id, sourceName: source.name, url: safeSourceUrl(source.url) ?? null, quote: binding.quote, sourceGrade: source.sourceGrade, record: source.record });
    }
    const bayesian = result.confidence.bayesian;
    const assessments: NonNullable<ReportSnapshot['assessments']> = assessment.bindings.map(binding => { const trace = bayesian?.bindings.find(trace => trace.bindingId === binding.id); return {
      citationId: `citation-${contentHash(JSON.stringify([binding.evidenceId, binding.quote])).slice(0, 24)}`, bindingId: binding.id, requirement: nodes.get(binding.requirementId)!.statement,
      verdict: binding.verdict, reason: binding.reason, rawLikelihoodRatio: trace?.rawLikelihoodRatio ?? binding.likelihood?.ratio ?? null, adjustedLikelihoodRatio: trace?.adjustedLikelihoodRatio ?? null,
      contributionStatus: trace?.status ?? 'UNASSESSED', contributionReason: trace?.reason ?? '현재 점수에 대한 기여가 평가되지 않았습니다.' };
    });
    const associationNodes = sourceGraph.nodes.slice(0, 40).map(({ id, label, type, description }) => ({ id, label, type, description }));
    const associationIds = new Set(associationNodes.map(node => node.id)); const sourceCitationIds = new Map<string, string>();
    // Only exact excerpts verified against retained record text enter the
    // citation registry. Association descriptions alone are not quotations.
    const selectedEdges = sourceGraph.edges.filter(edge => associationIds.has(edge.source) && associationIds.has(edge.target)).slice(0, 60);
    const wantedSources = new Set(selectedEdges.flatMap(edge => edge.sourceIds));
    const recordCache = new Map<number, ReturnType<typeof getAnalysisRecord>>();
    for (const source of sourceGraph.sources.filter(source => wantedSources.has(source.id)).slice(0, 40)) {
      if (!source.excerpt?.trim()) continue;
      for (const ref of analysisCase.provenance[source.id] ?? []) {
        if (!recordCache.has(ref.record)) recordCache.set(ref.record, getAnalysisRecord(this.db, job, ref.record));
        const matched = recordCache.get(ref.record)?.documents.some(document => {
          if (document.text.includes(source.excerpt!)) return true;
          for (let offset = 8000; offset < document.totalChars; offset += 8000) if (getRecordDocument(this.db, job, ref.record, document.id, offset)?.text.includes(source.excerpt!)) return true;
          return false;
        });
        if (!matched) continue;
        const id = `citation-${contentHash(JSON.stringify([source.id, source.excerpt])).slice(0, 24)}`;
        citations.set(id, { id, evidenceId: source.id, sourceName: source.title, url: safeSourceUrl(source.url) ?? null, quote: source.excerpt, sourceGrade: null, record: ref.record });
        sourceCitationIds.set(source.id, id); break;
      }
    }
    return { question: job.question, caseTitle: sourceGraph.title, analysisUpdatedAt: job.updatedAt, whyRunId: why.id, graph,
      confidence: { score: bayesian ? bayesian.score * 100 : null, baselineScore: bayesian ? bayesian.baselineScore * 100 : null, grade: bayesian?.grade ?? null, accepted: result.accepted, status: bayesian?.status ?? 'UNASSESSED', note: bayesian?.reason ?? result.confidence.reason },
      gaps: result.gaps.map(gap => ({ id: gap.id, type: gap.type, title: gapOverviewLabels[gap.type], explanation: gap.explanation, evaluationState: gap.evaluationState, blockingScope: gap.blockingScope,
        requirements: gap.requirementIds.map(id => nodes.get(id)?.statement ?? id), recommendations: result.actions.filter(action => action.gapIds.includes(gap.id)).map(action => `${action.title}: ${action.reason}`) })),
      citations: [...citations.values()], assessments,
      associationSummary: { summary: sourceGraph.summary, nodes: associationNodes, edges: selectedEdges.map(({ id, source, target, label, description, status, claim, sourceIds }) => ({ id, source, target, label, description, status, ...(claim ? { claim } : {}), citationIds: sourceIds.flatMap(id => sourceCitationIds.has(id) ? [sourceCitationIds.get(id)!] : []) })), totalNodes: sourceGraph.nodes.length, totalEdges: sourceGraph.edges.length, limitations: sourceGraph.limitations },
      coverage: { sources: assessment.evidence.length, citations: citations.size, nodes: graph.nodes.length, edges: graph.edges.length,
        notes: [assessment.coverage.note, ...result.limits, ...bayesian?.assumptions ?? [], '근거 그래프의 연결은 저장된 주장·논리·진단 관계이며 실제 사건의 독립 검증을 뜻하지 않습니다.', '보고서는 저장된 인용과 판정 범위에 한정됩니다. 원문 전체를 새로 조사하거나 외부 검색하지 않았습니다.'] } };
  }
  list(job: GenerationJob): ReportList {
    const reports = this.db.prepare("SELECT payload FROM case_reports WHERE job_id=? AND (rowid IN (SELECT rowid FROM case_reports WHERE job_id=? ORDER BY rowid DESC LIMIT 20) OR rowid IN (SELECT rowid FROM case_reports WHERE job_id=? AND json_extract(payload,'$.status')='completed' ORDER BY rowid DESC LIMIT 20)) ORDER BY rowid DESC").all(job.id, job.id, job.id).map(row => JSON.parse(String(row.payload)) as ReportRun);
    try { const snapshot = this.snapshot(job); reportInput(snapshot); return { reports, canGenerate: true, blockingReason: null, currentInputHash: contentHash(JSON.stringify(snapshot)) }; }
    catch (error) { if (!(error instanceof ReportError)) throw error; return { reports, canGenerate: false, blockingReason: error.message, currentInputHash: null }; }
  }
  generate(job: GenerationJob, body: { force?: boolean } = {}): ReportRun {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'force') || body.force !== undefined && typeof body.force !== 'boolean') throw new ReportError('보고서 작성 요청 형식을 확인해주세요.');
    if (this.closing || this.deleting.has(job.id)) throw new ReportError('케이스를 종료하고 있습니다.', 409);
    const active = this.active.get(job.id); if (active) return this.get(active.id)!;
    const snapshot = this.snapshot(job); const { input, citationIds } = reportInput(snapshot); const inputHash = contentHash(JSON.stringify(snapshot));
    if (!body.force) { const saved = this.db.prepare("SELECT payload FROM case_reports WHERE job_id=? AND json_extract(payload,'$.status')='completed' AND json_extract(payload,'$.inputHash')=? ORDER BY rowid DESC LIMIT 1").get(job.id, inputHash); if (saved) return JSON.parse(String(saved.payload)) as ReportRun; }
    if (this.active.size >= 2) throw new ReportError('다른 보고서를 작성 중입니다. 잠시 후 다시 시도해주세요.', 429);
    const now = new Date().toISOString(); const report: ReportRun = { id: `report-${randomUUID()}`, jobId: job.id, status: 'running', stage: 'preparing', createdAt: now, updatedAt: now,
      model: this.config.model!, effort: this.config.effort!, inputHash, snapshot };
    this.db.prepare('INSERT INTO case_reports VALUES (?,?,?,?)').run(report.id, job.id, now, JSON.stringify(report));
    const controller = new AbortController();
    const task = Promise.resolve().then(async () => {
      try {
        controller.signal.throwIfAborted(); report.stage = 'writing'; this.save(report);
        const raw = await this.run(input, this.config, { signal: controller.signal });
        controller.signal.throwIfAborted(); report.stage = 'verifying'; this.save(report);
        const content = parseReportContent(raw, snapshot, citationIds);
        controller.signal.throwIfAborted(); report.content = content; report.status = 'completed'; report.stage = 'completed'; this.save(report);
      } catch (error) {
        report.status = controller.signal.aborted ? 'cancelled' : 'failed'; report.error = controller.signal.aborted ? '보고서 작성을 중단했습니다. 이전 보고서는 보존됩니다.' : error instanceof ReportError || error instanceof CodexError ? error.message : '보고서 작성에 실패했습니다. 저장된 근거와 이전 보고서는 보존됩니다.'; this.save(report);
      }
    }).finally(() => { this.active.delete(job.id); });
    this.active.set(job.id, { id: report.id, controller, task }); return structuredClone(report);
  }
  async cancel(jobId: string): Promise<ReportRun | undefined> { const active = this.active.get(jobId); active?.controller.abort(); await active?.task; if (active) return this.get(active.id); const row = this.db.prepare('SELECT payload FROM case_reports WHERE job_id=? ORDER BY rowid DESC LIMIT 1').get(jobId); return row ? JSON.parse(String(row.payload)) as ReportRun : undefined; }
  async remove(jobId: string) { this.deleting.add(jobId); await this.cancel(jobId); this.db.prepare('DELETE FROM case_reports WHERE job_id=?').run(jobId); }
  async close() { this.closing = true; for (const active of this.active.values()) active.controller.abort(); await Promise.allSettled([...this.active.values()].map(active => active.task)); }
}
