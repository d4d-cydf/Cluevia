import { GraphValidationError } from '../src/lib/graph-document.ts';
import { recoverExtraction } from './extraction-recovery.ts';
import { normalizeClaimMetadata } from './claim-metadata.ts';
import { scopeExclusion } from './analysis-scope.ts';
import { WorkPool } from './work-pool.ts';
import { createHash } from 'node:crypto';
import { archiveRecord, createRecordArchive } from './analysis-case.ts';
import type { DatabaseSync } from 'node:sqlite';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { EvidenceDocument, GraphGenerationInput, GraphDocument } from '../src/types/graph.ts';
import type { OntologyExtraction, OntologyDefinition } from '../src/types/ontology.ts';
import type { AnalysisBrief } from '../src/types/clarification.ts';
import { analysisBriefContext } from './ontology-planner.ts';
import type { CodexConfig } from './codex.ts';
import { runCodex, effectiveCodexConfig } from './codex.ts';
import type { EvidenceUploads } from './evidence-uploads.ts';
import { parseExtraction, rebindExtractionSources, extractionSchema, extractionSchemaFor, InsufficientEvidenceError } from './ontology.ts';
import { readJevConfig, runJevExtraction, JEV_EXTRACTION_VERSION } from './jev.ts';
import type { JevConfig } from './jev.ts';
import { genericStructuredBatches } from './generic-ingest.ts';
import { runOntologyJev, ontologyJevEligible, ONTOLOGY_JEV_VERSION } from './ontology-jev.ts';
import { isStructuredName, structuredBatches } from './structured-ingest.ts';
import { assessJevDecisions, jevDecisionsEligible, JEV_DECISIONS_VERSION } from './jev-decisions.ts';
import type { JevDecisionResult, JevDecisionSource } from './jev-decisions.ts';

export interface AnalysisMetrics {
  structuredRecords: number; deterministicParts: number; jevRequests: number; jevInputTokens: number;
  codexCalls: number; cacheHits: number; reviewParts: number;
  scopeSkippedParts: number; codexQueueMs: number; codexRunMs: number; jevRoutingMs: number; preparationMs: number; designMs: number; designTimeoutRetries: number; validationRetries: number; timeoutSplits: number;
  ontologyProfileMs: number; ontologyModelMs: number; ontologyValidationMs: number; ontologyRulesMs: number; ontologyCacheHits: number;
  codexInputTokens: number; codexOutputTokens: number; codexCachedInputTokens: number;
  jevDecisions: number; jevAssistedParts: number; jevFallbackParts: number; codexBatches: number;
}
export const emptyMetrics = (): AnalysisMetrics => ({ scopeSkippedParts: 0, codexQueueMs: 0, codexRunMs: 0, jevRoutingMs: 0, preparationMs: 0, designMs: 0, ontologyProfileMs: 0, ontologyModelMs: 0, ontologyValidationMs: 0, ontologyRulesMs: 0, ontologyCacheHits: 0, designTimeoutRetries: 0, validationRetries: 0, timeoutSplits: 0, codexInputTokens: 0, codexOutputTokens: 0, codexCachedInputTokens: 0, structuredRecords: 0, deterministicParts: 0, jevRequests: 0, jevInputTokens: 0, codexCalls: 0, cacheHits: 0, reviewParts: 0, jevDecisions: 0, jevAssistedParts: 0, jevFallbackParts: 0, codexBatches: 0 });
export interface AnalysisOptions { jev?: JevConfig; runJev?: typeof runJevExtraction; ontologyPlanning?: boolean; runOntologyJev?: typeof runOntologyJev; assessJevDecisions?: typeof assessJevDecisions }
export type AnalysisUploads = Pick<EvidenceUploads, 'get' | 'getChunk'> & Partial<Pick<EvidenceUploads, 'getChunkRange'>>;
export interface AnalysisPart {
  documents: EvidenceDocument[]; extraction?: OntologyExtraction; records: number;
  semanticReview?: boolean; semanticContext?: OntologyExtraction; splitDepth?: number;
  semanticContexts?: OntologyExtraction[]; decisionSource?: JevDecisionSource;
  decisions?: { documentId: string; result: JevDecisionResult }[];
}
export interface AnalysisResult { extraction: OntologyExtraction; origin: GraphDocument['origin']; needsReview: boolean }
export interface PreparationCallbacks {
  usage?: (delta: Partial<AnalysisMetrics>) => void;
  routing?: (message: string) => void;
  prepared?: (part: AnalysisPart) => Promise<void>;
}
export interface JevDecisionAudit {
  sourceName: string; documentIds: string[]; characters: number;
  result: JevDecisionResult; cached: boolean; createdAt: string;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const CACHE_VERSION = 'cluevia-extraction-v6-source-scope-batches';
const INGESTION_QUESTION = '제공된 모든 자료에서 명시된 객체, 관계, 사건과 근거를 추출하세요. 특정 사용자 질문에 맞춰 사실을 제외하지 마세요. 원문에 없는 내용은 추가하지 마세요.';

/** Persistent bounded work units. Planning never concatenates a complete uploaded file. */
export class AnalysisPipeline {
  readonly concurrency: number;
  private db: DatabaseSync;
  private config: JevConfig;
  private codex: CodexConfig;
  private run: typeof runCodex;
  private runJev: typeof runJevExtraction;
  private runOntologyJev: typeof runOntologyJev;
  private assessDecisions: typeof assessJevDecisions;
  private uploads?: AnalysisUploads;
  private inFlight = new Map<string, Promise<AnalysisResult>>();
  private decisionsInFlight = new Map<string, Promise<JevDecisionResult>>();
  private codexPool: WorkPool;

  constructor(db: DatabaseSync, codex: CodexConfig, run: typeof runCodex, uploads: AnalysisUploads | undefined, options: AnalysisOptions) {
    this.db = db; this.codex = codex; this.run = run; this.uploads = uploads;
    createRecordArchive(db);
    this.config = options.jev ?? readJevConfig({}); this.runJev = options.runJev ?? runJevExtraction; this.runOntologyJev = options.runOntologyJev ?? runOntologyJev;
    this.assessDecisions = options.assessJevDecisions ?? assessJevDecisions;
    this.codexPool = new WorkPool(codex.concurrency ?? 1);
    this.concurrency = Math.max(this.codexPool.limit, this.config.apiKey ? this.config.concurrency : 1);
    db.exec(`
      CREATE TABLE IF NOT EXISTS analysis_plans (job_id TEXT PRIMARY KEY, ready INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS analysis_parts (
        job_id TEXT NOT NULL, part_index INTEGER NOT NULL, payload TEXT, reviewed INTEGER NOT NULL DEFAULT 0, graph_id TEXT,
        PRIMARY KEY(job_id,part_index)
      );
      CREATE TABLE IF NOT EXISTS extraction_cache (
        cache_key TEXT PRIMARY KEY, result_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jev_decision_cache (
        cache_key TEXT PRIMARY KEY, result_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS analysis_decisions (
        job_id TEXT NOT NULL, source_key TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(job_id,source_key)
      );
    `);
    const columns = db.prepare('PRAGMA table_info(analysis_parts)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'graph_id')) db.exec('ALTER TABLE analysis_parts ADD COLUMN graph_id TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS analysis_parts_graph ON analysis_parts(graph_id) WHERE graph_id IS NOT NULL');
  }

  async prepare(jobId: string, input: GraphGenerationInput, signal: AbortSignal, progress: (count: number) => void, definition?: OntologyDefinition, callbacks: PreparationCallbacks = {}): Promise<number> {
    const saved = this.db.prepare('SELECT ready,total FROM analysis_plans WHERE job_id=?').get(jobId);
    if (saved?.ready) {
      const prior = this.db.prepare('SELECT COUNT(*) AS count FROM analysis_decisions WHERE job_id=?').get(jobId);
      callbacks.routing?.(Number(prior?.count) ? '저장된 Jev 판정과 분석 계획을 재사용합니다.' : '기존 작업의 저장된 분석 계획을 재사용합니다. 새 반복 판정은 새 분석부터 적용됩니다.');
      return Number(saved.total);
    }
    this.db.prepare('DELETE FROM analysis_parts WHERE job_id=?').run(jobId);
    this.db.prepare('INSERT OR REPLACE INTO analysis_plans(job_id,ready,total) VALUES (?,0,0)').run(jobId);
    const insert = this.db.prepare('INSERT INTO analysis_parts(job_id,part_index,payload) VALUES (?,?,?)');
    let count = 0;
    const append = async (part: AnalysisPart, sourceName: string) => {
      signal.throwIfAborted();
      const exclusion = scopeExclusion(sourceName, part.documents.map(doc => doc.text).join('\n'), input.analysisBrief);
      if (exclusion && !part.extraction?.limitations.some(note => note.startsWith('[범위 제외]'))) part.extraction = { ...emptyExtraction(), limitations: ['[범위 제외] ' + exclusion] };
      insert.run(jobId, ++count, JSON.stringify(part));
      if (!definition || !this.config.apiKey) await callbacks.prepared?.(part);
      if (count % 20 === 0) { progress(count); await yieldToEventLoop(); }
    };
    const textParts = async (document: EvidenceDocument, records = 0, reviewPart?: AnalysisPart, sourceName = document.name) => {
      const limit = definition ? 8_000 : this.config.apiKey ? 6000 : 30_000;
      // Every excerpt belongs to the same original source. Hash that original once,
      // rather than re-reading the complete document for each bounded excerpt.
      const identityScope = document.identityScope ?? `inline-${digest(definition ? `${document.id}\n${document.name}\n${document.text}` : document.text)}`;
      const splitId = `text-${digest(document.id).slice(0, 24)}`;
      let start = 0; let index = 0;
      while (start < document.text.length) {
        let end = Math.min(start + limit, document.text.length);
        if (end < document.text.length) {
          const newline = document.text.lastIndexOf('\n', end - 1) + 1;
          if (newline > start + limit / 2) end = newline;
          if (/[\uDC00-\uDFFF]/.test(document.text[end] ?? '')) end--;
        }
        index++;
        const split = start > 0 || end < document.text.length;
        await append({ ...(reviewPart?.semanticReview ? { semanticReview: true, semanticContext: reviewPart.semanticContext, decisionSource: reviewPart.decisionSource } : {}), documents: [{ ...document,
          ...(split ? { id: `${splitId}-${index}`, name: `${document.name.slice(0, 250)} · section ${index}` } : {}),
          identityScope,
          text: document.text.slice(start, end),
        }], records: index === 1 ? records : 0 }, sourceName);
        if (end === document.text.length) break;
        start = end - 200;
        if (/[\uDC00-\uDFFF]/.test(document.text[start] ?? '')) start--;
      }
    };
    const appendStructured = async (batch: AnalysisPart, sourceName: string) => {
      if (batch.extraction) { await append(batch, sourceName); return; }
      for (const [index, document] of batch.documents.entries()) await textParts(document, index === 0 ? batch.records : 0, batch, sourceName);
    };
    for (const document of input.documents) {
      signal.throwIfAborted();
      if (isStructuredName(document.name)) {
        const source = { ...document, identityScope: `inline-${digest(definition ? `${document.id}\n${document.name}\n${document.text}` : document.text)}` };
        const batches = definition ? genericStructuredBatches(source, [document.text], definition, { signal, analysisBrief: input.analysisBrief }) : structuredBatches(source, [document.text], { signal });
        for await (const batch of batches) await appendStructured(batch, document.name);
      } else await textParts(document);
    }
    for (const id of input.uploadIds ?? []) {
      const upload = this.uploads?.get(id);
      if (!upload) throw new Error('업로드한 자료를 찾을 수 없습니다. 다시 첨부해주세요.');
      if (isStructuredName(upload.name)) {
        const uploads = this.uploads!;
        const pieces = async function* () {
          let previousEnd = 0;
          for (let index = 0; index < upload.chunkCount; index++) {
            signal.throwIfAborted();
            const doc = uploads.getChunk(id, index);
            const range = uploads.getChunkRange?.(id, index);
            if (!doc || !range) throw new Error('구조화 자료의 원문 위치를 읽지 못했습니다. 파일을 다시 업로드해주세요.');
            yield doc.text.slice(Math.max(0, previousEnd - range.start));
            previousEnd = range.end;
            await yieldToEventLoop();
          }
        };
        const source = { id, name: upload.name, identityScope: id };
        const batches = definition ? genericStructuredBatches(source, pieces(), definition, { signal, analysisBrief: input.analysisBrief }) : structuredBatches(source, pieces(), { signal });
        for await (const batch of batches) await appendStructured(batch, upload.name);
      } else {
        for (let index = 0; index < upload.chunkCount; index++) {
          signal.throwIfAborted();
          const document = this.uploads!.getChunk(id, index);
          if (!document) throw new Error('업로드한 자료의 일부를 읽지 못했습니다.');
          await textParts(document, 0, undefined, upload.name);
          await yieldToEventLoop();
        }
      }
    }
    signal.throwIfAborted();
    if (definition) count = await this.prepareDecisions(jobId, count, definition, signal, callbacks);
    signal.throwIfAborted();
    this.db.prepare('UPDATE analysis_plans SET ready=1,total=? WHERE job_id=?').run(count, jobId);
    return count;
  }

  /** Classify retained narrative records and compile bounded Codex batches. No row is discarded.
   * Staging parts remain invisible until every original part has been carried into the new plan. */
  private async prepareDecisions(jobId: string, total: number, definition: OntologyDefinition, signal: AbortSignal, callbacks: PreparationCallbacks): Promise<number> {
    if (!this.config.apiKey) {
      callbacks.routing?.('Jev API 키가 없어 표는 코드로 변환하고, 의미 분석은 AI가 처리합니다.');
      return total;
    }
    const stagedJob = `${jobId}:routing`;
    this.db.prepare('DELETE FROM analysis_parts WHERE job_id=?').run(stagedJob);
    const stop = new AbortController(); const routingSignal = AbortSignal.any([signal, stop.signal]);
    const pending = new Map<number, Promise<AnalysisPart>>();
    let launch = 1; let staged = 0; let assessed = 0; let batchedRows = 0;
    let group: AnalysisPart[] = [];
    let ready: AnalysisPart[] = [];
    const append = (part: AnalysisPart) => { this.db.prepare('INSERT INTO analysis_parts(job_id,part_index,payload) VALUES (?,?,?)').run(stagedJob, ++staged, JSON.stringify(part)); ready.push(part); };
    const flush = () => {
      if (!group.length) return;
      if (group.length === 1) append(group[0]);
      else {
        batchedRows += group.length;
        append({ documents: group.flatMap(part => part.documents), records: 0, semanticReview: true,
          decisionSource: group[0].decisionSource,
          semanticContexts: group.flatMap(part => [...(part.semanticContexts ?? []), ...(part.semanticContext ? [part.semanticContext] : [])]),
          decisions: group.flatMap(part => part.decisions ?? []) });
      }
      group = [];
    };
    const classify = async (part: AnalysisPart): Promise<AnalysisPart> => {
      const request = { documents: part.documents.map((doc, index) => ({ id: `source-${index + 1}`, name: doc.name, text: doc.text })), definition, source: part.decisionSource };
      if (part.extraction || !part.semanticReview || !jevDecisionsEligible(request)) return part;
      const sourceKey = digest(JSON.stringify(part.documents.map(doc => [doc.id, doc.text])));
      const previous = this.db.prepare('SELECT payload FROM analysis_decisions WHERE job_id=? AND source_key=?').get(jobId, sourceKey);
      const key = digest(JSON.stringify({ version: JEV_DECISIONS_VERSION, ontology: { ...definition, id: undefined },
        source: part.decisionSource, documents: request.documents, model: this.config.model, confidence: this.config.minConfidence }));
      let result: JevDecisionResult; let cached = false;
      const cache = this.db.prepare("SELECT result_json FROM jev_decision_cache WHERE cache_key=? AND created_at>datetime('now','-7 days')").get(key);
      if (cache) { result = JSON.parse(String(cache.result_json)) as JevDecisionResult; cached = true; }
      else {
        let promise = this.decisionsInFlight.get(`${jobId}|${key}`);
        if (promise) cached = true;
        else {
          callbacks.routing?.(`${part.decisionSource!.sourceName} · Jev가 진술 유형·문맥·관계 후보를 판정합니다.`);
          const routingStarted = performance.now();
          promise = this.assessDecisions(request, this.config, { signal: routingSignal,
            onUsage: value => callbacks.usage?.({ jevRequests: value.requests, jevInputTokens: value.inputTokens }),
          }).then(value => {
            routingSignal.throwIfAborted();
            // Transport failures have no decisions and must never become a successful cache hit.
            if (value.decisions.length) this.db.prepare("INSERT OR REPLACE INTO jev_decision_cache VALUES (?,?,datetime('now'))").run(key, JSON.stringify(value));
            callbacks.usage?.({ jevDecisions: value.decisions.length });
            return value;
          }).finally(() => callbacks.usage?.({ jevRoutingMs: performance.now() - routingStarted }));
          this.decisionsInFlight.set(`${jobId}|${key}`, promise);
          void promise.finally(() => this.decisionsInFlight.delete(`${jobId}|${key}`)).catch(() => undefined);
        }
        result = await promise;
      }
      routingSignal.throwIfAborted();
      assessed++;
      const audit = { ontologyId: definition.id, ontologyVersion: definition.version, sourceName: part.decisionSource!.sourceName, documentIds: part.documents.map(doc => doc.id),
        characters: part.documents.reduce((sum, doc) => sum + doc.text.length, 0), result, cached, createdAt: new Date().toISOString() };
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('INSERT OR REPLACE INTO analysis_decisions(job_id,source_key,payload) VALUES (?,?,?)').run(jobId, sourceKey, JSON.stringify(audit));
        if (!previous) callbacks.usage?.({ jevAssistedParts: result.decisions.length ? 1 : 0, jevFallbackParts: result.route === 'individual' ? 1 : 0 });
        if (cached) callbacks.usage?.({ cacheHits: 1 });
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      callbacks.routing?.(`${part.decisionSource!.sourceName} · ${result.reason}`);
      return { ...part, decisions: [{ documentId: part.documents[0].id, result }] };
    };
    const fill = () => {
      while (launch <= total && pending.size < this.concurrency && !routingSignal.aborted) {
        const index = launch++;
        const promise = classify(this.getPart(jobId, index));
        void promise.catch(() => undefined); pending.set(index, promise);
      }
    };
    try {
      fill();
      for (let index = 1; index <= total; index++) {
        routingSignal.throwIfAborted();
        const part = await pending.get(index)!; pending.delete(index);
        const canBatch = part.decisions?.length === 1 && part.decisions[0].result.route === 'batch' && part.documents.length === 1 && part.documents[0].text.length <= 3_000;
        if (!canBatch) { flush(); append(part); }
        else {
          const groupCharacters = group.reduce((sum, entry) => sum + entry.documents[0].text.length, 0);
          if (group.length >= 4 || groupCharacters + part.documents[0].text.length > 6_000 || (group.length && group[0].decisionSource?.sourceName !== part.decisionSource?.sourceName) || group.some(entry => entry.documents[0].id === part.documents[0].id)) flush();
          group.push(part);
        }
        fill();
        for (const part of ready) await callbacks.prepared?.(part); ready = [];
        await yieldToEventLoop();
      }
      flush();
      for (const part of ready) await callbacks.prepared?.(part); ready = [];
      routingSignal.throwIfAborted();
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('DELETE FROM analysis_parts WHERE job_id=?').run(jobId);
        this.db.prepare('UPDATE analysis_parts SET job_id=? WHERE job_id=?').run(jobId, stagedJob);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      callbacks.routing?.(assessed
        ? `반복 판정 ${assessed}구간 · ${batchedRows}구간 묶음 분석 배정 · ${assessed - batchedRows}구간 개별 분석 배정. 원문 전체를 AI가 확인합니다.`
        : '이번 자료에는 반복 판정 대상 서술 구간이 없습니다. 표는 코드로 변환하고, 적용 가능한 단순 관계 판정은 추출 단계에서 처리합니다.');
      return staged;
    } finally { stop.abort(); await Promise.allSettled(pending.values()); this.db.prepare('DELETE FROM analysis_parts WHERE job_id=?').run(stagedJob); }
  }

  listDecisions(jobId: string, limit = 100): JevDecisionAudit[] {
    return this.db.prepare('SELECT payload FROM analysis_decisions WHERE job_id=? ORDER BY rowid LIMIT ?').all(jobId, Math.max(1, Math.min(200, limit))).map(row => JSON.parse(String(row.payload)) as JevDecisionAudit);
  }

  getPart(jobId: string, number: number): AnalysisPart {
    const row = this.db.prepare('SELECT payload FROM analysis_parts WHERE job_id=? AND part_index=?').get(jobId, number);
    if (!row?.payload) throw new Error('저장된 분석 부분을 찾지 못했습니다.');
    return JSON.parse(String(row.payload)) as AnalysisPart;
  }
  /** Called in the unused-definition replacement transaction; no saved results may be discarded. */
  resetUnstartedPlan(jobId: string): void {
    if (this.db.prepare('SELECT part_index FROM analysis_parts WHERE job_id=? AND graph_id IS NOT NULL LIMIT 1').get(jobId)) throw new Error('저장된 결과가 있는 분석 계획은 초기화할 수 없습니다.');
    this.db.prepare('DELETE FROM analysis_parts WHERE job_id=?').run(jobId);
    this.db.prepare('DELETE FROM analysis_plans WHERE job_id=?').run(jobId);
  }
  /** Replace only the timed-out, uncommitted unit after its worker wave has drained.
   * The source is retained in overlapping windows; saved graph/checkpoint indices never move. */
  splitTimedOutPart(jobId: string, number: number, onSplit?: (result: { total: number; parts: number }) => void): { total: number; parts: number } | undefined {
    const plan = this.db.prepare('SELECT ready,total FROM analysis_plans WHERE job_id=?').get(jobId);
    const row = this.db.prepare('SELECT payload,graph_id,reviewed FROM analysis_parts WHERE job_id=? AND part_index=?').get(jobId, number);
    if (!plan?.ready || !row?.payload || row.graph_id) return undefined;
    const part = JSON.parse(String(row.payload)) as AnalysisPart;
    if (part.extraction || (part.splitDepth ?? 0) >= 2) return undefined;
    // No later committed result may be reindexed, even if a caller violates ordered commits.
    if (this.db.prepare('SELECT part_index FROM analysis_parts WHERE job_id=? AND part_index>? AND (graph_id IS NOT NULL OR payload IS NULL) LIMIT 1').get(jobId, number)) return undefined;
    const groups: EvidenceDocument[][] = [];
    if (part.documents.length > 1) {
      const middle = Math.ceil(part.documents.length / 2);
      groups.push(part.documents.slice(0, middle), part.documents.slice(middle));
    } else {
      const document = part.documents[0];
      if (!document || document.text.length < 2_000) return undefined;
      const text = document.text;
      let middle = Math.floor(text.length / 2);
      const newline = text.indexOf('\n', middle);
      if (newline >= middle && newline < middle + Math.min(1000, text.length / 8)) middle = newline + 1;
      let leftEnd = Math.min(text.length, middle + 400);
      let rightStart = Math.max(0, middle - 400);
      if (/[\uDC00-\uDFFF]/.test(text[leftEnd] ?? '')) leftEnd--;
      if (/[\uDC00-\uDFFF]/.test(text[rightStart] ?? '')) rightStart--;
      const stem = digest(document.id).slice(0, 24);
      for (const [index, [start, end]] of [[0, leftEnd], [rightStart, text.length]].entries()) {
        groups.push([{ ...document, id: `retry-${stem}-${index + 1}`, text: text.slice(start, end),
          identityScope: document.identityScope ?? document.id }]);
      }
    }
    const children = groups.map((documents, index): AnalysisPart => ({ ...part, documents,
      records: index === 0 ? part.records : 0, splitDepth: (part.splitDepth ?? 0) + 1 }));
    const total = Number(plan.total) + children.length - 1;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM analysis_parts WHERE job_id=? AND part_index=?').run(jobId, number);
      // Temporarily negative indices avoid uniqueness collisions while shifting the suffix.
      this.db.prepare('UPDATE analysis_parts SET part_index=-part_index WHERE job_id=? AND part_index>?').run(jobId, number);
      this.db.prepare('UPDATE analysis_parts SET part_index=-part_index+? WHERE job_id=? AND part_index<0').run(children.length - 1, jobId);
      const insert = this.db.prepare('INSERT INTO analysis_parts(job_id,part_index,payload,reviewed) VALUES (?,?,?,?)');
      for (const [index, child] of children.entries()) insert.run(jobId, number + index, JSON.stringify(child), Number(row.reviewed));
      this.db.prepare('UPDATE analysis_plans SET total=? WHERE job_id=?').run(total, jobId);
      onSplit?.({ total, parts: children.length });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { total, parts: children.length };
  }
  markReview(jobId: string, number: number): boolean {
    return this.db.prepare('UPDATE analysis_parts SET reviewed=1 WHERE job_id=? AND part_index=? AND reviewed=0').run(jobId, number).changes > 0;
  }
  /** Call inside the graph/checkpoint transaction; completed source data also lives in the ontology. */
  releasePart(jobId: string, number: number, graphId?: string, extraction?: OntologyExtraction) {
    const row = this.db.prepare('SELECT payload FROM analysis_parts WHERE job_id=? AND part_index=?').get(jobId, number);
    if (row?.payload) archiveRecord(this.db, jobId, number, (JSON.parse(String(row.payload)) as AnalysisPart).documents, extraction);
    this.db.prepare('UPDATE analysis_parts SET payload=NULL,graph_id=? WHERE job_id=? AND part_index=?').run(graphId ?? null, jobId, number);
  }

  async process(part: AnalysisPart, question: string, signal: AbortSignal, usage: (delta: Partial<AnalysisMetrics>) => void, review: () => void, definition?: OntologyDefinition, analysisBrief?: AnalysisBrief, runScope = ''): Promise<AnalysisResult> {
    signal.throwIfAborted();
    if (part.extraction) return { extraction: part.extraction, origin: 'structured', needsReview: false };
    const documents = part.documents.filter(doc => doc.text.trim());
    if (!documents.length) return { extraction: emptyExtraction(), origin: 'jev', needsReview: false };
    // Source IDs are rebound on every cache hit, including a re-upload of the same file.
    // Canonical IDs must retain which excerpts share an original source. Otherwise equal
    // source-scoped keys can pass extraction validation and collide only after rebinding.
    const scopes = new Map<string, string>();
    const canonical: GraphGenerationInput = { question: analysisBrief ? question : INGESTION_QUESTION, ...(analysisBrief ? { analysisBrief } : {}), documents: documents.map((doc, index) => {
      const source = doc.identityScope ?? doc.id;
      if (!scopes.has(source)) scopes.set(source, `scope-${scopes.size + 1}`);
      return { id: `source-${index + 1}`, name: definition ? doc.name : `자료 ${index + 1}`, text: doc.text,
        identityScope: scopes.get(source)!, ...(doc.url ? { url: doc.url } : {}) };
    }) };
    const semanticContext = part.semanticReview && definition ? reviewContext(part, canonical, definition) : undefined;
    const decisionContext = part.decisions?.length ? decisionHints(part, canonical) : undefined;
    const batch = Boolean(part.semanticReview && documents.length > 1);
    const key = digest(JSON.stringify({ version: CACHE_VERSION + '-associations-v2', ontology: definition ? { ...definition, id: undefined } : undefined, ontologyJevVersion: ONTOLOGY_JEV_VERSION, jevVersion: JEV_EXTRACTION_VERSION, documents: canonical.documents,
      semanticContext, decisionContext, batch,
      ...(analysisBrief ? { scopedRequest: { version: 'confirmed-analysis-brief-v1', question, analysisBrief } } : {}),
      provider: this.config.apiKey ? 'jev' : 'codex', model: this.config.model, confidence: this.config.minConfidence,
      fallback: this.config.fallback, modelProvider: this.codex.provider, codexModel: effectiveCodexConfig(this.codex).model, codexEffort: effectiveCodexConfig(this.codex).effort }));
    let result: AnalysisResult; let cacheHit = false;
    const row = this.db.prepare("SELECT result_json FROM extraction_cache WHERE cache_key=? AND created_at > datetime('now','-7 days')").get(key);
    if (row) { result = JSON.parse(String(row.result_json)) as AnalysisResult; cacheHit = true; }
    else {
      const flightKey = `${runScope}|${key}`;
      let promise = this.inFlight.get(flightKey);
      if (promise) cacheHit = true;
      else {
        promise = this.extract(canonical, signal, usage, review, definition, semanticContext, decisionContext, batch).then(value => {
          signal.throwIfAborted();
          this.db.prepare('INSERT OR REPLACE INTO extraction_cache VALUES (?,?,datetime(\'now\'))').run(key, JSON.stringify(value));
          return value;
        });
        this.inFlight.set(flightKey, promise);
        void promise.finally(() => this.inFlight.delete(flightKey)).catch(() => undefined);
      }
      result = await promise;
    }
    signal.throwIfAborted();
    if (result.needsReview) review();
    const rebound = { ...result, extraction: result.extraction.entities.length
      ? rebindExtractionSources(result.extraction, canonical, { question, documents }, definition)
      : this.validate(result.extraction, { question, documents }, definition) };
    if (cacheHit) usage({ cacheHits: 1 });
    return rebound;
  }

  private validate(extraction: OntologyExtraction, input: GraphGenerationInput, definition?: OntologyDefinition) {
    try { return parseExtraction(extraction, input, definition); } catch (error) { if (!(error instanceof InsufficientEvidenceError)) throw error; return extraction; }
  }

  private async extract(input: GraphGenerationInput, signal: AbortSignal, usage: (delta: Partial<AnalysisMetrics>) => void, review: () => void, definition?: OntologyDefinition, semanticContext?: string, decisionContext?: string, batch = false): Promise<AnalysisResult> {
    let needsReview = false;
    if (!input.analysisBrief && definition && this.config.apiKey && ontologyJevEligible(input, definition)) {
      try {
        const candidate = await this.runOntologyJev(input, definition, this.config, { signal, onUsage: value => usage({ jevRequests: value.requests, jevInputTokens: value.inputTokens }) });
        if (!candidate.needsFallback) {
          const checked = this.validate(candidate.extraction, input, definition);
          return { extraction: checked, origin: 'jev', needsReview: false };
        }
      } catch (error) { signal.throwIfAborted(); if (!(error instanceof Error)) throw error; }
      // Generic mode never accepts an uncertain Jev subset. Codex re-extracts the original evidence.
      needsReview = true; review();
    }
    if (!input.analysisBrief && !definition && this.config.apiKey) {
      // API/auth/transport errors stop here. They never trigger an unannounced expensive fallback.
      const candidate = await this.runJev(input, this.config, { signal, onUsage: value => usage({ jevRequests: value.requests, jevInputTokens: value.inputTokens }) });
      this.validate(candidate.extraction, input);
      needsReview = candidate.needsFallback;
      if (needsReview) review();
      if (!needsReview || !this.config.fallback) {
        if (needsReview) candidate.extraction.limitations = [...candidate.extraction.limitations.slice(0, 18), '추가 검토가 필요한 구간입니다. Jev가 확실하게 판정한 후보만 포함하며 객체·관계가 누락될 수 있습니다.'];
        return { extraction: candidate.extraction, origin: 'jev', needsReview };
      }
    }
    const queuedAt = performance.now();
    const unlock = await this.codexPool.acquire(signal);
    usage({ codexQueueMs: performance.now() - queuedAt });
    try {
      signal.throwIfAborted();
      let feedback = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        signal.throwIfAborted(); usage({ codexCalls: 1, ...(batch ? { codexBatches: 1 } : {}) });
        const schema = definition ? extractionSchemaFor(definition) : extractionSchema;
        const callStarted = performance.now();
        const raw = await this.run({ ...input, schema: batch ? batchSchema(schema, input) : schema, context: definition
          ? `${input.analysisBrief ? 'Extract source-grounded objects, reported claims and associations relevant to the confirmed analysis brief that fit this frozen ontology.' : 'Extract all source-grounded objects, reported claims and associations that fit this frozen ontology.'} Use property API names as keys; serialize non-string values as JSON strings. Include required evidence-sourced primary and title properties, never invent missing values. Properties with valueSource documentId/documentName/evidenceId are assigned by the server: omit them from properties. Evidence quote spans for evidenceId records must specifically identify each distinct claim and its originating record. Include the actual record identifier or row anchor from the original text when the same short wording appears in separate records; never invent an anchor. Repeated descriptions alone cannot distinguish those records. Document envelope ids such as source-1 are metadata, never business identifiers from source columns. A Report mapped to doc_id requires an actual record containing doc_id; do not turn arbitrary CSV sections into Reports. Respect sourceMappings when interpreting individual records inside input documents. Declared primary keys define identity within this case. ${input.analysisBrief ? 'Consider every supplied record for the confirmed scope, including counterevidence; irrelevant facts remain in raw storage.' : 'Do not omit supported records because of the question.'} Do not require the main conclusion to be proven before retaining the surrounding graph. Preserve uncertainty, denial and source mentions with the appropriate claim stance and relation label. Keep independently grounded objects even if they have no relationship. Missing optional metadata must not erase a claim. Keep output concise: avoid repeating source text in descriptions, quote only supporting spans. Unrepresentable facts must be explained in limitations. ${batch ? `Source identity groups: ${JSON.stringify(input.documents.map(doc => ({ documentId: doc.id, sourceGroup: doc.identityScope })))}. ` : ''}${batch ? 'This is a batch of separate records, all included in full. Read each independently. Return {extraction,sourceReviews}; include exactly one sourceReviews entry per supplied document, with status extracted or no_additional_facts and an explanation. Do not merge people or objects across documents merely because their names match. Do not skip any source or let one source negate another. If a record contradicts Jev hypotheses, follow the original evidence.' : ''} Ontology: ${JSON.stringify(extractionContract(definition))}\n${semanticContext ?? ''}\n${decisionContext ?? ''}\n${analysisBriefContext(input.analysisBrief)}\n${feedback}`
          : `${input.analysisBrief ? 'Review every supplied document and extract grounded objects, claims and contextual associations within the confirmed scope, retaining exact evidence, uncertainty and counterevidence.' : 'Extract grounded objects, claims and contextual associations from every supplied document, retaining exact evidence and uncertainty even when the question cannot be answered conclusively.'} visited/located_in target places; encountered connects vessels; participated_in targets events; reported_by targets person/organization/document. ${analysisBriefContext(input.analysisBrief)}\n${feedback}` }, effectiveCodexConfig(this.codex), { signal, onUsage: value => usage({ codexInputTokens: value.inputTokens, codexOutputTokens: value.outputTokens, codexCachedInputTokens: value.cachedInputTokens }) }).finally(() => usage({ codexRunMs: performance.now() - callStarted }));
        let candidate: unknown;
        try {
          candidate = batch ? readBatchExtraction(raw, input) : raw;
          const normalized = normalizeClaimMetadata(candidate, input);
          candidate = normalized.value;
          if (normalized.changed) { needsReview = true; review(); }
          const checked = this.validate(candidate as OntologyExtraction, input, definition);
          return { extraction: checked, origin: 'codex', needsReview };
        } catch (error) {
          if (attempt) {
            const recovered = error instanceof GraphValidationError ? recoverExtraction(candidate, input, definition) : undefined;
            if (!recovered) throw error;
            review();
            return { extraction: recovered, origin: 'codex', needsReview: true };
          }
          usage({ validationRetries: 1 });
          feedback = `Repair validation errors using only source evidence: ${error instanceof Error ? error.message.slice(0, 1000) : 'invalid extraction'}`;
        }
      }
      throw new Error('추출 결과를 검증하지 못했습니다.');
    } finally { unlock(); }
  }
}

/** Extraction needs schema meaning and constraints, not UI, actions or display boilerplate. */
function extractionContract(definition: OntologyDefinition) {
  return {
    apiName: definition.apiName, description: definition.description,
    objectTypes: definition.objectTypes.map(type => ({
      apiName: type.apiName, description: type.description, primaryKey: type.primaryKey,
      titleProperty: type.titleProperty, identityScope: type.identityScope,
      properties: type.properties.map(property => ({ apiName: property.apiName, description: property.description,
        baseType: property.baseType, required: property.required, valueSource: property.valueSource,
        constraints: property.constraints, elementType: property.elementType, fields: property.fields, valueType: property.valueType })),
    })),
    linkTypes: definition.linkTypes.map(link => ({ apiName: link.apiName, description: link.description,
      sourceType: link.sourceType, targetType: link.targetType,
      sourceCardinality: link.sourceCardinality, targetCardinality: link.targetCardinality })),
    valueTypes: definition.valueTypes, sourceMappings: definition.sourceMappings,
  };
}

function reviewContext(part: AnalysisPart, canonical: GraphGenerationInput, definition: OntologyDefinition): string {
  const byOriginalId = new Map(part.documents.map((doc, index) => [doc.id, canonical.documents[index]]));
  const entities = [...(part.semanticContext?.entities ?? []), ...(part.semanticContexts ?? []).flatMap(context => context.entities)].flatMap(entity => {
    const type = definition.objectTypes.find(item => item.apiName === entity.type)!;
    const evidence = entity.evidence.map(item => {
      const original = byOriginalId.get(item.documentId);
      const matching = canonical.documents.filter(doc => doc.text.includes(item.quote));
      const document = original?.text.includes(item.quote) ? original : matching.length === 1 ? matching[0] : undefined;
      return document ? { documentId: document.id, quote: item.quote } : undefined;
    });
    // A subdivided window cannot carry context whose evidence is outside that window.
    if (evidence.some(item => !item)) return [];
    return [{ type: entity.type, properties: entity.properties.filter(property =>
      (type.properties.find(item => item.apiName === property.key)?.valueSource ?? 'evidence') === 'evidence'), evidence }];
  });
  return `This unit reviews narrative fields in a structured row. The row is retained in full. Mechanical fields have already been stored. Extract additional grounded claims and relations from the narrative; include existing objects only when needed as relation endpoints. Reuse the exact evidence anchors below when referring to an existing evidenceId object so its identity remains stable. Never treat absence of a claim in the mapped fields as proof that the narrative has no facts. Already mapped objects: ${JSON.stringify(entities)}`;
}

function decisionHints(part: AnalysisPart, canonical: GraphGenerationInput): string {
  const byId = new Map(part.documents.map((doc, index) => [doc.id, canonical.documents[index].id]));
  const decisions = (part.decisions ?? []).flatMap(item => {
    const documentId = byId.get(item.documentId);
    return documentId ? [{ documentId, decisions: item.result.decisions }] : [];
  });
  return `Jev advisory classification hypotheses follow. They are not evidence or verified facts. Independently read every complete source. Check every hypothesis against that source; ignore a wrong category. Preserve denial, attribution, ambiguity and conflicting accounts. Candidate relationship types only guide review, never prove an edge, identity, event or truth. A none/uncertain category never authorizes dropping a document. ${JSON.stringify(decisions)}`;
}

function batchSchema(extraction: Record<string, unknown>, input: GraphGenerationInput): Record<string, unknown> {
  return {
    type: 'object', additionalProperties: false, required: ['extraction', 'sourceReviews'], properties: {
      extraction,
      sourceReviews: { type: 'array', minItems: input.documents.length, maxItems: input.documents.length,
        items: { type: 'object', additionalProperties: false, required: ['documentId', 'status', 'reason'], properties: {
          documentId: { type: 'string', enum: input.documents.map(doc => doc.id) },
          status: { type: 'string', enum: ['extracted', 'no_additional_facts'] },
          reason: { type: 'string', minLength: 1, maxLength: 500 },
        } },
      },
    },
  };
}

function readBatchExtraction(raw: unknown, input: GraphGenerationInput): OntologyExtraction {
  const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const failure = () => { throw new Error('묶음 분석은 모든 자료를 sourceReviews에 한 번씩 포함하고 검토 결과를 설명해야 합니다.'); };
  if (!object(raw) || Object.keys(raw).length !== 2 || !object(raw.extraction) || !Array.isArray(raw.sourceReviews) || raw.sourceReviews.length !== input.documents.length) return failure();
  const unseen = new Set(input.documents.map(doc => doc.id));
  const extractionValue = raw.extraction;
  const extraction = structuredClone(extractionValue) as unknown as OntologyExtraction;
  const notes: string[] = [];
  for (const review of raw.sourceReviews) {
    if (!object(review) || Object.keys(review).length !== 3 || typeof review.documentId !== 'string' || !unseen.delete(review.documentId) || !['extracted', 'no_additional_facts'].includes(String(review.status)) || typeof review.reason !== 'string' || !review.reason.trim() || review.reason.length > 500) return failure();
    if (review.status === 'extracted') {
      const items = ['entities', 'relationships', 'events', 'findings'].flatMap(key => Array.isArray(extractionValue[key]) ? extractionValue[key] : []) as unknown[];
      if (!items.some(item => object(item) && Array.isArray(item.evidence) && item.evidence.some(evidence => object(evidence) && evidence.documentId === review.documentId))) return failure();
    } else notes.push(`${review.documentId} 추가 의미 분석: ${review.reason}`);
  }
  if (unseen.size || !Array.isArray(extraction.limitations)) return failure();
  extraction.limitations = [...extraction.limitations.slice(0, 20 - notes.length), ...notes];
  return extraction;
}

function emptyExtraction(): OntologyExtraction {
  return { title: '빈 자료', summary: '분석할 텍스트가 없습니다.', entities: [], relationships: [], events: [], findings: [], limitations: [] };
}
