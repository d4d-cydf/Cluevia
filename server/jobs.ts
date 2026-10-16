import { deleteStoredCase } from './case-deletion.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { recoverExtraction } from './extraction-recovery.ts';
import { normalizeClaimMetadata } from './claim-metadata.ts';
import { GRAPH_LIMITS, GraphValidationError } from '../src/lib/graph-document.ts';
import type { GraphGenerationInput, EvidenceDocument } from '../src/types/graph.ts';
import type { CodexConfig } from './codex.ts';
import type { AnalysisBrief } from '../src/types/clarification.ts';
import { CodexError, runCodex } from './codex.ts';
import { compileExtraction, parseExtraction, extractionSchema, InsufficientEvidenceError } from './ontology.ts';
import type { OntologyStore } from './ontology-store.ts';
import { EVIDENCE_CHUNK_CHARS, splitEvidenceText } from './evidence-uploads.ts';
import type { UploadedEvidence } from './evidence-uploads.ts';
import { analysisBriefContext, designOntology } from './ontology-planner.ts';
import { SqliteOntologyDesignCache } from './ontology-design-cache.ts';
import { isStructuredName } from './structured-ingest.ts';
import { AnalysisPipeline, emptyMetrics } from './analysis-pipeline.ts';
import type { AnalysisMetrics, AnalysisOptions, AnalysisPart, AnalysisResult, AnalysisUploads } from './analysis-pipeline.ts';
import { resolveUrlEvidence } from './url-evidence.ts';
import type { UrlEvidenceRead } from './url-evidence.ts';

export interface GenerationJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  stage: 'designing' | 'preparing' | 'extracting' | 'validating' | 'saving';
  message: string;
  question: string;
  analysisBrief?: AnalysisBrief;
  createdAt: string;
  updatedAt: string;
  completedChunks: number;
  totalChunks: number;
  emptyChunks: number;
  graphIds: string[];
  /** Hybrid jobs store the count here and graph membership in analysis_parts. */
  graphCount?: number;
  currentSource?: string;
  graphId?: string;
  error?: string;
  errorCode?: string;
  resumable: boolean;
  processingMode?: 'hybrid' | 'codex';
  metrics?: AnalysisMetrics;
  jevRouting?: { message: string };
  ontologyPlanning?: boolean;
  ontologyId?: string;
  ontologyVersion?: number;
  ontologyName?: string;
  schemaOnly?: boolean;
  urlReads?: UrlEvidenceRead[];
  startedAt?: string; firstGraphMs?: number; elapsedMs?: number;
}
export type CodexRunner = typeof runCodex;
type UploadReader = AnalysisUploads;
interface StoredInput extends GraphGenerationInput {
  evidenceResolved?: boolean;
  urlEvidenceResolved?: boolean;
  originalDocuments?: EvidenceDocument[];
  ontologyRepair?: { fromVersion: number; reason: string; kind?: 'identity' | 'mapping' };
  /** A timeout can request one mapping redesign; later retries keep the repaired schema. */
  timeoutMappingRepaired?: boolean;
}
interface PendingJob { id: string; input: StoredInput; controller: AbortController }
interface JobRow { payload: string; input_json: string | null }

/** Preserve every source character. Long sources overlap at boundaries to retain nearby context. */
function inlineBatches(documents: EvidenceDocument[]): EvidenceDocument[][] {
  const batches: EvidenceDocument[][] = [];
  let batch: EvidenceDocument[] = [];
  let characters = 0;
  const append = (document: EvidenceDocument) => {
    if (batch.length && (characters + document.text.length > EVIDENCE_CHUNK_CHARS || batch.length >= GRAPH_LIMITS.documents)) {
      batches.push(batch); batch = []; characters = 0;
    }
    batch.push(document); characters += document.text.length;
  };
  for (const source of documents) {
    const document: EvidenceDocument = { id: source.id, name: source.name, text: source.text, ...(source.url ? { url: source.url } : {}), ...(source.identityScope ? { identityScope: source.identityScope } : {}) };
    if (document.text.length <= EVIDENCE_CHUNK_CHARS) { append(document); continue; }
    const digest = createHash('sha256').update(document.text).digest('hex');
    const idDigest = createHash('sha256').update(document.id).digest('hex').slice(0, 20);
    let index = 0;
    for (const part of splitEvidenceText(document.text)) {
      const suffix = ` · part ${++index}`;
      append({ ...document, id: `inline-${idDigest}-part-${index}`, name: `${document.name.slice(0, 300 - suffix.length)}${suffix}`, text: part.text, identityScope: `inline-${digest}` });
    }
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export class JobManager {
  private deleting = new Set<string>();
  private db: DatabaseSync;
  private queue: PendingJob[] = [];
  private active = new Map<string, { job: PendingJob; task: Promise<void> }>();
  private closing = false;
  private store: OntologyStore;
  private config: CodexConfig;
  private runner: CodexRunner;
  private uploads?: UploadReader;
  private pipeline?: AnalysisPipeline;
  private ontologyPlanning: boolean;
  private planJevRules: boolean;
  private ontologyDesignCache: SqliteOntologyDesignCache;
  private executionGenerations = new Map<string, symbol>();

  private resolveUrls: typeof resolveUrlEvidence;
  private completedListener?: (job: GenerationJob) => void;
  private inputsReadyListener?: (job: GenerationJob, documents: EvidenceDocument[]) => void;
  private stoppedListener?: (job: GenerationJob) => void;

  onCompleted(listener: (job: GenerationJob) => void) { this.completedListener = listener; }
  onInputsReady(listener: (job: GenerationJob, documents: EvidenceDocument[]) => void) { this.inputsReadyListener = listener; }
  onStopped(listener: (job: GenerationJob) => void) { this.stoppedListener = listener; }
  private notifyInputsReady(job: PendingJob) {
    if (!this.inputsReadyListener) return;
    const documents = job.input.documents.filter(source => source.text.trim()).slice(0, 10).map(source => ({ ...source, text: source.text.slice(0, 10000) }));
    for (const id of job.input.uploadIds ?? []) {
      if (documents.length >= 10) break;
      const chunk = this.uploads?.getChunk(id, 0);
      if (chunk?.text.trim()) documents.push({ ...chunk, text: chunk.text.slice(0, 10000) });
    }
    if (documents.length) {
      try { this.inputsReadyListener(this.get(job.id)!, documents); }
      catch { /* Background graph preparation must not stop main analysis. */ }
    }
  }

  constructor(store: OntologyStore, config: CodexConfig, runner: CodexRunner = runCodex, uploads?: UploadReader, analysis?: AnalysisOptions, resolveUrls: typeof resolveUrlEvidence = resolveUrlEvidence) {
    this.store = store; this.db = store.db; this.config = config; this.runner = runner; this.uploads = uploads;
    this.resolveUrls = resolveUrls;
    this.ontologyPlanning = analysis?.ontologyPlanning === true;
    this.planJevRules = Boolean(analysis?.jev?.apiKey);
    this.ontologyDesignCache = new SqliteOntologyDesignCache(this.db);
    if (analysis) this.pipeline = new AnalysisPipeline(this.db, config, runner, uploads, analysis);
    this.db.exec('CREATE TABLE IF NOT EXISTS generation_jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL, input_json TEXT)');
    const columns = this.db.prepare('PRAGMA table_info(generation_jobs)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'input_json')) this.db.exec('ALTER TABLE generation_jobs ADD COLUMN input_json TEXT');
    if (this.pipeline) this.migrateHybridGraphMembership();
    const interrupted = this.db.prepare("SELECT id FROM generation_jobs WHERE json_extract(payload,'$.status') IN ('queued','running')").all() as { id: string }[];
    for (const { id } of interrupted) {
      const job = this.readJob(id)!;
      if (job.totalChunks > 0 && job.completedChunks === job.totalChunks) {
        const emptyReport = this.hasCompletedEmptyRecords(job);
        this.update(id, emptyReport
          ? { status: 'completed', error: undefined, errorCode: undefined, message: this.emptyResultMessage(job.totalChunks) }
          : job.graphCount || job.metrics?.scopeSkippedParts === job.totalChunks
          ? { status: 'completed', error: undefined, message: `전체 ${job.totalChunks}부분의 저장된 완료 기록을 복구했습니다. 그래프 ${job.graphCount}개가 보관되어 있습니다.` }
          : { status: 'failed', error: `전체 ${job.totalChunks}부분에서 질문과 관련된 근거를 찾지 못했습니다.`, message: '전체 자료를 확인했지만 생성할 그래프가 없습니다.' });
        continue;
      }
      this.update(id, { status: 'failed', error: '서버가 재시작되어 작업이 중단되었습니다. 저장된 결과를 유지하며 남은 부분부터 다시 시작할 수 있습니다.', message: `서버 재시작으로 중단됨 · ${job.completedChunks}/${job.totalChunks}부분 처리 · 그래프 ${job.graphCount}개 보관` });
    }
  }

  private emptyResultMessage(total: number): string {
    return `전체 ${total}부분을 분석했습니다. 제공된 자료만으로 질문에 답할 근거가 충분하지 않습니다. 판단 이유와 원문을 분석 기록에 보존했습니다.`;
  }

  /** A valid empty answer is usable only when its explanation and originals were saved. */
  private hasCompletedEmptyRecords(job: GenerationJob): boolean {
    if (!this.pipeline || job.processingMode !== 'hybrid' || job.graphCount || !job.totalChunks
      || job.completedChunks !== job.totalChunks || job.emptyChunks !== job.totalChunks || job.metrics?.reviewParts) return false;
    const row = this.db.prepare(`SELECT count(*) AS count FROM analysis_parts p
      JOIN analysis_record_archive a ON a.job_id=p.job_id AND a.part_index=p.part_index
      WHERE p.job_id=? AND p.part_index BETWEEN 1 AND ? AND p.payload IS NULL AND p.graph_id IS NULL AND p.reviewed=0
        AND json_type(a.record_json,'$.extraction')='object'
        AND json_array_length(a.record_json,'$.extraction.entities')=0`).get(job.id, job.totalChunks);
    return Number(row?.count) === job.totalChunks;
  }

  /** One-time migration for hybrid snapshots written before graph membership was normalized. */
  private migrateHybridGraphMembership() {
    const rows = this.db.prepare("SELECT id,payload FROM generation_jobs WHERE json_extract(payload,'$.processingMode')='hybrid' AND json_type(payload,'$.graphIds')='array'").all() as { id: string; payload: string }[];
    for (const row of rows) {
      const job = JSON.parse(row.payload) as GenerationJob;
      const parts = this.db.prepare('SELECT part_index,graph_id FROM analysis_parts WHERE job_id=? AND part_index<=? ORDER BY part_index').all(row.id, job.completedChunks) as { part_index: number; graph_id: string | null }[];
      const existing = new Set(parts.map(part => part.graph_id).filter(Boolean));
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const graphId of job.graphIds) {
          if (existing.has(graphId)) continue;
          const title = this.store.getGraph(graphId)?.title ?? '';
          const number = Number(title.match(/ · part (\d+)\/\d+$/u)?.[1]);
          const part = parts.find(part => part.part_index === number && !part.graph_id) ?? parts.find(part => !part.graph_id);
          if (!part) throw new Error('기존 분석 결과의 부분 기록을 찾지 못했습니다.');
          this.db.prepare('UPDATE analysis_parts SET graph_id=? WHERE job_id=? AND part_index=?').run(graphId, row.id, part.part_index);
          part.graph_id = graphId; existing.add(graphId);
        }
        this.db.prepare('UPDATE generation_jobs SET payload=? WHERE id=?').run(JSON.stringify({ ...job, graphCount: job.graphIds.length, graphIds: undefined }), row.id);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
  }

  private publicJob(row: JobRow, materializeGraphs = true): GenerationJob {
    const raw = JSON.parse(row.payload) as Partial<GenerationJob> & Pick<GenerationJob, 'id' | 'status' | 'stage' | 'message' | 'question' | 'createdAt' | 'updatedAt'>;
    const normalized = raw.processingMode === 'hybrid' && raw.graphCount !== undefined;
    const graphIds = normalized
      ? materializeGraphs ? (this.db.prepare('SELECT graph_id FROM analysis_parts WHERE job_id=? AND graph_id IS NOT NULL ORDER BY part_index').all(raw.id) as { graph_id: string }[]).map(row => row.graph_id) : []
      : raw.graphIds ?? (raw.graphId ? [raw.graphId] : []);
    const graphCount = normalized ? raw.graphCount! : graphIds.length;
    const completedChunks = raw.completedChunks ?? (raw.status === 'completed' ? 1 : 0);
    const totalChunks = raw.totalChunks ?? (raw.status === 'completed' ? 1 : 0);
    const pendingPlan = raw.processingMode === 'hybrid' && this.pipeline && !this.db.prepare('SELECT ready FROM analysis_plans WHERE job_id=?').get(raw.id)?.ready;
    const input = row.input_json ? JSON.parse(row.input_json) as StoredInput : undefined;
    const pendingUrls = input?.urlEvidenceResolved === false;
    const canStart = !!input && (totalChunks > completedChunks || (totalChunks === 0 && (pendingPlan || !input.evidenceResolved || pendingUrls)));
    return { ...raw, graphIds, graphCount, completedChunks, totalChunks, emptyChunks: raw.emptyChunks ?? 0, resumable: ['failed', 'cancelled'].includes(raw.status) && canStart };
  }
  /** Internal status changes never fetch the growing graph membership collection. */
  private readJob(id: string): GenerationJob | null {
    const row = this.db.prepare('SELECT payload,input_json FROM generation_jobs WHERE id=?').get(id) as unknown as JobRow | undefined;
    return row ? this.publicJob(row, false) : null;
  }
  get(id: string): GenerationJob | null {
    const row = this.db.prepare('SELECT payload,input_json FROM generation_jobs WHERE id = ?').get(id) as unknown as JobRow | undefined;
    return row ? this.publicJob(row) : null;
  }
  decisions(id: string) {
    const definition = this.store.getDefinitionForJob(id);
    const labels: Record<string, { displayName: string; selections: Record<string, string> }> = {
      stance: { displayName: '진술 유형', selections: { direct_assertion: '직접 진술', attributed_claim: '인용·전언 주장', denial_or_correction: '부인·정정', mixed_or_uncertain: '혼합·불확실' } },
      complexity: { displayName: '문맥 복잡도', selections: { self_contained: '독립적으로 해석 가능', context_required: '추가 문맥 필요', multiple_claims: '여러 주장 포함', uncertain: '불확실' } },
      candidateLinkType: { displayName: '관계 후보', selections: { ...Object.fromEntries((definition?.linkTypes ?? []).map(link => [link.apiName, link.displayName])), none: '단일 관계 후보 없음', multiple_or_uncertain: '복수 후보·불확실' } },
    };
    return (this.pipeline?.listDecisions(id) ?? []).map(audit => ({ ...audit, result: { ...audit.result, decisions: audit.result.decisions.map(decision => {
      const rule = definition?.processing.decisionRules?.find(rule => `rule_${rule.apiName}` === decision.id && rule.sourceName === audit.sourceName);
      return { ...decision, displayName: rule?.displayName ?? labels[decision.id]?.displayName,
        selectionLabel: rule?.choices.find(choice => choice.apiName === decision.selection)?.description ?? labels[decision.id]?.selections?.[decision.selection] };
    }) } }));
  }
  list(limit = 30): GenerationJob[] {
    return (this.db.prepare('SELECT payload,input_json FROM generation_jobs ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as unknown as JobRow[]).map(row => this.publicJob(row));
  }
  private checkCapacity() {
    if (this.closing) throw new Error('서버를 종료하고 있습니다.');
    if (this.queue.length + this.active.size >= 5) throw new Error('대기 중인 작업이 많습니다. 기존 작업이 끝난 뒤 다시 요청해주세요.');
  }
  create(input: GraphGenerationInput): GenerationJob {
    this.checkCapacity();
    const now = new Date().toISOString();
    const snapshot: StoredInput = structuredClone(input);
    const job: GenerationJob = { id: `job-${randomUUID()}`, status: 'queued', stage: 'preparing', message: '자료 분석을 기다리고 있습니다.', question: input.question, ...(snapshot.analysisBrief ? { analysisBrief: structuredClone(snapshot.analysisBrief) } : {}), createdAt: now, updatedAt: now, completedChunks: 0, totalChunks: 0, emptyChunks: 0, graphIds: [], resumable: false };
    if (this.pipeline) { job.processingMode = 'hybrid'; job.metrics = emptyMetrics(); job.graphCount = 0; job.ontologyPlanning = this.ontologyPlanning; }
    const persisted = { ...job, ...(job.processingMode === 'hybrid' ? { graphIds: undefined } : {}) };
    this.db.prepare('INSERT INTO generation_jobs (id,payload,created_at,input_json) VALUES (?,?,?,?)').run(job.id, JSON.stringify(persisted), now, JSON.stringify(snapshot));
    this.queue.push({ id: job.id, input: snapshot, controller: new AbortController() });
    queueMicrotask(() => this.pump());
    return job;
  }
  resume(id: string): GenerationJob {
    if (this.deleting.has(id)) throw new Error('삭제 중인 케이스는 재개할 수 없습니다.');
    const job = this.readJob(id);
    if (!job) throw new Error('작업을 찾을 수 없습니다.');
    if (!job.resumable || this.queue.some(item => item.id === id)) throw new Error('남은 자료가 있는 실패·취소 작업만 이어서 분석할 수 있습니다.');
    this.checkCapacity();
    const row = this.db.prepare('SELECT input_json FROM generation_jobs WHERE id=?').get(id) as { input_json: string };
    const input = JSON.parse(row.input_json) as StoredInput;
    const identityFailure = Boolean(job.error?.includes('Primary Key 값이 인용된 원문에 없습니다'));
    const timeoutFailure = job.errorCode === 'CODEX_TIMEOUT' || Boolean(job.error?.includes('Codex 응답 시간이 초과'));
    const structuredSources = input.documents.some(document => isStructuredName(document.name)) || (input.uploadIds ?? []).some(id => {
      const upload = this.uploads?.get(id); return upload && isStructuredName(upload.name);
    });
    const repairMappings = timeoutFailure && structuredSources && !input.timeoutMappingRepaired;
    if (job.ontologyPlanning && job.completedChunks === 0 && !job.graphCount && (identityFailure || repairMappings)) {
      const definition = this.store.getDefinitionForJob(id);
      if (definition) {
        input.ontologyRepair = { fromVersion: definition.version, reason: job.error ?? 'CODEX_TIMEOUT', kind: repairMappings ? 'mapping' : 'identity' };
        this.db.prepare('UPDATE generation_jobs SET input_json=? WHERE id=?').run(JSON.stringify(input), id);
      }
    }
    this.queue.push({ id, input, controller: new AbortController() });
    this.update(id, { status: 'queued', stage: input.ontologyRepair ? 'designing' : 'preparing', error: undefined, errorCode: undefined, message: input.ontologyRepair ? '자료는 보존하고 식별 키·표 변환 규칙을 보완한 뒤 분석을 재개합니다.' : `${job.completedChunks}/${job.totalChunks}부분 완료 · 남은 부분의 분석을 기다리고 있습니다.` });
    queueMicrotask(() => this.pump());
    return this.get(id)!;
  }
  cancel(id: string): GenerationJob | null {
    const job = this.readJob(id);
    if (!job || !['queued', 'running'].includes(job.status)) return this.get(id);
    this.active.get(id)?.job.controller.abort();
    for (const pending of this.queue) if (pending.id === id) pending.controller.abort();
    this.queue = this.queue.filter(item => item.id !== id);
    this.update(id, { status: 'cancelled', message: `생성을 취소했습니다. ${job.completedChunks}/${job.totalChunks}부분 처리 · 그래프 ${job.graphCount}개를 보관했습니다. 남은 부분은 분석하지 않았습니다.` });
    return this.get(id);
  }
  async remove(id: string): Promise<string[]> {
    if (this.deleting.has(id)) throw new Error('이미 삭제 중인 케이스입니다.');
    this.deleting.add(id);
    try {
      const running = this.active.get(id)?.task;
      this.cancel(id);
      if (running) await running;
      const ids = deleteStoredCase(this.db, id);
      this.executionGenerations.delete(id);
      return ids;
    } finally { this.deleting.delete(id); }
  }
  private update(id: string, changes: Partial<GenerationJob>): GenerationJob {
    const previous = this.readJob(id);
    if (!previous) throw new Error('작업을 찾을 수 없습니다.');
    const next = { ...previous, ...changes, updatedAt: new Date().toISOString() };
    if (changes.status === 'running' && !next.startedAt) next.startedAt = new Date().toISOString();
    if (next.startedAt) next.elapsedMs = Math.max(0, Date.now() - Date.parse(next.startedAt));
    const persisted = { ...next, ...(next.processingMode === 'hybrid' && next.graphCount !== undefined ? { graphIds: undefined } : {}) };
    this.db.prepare('UPDATE generation_jobs SET payload = ? WHERE id = ?').run(JSON.stringify(persisted), id);
    if (previous.status !== 'completed' && next.status === 'completed' && this.completedListener) {
      // Preparation is queued after the durable completion commit. Its failure
      // must never turn an already saved analysis into a failed analysis.
      try { this.completedListener(this.get(id)!); } catch { /* reconciled on startup */ }
    }
    if (previous.status !== next.status && (next.status === 'failed' || next.status === 'cancelled')) {
      try { this.stoppedListener?.(this.get(id)!); } catch { /* preparation must not invalidate saved analysis */ }
    }
    return this.readJob(id)!;
  }
  private pump() {
    if (this.closing) return;
    while (this.queue.length && this.active.size < (this.config.jobConcurrency ?? 1)) {
      const index = this.queue.findIndex(job => !this.active.has(job.id));
      if (index < 0) break;
      const next = this.queue.splice(index, 1)[0];
      if (next.controller.signal.aborted) continue;
      const task = this.execute(next).finally(() => { if (this.active.get(next.id)?.job === next) this.active.delete(next.id); this.pump(); });
      this.active.set(next.id, { job: next, task });
    }
  }
  private async prepareUrlEvidence(job: PendingJob, signal: AbortSignal) {
    const checkpoint = this.readJob(job.id)!;
    // Resuming an existing extraction must use the same evidence and frozen plan.
    if (job.input.urlEvidenceResolved || checkpoint.totalChunks || this.store.getDefinitionForJob(job.id)) return;
    job.input.urlEvidenceResolved = false;
    this.db.prepare('UPDATE generation_jobs SET input_json=? WHERE id=?').run(JSON.stringify(job.input), job.id);
    const resolved = await this.resolveUrls(job.input.documents, {
      signal,
      progress: message => { if (!signal.aborted) this.update(job.id, { stage: 'preparing', message }); },
    });
    signal.throwIfAborted();
    if (resolved.results.length) {
      job.input.originalDocuments ??= structuredClone(job.input.documents);
      this.update(job.id, { urlReads: resolved.results });
      if (!resolved.documents.some(document => document.text.trim()) && !job.input.uploadIds?.length) {
        // Keep the original URLs retryable; failed reads must not become a saved empty input.
        this.db.prepare('UPDATE generation_jobs SET input_json=? WHERE id=?').run(JSON.stringify(job.input), job.id);
        const reasons = resolved.results.filter(read => read.status === 'failed').slice(0, 3)
          .map(read => `${read.url}: ${read.reason ?? '본문을 읽지 못했습니다.'}`).join('\n');
        throw new Error(`URL ${resolved.results.length}개의 본문을 읽지 못해 분석을 시작하지 않았습니다. 링크를 다시 확인하거나 기사 본문을 붙여넣어주세요.\n${reasons}`);
      }
      job.input.documents = resolved.documents;
    }
    job.input.urlEvidenceResolved = true;
    this.db.prepare('UPDATE generation_jobs SET input_json=? WHERE id=?').run(JSON.stringify(job.input), job.id);
  }

  private urlReadLimitations(id: string): string[] {
    return (this.readJob(id)?.urlReads ?? []).flatMap(read => read.status === 'failed'
      ? [`URL 본문을 읽지 못해 이 자료의 주장은 검증하지 않았습니다: ${read.url.slice(0, 350)} (${read.reason?.slice(0, 180) ?? '읽기 실패'}).`]
      : read.truncated ? [`URL 본문이 길어 읽기 한도까지 분석했습니다. 뒷부분은 검토하지 않았습니다: ${read.url.slice(0, 350)}.`] : []);
  }

  private async execute(job: PendingJob) {
    if (this.pipeline && this.readJob(job.id)?.processingMode === 'hybrid') return this.executeHybrid(job);
    const signal = job.controller.signal;
    const advance = (stage: GenerationJob['stage'], message: string, changes: Partial<GenerationJob> = {}) => {
      signal.throwIfAborted();
      this.update(job.id, { status: 'running', stage, message, ...changes });
    };
    try {
      advance('preparing', '첨부 자료와 저장된 지식에서 전체 분석 순서를 준비하고 있습니다.');
      if (!job.input.evidenceResolved) {
        if (!job.input.documents.length && !job.input.uploadIds?.length) job.input.documents = this.store.searchContext(job.input.question).documents;
        job.input.evidenceResolved = true;
        this.db.prepare('UPDATE generation_jobs SET input_json=? WHERE id=?').run(JSON.stringify(job.input), job.id);
      }
      await this.prepareUrlEvidence(job, signal);
      this.notifyInputsReady(job);
      const batches = inlineBatches(job.input.documents);
      const uploaded = (job.input.uploadIds ?? []).map(id => {
        const metadata = this.uploads?.get(id);
        if (!metadata) throw new Error('업로드한 자료를 찾을 수 없습니다. 파일을 다시 첨부해 주세요.');
        return metadata;
      });
      const totalChunks = batches.length + uploaded.reduce((sum, upload) => sum + upload.chunkCount, 0);
      if (!totalChunks) throw new Error('질문에 사용할 저장된 자료가 없습니다. TXT·MD·CSV·JSON 자료를 첨부해주세요.');
      const checkpoint = this.get(job.id)!;
      if (checkpoint.totalChunks && checkpoint.totalChunks !== totalChunks) throw new Error('저장된 자료의 분석 순서가 변경되어 이어서 분석할 수 없습니다.');
      this.update(job.id, { totalChunks });
      const sourceFor = (upload: UploadedEvidence, index: number): EvidenceDocument[] => {
        const chunk = this.uploads?.getChunk(upload.id, index);
        if (!chunk) throw new Error(`자료의 ${index + 1}번째 부분을 읽지 못했습니다. 이전 결과를 유지합니다.`);
        return [chunk];
      };
      // Keep uploaded content lazy: only the currently executing chunk is loaded from SQLite.
      const parts = function* () {
        let number = 0;
        for (const batch of batches) { number++; if (number > checkpoint.completedChunks) yield { number, documents: batch }; }
        for (const upload of uploaded) for (let index = 0; index < upload.chunkCount; index++) {
          number++;
          if (number > checkpoint.completedChunks) yield { number, documents: sourceFor(upload, index) };
        }
      };
      for (const part of parts()) {
        // Blank chunks also yield, so a very large whitespace-only file stays cancellable.
        await yieldToEventLoop();
        signal.throwIfAborted();
        const { number, documents } = part;
        const currentSource = documents.map(document => document.name).join(', ').slice(0, 1000);
        const prefix = totalChunks > 1 ? `${number}/${totalChunks}부분 · ` : '';
        advance('preparing', `${prefix}자료를 준비하고 있습니다.`, { currentSource });
        const usable = documents.filter(document => document.text.trim());
        if (!usable.length) {
          const previous = this.get(job.id)!;
          this.update(job.id, { completedChunks: number, emptyChunks: previous.emptyChunks + 1, message: `${prefix}공백만 있는 부분을 확인했습니다. 다음 부분으로 진행합니다.` });
          continue;
        }
        const input: GraphGenerationInput = { question: job.input.question, documents: usable, ...(job.input.analysisBrief ? { analysisBrief: job.input.analysisBrief } : {}) };
        const context = this.store.searchContext(job.input.question);
        const ontologyContext = JSON.stringify({
          knownEntities: context.entities?.slice(0, 30) ?? [],
          rule: 'Existing names are identity hints only. Every output claim must be grounded in supplied documents.',
          relationRules: 'visited and located_in target a place; participated_in targets an event; encountered connects two vessels; reported_by targets a person, organization, or document. Only use a relationship when the supplied evidence supports its meaning.',
          coverage: totalChunks > 1 ? `This is part ${number} of ${totalChunks}. Analyze this entire supplied part for the question. Other parts are analyzed separately; do not claim to have reviewed the full original file.` : 'Analyze all supplied evidence for the question.',
        });
        let validationFeedback = '';
        for (let attempt = 0; attempt < 2; attempt++) {
          advance('extracting', `${prefix}${attempt ? '검증에서 발견한 항목을 원문과 다시 대조하고 있습니다.' : '객체·관계와 원문 근거를 추출하고 있습니다.'}`);
          const raw = await this.runner({ ...input, schema: extractionSchema, context: `${ontologyContext}\n${analysisBriefContext(job.input.analysisBrief)}\n${validationFeedback}` }, this.config, { signal });
          const candidate = normalizeClaimMetadata(raw, input).value;
          advance('validating', `${prefix}출처 문장, 객체 유형, 연결 대상과 날짜를 검사하고 있습니다.`);
          let extraction;
          let graph;
          try {
            extraction = parseExtraction(candidate, input);
            extraction.limitations = [...new Set([...extraction.limitations, ...this.urlReadLimitations(job.id)])].slice(0, 20);
            graph = compileExtraction(extraction, input);
          } catch (error) {
            if (error instanceof InsufficientEvidenceError) {
              const previous = this.get(job.id)!;
              this.update(job.id, { completedChunks: number, emptyChunks: previous.emptyChunks + 1, message: `${prefix}질문에 사용할 근거가 없는 부분입니다. 다음 부분으로 진행합니다.` });
              break;
            }
            if (attempt) {
              extraction = error instanceof GraphValidationError ? recoverExtraction(candidate, input) : undefined;
              if (!extraction) throw new Error(`자료의 근거와 그래프 규칙을 확인하지 못했습니다. ${error instanceof Error ? error.message.slice(0, 400) : ''}`);
              extraction.limitations = [...new Set([...extraction.limitations, ...this.urlReadLimitations(job.id)])].slice(0, 20);
              graph = compileExtraction(extraction, input);
            } else {
              validationFeedback = `Your previous extraction failed validation: ${error instanceof Error ? error.message.slice(0, 1000) : 'invalid graph'}. Return a corrected extraction grounded in exact supplied text.`;
              continue;
            }
          }
          if (totalChunks > 1) {
            const suffix = ` · part ${number}/${totalChunks}`;
            graph.title = `${graph.title.slice(0, 200 - suffix.length)}${suffix}`;
            graph.limitations = [...graph.limitations.slice(0, 19), `전체 ${totalChunks}구간 중 ${number}번째 구간의 분석입니다. 파일을 구간별로 분석하므로 서로 멀리 떨어진 내용 사이의 관계는 누락될 수 있습니다.`];
          }
          advance('saving', `${prefix}검증된 그래프와 근거를 온톨로지에 저장하고 있습니다.`);
          signal.throwIfAborted();
          this.store.saveGraph(graph, usable, extraction, stored => {
            const previous = this.get(job.id)!;
            this.update(job.id, { completedChunks: number, graphIds: [...previous.graphIds, stored.id], graphId: previous.graphId ?? stored.id, message: `${prefix}그래프를 저장했습니다.` });
          });
          break;
        }
      }
      signal.throwIfAborted();
      const finished = this.get(job.id)!;
      if (!finished.graphIds.length) throw new Error(`전체 ${finished.totalChunks}부분에서 질문과 관련된 객체·관계를 뒷받침할 근거를 찾지 못했습니다.`);
      this.update(job.id, { status: 'completed', error: undefined, message: `전체 ${totalChunks}부분을 분석했습니다. 그래프 ${finished.graphIds.length}개를 저장했고 근거가 없는 부분은 ${finished.emptyChunks}개입니다.` });
    } catch (error) {
      // A cancelled invocation may finish after the user has queued its continuation.
      if (signal.aborted && this.queue.some(pending => pending.id === job.id)) return;
      const partial = this.get(job.id)!;
      const progress = `${partial.completedChunks}/${partial.totalChunks}부분 처리 · 그래프 ${partial.graphIds.length}개 보관`;
      if (signal.aborted) this.update(job.id, { status: 'cancelled', message: `생성을 취소했습니다. ${progress}. 남은 부분은 분석하지 않았습니다.` });
      else this.update(job.id, { status: 'failed', error: error instanceof Error ? error.message.slice(0, 800) : '그래프 생성에 실패했습니다.', errorCode: error instanceof CodexError ? error.code : undefined, message: `${progress}. ${partial.completedChunks < partial.totalChunks ? '남은 부분을 완료하지 못했습니다. 이어서 분석할 수 있습니다.' : '그래프를 생성하지 못했습니다.'}` });
    }
  }
  private async executeHybrid(job: PendingJob) {
    const pipeline = this.pipeline!;
    const generation = Symbol(job.id);
    this.executionGenerations.set(job.id, generation);
    const stopped = new AbortController();
    const signal = AbortSignal.any([job.controller.signal, stopped.signal]);
    let wave = new AbortController();
    type Settled = { ok: true; part: AnalysisPart; result: AnalysisResult } | { ok: false; error: unknown };
    const pending = new Map<number, Promise<Settled>>();
    const prefetching = new Set<Promise<void>>();
    const warmed = new Map<string, { outcome: Promise<Settled>; reviewState: { needed: boolean } }>();
    let prefetched = 0;
    const metrics = (delta: Partial<AnalysisMetrics>) => {
      // A response may report billed usage while cancellation is draining pending work.
      // Persist those numbers without changing queued/cancelled state; stale generations cannot write.
      if (this.executionGenerations.get(job.id) !== generation) return;
      const current = { ...emptyMetrics(), ...this.readJob(job.id)!.metrics };
      for (const key of Object.keys(delta) as (keyof AnalysisMetrics)[]) current[key] += delta[key] ?? 0;
      this.update(job.id, { metrics: current });
    };
    try {
      this.update(job.id, { status: 'running', stage: 'preparing', error: undefined, errorCode: undefined, message: '표 데이터와 문서를 구분하고 전체 자료의 분석 단위를 준비합니다.' });
      if (!job.input.evidenceResolved) {
        if (!this.readJob(job.id)!.ontologyPlanning && !job.input.documents.length && !job.input.uploadIds?.length) job.input.documents = this.store.searchContext(job.input.question).documents;
        job.input.evidenceResolved = true;
        this.db.prepare('UPDATE generation_jobs SET input_json=? WHERE id=?').run(JSON.stringify(job.input), job.id);
      }
      await this.prepareUrlEvidence(job, signal);
      this.notifyInputsReady(job);
      let definition = this.store.getDefinitionForJob(job.id);
      if (this.readJob(job.id)!.ontologyPlanning) {
        this.update(job.id, { stage: 'designing', message: 'AI가 자료와 질문에 맞는 객체 유형·속성·관계·변환 규칙을 설계합니다.' });
        if (definition && job.input.ontologyRepair) {
          const repair = job.input.ontologyRepair;
          if (definition.version !== repair.fromVersion) throw new Error('수정 대상 온톨로지 버전이 변경되었습니다. 새 분석을 시작해주세요.');
          if (this.readJob(job.id)!.completedChunks || this.readJob(job.id)!.graphCount) throw new Error('이미 저장한 결과의 온톨로지는 다시 설계하지 않습니다.');
          const revised = await designOntology(job.input, this.uploads, this.runner, this.config, {
            id: definition.id, version: definition.version + 1, repairReason: repair.reason, signal, metrics, planJevRules: this.planJevRules, cache: this.ontologyDesignCache,
            usage: () => metrics({ codexCalls: 1 }), progress: message => { if (!signal.aborted) this.update(job.id, { message: `변환 규칙 보완 · ${message}` }); },
          });
          signal.throwIfAborted();
          this.store.replaceUnusedDefinition(revised, job.id, () => {
            pipeline.resetUnstartedPlan(job.id);
            if (repair.kind === 'mapping') job.input.timeoutMappingRepaired = true;
            delete job.input.ontologyRepair;
            this.db.prepare('UPDATE generation_jobs SET input_json=? WHERE id=?').run(JSON.stringify(job.input), job.id);
            this.update(job.id, { totalChunks: 0, emptyChunks: 0, ontologyVersion: revised.version });
          });
          definition = revised;
        }
        if (!definition && job.input.analysisBrief?.ontologyTemplateId) {
          const template = this.store.getDefinition(job.input.analysisBrief.ontologyTemplateId);
          if (!template) throw new Error('재사용할 온톨로지가 없습니다. 새 설계를 선택해주세요.');
          const sourceNames = new Set([...job.input.documents.map(document => document.name), ...(job.input.uploadIds ?? []).map(id => this.uploads?.get(id)?.name)]);
          if (template.sourceMappings.some(mapping => !sourceNames.has(mapping.sourceName))) throw new Error('재사용할 온톨로지의 자료 이름이 현재 자료와 다릅니다. 새 설계를 선택해주세요.');
          definition = structuredClone({ ...template, id: `ontology-${job.id}` });
          this.store.saveDefinition(definition, job.id);
          this.update(job.id, { message: '선택한 온톨로지와 변환 규칙을 재사용합니다.' });
        }
        if (!definition) {
          definition = await designOntology(job.input, this.uploads, this.runner, this.config, {
            id: `ontology-${job.id}`, signal, metrics, planJevRules: this.planJevRules, cache: this.ontologyDesignCache, usage: () => metrics({ codexCalls: 1 }),
            progress: message => { if (!signal.aborted) this.update(job.id, { message }); },
          });
          signal.throwIfAborted();
          this.store.saveDefinition(definition, job.id);
        }
        this.update(job.id, { ontologyId: definition.id, ontologyVersion: definition.version, ontologyName: definition.displayName });
        if (!job.input.documents.length && !job.input.uploadIds?.length) {
          this.update(job.id, { status: 'completed', stage: 'saving', schemaOnly: true, error: undefined, message: '온톨로지 구조를 저장했습니다. 자료가 없으므로 실제 객체·관계는 생성하지 않았습니다.' });
          return;
        }
      }
      const preparationStarted = performance.now();
      this.update(job.id, { stage: 'preparing', message: '설계된 온톨로지로 전체 자료의 변환·추출 순서를 준비합니다.' });
      let total = await pipeline.prepare(job.id, job.input, signal, count => {
        if (!signal.aborted) this.update(job.id, { message: `전체 자료를 읽으며 ${count}개 분석 단위를 준비했습니다. 표의 모든 행을 보존합니다.` });
      }, definition, { usage: metrics, prepared: async part => {
        // Warm only the first window. Warming the entire plan would postpone every saved result.
        // Even one worker can extract the first source while later uploads are prepared.
        if (part.extraction || prefetched >= (this.config.concurrency ?? 1)) return;
        const key = JSON.stringify(part);
        if (warmed.has(key)) return;
        prefetched++;
        signal.throwIfAborted();
        const warmSignal = AbortSignal.any([signal, wave.signal]);
        const reviewState = { needed: false };
        const outcome = pipeline.process(part, job.input.question, warmSignal, metrics, () => { reviewState.needed = true; }, definition, job.input.analysisBrief, job.id)
          .then(result => ({ ok: true as const, part, result }), error => ({ ok: false as const, error }));
        warmed.set(key, { outcome, reviewState });
        // Hand the validated result directly to the saving worker. Running process again
        // would repeat source rebinding and count a warm cache hit twice.
        const task = outcome.then(() => undefined).finally(() => prefetching.delete(task));
        prefetching.add(task);
      }, routing: message => {
        if (!signal.aborted) this.update(job.id, { jevRouting: { message }, message });
      } });
      metrics({ preparationMs: performance.now() - preparationStarted });
      signal.throwIfAborted();
      if (!total) throw new Error('분석할 자료가 없습니다. 내용이 있는 파일을 첨부해주세요.');
      const checkpoint = this.readJob(job.id)!;
      if (checkpoint.totalChunks && checkpoint.totalChunks !== total) throw new Error('저장된 분석 순서가 변경되었습니다. 기존 결과를 보존합니다.');
      this.update(job.id, { totalChunks: total, stage: 'extracting', message: `전체 ${total}부분의 분석을 시작합니다.` });
      let next = checkpoint.completedChunks + 1;
      let launch = next;
      const fill = () => {
        while (launch <= total && pending.size < pipeline.concurrency && !signal.aborted) {
          const number = launch++;
          const part = pipeline.getPart(job.id, number);
          const partSignal = AbortSignal.any([signal, wave.signal]);
          const review = () => {
            if (!partSignal.aborted && pipeline.markReview(job.id, number)) metrics({ reviewParts: 1 });
          };
          const key = !part.extraction && warmed.size ? JSON.stringify(part) : undefined;
          const warm = key ? warmed.get(key) : undefined;
          if (key) warmed.delete(key);
          const promise = warm
            ? warm.outcome.then(outcome => { if (warm.reviewState.needed) review(); return outcome; })
            : pipeline.process(part, job.input.question, partSignal, metrics, review, definition, job.input.analysisBrief, job.id)
              .then(result => ({ ok: true as const, part, result }), error => ({ ok: false as const, error }));
          pending.set(number, promise);
        }
      };
      fill();
      while (next <= total) {
        signal.throwIfAborted();
        this.update(job.id, { stage: 'extracting', currentSource: pipeline.getPart(job.id, next).documents.map(document => document.name).join(', ').slice(0, 1000), message: `${this.readJob(job.id)!.completedChunks}/${total}부분 처리 · 최대 ${pipeline.concurrency}부분을 함께 분석합니다.` });
        const item = await pending.get(next)!;
        signal.throwIfAborted();
        if (!item.ok) {
          if (item.error instanceof CodexError && item.error.code === 'CODEX_TIMEOUT') {
            // Settle every launched part before moving their persisted indexes. Billed usage is retained.
            wave.abort();
            await Promise.allSettled([...pending.values(), ...prefetching]);
            pending.clear();
            warmed.clear();
            signal.throwIfAborted();
            const split = pipeline.splitTimedOutPart(job.id, next, updated => {
              // Commit the public total with the repartitioned plan so restart sees one checkpoint.
              this.update(job.id, { totalChunks: updated.total, message: `응답 시간이 초과된 구간을 ${updated.parts}개로 더 작게 나눠 다시 분석합니다. 저장된 결과와 원문은 보존합니다.` });
            });
            if (split) {
              metrics({ timeoutSplits: 1 });
              total = split.total;
              launch = next;
              wave = new AbortController();
              fill();
              continue;
            }
          }
          throw item.error;
        }
        const { part, result } = item;
        result.extraction.limitations = [...new Set([...result.extraction.limitations, ...this.urlReadLimitations(job.id)])].slice(0, 20);
        const prefix = `${next}/${total}부분`;
        this.update(job.id, { stage: 'validating', currentSource: part.documents.map(doc => doc.name).join(', ').slice(0, 1000), message: `${prefix} · 출처와 그래프 구조를 검증합니다.` });
        const complete = (graphId?: string) => {
          const previous = this.readJob(job.id)!;
          const nextMetrics = { ...emptyMetrics(), ...previous.metrics };
          const excluded = part.extraction?.limitations.some(note => note.startsWith('[범위 제외]'));
          if (excluded) nextMetrics.scopeSkippedParts++;
          else if (part.extraction) { nextMetrics.deterministicParts++; nextMetrics.structuredRecords += part.records; }
          this.update(job.id, { completedChunks: next, metrics: nextMetrics,
            emptyChunks: previous.emptyChunks + (graphId ? 0 : 1),
            ...(graphId ? { graphCount: (previous.graphCount ?? 0) + 1, graphId: previous.graphId ?? graphId, firstGraphMs: previous.firstGraphMs ?? Math.max(0, Date.now() - Date.parse(previous.startedAt ?? previous.createdAt)) } : {}),
            message: `${prefix} · ${excluded ? '확정한 범위 밖의 원문을 보존했습니다.' : part.extraction ? `${part.records}행을 직접 변환했습니다.` : '분석 결과를 저장했습니다.'}`,
          });
          pipeline.releasePart(job.id, next, graphId, result.extraction);
        };
        let graph;
        try { graph = compileExtraction(result.extraction, { question: job.input.question, documents: part.documents }, definition); }
        catch (error) {
          if (!(error instanceof InsufficientEvidenceError)) throw error;
          this.db.exec('BEGIN IMMEDIATE');
          try { complete(); this.db.exec('COMMIT'); } catch (failure) { this.db.exec('ROLLBACK'); throw failure; }
        }
        if (graph) {
          graph.origin = result.origin;
          if (definition) { graph.ontologyId = definition.id; graph.ontologyVersion = definition.version; }
          if (total > 1) {
            const suffix = ` · part ${next}/${total}`;
            graph.title = `${graph.title.slice(0, 200 - suffix.length)}${suffix}`;
            graph.limitations = [...graph.limitations.slice(0, 19), `전체 ${total}부분 중 ${next}번째 결과입니다. 부분 사이의 복잡한 관계는 별도 검토가 필요합니다.`];
          }
          this.update(job.id, { stage: 'saving' });
          signal.throwIfAborted();
          this.store.saveGraph(graph, part.documents, result.extraction, stored => complete(stored.id));
        }
        pending.delete(next++);
        await yieldToEventLoop();
        fill();
      }
      signal.throwIfAborted();
      const finished = this.readJob(job.id)!;
      if (!finished.graphCount && finished.metrics?.scopeSkippedParts === total) {
        this.update(job.id, { status: 'completed', stage: 'saving', error: undefined, message: '확정한 범위에 해당하는 자료가 없습니다. 전체 원문은 분석 기록과 검색에 보존했습니다.' });
        return;
      }
      if (this.hasCompletedEmptyRecords(finished)) {
        this.update(job.id, { status: 'completed', stage: 'saving', error: undefined, errorCode: undefined, message: this.emptyResultMessage(total) });
        return;
      }
      if (!finished.graphCount) throw new Error(`전체 ${total}부분을 처리했으나 그래프로 저장할 근거를 찾지 못했습니다. 검토가 필요한 부분은 ${finished.metrics?.reviewParts ?? 0}개입니다.`);
      this.update(job.id, { status: 'completed', error: undefined,
        message: `전체 ${total}부분 처리 완료 · ${finished.metrics?.structuredRecords ?? 0}행 직접 변환 · 그래프 ${finished.graphCount}개 저장${finished.metrics?.reviewParts ? ` · 추가 검토 대상으로 분류된 부분 ${finished.metrics.reviewParts}개` : ''}` });
    } catch (error) {
      stopped.abort();
      await Promise.allSettled([...pending.values(), ...prefetching]);
      if (job.controller.signal.aborted && this.queue.some(item => item.id === job.id)) return;
      const partial = this.readJob(job.id)!;
      const progress = `${partial.completedChunks}/${partial.totalChunks}부분 처리 · 그래프 ${partial.graphCount}개 보관`;
      if (job.controller.signal.aborted) this.update(job.id, { status: 'cancelled', message: `생성을 취소했습니다. ${progress}. 남은 부분은 이어서 분석할 수 있습니다.` });
      else this.update(job.id, { status: 'failed', error: error instanceof Error ? error.message.slice(0, 800) : '자료 분석에 실패했습니다.', errorCode: error instanceof CodexError ? error.code : undefined, message: `${progress}. 오류를 확인한 뒤 남은 부분부터 이어서 분석할 수 있습니다.` });
    } finally { if (this.executionGenerations.get(job.id) === generation) this.executionGenerations.delete(job.id); }
  }
  async close() {
    this.closing = true;
    for (const item of [...this.queue]) this.cancel(item.id);
    const running = [...this.active.values()];
    for (const item of running) this.cancel(item.job.id);
    await Promise.allSettled(running.map(item => item.task));
  }
}
