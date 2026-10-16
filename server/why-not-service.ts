import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { GenerationJob } from './jobs.ts';
import type { EvidenceDocument } from '../src/types/graph.ts';
import type { OverviewConfidenceSummary, WhyBinding, WhyEvidence, WhyOverviewLayout, WhyPreparation, WhyResult, WhyRun, WhyRunStage, WhySnapshot } from '../src/types/why-not.ts';
import { caseChatContext } from './case-chat.ts';
import { searchCaseEvidence } from './analysis-case.ts';
import { relevantPassages, searchScore, searchTerms } from './evidence-search.ts';
import { CodexError, effectiveCodexConfig, runCodex } from './codex.ts';
import type { CodexConfig } from './codex.ts';
import { contentHash, initialWhyPolicy, parseWhySnapshot, WhyNotError } from './why-not-contract.ts';
import { evaluateWhyNot } from './why-not-engine.ts';
import { sourceGradeCoefficient } from '../src/lib/confidence-grade.ts';
import { applyWhyReview, snapshotFromWhyBaseline, whyBaselineSchema, whyReviewSchema } from './why-not-phases.ts';
import { applyWhyEstimation, estimationContext, estimationSchema } from './why-not-estimation.ts';
import { resolveUrlEvidence } from './url-evidence.ts';

const str = { type: 'string' }; const nullable = { type: ['string', 'null'] };
const strings = { type: 'array', items: str };
const obj = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const field = obj({ key: str, value: str, quote: str });
export const whyDraftSchema = obj({
  rootId: str,
  nodes: { type: 'array', maxItems: 24, items: obj({ id: str, kind: { enum: ['claim', 'requirement'] }, statement: str, operator: { enum: ['AND', 'OR', 'NOT_SUPPORT'] }, children: strings, inferenceRule: str, negativeOf: nullable, eventRuleId: nullable, need: { anyOf: [{ type: 'null' }, obj({ kinds: strings, fields: strings, criteria: strings, eventScope: str })] } }) },
  eventRules: { type: 'array', maxItems: 12, items: obj({ id: str, kind: { enum: ['SAME_EVENT', 'SAME_ENTITY', 'ORDERED_EVENTS'] }, fields: strings, expected: { type: 'array', items: obj({ key: str, value: str }) }, requireTime: { type: 'boolean' }, order: strings }) },
  bindings: { type: 'array', maxItems: 40, items: obj({ evidenceId: str, requirementId: str, quote: str, verdict: { enum: ['SUPPORTED', 'REFUTED', 'INSUFFICIENT', 'IRRELEVANT'] }, reason: str, missingRequirements: strings, likelihood: obj({ ratio: { type: 'null' }, basis: { enum: ['UNASSESSED'] }, reason: str }), metadata: obj({ fields: { type: 'array', items: field }, start: nullable, end: nullable, timeQuote: nullable }) }) },
  duplicates: { type: 'array', maxItems: 80, items: obj({ requirementId: str, leftEvidenceId: str, rightEvidenceId: str, leftQuote: str, rightQuote: str, verdict: { enum: ['SAME_OBSERVATION', 'PARTIAL_OVERLAP', 'DISTINCT', 'UNKNOWN'] }, reason: str }) },
});

export function makeWhyEvidence(id: string, name: string, text: string, record: number | null = null, url: string | null = null): WhyEvidence {
  return { id, name, text, record, url, contentHash: contentHash(text), documentId: null, kind: url ? 'WEB_PAGE' : 'DOCUMENT', processingStatus: 'READY', sourceGrade: null, sourceCoefficient: null, sourceReason: '', sourceType: null, originalVerified: false };
}

/** Job timestamps also change for progress messages. Pin the actual analysis
 * state instead, including saved graph membership and ontology version. */
export function analysisRevision(job: GenerationJob): string {
  return contentHash(JSON.stringify({ status: job.status, completed: job.completedChunks, total: job.totalChunks,
    graphIds: job.graphIds, graphCount: job.graphCount ?? job.graphIds.length,
    ontologyId: job.ontologyId ?? null, ontologyVersion: job.ontologyVersion ?? null }));
}
const sameGoal = (left: string, right: string) => left.normalize('NFKC').trim().replace(/\s+/gu, ' ') === right.normalize('NFKC').trim().replace(/\s+/gu, ' ');
function neutralBase(snapshot: WhySnapshot): WhySnapshot {
  return { ...structuredClone(snapshot), bindings: snapshot.bindings.map(binding => ({ ...structuredClone(binding), verdict: 'UNREVIEWED', reason: '검토 전 원문 연결입니다.', missingRequirements: [] })), duplicates: [] };
}

/** Model output never controls source contents, scores, versions, or coverage. */
export function snapshotFromWhyDraft(raw: unknown, goal: string, sources: WhyEvidence[], version: string, previous?: WhySnapshot): WhySnapshot {
  const draft = raw as { rootId?: unknown; nodes?: unknown[]; eventRules?: unknown[]; bindings?: unknown[]; duplicates?: unknown[] };
  if (!draft || !Array.isArray(draft.nodes) || draft.nodes.length > 24 || !Array.isArray(draft.eventRules) || draft.eventRules.length > 12 || !Array.isArray(draft.bindings) || draft.bindings.length > 40) throw new WhyNotError('검증 트리 응답 형식이 올바르지 않습니다.', 502);
  const nodes = previous ? structuredClone(previous.nodes) : draft.nodes.map(raw => ({ ...(raw as WhySnapshot['nodes'][number]), threshold: null }));
  if (!previous && nodes.some(n => n.kind === 'requirement' && (!Array.isArray(n.children) || n.children.length))) throw new WhyNotError('모델이 자료 요구에 임의의 증거 연결을 추가했습니다.', 502);
  const bindings = previous ? structuredClone(previous.bindings) : [];
  for (const raw of draft.bindings) {
    const b = raw as WhyBinding; const source = sources.find(e => e.id === b?.evidenceId);
    const node = nodes.find(n => n.id === b?.requirementId && n.kind === 'requirement');
    if (!source || !node || typeof b.quote !== 'string' || !b.quote.trim() || source.text.indexOf(b.quote) < 0) throw new WhyNotError('모델 인용이 제공된 원문 또는 자료 요구와 일치하지 않습니다.', 502);
    if (bindings.some(old => old.requirementId === b.requirementId && old.evidenceId === b.evidenceId && old.quote === b.quote)) continue;
    const id = `binding-${version.slice(-12)}-${bindings.length + 1}`;
    bindings.push({ ...b, id, start: source.text.indexOf(b.quote), end: source.text.indexOf(b.quote) + b.quote.length, evaluator: 'model-draft', decisionVersion: version, materialCoefficient: null, materialReason: '', atomId: null,
      ...(b.likelihood === undefined ? {} : { likelihood: { ratio: null, basis: 'UNASSESSED' as const, reason: '우도비와 산정 근거는 사용자 검토가 필요합니다.' } }) });
    node.children.push(id);
  }
  if (draft.duplicates !== undefined && (!Array.isArray(draft.duplicates) || draft.duplicates.length > 80)) throw new WhyNotError('중복 판정 응답 형식이 올바르지 않습니다.', 502);
  const duplicates = [...(previous?.duplicates ?? [])];
  for (const raw of draft.duplicates ?? []) {
    const d = raw as { requirementId: string; leftEvidenceId: string; rightEvidenceId: string; leftQuote: string; rightQuote: string; verdict: string; reason: string };
    const left = bindings.find(b => b.requirementId === d?.requirementId && b.evidenceId === d.leftEvidenceId && b.quote === d.leftQuote);
    const right = bindings.find(b => b.requirementId === d?.requirementId && b.evidenceId === d.rightEvidenceId && b.quote === d.rightQuote);
    if (!left || !right || left.id === right.id) throw new WhyNotError('중복 판정이 실제 증거 연결을 참조하지 않습니다.', 502);
    duplicates.push({ parentId: d.requirementId, left: left.id, right: right.id, verdict: d.verdict as WhySnapshot['duplicates'][number]['verdict'], reason: d.reason, leftQuote: d.leftQuote, rightQuote: d.rightQuote });
  }
  return parseWhySnapshot({ version: 'why-not-1.0', treeVersion: previous?.treeVersion ?? version, evidenceVersion: version, decisionVersion: version, goal, rootId: previous?.rootId ?? draft.rootId, nodes, bindings,
    evidence: [...(previous?.evidence ?? []), ...sources], eventRules: previous?.eventRules ?? draft.eventRules.map(r => ({ ...(r as object), version })), duplicates, provenance: previous?.provenance ?? [], policy: { ...(previous?.policy ?? initialWhyPolicy()), bayes: previous?.policy.bayes ?? { target: 'GOAL', priors: [], conditionalIndependence: [] } },
    coverage: { complete: false, note: '검색으로 선택한 원문 발췌 및 사용자 보완 범위입니다. 전체 자료의 부재를 단정하지 않습니다.' } });
}

export class WhyNotService {
  private db: DatabaseSync; private config: CodexConfig; private run: typeof runCodex;
  private active = new Map<string, { controller: AbortController; task: Promise<void> }>();
  private confidenceCache = new Map<string, { snapshot: WhySnapshot; result: WhyResult }>();
  private preparationQueue = new Map<string, GenerationJob>();
  private earlySources = new Map<string, WhyEvidence[]>();
  private jobReader?: (id: string) => GenerationJob | undefined;
  private resolveUrls: typeof resolveUrlEvidence;
  private preparationTimer?: ReturnType<typeof setTimeout>;
  private preparing = false;
  private diagnosticQueue = new Map<string, string>();
  private diagnosticImmediate?: ReturnType<typeof setImmediate>;
  private diagnosing = false;
  private deleting = new Set<string>(); private closing = false;
  constructor(db: DatabaseSync, config: CodexConfig, run: typeof runCodex = runCodex, jobReader?: (id: string) => GenerationJob | undefined, resolveUrls: typeof resolveUrlEvidence = resolveUrlEvidence) {
    this.db = db; this.config = effectiveCodexConfig(config, 'why-not'); this.run = run; this.jobReader = jobReader; this.resolveUrls = resolveUrls;
    db.exec('CREATE TABLE IF NOT EXISTS why_not_runs (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE, created_at TEXT NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS why_not_job ON why_not_runs(job_id,created_at)');
    db.exec('CREATE TABLE IF NOT EXISTS why_not_layouts (job_id TEXT PRIMARY KEY REFERENCES generation_jobs(id) ON DELETE CASCADE, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, positions_json TEXT NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS why_not_preparation_attempts (job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE, analysis_revision TEXT NOT NULL, attempted_at TEXT NOT NULL, PRIMARY KEY(job_id,analysis_revision))');
    for (const row of db.prepare("SELECT payload FROM why_not_runs WHERE json_extract(payload,'$.status')='running'").all()) {
      const item = JSON.parse(String(row.payload)) as WhyRun;
      if (item.baseSnapshot && (item.phase === 'graph-ready' || item.phase === 'diagnosing')) {
        const ready: WhyRun = { ...item, phase: 'graph-ready', stage: '기본 그래프 저장 완료 · 진단 재개 대기', error: undefined };
        this.update(ready); this.enqueueDiagnostics(ready);
      } else this.update({ ...item, status: 'failed', stage: '중단됨', error: '서버 재시작으로 중단되었습니다. 이전 버전은 보존되어 있습니다.' });
    }
    for (const row of db.prepare("SELECT payload FROM why_not_runs WHERE json_extract(payload,'$.status')='completed' AND json_type(payload,'$.snapshot')='object' AND (json_extract(payload,'$.phase') IS NULL OR json_type(payload,'$.baseSnapshot') IS NULL)").all()) {
      const item = JSON.parse(String(row.payload)) as WhyRun;
      this.update({ ...item, phase: 'ready', baseSnapshot: neutralBase(item.snapshot!), graphReadyAt: item.graphReadyAt ?? item.updatedAt });
    }
  }
  private currentJob(id: string): GenerationJob | undefined {
    if (this.jobReader) return this.jobReader(id);
    const row = this.db.prepare('SELECT payload FROM generation_jobs WHERE id=?').get(id);
    return row ? JSON.parse(String(row.payload)) as GenerationJob : undefined;
  }
  private inputIdentity(job: GenerationJob): string {
    const row = this.db.prepare('SELECT input_json FROM generation_jobs WHERE id=?').get(job.id);
    const input = row?.input_json ? JSON.parse(String(row.input_json)) as { documents?: EvidenceDocument[]; uploadIds?: string[] } : {};
    return contentHash(JSON.stringify({ question: job.question, documents: (input.documents ?? []).map(source => ({ id: source.id, hash: contentHash(source.text), url: source.url ?? null })), uploadIds: input.uploadIds ?? [] }));
  }
  scheduleBaseline(job: GenerationJob, documents: EvidenceDocument[]) {
    if (this.closing || this.deleting.has(job.id) || job.status !== 'running' || !documents.length) return;
    const previous = this.list(job.id).runs[0];
    if (previous) {
      if (previous.status === 'running' || previous.status === 'completed' || !previous.awaitingAnalysis || previous.baselineInputHash !== this.inputIdentity(job) || this.active.has(job.id)) return;
      if (previous.baseSnapshot) {
        // Explicit main-analysis resume reuses the complete neutral graph in a
        // new version, preserving the stopped attempt and all source IDs.
        const resumed = this.newRun(job, previous);
        resumed.snapshot = structuredClone(previous.baseSnapshot);
        resumed.snapshot.evidenceVersion = resumed.id; resumed.snapshot.decisionVersion = resumed.id;
        for (const binding of resumed.snapshot.bindings) if (binding.evaluator === 'graph-baseline') binding.decisionVersion = resumed.id;
        resumed.baseSnapshot = structuredClone(previous.baseSnapshot); resumed.graphReadyAt = previous.graphReadyAt;
        resumed.phase = 'graph-ready'; resumed.awaitingAnalysis = true; resumed.baselineInputHash = previous.baselineInputHash;
        resumed.stage = '기본 그래프 보존 · 주 분석 완료 대기';
        this.insert(resumed); return;
      }
    }
    this.earlySources.set(job.id, documents.slice(0, 10).map((source, index) => {
      const evidence = makeWhyEvidence(`early-${index + 1}`, source.name, source.text.slice(0, 10000), null, source.url ?? null); evidence.documentId = source.id; return evidence;
    }));
    this.preparationQueue.set(job.id, structuredClone(job)); this.wakePreparation();
  }
  stopAnalysis(job: GenerationJob) {
    this.earlySources.delete(job.id); this.preparationQueue.delete(job.id);
    const item = this.list(job.id).runs[0]; if (!item?.awaitingAnalysis) return;
    this.diagnosticQueue.delete(job.id); this.active.get(job.id)?.controller.abort();
    this.update({ ...item, status: job.status === 'cancelled' ? 'cancelled' : 'failed', stage: '주 분석 중단 · 기본 그래프 보존', error: '주 분석이 완료되지 않아 Cluevia 진단을 시작하지 않았습니다.' });
  }
  /** Returns false while awaiting input completion or after a terminal stop. */
  private releaseAnalysis(item: WhyRun): boolean {
    if (!item.awaitingAnalysis) return true;
    const job = this.currentJob(item.jobId);
    if (!job || job.status === 'failed' || job.status === 'cancelled') {
      item.status = job?.status === 'cancelled' ? 'cancelled' : 'failed'; item.stage = '주 분석 중단 · 기본 그래프 보존'; item.error = '주 분석이 완료되지 않아 Cluevia 진단을 시작하지 않았습니다.'; this.update(item); return false;
    }
    if (job.status !== 'completed') return false;
    if (item.baselineInputHash !== this.inputIdentity(job)) { item.status = 'failed'; item.error = '기본 그래프 생성 이후 입력 자료가 변경되어 진단을 시작하지 않았습니다.'; item.stage = '입력 변경 · 기본 그래프 보존'; this.update(item); return false; }
    item.awaitingAnalysis = false; item.analysisRevision = analysisRevision(job); this.update(item); return true;
  }
  /** Called by the durable analysis lifecycle, never by a read endpoint. */
  schedulePreparation(job: GenerationJob) {
    if (this.closing || this.deleting.has(job.id) || job.status !== 'completed') return;
    this.preparationQueue.set(job.id, structuredClone(job));
    this.wakePreparation();
  }
  private wakePreparation() {
    if (this.closing || this.preparing || this.preparationTimer || !this.preparationQueue.size) return;
    this.preparationTimer = setTimeout(() => { this.preparationTimer = undefined; void this.prepareNext(); }, 25);
    this.preparationTimer.unref?.();
  }
  private async prepareNext() {
    if (this.closing || this.preparing) return;
    if (this.active.size >= 2) { this.wakePreparation(); return; }
    const entry = this.preparationQueue.entries().next().value;
    if (!entry) return;
      const [id, queuedJob] = entry; this.preparationQueue.delete(id);
      const job = this.currentJob(id) ?? queuedJob;
    this.preparing = true;
    try {
      if (this.deleting.has(id) || !this.db.prepare('SELECT id FROM generation_jobs WHERE id=?').get(id)) return;
      const revision = analysisRevision(job);
      const previous = this.list(id).runs[0];
      if (previous?.status === 'running' && previous.phase === 'graph-ready' && previous.baseSnapshot) {
        this.enqueueDiagnostics(previous); return;
      }
      // A failed early attempt is visible and is never retried just because the
      // unrelated extraction stage finishes. Explicit main-analysis resume may
      // reuse its durable base through scheduleBaseline.
      if (previous?.baselineInputHash && previous.status !== 'running' && previous.status !== 'completed' && !this.earlySources.has(id)) return;
      // Migration is deterministic and precedes the attempt marker check: older
      // deployments may already have an attempt but no separate base checkpoint.
      if (previous?.status === 'completed' && previous.snapshot && (!previous.analysisRevision || previous.analysisRevision === revision)) {
        const result = evaluateWhyNot(parseWhySnapshot(previous.snapshot));
        this.update({ ...previous, phase: 'ready', baseSnapshot: previous.baseSnapshot ?? neutralBase(previous.snapshot), graphReadyAt: previous.graphReadyAt ?? previous.updatedAt,
          result, preparation: this.prepared(previous.snapshot, result) });
        this.db.prepare('INSERT INTO why_not_preparation_attempts VALUES (?,?,?) ON CONFLICT DO NOTHING').run(id, revision, new Date().toISOString()); return;
      }
      // Persist before provider invocation. Failed/cancelled work is not retried
      // by mounts, repeated completion notifications, or server restarts.
      const attempt = this.db.prepare('INSERT INTO why_not_preparation_attempts VALUES (?,?,?) ON CONFLICT DO NOTHING').run(id, revision, new Date().toISOString());
      if (!attempt.changes && !(this.earlySources.has(id) && previous?.awaitingAnalysis && previous.status !== 'running')) return;
      if (previous && (previous.status === 'running' || previous.analysisRevision === revision)) return;
      const early = this.earlySources.get(id); this.earlySources.delete(id);
      if (job.status !== 'completed' && !early) return;
      const run = this.start(job, { previousId: previous?.id, goal: job.question }, early ? { sources: early, defer: job.status !== 'completed' } : undefined);
      // The scheduler creates a new immutable version; existing manual inputs
      // above only refresh derived results/presentation, never through a model.
      run.attemptKey = contentHash(JSON.stringify([id, revision, job.question])); this.update(run);
      await this.active.get(id)?.task;
    } catch (error) {
      // Even a synchronous source/validation failure has a visible durable
      // terminal state, so clients cannot remain in an endless loading state.
      if (!this.closing && !this.deleting.has(id) && this.db.prepare('SELECT id FROM generation_jobs WHERE id=?').get(id)) {
        const previous = this.list(id).runs[0];
        const failed = this.newRun(job, previous);
        failed.status = 'failed'; failed.stage = '자동 준비 중단';
        failed.error = error instanceof WhyNotError || error instanceof CodexError ? error.message : '근거 그래프 준비에 실패했습니다. 저장된 분석과 이전 검토는 보존되어 있습니다.';
        this.insert(failed);
      }
    }
    finally { this.preparing = false; this.wakePreparation(); }
  }
  private enqueueDiagnostics(item: WhyRun) {
    if (this.closing || this.deleting.has(item.jobId)) return;
    if (!this.releaseAnalysis(item)) return;
    this.diagnosticQueue.set(item.jobId, item.id); this.wakeDiagnostics();
  }
  private wakeDiagnostics() {
    if (this.closing || this.diagnosing || this.diagnosticImmediate || !this.diagnosticQueue.size) return;
    this.diagnosticImmediate = setImmediate(() => {
      this.diagnosticImmediate = undefined;
      const entry = [...this.diagnosticQueue].find(([jobId]) => !this.active.has(jobId));
      if (!entry || this.closing) return;
      const [jobId, runId] = entry; this.diagnosticQueue.delete(jobId);
      const item = this.get(jobId, runId);
      if (item.status !== 'running' || item.phase !== 'graph-ready' || !item.baseSnapshot || !item.snapshot || !this.releaseAnalysis(item)) { this.wakeDiagnostics(); return; }
      this.diagnosing = true;
      const controller = new AbortController();
      const task = this.diagnose(item, controller).finally(() => {
        this.active.delete(jobId); this.diagnosing = false; this.wakeDiagnostics(); this.wakePreparation();
      });
      this.active.set(jobId, { controller, task });
    });
  }
  private async diagnose(item: WhyRun, controller: AbortController) {
    const finish = () => { const current = item.stages?.at(-1); if (current && !current.completedAt) current.completedAt = new Date().toISOString(); };
    try {
      item.phase = 'diagnosing'; item.stage = '완성된 기본 그래프의 자료 판정과 중복을 검토하고 있습니다.';
      item.stages = [...(item.stages ?? []), { stage: 'evaluating', startedAt: new Date().toISOString() }]; this.update(item);
      const baseline = parseWhySnapshot(item.snapshot);
      const bindingIds = baseline.bindings.filter(binding => binding.verdict === 'UNREVIEWED' && binding.evaluator === 'graph-baseline' && binding.decisionVersion === item.id).map(binding => binding.id);
      let snapshot = baseline;
      if (bindingIds.length) {
        const requestedSources = new Set(baseline.bindings.filter(binding => bindingIds.includes(binding.id)).map(binding => binding.evidenceId));
        const answer = await this.run({ purpose: 'why-not', question: baseline.goal,
          documents: baseline.evidence.filter(source => requestedSources.has(source.id)).map(source => ({ id: source.id, name: source.name, text: source.text })), schema: whyReviewSchema,
          context: JSON.stringify({ mode: 'review', rootId: baseline.rootId, nodes: baseline.nodes, bindings: baseline.bindings, bindingIds, eventRules: baseline.eventRules, duplicates: baseline.duplicates }) }, this.config, { signal: controller.signal });
        controller.signal.throwIfAborted(); snapshot = applyWhyReview(baseline, answer, item.id, { bindingIds });
      } else if (baseline.evidenceVersion === item.id) snapshot = applyWhyReview(baseline, { decisions: [], duplicates: [] }, item.id, { bindingIds: [] });
      controller.signal.throwIfAborted();
      // The reviewed fixed graph is a durable checkpoint too: restart during
      // confidence estimation never repeats topology generation or verdicts.
      item.snapshot = snapshot; finish(); this.update(item);
      if (!['completed', 'failed', 'skipped'].includes(item.estimation?.status ?? '')) {
        item.stage = 'Claude LOW로 사전확률·우도비·출처 등급을 추정하고 있습니다.';
        item.stages!.push({ stage: 'estimating', startedAt: new Date().toISOString() });
        item.estimation = { ...item.estimation, status: 'running', model: this.config.model ?? 'configured-model', effort: 'low' }; this.update(item);
        try {
          const context = estimationContext(snapshot);
          if (!context.hasTargets || !context.targets.evidenceIds.length) item.estimation = { ...item.estimation, status: 'skipped', completedAt: new Date().toISOString() };
          else {
            const freshSources = new Set(snapshot.bindings.filter(binding => binding.decisionVersion === item.id).map(binding => binding.evidenceId));
            const prioritizedIds = [...context.targets.evidenceIds].sort((left, right) => Number(freshSources.has(right)) - Number(freshSources.has(left)));
            const documents = prioritizedIds.slice(0, 10).map(id => snapshot.evidence.find(source => source.id === id)!).map(source => ({ id: source.id, name: source.name, text: source.text.slice(0, 10000) }));
            const answer = await this.run({ purpose: 'why-not', question: snapshot.goal, documents, schema: estimationSchema(context),
              context: JSON.stringify({ mode: 'estimate-confidence', ...context }) },
            { ...this.config, effort: 'low', efforts: { ...this.config.efforts, 'why-not': 'low' } }, { signal: controller.signal });
            controller.signal.throwIfAborted();
            snapshot = applyWhyEstimation(snapshot, answer, { model: this.config.model ?? 'configured-model' });
            snapshot.decisionVersion = item.id;
            item.estimation = { ...item.estimation, status: 'completed', completedAt: new Date().toISOString() };
          }
        } catch (error) {
          controller.signal.throwIfAborted();
          item.estimation = { ...item.estimation, status: 'failed', completedAt: new Date().toISOString(), error: error instanceof WhyNotError || error instanceof CodexError ? error.message : '신뢰도 추정을 완료하지 못해 미평가 입력의 중립 기준값을 유지했습니다.' };
        }
        finish(); item.snapshot = snapshot; this.update(item);
      }
      const result = evaluateWhyNot(snapshot);
      item.stage = '진단 결과와 보완 계획을 저장하고 있습니다.';
      item.stages!.push({ stage: 'saving', startedAt: new Date().toISOString() }); this.update(item); finish();
      this.update({ ...item, phase: 'ready', status: 'completed', stage: '진단과 보완 계획 준비 완료', snapshot, result, preparation: this.prepared(snapshot, result) });
    } catch (error) {
      if (this.closing && controller.signal.aborted) {
        this.update({ ...item, phase: 'graph-ready', status: 'running', stage: '기본 그래프 저장 완료 · 진단 재개 대기' });
      } else this.update({ ...item, status: controller.signal.aborted ? 'cancelled' : 'failed', stage: '기본 그래프 보존 · 진단 중단', error: controller.signal.aborted ? '진단을 중단했습니다. 완성된 기본 그래프는 보존되어 있습니다.' : error instanceof WhyNotError || error instanceof CodexError ? error.message : '자료 판정에 실패했습니다. 완성된 기본 그래프는 보존되어 있습니다.' });
    }
  }
  estimate(job: GenerationJob, body: { previousId?: unknown }): WhyRun {
    if (Object.keys(body).some(key => key !== 'previousId') || typeof body.previousId !== 'string' || !body.previousId) throw new WhyNotError('추정할 최신 평가 버전을 지정해주세요.');
    if (this.closing || this.deleting.has(job.id)) throw new WhyNotError('케이스를 종료하고 있습니다.', 409);
    const latest = this.list(job.id).runs[0];
    if (latest?.estimation?.requestedFrom === body.previousId) return latest;
    const previous = this.base(job, body.previousId);
    if (previous?.status !== 'completed' || !previous.snapshot) throw new WhyNotError('완료된 평가에서 신뢰도 추정을 시작해주세요.', 409);
    const item = this.newRun(job, previous);
    item.analysisRevision = previous.analysisRevision; item.snapshot = structuredClone(previous.snapshot);
    item.baseSnapshot = structuredClone(previous.baseSnapshot ?? neutralBase(previous.snapshot)); item.graphReadyAt = previous.graphReadyAt ?? previous.updatedAt;
    item.phase = 'graph-ready'; item.stage = '저장된 그래프의 신뢰도 추정 대기';
    item.preparation = { version: 'cluevia-preparation-1', ready: false, baselineScore: null, score: null, grade: null, preparedAt: null, animation: [], gapFill: [] };
    item.estimation = { status: 'pending', model: this.config.model ?? 'configured-model', effort: 'low', requestedFrom: previous.id };
    this.insert(item); this.enqueueDiagnostics(item); return item;
  }
  private prepared(_snapshot: WhySnapshot, result: WhyResult): WhyPreparation {
    const bayes = result.confidence.bayesian;
    return { version: 'cluevia-preparation-1', ready: true,
      baselineScore: bayes ? (bayes.baselineScore ?? bayes.trace.find(node => node.nodeId === _snapshot.rootId)?.prior ?? .5) * 100 : null,
      score: bayes ? bayes.score * 100 : null, grade: bayes?.grade ?? null, preparedAt: new Date().toISOString(),
      animation: result.gaps.map((gap, index) => ({ gapId: gap.id, delayMs: Math.min(index * 65, 650), durationMs: 650 })),
      gapFill: result.actions.map(action => ({ actionId: action.id, status: 'PLANNED' as const })) };
  }
  list(jobId: string) {
    const rows = this.db.prepare('SELECT payload FROM why_not_runs WHERE job_id=? ORDER BY rowid DESC LIMIT 50').all(jobId);
    return { runs: rows.map((row, i) => { const run = JSON.parse(String(row.payload)) as WhyRun; return i === 0 ? run : { ...run, snapshot: undefined, baseSnapshot: undefined, result: undefined }; }) };
  }
  get(jobId: string, id: string): WhyRun {
    const row = this.db.prepare('SELECT payload FROM why_not_runs WHERE job_id=? AND id=?').get(jobId, id);
    if (!row) throw new WhyNotError('진단 버전을 찾을 수 없습니다.', 404);
    return JSON.parse(String(row.payload));
  }
  /** Diagnostic animation is reconstructed from immutable WhyRun snapshots and
   * results. Only the user's display positions live in this separate record. */
  layout(jobId: string): WhyOverviewLayout {
    const row = this.db.prepare('SELECT revision,updated_at,positions_json FROM why_not_layouts WHERE job_id=?').get(jobId);
    return row ? { jobId, revision: Number(row.revision), updatedAt: String(row.updated_at), positions: JSON.parse(String(row.positions_json)) }
      : { jobId, revision: 0, updatedAt: null, positions: {} };
  }
  saveLayout(jobId: string, raw: unknown): WhyOverviewLayout {
    if (this.closing || this.deleting.has(jobId)) throw new WhyNotError('케이스를 종료하고 있습니다.', 409);
    if (!this.db.prepare('SELECT id FROM generation_jobs WHERE id=?').get(jobId)) throw new WhyNotError('케이스를 찾을 수 없습니다.', 404);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => key !== 'revision' && key !== 'positions')) throw new WhyNotError('그래프 위치 저장 형식이 올바르지 않습니다.');
    const { revision, positions } = raw as { revision?: unknown; positions?: unknown };
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) throw new WhyNotError('저장할 그래프 위치의 버전을 확인해주세요.');
    if (!positions || typeof positions !== 'object' || Array.isArray(positions) || Object.keys(positions).length > 10000) throw new WhyNotError('그래프 위치는 최대 10,000개까지 저장할 수 있습니다.');
    const entries = Object.entries(positions).map(([id, point]) => {
      if (!id.trim() || id.length > 500 || ['__proto__', 'constructor', 'prototype'].includes(id)
        || !point || typeof point !== 'object' || Array.isArray(point) || Object.keys(point).length !== 2 || !Object.hasOwn(point, 'x') || !Object.hasOwn(point, 'y')) throw new WhyNotError('그래프 노드와 좌표 형식을 확인해주세요.');
      const { x, y } = point as { x: unknown; y: unknown };
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1000000 || Math.abs(y) > 1000000) throw new WhyNotError('그래프 좌표는 유한한 숫자이며 ±1,000,000 이내여야 합니다.');
      return [id, { x, y }] as const;
    });
    const layout: WhyOverviewLayout = { jobId, revision: revision + 1, updatedAt: new Date().toISOString(), positions: Object.fromEntries(entries) };
    // A single conditional SQLite write prevents one device from silently
    // replacing another device's newer positions, including the first save.
    const changed = revision === 0
      ? this.db.prepare('INSERT INTO why_not_layouts VALUES (?,?,?,?) ON CONFLICT(job_id) DO NOTHING').run(jobId, layout.revision, layout.updatedAt, JSON.stringify(layout.positions))
      : this.db.prepare('UPDATE why_not_layouts SET revision=?,updated_at=?,positions_json=? WHERE job_id=? AND revision=?').run(layout.revision, layout.updatedAt, JSON.stringify(layout.positions), jobId, revision);
    if (!changed.changes) throw new WhyNotError('다른 화면에서 그래프 위치가 변경되었습니다. 최신 위치를 불러온 뒤 다시 저장해주세요.', 409);
    return layout;
  }
  /** Read-only evaluation of the latest completed snapshot. No model requests,
   * new diagnosis versions, source fetches, or fabricated coefficients. */
  confidence(job: GenerationJob): OverviewConfidenceSummary {
    const latestRow = this.db.prepare('SELECT payload FROM why_not_runs WHERE job_id=? ORDER BY rowid DESC LIMIT 1').get(job.id);
    const latest = latestRow ? JSON.parse(String(latestRow.payload)) as WhyRun : undefined;
    // A long sequence of cancelled attempts must not hide the last saved assessment.
    const row = this.db.prepare("SELECT payload FROM why_not_runs WHERE job_id=? AND json_extract(payload,'$.status')='completed' AND json_type(payload,'$.snapshot')='object' ORDER BY rowid DESC LIMIT 1").get(job.id);
    const run = row ? JSON.parse(String(row.payload)) as WhyRun : undefined;
    const pendingAnalysis = job.status === 'queued' || job.status === 'running';
    const pending = pendingAnalysis || latest?.status === 'running';
    const previousNote = latest && run && latest.id !== run.id
      ? latest.status === 'running' ? '새 근거 평가를 진행하는 동안 마지막으로 저장한 평가를 표시합니다.'
        : latest.status === 'failed' ? '최근 근거 평가에 실패하여 마지막으로 저장한 평가를 표시합니다.'
          : latest.status === 'cancelled' ? '최근 근거 평가를 중단하여 마지막으로 저장한 평가를 표시합니다.' : ''
      : '';
    const base: OverviewConfidenceSummary = { state: pending ? 'pending' : 'unassessed', confidence: null, goal: run?.snapshot?.goal ?? job.question,
      reason: pendingAnalysis ? '자료 분석 중입니다. 저장된 평가가 있어도 현재 그래프 전체의 점수로 확정하지 않습니다.'
        : pending ? '근거 평가를 진행하고 있습니다.' : '아직 저장된 근거 평가가 없습니다. 출처·자료 계수와 논리 연결을 평가해야 지지 점수를 계산할 수 있습니다.',
      unknownReasons: [], inputs: [], policyVersion: null, assessmentVersion: run?.id ?? null, evaluatedAt: run?.updatedAt ?? null,
      assumptions: ['지지 점수는 설정한 모형에서 자료가 주장을 뒷받침하는 정도이며, 결론이 참일 확률이 아닙니다.'],
      coverageNote: '', accepted: false };
    if (!run?.snapshot) {
      base.unknownReasons = ['계산에 사용할 논리와 증거 연결이 아직 평가되지 않았습니다.', '출처·자료 계수와 독립성 가정에 임의의 기본값을 넣지 않습니다.'];
      if (latest?.status === 'failed' || latest?.status === 'cancelled') base.reason = `${latest.status === 'failed' ? '최근 근거 평가가 실패했습니다.' : '최근 근거 평가를 중단했습니다.'} 완료된 평가가 없어 점수를 표시하지 않습니다.`;
      return base;
    }
    const cacheKey = `linear-bayes-v1:${run.id}:${contentHash(JSON.stringify(run.snapshot))}`;
    let evaluated = this.confidenceCache.get(cacheKey);
    if (!evaluated) {
      const snapshot = parseWhySnapshot(run.snapshot);
      evaluated = { snapshot, result: evaluateWhyNot(snapshot) };
      if (this.confidenceCache.size >= 32) this.confidenceCache.delete(this.confidenceCache.keys().next().value!);
      this.confidenceCache.set(cacheKey, evaluated);
    }
    const { snapshot, result } = evaluated;
    const usesBayes = snapshot.policy.bayes !== undefined || snapshot.bindings.some(binding => binding.likelihood !== undefined);
    const bayesian = result.confidence.bayesian!;
    const unknownReasons: string[] = [...bayesian.unknownReasons];
    if (run.estimation?.status === 'failed') unknownReasons.push(`모델 신뢰도 추정 실패: ${run.estimation.error ?? '미평가 입력의 중립 기준값을 유지했습니다.'}`);
    const countUnknown = (count: number, description: string) => { if (count) unknownReasons.push(`${description}: ${count}개`); };
    countUnknown(snapshot.evidence.filter(e => e.sourceGrade === null).length, '출처 등급 미평가');
    if (!usesBayes) {
      countUnknown(snapshot.evidence.filter(e => e.sourceCoefficient === null).length, '출처 계수 미평가');
      countUnknown(snapshot.bindings.filter(b => b.materialCoefficient === null).length, '자료 품질 계수 미평가');
    }
    countUnknown(snapshot.bindings.filter(b => b.verdict === 'UNREVIEWED').length, '자료–주장 연결 판정 미평가');
    countUnknown(result.confidence.atoms.filter(atom => atom.score === null).length, '계수가 없거나 평가가 일치하지 않는 공유 관측');
    if (result.confidence.threshold === null) unknownReasons.push('운영 임계값이 지정되지 않아 기준 충족을 판정하지 않습니다.');
    if (result.confidence.method === 'CONSERVATIVE_BOUNDS') unknownReasons.push(result.confidence.reason);
    if (result.chainStatus !== 'COMPLETE_CHAIN_FOUND') unknownReasons.push(result.chainStatus === 'NO_COMPLETE_CHAIN' ? '현재 자료에서 적격한 완성 체인을 찾지 못했습니다.' : '필수 근거 또는 출처 평가가 끝나지 않아 완성 체인을 확정하지 못했습니다.');
    if (!snapshot.coverage.complete) unknownReasons.push(snapshot.coverage.note || '전체 자료의 평가가 완료되지 않았습니다.');
    if (result.limits.some(limit => limit.startsWith('CANDIDATE_LIMIT'))) unknownReasons.push('후보 계산 한도에 도달했습니다. 표시된 값은 검토한 일부 경로의 점수입니다.');
    if (result.limits.some(limit => limit.startsWith('SCORE_STATE_LIMIT'))) unknownReasons.push('공유 증거 계산 한도에 도달하여 일부 점수를 확정하지 못했습니다.');
    const evidence = new Map(snapshot.evidence.map(e => [e.id, e]));
    const nodes = new Map(snapshot.nodes.map(node => [node.id, node]));
    const included = new Set(result.witnesses.filter(w => w.status === 'ACTIVE' || w.status === 'DUPLICATE').flatMap(w => w.bindingIds));
    const duplicates = new Set(result.witnesses.filter(w => w.status === 'DUPLICATE').flatMap(w => w.bindingIds));
    const inputs: OverviewConfidenceSummary['inputs'] = snapshot.bindings.map(binding => {
      const source = evidence.get(binding.evidenceId)!;
      const likelihoodTrace = bayesian.bindings.find(trace => trace.bindingId === binding.id);
      const excludedReason = usesBayes ? likelihoodTrace && likelihoodTrace.status !== 'USED' ? likelihoodTrace.reason : undefined : source.processingStatus !== 'READY' ? '자료 처리가 완료되지 않음'
        : binding.verdict !== 'SUPPORTED' ? `${({ REFUTED: '반증', INSUFFICIENT: '근거 불충분', IRRELEVANT: '관련 없음', UNREVIEWED: '판정 미완료' } as const)[binding.verdict]} · ${binding.reason}`
          : source.sourceGrade === 'D' || source.sourceGrade === 'E' ? `출처 ${source.sourceGrade}등급 · 적격 근거에서 제외`
            : source.sourceGrade === null ? '출처 등급 미평가'
              : !included.has(binding.id) ? '적격한 완성 체인에 포함되지 않음'
                : duplicates.has(binding.id) ? '같은 관측으로 중복 가산하지 않음' : undefined;
      return { id: binding.id, label: `${source.name} · ${nodes.get(binding.requirementId)!.statement}`,
        sourceCoefficient: usesBayes ? sourceGradeCoefficient(source.sourceGrade) : source.sourceCoefficient, materialCoefficient: usesBayes ? null : binding.materialCoefficient,
        sourceReason: source.sourceReason, materialReason: binding.materialReason, ...(excludedReason ? { excludedReason } : {}) };
    });
    const boundSources = new Set(snapshot.bindings.map(binding => binding.evidenceId));
    for (const source of snapshot.evidence.filter(e => !boundSources.has(e.id))) inputs.push({ id: `source:${source.id}`, label: source.name,
      sourceCoefficient: usesBayes ? sourceGradeCoefficient(source.sourceGrade) : source.sourceCoefficient, materialCoefficient: null, sourceReason: source.sourceReason, excludedReason: '자료–주장 연결이 없음' });
    const staleReasons: string[] = [];
    if (!run.analysisRevision) staleReasons.push('이전 평가에 분석 버전 정보가 없어 현재 자료와의 일치를 확인할 수 없습니다.');
    else if (run.analysisRevision !== analysisRevision(job)) staleReasons.push('평가 이후 분석 자료 또는 저장된 그래프가 변경되었습니다.');
    if (!sameGoal(snapshot.goal, job.question)) staleReasons.push('저장된 평가의 대상 주장이 현재 케이스 질문과 다릅니다.');
    const incomplete = result.evaluationStatus === 'INCOMPLETE' || !snapshot.coverage.complete || job.status === 'failed' || job.status === 'cancelled' || job.completedChunks < job.totalChunks;
    const numeric = usesBayes ? bayesian.range !== null : result.confidence.supportScore !== null || result.confidence.range !== null;
    const state: OverviewConfidenceSummary['state'] = pending ? 'pending' : staleReasons.length ? 'stale'
      : !inputs.length ? 'unassessed' : incomplete ? 'incomplete' : numeric ? 'ready' : 'unassessed';
    let reason = pending ? base.reason : staleReasons.length ? staleReasons.join(' ')
      : incomplete ? '일부 자료 또는 계산만 평가한 결과입니다. 현재 값은 전체 분석의 확정 점수가 아닙니다.'
        : usesBayes ? bayesian.reason : result.confidence.reason;
    if (previousNote) reason = `${previousNote} ${reason}`;
    reason += ' 저장된 평가 입력을 현재 계산 규칙으로 다시 계산한 결과입니다.';
    return { ...base, state, confidence: structuredClone(result.confidence), goal: snapshot.goal, reason,
      unknownReasons: [...new Set([...staleReasons, ...unknownReasons])], inputs, policyVersion: snapshot.policy.version,
      assumptions: [...base.assumptions, ...bayesian.assumptions, ...snapshot.policy.independence.map(group => `기존 지지 점수의 독립성 가정 (${group.atomIds.join(', ')}): ${group.reason}`),
        ...(result.confidence.method === 'CONSERVATIVE_BOUNDS' ? ['독립성이 확정되지 않은 관측은 단일 점수로 합산하지 않고 보수적 범위를 표시합니다.'] : [])],
      coverageNote: snapshot.coverage.note, accepted: state === 'ready' && result.accepted,
      nodeLabels: Object.fromEntries(snapshot.nodes.map(node => [node.id, node.statement])) };
  }
  private base(job: GenerationJob, previousId: unknown): WhyRun | undefined {
    if (this.closing || this.deleting.has(job.id)) throw new WhyNotError('케이스를 종료하고 있습니다.', 409);
    if (!['completed', 'failed'].includes(job.status)) throw new WhyNotError('자료 분석이 완료되거나 실패한 뒤 근거 진단을 시작해주세요.', 409);
    if (this.active.has(job.id) || this.diagnosticQueue.has(job.id)) throw new WhyNotError('진행 중인 검증을 완료하거나 중단해주세요.', 409);
    const latest = this.db.prepare('SELECT id FROM why_not_runs WHERE job_id=? ORDER BY rowid DESC LIMIT 1').get(job.id);
    if ((latest?.id ?? null) !== (previousId ?? null)) throw new WhyNotError('다른 창에서 버전이 변경되었습니다. 최신 상태를 불러온 뒤 다시 시도해주세요.', 409);
    return typeof previousId === 'string' ? this.get(job.id, previousId) : undefined;
  }
  private insert(item: WhyRun) { this.db.prepare('INSERT INTO why_not_runs VALUES (?,?,?,?)').run(item.id, item.jobId, item.createdAt, JSON.stringify(item)); }
  private update(item: WhyRun) { this.db.prepare('UPDATE why_not_runs SET payload=? WHERE id=?').run(JSON.stringify({ ...item, updatedAt: new Date().toISOString() }), item.id); }
  private newRun(job: GenerationJob, previous?: WhyRun): WhyRun { const now = new Date().toISOString(); return { id: `why-${randomUUID()}`, jobId: job.id, previousId: previous?.id ?? null, createdAt: now, updatedAt: now, status: 'running', phase: 'building-graph', stage: '원문에서 주장과 필수 근거를 설계하고 있습니다', analysisRevision: analysisRevision(job) }; }
  /** Failed extraction may have saved no records. Read only retained input, never URL contents. */
  private originalInputSources(jobId: string): WhyEvidence[] {
    const row = this.db.prepare('SELECT input_json FROM generation_jobs WHERE id=?').get(jobId);
    if (typeof row?.input_json !== 'string') return [];
    const input = JSON.parse(row.input_json) as { documents?: unknown };
    if (!Array.isArray(input.documents)) return [];
    const sources: WhyEvidence[] = [];
    for (let index = 0; index < input.documents.length && sources.length < 10; index++) {
      const document = input.documents[index] as { id?: unknown; name?: unknown; text?: unknown; url?: unknown } | null;
      if (typeof document?.text !== 'string' || !document.text.trim()) continue;
      const text = document.text.slice(0, 10000);
      if (sources.some(source => source.contentHash === contentHash(text))) continue;
      const name = typeof document.name === 'string' && document.name.trim() ? document.name.slice(0, 300) : `입력 자료 ${index + 1}`;
      const source = makeWhyEvidence(`input-${index + 1}`, name, text, null, typeof document.url === 'string' ? document.url || null : null);
      source.documentId = typeof document.id === 'string' && document.id.length <= 200 ? document.id : null;
      sources.push(source);
    }
    return sources;
  }
  search(job: GenerationJob, query: string) {
    if (!query.trim() || query.length > 1000) throw new WhyNotError('검색어는 1–1000자로 입력해주세요.');
    const found = searchCaseEvidence(this.db, job, query, 8); const terms = searchTerms(query);
    const latest = this.list(job.id).runs[0];
    const supplements = (latest?.snapshot?.evidence ?? []).filter(e => e.id.startsWith('user-') && searchScore(e.text, terms) > 0).slice(0, 8).map(e => ({ id: e.id, name: e.name, text: relevantPassages(e.text, terms, 4000).map(p => p.text).join('\n\n') }));
    return { ...found, supplements };
  }
  evaluate(job: GenerationJob, body: { previousId?: unknown; snapshot?: unknown }): WhyRun {
    const previous = this.base(job, body.previousId); const parsed = parseWhySnapshot(body.snapshot);
    const item = this.newRun(job, previous);
    // Editing scores or logic does not refresh the underlying source selection.
    if (previous?.snapshot) item.analysisRevision = previous.analysisRevision;
    const snapshot: WhySnapshot = { ...parsed, treeVersion: item.id, evidenceVersion: item.id, decisionVersion: item.id, policy: { ...parsed.policy, version: item.id }, bindings: parsed.bindings.map(b => ({ ...b, decisionVersion: item.id })) };
    // Raw evidence in a reviewed version is immutable; additions go through the supplement route.
    if (previous?.snapshot && (parsed.evidence.length !== previous.snapshot.evidence.length || parsed.evidence.some(e => { const old = previous.snapshot!.evidence.find(o => o.id === e.id); return !old || ['text', 'contentHash', 'url', 'record', 'documentId', 'processingStatus'].some(k => e[k as keyof WhyEvidence] !== old[k as keyof WhyEvidence]); }))) throw new WhyNotError('저장된 원문은 수정할 수 없습니다. 자료 보완으로 새 자료를 추가해주세요.');
    const fingerprint = (s: WhySnapshot) => contentHash(JSON.stringify({ ...s, treeVersion: '', evidenceVersion: '', decisionVersion: '', policy: { ...s.policy, version: '' }, bindings: s.bindings.map(b => ({ ...b, decisionVersion: '' })) }));
    const result = evaluateWhyNot(snapshot);
    // Replaying identical inputs is a no-op only while the deterministic
    // calculation is identical too. Rule corrections get a new immutable run.
    if (previous?.snapshot && fingerprint(parsed) === fingerprint(previous.snapshot) && JSON.stringify(result) === JSON.stringify(previous.result)) return previous;
    item.snapshot = snapshot; item.baseSnapshot = neutralBase(snapshot); item.graphReadyAt = item.createdAt; item.phase = 'ready'; item.result = result; item.status = 'completed'; item.stage = '진단 완료'; item.preparation = this.prepared(snapshot, item.result); this.insert(item); return item;
  }
  start(job: GenerationJob, body: { previousId?: unknown; goal?: unknown; supplement?: unknown; auto?: unknown }, early?: { sources: WhyEvidence[]; defer: boolean }): WhyRun {
    if (body.auto !== undefined && typeof body.auto !== 'boolean') throw new WhyNotError('auto 값은 boolean이어야 합니다.');
    const automatic = body.auto === true;
    let previous: WhyRun | undefined;
    if (automatic) {
      if (this.closing || this.deleting.has(job.id)) throw new WhyNotError('케이스를 종료하고 있습니다.', 409);
      if (job.status !== 'completed') throw new WhyNotError('자료 분석이 완료된 뒤 자동 근거 평가를 시작할 수 있습니다.', 409);
      if (body.supplement !== undefined) throw new WhyNotError('자료 보완은 자동 평가에 포함할 수 없습니다.');
      const latest = this.db.prepare('SELECT payload FROM why_not_runs WHERE job_id=? ORDER BY rowid DESC LIMIT 1').get(job.id);
      // Existing manual reviews, running work and failed/cancelled attempts are
      // all preserved. Only an explicit manual action may create another version.
      if (latest) return JSON.parse(String(latest.payload)) as WhyRun;
    } else if (early && job.status === 'running') {
      const latest = this.list(job.id).runs[0];
      if (this.closing || this.deleting.has(job.id) || this.active.has(job.id) || (latest && (latest.id !== body.previousId || latest.status === 'running' || latest.status === 'completed' || !latest.awaitingAnalysis))) throw new WhyNotError('기본 그래프를 이미 준비하고 있습니다.', 409);
      previous = latest;
    } else previous = this.base(job, body.previousId);
    if (this.active.size >= 2) throw new WhyNotError('다른 검증을 처리 중입니다. 잠시 후 다시 시도해주세요.', 429);
    const supplement = body.supplement as { name?: unknown; text?: unknown; url?: unknown } | undefined;
    const base = supplement ? previous?.snapshot : undefined;
    if (supplement && !base) throw new WhyNotError('자료를 보완할 진단 버전이 필요합니다.');
    const goal = base?.goal ?? body.goal ?? (automatic ? job.question : undefined);
    if (typeof goal !== 'string' || !goal.trim() || goal.length > 2000) throw new WhyNotError('검증할 주장은 1–2000자로 입력해주세요.');
    let sources: WhyEvidence[];
    if (supplement) {
      if (typeof supplement.name !== 'string' || !supplement.name.trim() || supplement.name.length > 300 || typeof supplement.text !== 'string' || supplement.text.length > 30000 || (supplement.url != null && (typeof supplement.url !== 'string' || supplement.url.length > 2000)) || !supplement.text.trim() && !(typeof supplement.url === 'string' && supplement.url.trim())) throw new WhyNotError('자료 제목과 원문 또는 URL(본문 최대 30,000자)을 확인해주세요.');
      const hasUrl = Boolean(typeof supplement.url === 'string' && supplement.url.trim()) || supplement.text.split(/\r?\n/u).some(line => /^[a-z][a-z\d+.-]*:\/\/\S+$/iu.test(line.trim()));
      if (typeof supplement.url === 'string' && supplement.url.trim()) {
        let url: URL; try { url = new URL(supplement.url.trim()); } catch { throw new WhyNotError('추가 자료의 URL을 확인해주세요.'); }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new WhyNotError('로그인 정보가 없는 HTTP·HTTPS URL을 입력해주세요.');
      }
      if (!hasUrl && base!.evidence.some(e => e.contentHash === contentHash(supplement.text as string))) throw new WhyNotError('동일한 원문이 이미 있습니다. 기존 자료의 판정·출처 평가를 검토해주세요.', 409);
      sources = [makeWhyEvidence(`user-${randomUUID()}`, supplement.name.trim(), supplement.text)];
      parseWhySnapshot({ ...base, evidence: [...base!.evidence, ...sources] });
    } else if (early) sources = early.sources;
    else {
      const retrieved = caseChatContext(this.db, job, goal);
      sources = [];
      const longest = Math.max(0, ...retrieved.recordsUsed.map(record => retrieved.quoteTexts.get(record)?.length ?? 0));
      for (let i = 0; i < longest && sources.length < 10; i++) {
        for (const record of retrieved.recordsUsed) {
          if (sources.length >= 10) break;
          const text = retrieved.quoteTexts.get(record)?.[i]?.slice(0, 10000); if (!text?.trim() || sources.some(s => s.contentHash === contentHash(text))) continue;
          sources.push(makeWhyEvidence(`record-${record}-${i}`, `기록 ${record} · 발췌 ${i + 1}`, text, record));
        }
      }
      if (!sources.length) sources = this.originalInputSources(job.id);
    }
    const item = this.newRun(job, previous); item.snapshot = base ?? previous?.snapshot;
    if (early) { item.awaitingAnalysis = early.defer; item.baselineInputHash = this.inputIdentity(job); }
    item.preparation = { version: 'cluevia-preparation-1', ready: false, baselineScore: null, score: null, grade: null, preparedAt: null, animation: [], gapFill: [] };
    const sourceRevision = base ? previous?.analysisRevision : item.analysisRevision;
    // A running/failed attempt may expose its previous snapshot for review.
    // Keep that snapshot's revision until the new source selection succeeds.
    if (item.snapshot) item.analysisRevision = previous?.analysisRevision;
    item.inputHash = contentHash(JSON.stringify([goal, sources.map(s => s.contentHash), base?.decisionVersion, sourceRevision]));
    if (!supplement && previous?.status === 'completed' && previous.analysisRevision !== undefined && previous.analysisRevision === sourceRevision && previous.inputHash === item.inputHash) return previous;
    if (automatic) {
      item.attemptKey = contentHash(JSON.stringify([job.id, sourceRevision, goal]));
      // One atomic statement wins even when two automatic mounts race after
      // observing empty history. Persist the attempt before invoking the model.
      const inserted = this.db.prepare('INSERT INTO why_not_runs SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM why_not_runs WHERE job_id=?)')
        .run(item.id, item.jobId, item.createdAt, JSON.stringify(item), job.id);
      if (!inserted.changes) {
        const latest = this.db.prepare('SELECT payload FROM why_not_runs WHERE job_id=? ORDER BY rowid DESC LIMIT 1').get(job.id)!;
        return JSON.parse(String(latest.payload)) as WhyRun;
      }
    } else this.insert(item);
    const controller = new AbortController();
    const finishStage = () => {
      const current = item.stages?.at(-1);
      if (current && !current.completedAt) current.completedAt = new Date().toISOString();
    };
    const stage = (step: WhyRunStage['stage'], label: string) => {
      controller.signal.throwIfAborted(); finishStage();
      item.stages = [...(item.stages ?? []), { stage: step, startedAt: new Date().toISOString() }];
      item.stage = label; this.update(item);
    };
    // Deferring execution ensures active is installed even if the injected runner throws synchronously.
    const task = Promise.resolve().then(async () => {
      try {
        if (supplement) {
          item.stage = '추가 자료의 URL 원문을 읽고 있습니다.'; this.update(item);
          const original = sources[0];
          const explicitUrl = typeof supplement.url === 'string' && supplement.url.trim() ? new URL(supplement.url.trim()).href : '';
          const inputText = [original.text, ...(explicitUrl && !original.text.split(/\r?\n/u).some(line => line.trim() === explicitUrl) ? [explicitUrl] : [])].filter(Boolean).join('\n');
          const resolved = await this.resolveUrls([{ id: original.id, name: explicitUrl ? `${original.name.slice(0, 280)} · URL` : original.name, text: inputText }], {
            signal: controller.signal, progress: message => { if (!controller.signal.aborted) { item.stage = message; this.update(item); } },
          });
          controller.signal.throwIfAborted(); item.urlReads = resolved.results;
          sources = resolved.documents.filter(document => document.text.trim()).map(document => {
            const fetched = document.id !== original.id && Boolean(document.url);
            const source = makeWhyEvidence(fetched ? `user-${document.id}` : document.id,
              fetched ? `${original.name.slice(0, 280)} · Web source` : original.name,
              document.text.slice(0, 30000), null, fetched ? document.url! : null);
            source.documentId = document.id;
            if (!fetched && resolved.results.length) source.sourceReason = '사용자가 직접 입력한 설명입니다. 링크에서 읽은 원문과 구분해 평가합니다.';
            if (fetched && document.text.length > 30000) { const read = item.urlReads!.find(read => read.url === document.url); if (read) read.truncated = true; }
            return source;
          }).filter((source, index, all) => !base!.evidence.some(old => old.contentHash === source.contentHash) && all.findIndex(other => other.contentHash === source.contentHash) === index);
          let remainingCharacters = 150000;
          sources = sources.flatMap(source => {
            const text = source.text.slice(0, remainingCharacters); remainingCharacters -= text.length;
            if (text.length < source.text.length) { const read = item.urlReads?.find(read => read.url === source.url); if (read) read.truncated = true; }
            return text ? [{ ...source, text, contentHash: contentHash(text) }] : [];
          });
          this.update(item);
          if (!sources.length) {
            if (resolved.results.some(read => read.status === 'failed')) throw new WhyNotError(`추가 URL 원문을 읽지 못했습니다. ${resolved.results.filter(read => read.status === 'failed').map(read => read.reason).join(' ')}`, 502);
            const snapshot = structuredClone(base!); const result = evaluateWhyNot(snapshot);
            this.update({ ...item, phase: 'ready', status: 'completed', stage: '이미 평가한 동일 원문 · 신뢰도 유지', snapshot, baseSnapshot: neutralBase(snapshot), graphReadyAt: new Date().toISOString(), result, preparation: this.prepared(snapshot, result) }); return;
          }
          parseWhySnapshot({ ...base, evidence: [...base!.evidence, ...sources] });
          item.inputHash = contentHash(JSON.stringify([goal, sources.map(source => source.contentHash), base?.decisionVersion, sourceRevision]));
        }
        stage('drafting', '자료에서 주장과 필수 근거를 설계하고 있습니다.');
        const answer = await this.run({ purpose: 'why-not', question: goal, documents: sources.map(e => ({ id: e.id, name: e.name, text: e.text })), schema: whyBaselineSchema, context: JSON.stringify({ mode: 'baseline', supplement: Boolean(base), existingTree: base ? { rootId: base.rootId, nodes: base.nodes, eventRules: base.eventRules, bindings: base.bindings.map(b => ({ requirementId: b.requirementId, evidenceId: b.evidenceId, quote: b.quote })).slice(-40) } : null, coverage: 'Partial retained input or retrieved excerpts. URL references are not fetched page content. Build topology and exact quote links only. Verdicts and duplicate judgments belong to the later review phase.' }) }, this.config, { signal: controller.signal });
        controller.signal.throwIfAborted();
        stage('validating', '인용문 위치와 자료·주장 연결을 원문과 검증하고 있습니다.');
        const snapshot = snapshotFromWhyBaseline(answer, goal, sources, item.id, base);
        finishStage();
        item.snapshot = snapshot; item.baseSnapshot = neutralBase(snapshot); item.analysisRevision = sourceRevision;
        item.phase = 'graph-ready'; item.graphReadyAt = new Date().toISOString(); item.stage = '기본 그래프 완성 · Cluevia 진단 대기'; this.update(item);
        this.enqueueDiagnostics(item);
      } catch (error) {
        const current = this.get(item.jobId, item.id);
        if (current.status === 'running') this.update({ ...item, status: controller.signal.aborted ? 'cancelled' : 'failed', stage: '검증 중단', error: controller.signal.aborted ? '검증을 중단했습니다. 이전 진단은 보존됩니다.' : error instanceof WhyNotError || error instanceof CodexError ? error.message : '검증 생성에 실패했습니다. 이전 진단에서 다시 시도해주세요.' });
      }
    }).finally(() => { this.active.delete(job.id); this.wakeDiagnostics(); this.wakePreparation(); });
    this.active.set(job.id, { controller, task }); return item;
  }
  async cancel(jobId: string) { const pending = this.active.get(jobId); pending?.controller.abort(); await pending?.task;
    const queued = this.diagnosticQueue.get(jobId); this.diagnosticQueue.delete(jobId);
    if (queued) { const item = this.get(jobId, queued); if (item.status === 'running') this.update({ ...item, status: 'cancelled', stage: '기본 그래프 보존 · 진단 중단', error: '진단을 중단했습니다.' }); }
    const waiting = this.list(jobId).runs[0];
    if (waiting?.status === 'running' && waiting.awaitingAnalysis) this.update({ ...waiting, status: 'cancelled', stage: '기본 그래프 보존 · 진단 중단', error: '진단을 중단했습니다.' });
    return this.list(jobId); }
  async remove(jobId: string) { this.deleting.add(jobId); this.preparationQueue.delete(jobId); this.earlySources.delete(jobId); await this.cancel(jobId); this.confidenceCache.clear(); }
  async close() { this.closing = true; if (this.preparationTimer) clearTimeout(this.preparationTimer); if (this.diagnosticImmediate) clearImmediate(this.diagnosticImmediate); this.diagnosticQueue.clear(); this.preparationQueue.clear(); this.earlySources.clear(); for (const p of this.active.values()) p.controller.abort(); await Promise.allSettled([...this.active.values()].map(p => p.task)); this.confidenceCache.clear(); }
}
