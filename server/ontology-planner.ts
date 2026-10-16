import { createHash } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { GraphGenerationInput, EvidenceDocument } from '../src/types/graph.ts';
import type { OntologyDefinition } from '../src/types/ontology.ts';
import type { AnalysisBrief } from '../src/types/clarification.ts';
import type { AnalysisUploads, AnalysisMetrics } from './analysis-pipeline.ts';
import { isStructuredName } from './structured-ingest.ts';
import { profileStructured } from './generic-ingest.ts';
import { ontologyPlanningSchema, buildOntologyDefinition } from './ontology-builder.ts';
import type { OntologyDesignCache } from './ontology-design-cache.ts';
import { jevDecisionPlanSchema, parseOntologyDefinition } from './ontology-schema.ts';
import { runCodex, CodexError, effectiveCodexConfig } from './codex.ts';
import type { CodexConfig } from './codex.ts';
import { compactPlanningDocument } from './planning-profile.ts';

/** User-confirmed intent guides relevance; it is never a source of factual claims. */
export function analysisBriefContext(brief?: AnalysisBrief): string {
  if (!brief) return '';
  return `Confirmed analysis brief: ${JSON.stringify(brief)}
The confirmed objective, scope and requested output are the latest user-reviewed requirements and refine the original question. Preserve the exact recorded answers as context; when the final confirmed fields explicitly revise an earlier request or answer, follow the confirmed revision. They are analysis requirements, not factual evidence. Consider every supplied source for relevance, supporting context and counterevidence; extract the grounded facts needed for this confirmed purpose, including contradictions and identity context. Unrelated facts may remain in retained raw records without expanding this graph. Never infer that unmentioned facts are absent or invent facts to fulfill the requested output. Preserve raw source data and explain scope-related omissions or missing evidence in limitations. The semantic brief guides relevance. Only the explicitly confirmed filters may mechanically exclude sources or rows; missing dates and counterevidence remain eligible. Retained originals remain searchable.`;
}

export interface PlanningSource {
  id: string; name: string; pieces: () => AsyncIterable<string>;
}
/** Repeatable bounded readers. Original bytes remain in upload storage. */
export function planningSources(input: GraphGenerationInput, uploads?: AnalysisUploads): PlanningSource[] {
  // Several fetched URLs can belong to one pasted source. Keep that source as one
  // planning profile without merging the separately cited extraction documents.
  const groups: EvidenceDocument[][] = [];
  const textGroups = new Map<string, EvidenceDocument[]>();
  const expandedNames = new Set(input.documents.filter(document => document.url && document.identityScope?.startsWith('url-')).map(document => document.name));
  for (const document of input.documents) {
    const canGroup = expandedNames.has(document.name) && !isStructuredName(document.name);
    const group = canGroup ? textGroups.get(document.name) : undefined;
    if (group) group.push(document);
    else {
      const next = [document]; groups.push(next);
      if (canGroup) textGroups.set(document.name, next);
    }
  }
  const inline = groups.map(documents => ({ id: documents[0].id, name: documents[0].name, pieces: async function* () {
    for (const document of documents) yield document.text;
  } }));
  const files = (input.uploadIds ?? []).map(id => {
    const upload = uploads?.get(id);
    if (!upload) throw new Error('설계할 업로드 자료를 찾지 못했습니다.');
    return { id, name: upload.name, pieces: async function* () {
      let previousEnd = 0;
      for (let index = 0; index < upload.chunkCount; index++) {
        const doc = uploads!.getChunk(id, index);
        const range = uploads!.getChunkRange?.(id, index);
        if (!doc || !range) throw new Error('원문 범위를 확인하지 못했습니다. 자료를 다시 업로드해주세요.');
        yield doc.text.slice(Math.max(0, previousEnd - range.start));
        previousEnd = range.end;
        await yieldToEventLoop();
      }
    } };
  });
  return [...inline, ...files];
}

/** Design once, then freeze the definition for every work part and every resume. */
export async function designOntology(input: GraphGenerationInput, uploads: AnalysisUploads | undefined, runner: typeof runCodex, config: CodexConfig, options: {
  id: string; version?: number; repairReason?: string; signal: AbortSignal; usage: () => void; progress: (message: string) => void;
  metrics?: (delta: Partial<AnalysisMetrics>) => void;
  planJevRules?: boolean;
  cache?: OntologyDesignCache;
}): Promise<OntologyDefinition> {
  const started = performance.now();
  try {
  const sources = planningSources(input, uploads);
  const previewChars = Math.min(6000, Math.floor(24_000 / Math.max(1, sources.length)));
  const structuredNames = sources.filter(source => isStructuredName(source.name)).map(source => source.name);
  if (new Set(structuredNames).size !== structuredNames.length) throw new Error('구조화 자료의 파일명이 중복됩니다. 파일명을 서로 다르게 지정해주세요. 매핑 혼동을 방지하기 위한 검사입니다.');
  const profiles: { sourceName: string; format: string; columns: string[]; records: number }[] = [];
  const documents: EvidenceDocument[] = [];
  const fingerprints: { name: string; content: string }[] = [];
  const profileStarted = performance.now();
  for (const source of sources) {
    options.signal.throwIfAborted();
    options.progress(`${source.name} · 전체 구조를 확인해 온톨로지 설계 자료를 준비합니다.`);
    const hash = createHash('sha256');
    // Hash while doing the existing full scan, never just the bounded preview. UTF-16
    // keeps the fingerprint independent of chunk boundaries inside surrogate pairs.
    const pieces = async function* () {
      for await (const piece of source.pieces()) { options.signal.throwIfAborted(); hash.update(piece, 'utf16le'); yield piece; }
    };
    let text: string;
    if (isStructuredName(source.name)) {
      const profile = await profileStructured(source, pieces(), { signal: options.signal, maxChars: 14_000 });
      profiles.push({ sourceName: source.name, format: profile.format, columns: profile.columns.map(column => column.name), records: profile.records });
      // Profiles contain bounded examples and counts, not a complete large file.
      const { sampleDocument: _sample, sourceId: _sourceId, ...description } = profile;
      text = JSON.stringify(description);
    } else {
      let characters = 0; let first = ''; let last = '';
      const samples: string[] = [];
      let chunk = 0;
      // Deterministic reservoir sampling: every region has a chance to survive.
      let randomState = 0x9e3779b9;
      const random = () => { randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5; return (randomState >>> 0) / 0x100000000; };
      for await (const piece of pieces()) {
        options.signal.throwIfAborted(); characters += piece.length;
        if (first.length < 3500) first += piece.slice(0, 3500 - first.length);
        last = (last + piece.slice(-2500)).slice(-2500);
        chunk++;
        const slot = chunk <= 12 ? chunk - 1 : Math.floor(random() * chunk);
        if (slot < 12) samples[slot] = `Chunk ${chunk}: ${piece.slice(0, 650)}`;
        await yieldToEventLoop();
      }
      const render = () => JSON.stringify({ sourceName: source.name, characters, note: 'Schema design samples only. Every original part is extracted later.', first,
        ...(characters > first.length ? { samples: samples.filter(sample => !first.includes(sample.slice(sample.indexOf(': ') + 2))), last } : {}) });
      text = render();
      while (text.length > 14_000) {
        first = first.slice(0, Math.floor(first.length * 0.8)); last = last.slice(0, Math.floor(last.length * 0.8));
        for (let i = 0; i < samples.length; i++) samples[i] = samples[i].slice(0, Math.floor(samples[i].length * 0.8));
        text = render();
      }
    }
    // Limit each source's design input; the extraction pass still reads all rows/characters.
    const content = hash.digest('hex');
    fingerprints.push({ name: source.name, content });
    documents.push(compactPlanningDocument({ id: `profile-${documents.length + 1}-${createHash('sha256').update(source.name).update(content).digest('hex').slice(0, 24)}`, name: source.name, text }, previewChars));
  }
  options.metrics?.({ ontologyProfileMs: performance.now() - profileStarted });
  // API accepts at most ten supplied sources; persisted inputs use the same bound.
  if (documents.length > 10) throw new Error('온톨로지 하나에는 최대 10개 자료를 함께 설계할 수 있습니다.');
  const designIntent = [input.question, input.analysisBrief?.objective, input.analysisBrief?.scope, input.analysisBrief?.output].filter(Boolean).join('\n');
  const designSchema = ontologyPlanningSchema({ advanced: /인터페이스|공유\s*속성|값\s*타입|액션\s*타입|\b(interface|shared property|value type|action type)\b/i.test(designIntent), structured: profiles.length > 0 });
  const designConfig = effectiveCodexConfig(config, 'ontology-design');
  const ruleConfig = effectiveCodexConfig(config, 'jev-planning');
  // Bump this contract when prompts, profile semantics or validation behavior change.
  // Include full source content, confirmed intent and both model stages; transient
  // upload/job identifiers deliberately do not change the domain design.
  const cacheKey = options.cache && !options.repairReason ? createHash('sha256').update(JSON.stringify({
    contract: 'ontology-design-associations-v3', question: input.question, analysisBrief: input.analysisBrief ?? null,
    sources: fingerprints, schema: designSchema, planJevRules: Boolean(options.planJevRules),
    design: { provider: designConfig.provider, bin: designConfig.bin, model: designConfig.model, effort: designConfig.effort },
    rules: options.planJevRules ? { provider: ruleConfig.provider, bin: ruleConfig.bin, model: ruleConfig.model, effort: ruleConfig.effort } : null,
  })).digest('hex') : undefined;
  options.signal.throwIfAborted();
  if (cacheKey) {
    try {
      const cached = options.cache!.get(cacheKey);
      if (cached) {
        const definition = parseOntologyDefinition(cached, { id: options.id, version: options.version ?? 1 });
        options.metrics?.({ ontologyCacheHits: 1 });
        options.progress('동일한 자료·질문에서 검증한 온톨로지를 재사용해 설계 모델 호출을 생략합니다.');
        return definition;
      }
    } catch { /* Optional cache failure always falls through to fresh design. */ }
  }
  let cacheEligible = true;
  const planRules = async (definition: OntologyDefinition): Promise<OntologyDefinition> => {
    // Schema design cannot supply custom rules at its lower effort. Plan only when Jev
    // is configured and repeated structured narrative rows can actually use the rules.
    definition.processing.decisionRules = [];
    const sources = profiles.filter(profile => profile.records > 1).map(profile => ({
      sourceName: profile.sourceName,
      semanticColumns: [...new Set(definition.sourceMappings.filter(mapping => mapping.sourceName === profile.sourceName).flatMap(mapping => mapping.semanticColumns ?? []))],
    })).filter(source => source.semanticColumns.length);
    if (!options.planJevRules || !sources.length) return definition;
    options.signal.throwIfAborted();
    options.progress('반복되는 서술을 분류할 Jev 판정 규칙을 설계합니다.');
    options.usage();
    const callStarted = performance.now();
    try {
      const response = await runner({
        purpose: 'jev-planning', question: input.question, schema: jevDecisionPlanSchema,
        documents: documents.filter(document => sources.some(source => source.sourceName === document.name)).map(document => compactPlanningDocument(document, 2400)),
        context: `Eligible sources and columns: ${JSON.stringify(sources)}\nDomain: ${definition.apiName} (${definition.displayName})\n${analysisBriefContext(input.analysisBrief)}`,
      }, ruleConfig, {
        signal: options.signal,
        onUsage: value => options.metrics?.({ codexInputTokens: value.inputTokens, codexOutputTokens: value.outputTokens, codexCachedInputTokens: value.cachedInputTokens }),
      });
      options.signal.throwIfAborted();
      if (!response || typeof response !== 'object' || Array.isArray(response) || Object.keys(response).length !== 1 || !('decisionRules' in response) || !Array.isArray(response.decisionRules)) throw new Error('Invalid decision rule plan');
      const planned = parseOntologyDefinition({ ...definition, processing: { ...definition.processing, decisionRules: response.decisionRules } });
      if (planned.processing.decisionRules!.some(rule => !sources.some(source => source.sourceName === rule.sourceName))) throw new Error('Ineligible decision rule source');
      options.progress(`Jev 반복 판정 규칙 ${planned.processing.decisionRules!.length}개를 검증했습니다.`);
      return planned;
    } catch (error) {
      options.signal.throwIfAborted();
      if (error instanceof CodexError && error.code === 'CODEX_CANCELLED') throw error;
      // Optional optimization: do not redesign a valid ontology or lose original evidence.
      cacheEligible = false;
      options.progress('Jev 추가 판정 규칙을 만들지 못해 기본 판정과 AI 원문 검토로 계속합니다.');
      return definition;
    } finally { const elapsed = performance.now() - callStarted; options.metrics?.({ codexRunMs: elapsed, ontologyRulesMs: elapsed }); }
  };
  let timedOut = false;
  let designDocuments = documents;
  const invoke = async (context: string): Promise<unknown> => {
    options.signal.throwIfAborted(); options.usage();
    const callStarted = performance.now();
    try {
      return await runner({ purpose: 'ontology-design', question: input.question, documents: designDocuments, schema: designSchema, context }, designConfig, {
        signal: options.signal,
        onUsage: value => options.metrics?.({ codexInputTokens: value.inputTokens, codexOutputTokens: value.outputTokens, codexCachedInputTokens: value.cachedInputTokens }),
      });
    } catch (error) {
      options.signal.throwIfAborted();
      if (!(error instanceof CodexError) || error.code !== 'CODEX_TIMEOUT') throw error;
      if (timedOut) throw new CodexError('CODEX_TIMEOUT', '온톨로지 설계 응답이 축약 재시도 후에도 제한 시간을 초과했습니다. 원본 자료는 보존되어 있습니다. 이어서 분석으로 재개하거나 CODEX_ONTOLOGY_TIMEOUT_MS와 CODEX_ONTOLOGY_EFFORT를 조정해주세요.', 504);
      timedOut = true;
      options.metrics?.({ designTimeoutRetries: 1 });
      designDocuments = designDocuments.map(document => compactPlanningDocument(document, Math.max(1000, Math.floor(document.text.length * 0.5))));
      options.progress('온톨로지 설계 응답이 지연되어 예시를 축약하고 한 번 다시 시도합니다. 원본 자료와 전체 열 정의는 보존합니다.');
    } finally { const elapsed = performance.now() - callStarted; options.metrics?.({ codexRunMs: elapsed, ontologyModelMs: elapsed }); }
    return invoke(`${context}\nTimeout recovery: keep the same requested scope and all source columns, but return a concise blueprint. Do not repeat domain facts, add speculative types or emit object instances.`);
  };
  let feedback = options.repairReason ? `A previous schema failed during extraction: ${options.repairReason.slice(0, 1000)}. Repair both identity contracts and structured conversion coverage. Actual source columns such as doc_id are evidence values, never source-N metadata. Records without literal row IDs can still use deterministic sourceMappings: declare the record primary key valueSource=evidenceId, omit its generated property from columns, use identityColumns=[], and map all actual columns. Use a separate source-document type for metadata. Mark narrative columns semanticColumns so direct conversion does not skip their factual claims.` : '';
  for (let attempt = 0; attempt < 2; attempt++) {
    options.signal.throwIfAborted();
    options.progress(attempt ? '온톨로지의 누락된 매핑·참조를 검증하고 보완합니다.' : '전체 자료의 열·타입과 짧은 예시로 온톨로지를 설계합니다.');
    const candidate = await invoke(`Build a concise ontology for the confirmed scope while retaining every original source row. Preserve actors, places, source mentions and reported claims even when the main event is unconfirmed; graph construction is not a proof verdict. Include suitable domain/context links with many-to-many cardinality unless stricter source semantics are explicit. Use evidenceId when literal identifiers are missing; keep other non-guaranteed properties optional. The supplied profiles list exact source names, formats and columns from a full scan; examples are only schema guidance, not complete evidence. Rows without literal IDs use evidenceId primary keys and identityColumns=[]; factual narrative belongs in semanticColumns. The server fills defaults and validates references. Set processing.decisionRules=[]; Jev rules are planned separately.\n${analysisBriefContext(input.analysisBrief)}\n${feedback}`);
    options.signal.throwIfAborted();
    let validationStarted: number | undefined = performance.now();
    const finishValidation = () => {
      if (validationStarted !== undefined) { options.metrics?.({ ontologyValidationMs: performance.now() - validationStarted }); validationStarted = undefined; }
    };
    try {
      const definition = buildOntologyDefinition(candidate, { id: options.id, version: options.version ?? 1 });
      for (const mapping of definition.sourceMappings) {
        const profile = profiles.find(profile => profile.sourceName === mapping.sourceName);
        if (!profile || profile.format !== mapping.format) throw new Error(`매핑 자료 또는 형식이 원문과 다릅니다: ${mapping.sourceName}`);
        if ([...mapping.columns.map(column => column.column), ...mapping.identityColumns, ...(mapping.semanticColumns ?? []), ...(mapping.retainedColumns ?? []), ...mapping.relations.map(link => link.sourceColumn)].some(column => !profile.columns.includes(column))) throw new Error(`원문에 없는 열을 매핑했습니다: ${mapping.sourceName}`);
      }
      const gaps = profiles.flatMap(profile => {
        const mappings = definition.sourceMappings.filter(mapping => mapping.sourceName === profile.sourceName);
        const covered = new Set(mappings.flatMap(mapping => [...mapping.columns.map(column => column.column), ...(mapping.semanticColumns ?? []), ...(mapping.retainedColumns ?? []), ...mapping.relations.map(link => link.sourceColumn)]));
        const missing = profile.columns.filter(column => !covered.has(column));
        return missing.length ? [{ sourceName: profile.sourceName, columns: missing }] : [];
      });
      if (gaps.length && !attempt) {
        options.metrics?.({ validationRetries: 1 });
        options.progress('표의 누락된 변환 규칙을 보완해 반복적인 모델 추출을 줄이고 있습니다.');
        feedback = `The definition is structurally valid but leaves source columns uncovered: ${JSON.stringify(gaps).slice(0, 12_000)}. Repair these mappings once. Preserve actual column names; use evidenceId record primary keys with identityColumns=[] for rows lacking a literal ID. Cover useful analytic columns with mappings, keep purely administrative or presentation columns in retainedColumns without creating graph properties, and mark factual narrative fields in semanticColumns. Unsupported nested or genuinely irregular records may remain for bounded Codex review; never invent data or drop source fields.`;
        continue;
      }
      if (gaps.length) {
        cacheEligible = false;
        const fallback = `직접 변환 규칙에 포함되지 않은 ${gaps.reduce((sum, gap) => sum + gap.columns.length, 0)}개 열이 있는 ${gaps.length}개 자료는 원문을 보존해 작은 단위로 AI가 검토합니다.`;
        definition.processing.rationale = `${definition.processing.rationale.slice(0, 1700)} ${fallback}`.trim();
        options.progress(fallback);
      }
      finishValidation();
      const result: OntologyDefinition = documents.length ? await planRules(definition) : { ...definition, status: 'draft', sourceMappings: [] };
      options.signal.throwIfAborted();
      if (cacheKey && cacheEligible) { try { options.cache!.set(cacheKey, result); } catch { /* Optional persistence must not fail analysis. */ } }
      return result;
    } catch (error) {
      options.signal.throwIfAborted();
      if (error instanceof CodexError && error.code === 'CODEX_CANCELLED') throw error;
      if (attempt) throw error;
      options.metrics?.({ validationRetries: 1 });
      feedback = `Previous definition failed server validation. Repair using actual fields only: ${error instanceof Error ? error.message.slice(0, 1200) : 'invalid schema'}`;
    } finally { finishValidation(); }
  }
  throw new Error('온톨로지 설계를 검증하지 못했습니다.');
  } finally { options.metrics?.({ designMs: performance.now() - started }); }
}
