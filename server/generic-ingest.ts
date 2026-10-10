import { scopeExclusion } from './analysis-scope.ts';
import type { AnalysisBrief } from '../src/types/clarification.ts';
import { createHash } from 'node:crypto';
import type { EvidenceDocument } from '../src/types/graph.ts';
import type { ExtractedEntity, ExtractedRelationship, OntologyDefinition, OntologyExtraction, PropertyDefinition, StructuredSourceMapping } from '../src/types/ontology.ts';
import { parseExtraction, rebindExtractionSources } from './ontology.ts';
import { typedValuesFor } from './ontology-schema.ts';
import { structuredRecords } from './structured-ingest.ts';
import type { StructuredRecord, StructuredSource } from './structured-ingest.ts';

export const GENERIC_INGEST_VERSION = 'generic-ingest-2-metadata-records';
export interface StructuredProfile {
  sourceId: string; sourceName: string; format: StructuredSourceMapping['format']; records: number;
  columns: { name: string; kinds: string[]; presentCount: number; maxLength: number; examples: string[] }[];
  heterogeneous: boolean; truncated: boolean; sampleDocument: EvidenceDocument;
}
export interface GenericStructuredBatch {
  documents: EvidenceDocument[]; extraction?: OntologyExtraction; records: number;
  semanticReview?: boolean; semanticContext?: OntologyExtraction;
  decisionSource?: { sourceName: string; semanticColumns: string[] };
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const formatOf = (name: string): StructuredSourceMapping['format'] => /\.(?:csv|tsv)$/i.test(name) ? 'csv' : /\.json$/i.test(name) ? 'json' : 'jsonl';
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const stringify = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
const kind = (value: unknown): string => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const clip = (value: string, limit: number) => value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;

/** Scan every record, retaining bounded type/column statistics and samples, including late schema changes.
 * Samples describe data; they are never passed off as complete evidence for an extraction. */
export async function profileStructured(source: StructuredSource, chunks: AsyncIterable<string> | Iterable<string>, options: { signal?: AbortSignal; maxChars?: number } = {}): Promise<StructuredProfile> {
  const maxChars = Number.isInteger(options.maxChars) && Number(options.maxChars) >= 2_000 ? Math.min(24_000, Number(options.maxChars)) : 24_000;
  const columns = new Map<string, { name: string; kinds: string[]; presentCount: number; maxLength: number; examples: string[] }>();
  const signatures = new Set<string>(); const samples: { ordinal: number; context?: string; raw: string }[] = [];
  let records = 0; let truncated = false; let sampleSequence = 0;
  for await (const record of structuredRecords(source, chunks, options)) {
    records++;
    const entries = object(record.value) ? Object.entries(record.value) : [['$value', record.value] as [string, unknown]];
    const signature = digest(entries.map(([name, value]) => `${name}:${kind(value)}`).sort().join('\n'));
    const novel = !signatures.has(signature);
    if (novel) { if (signatures.size < 128) signatures.add(signature); else truncated = true; }
    for (const [name, value] of entries) {
      let column = columns.get(name);
      if (!column) {
        if (columns.size >= 128) { truncated = true; continue; }
        column = { name, kinds: [], presentCount: 0, maxLength: 0, examples: [] }; columns.set(name, column);
      }
      column.presentCount++;
      if (typeof value === 'string') column.maxLength = Math.max(column.maxLength, value.length);
      const valueKind = kind(value); if (!column.kinds.includes(valueKind)) column.kinds.push(valueKind);
      const example = clip(stringify(value), 120);
      if (!column.examples.includes(example) && column.examples.length < 2) column.examples.push(example);
    }
    // First records, distinct layouts and deterministic reservoir entries cover the complete stream.
    const sample = { ordinal: record.ordinal, ...(record.context ? { context: clip(record.context, 160) } : {}), raw: clip(record.raw, 700) };
    if (samples.length < 12) samples.push(sample);
    else if (novel || records % 97 === 0) { samples[2 + sampleSequence++ % 10] = sample; }
  }
  const profile = { sourceId: source.id, sourceName: source.name, format: formatOf(source.name), records, columns: [...columns.values()], heterogeneous: signatures.size > 1, truncated };
  // Include each known column even when values require a shorter preview. Never truncate JSON mid-token.
  const presented = profile.columns.map(column => ({ ...column, name: clip(column.name, 150) }));
  if (profile.columns.some(column => column.name.length > 150)) profile.truncated = true;
  let shownSamples = samples;
  const render = () => JSON.stringify({ ...profile, columns: presented, omittedColumns: profile.columns.length - presented.length, note: '전체 레코드를 스캔한 스키마 프로필입니다. samples는 일부 예시이며 객체 근거로 사용하지 마세요.', samples: shownSamples });
  let text = render();
  if (text.length > maxChars) {
    profile.truncated = true; shownSamples = samples.slice(0, 4);
    for (const column of presented) column.examples = column.examples.map(example => clip(example, 40));
    text = render();
    if (text.length > maxChars) { for (const column of presented) column.examples = []; shownSamples = samples.slice(0, 1); text = render(); }
    while (text.length > maxChars && presented.length) { presented.pop(); text = render(); }
  }
  return { ...profile, sampleDocument: { id: `profile-${digest(source.id)}`, name: clip(`${source.name} · 전체 자료 구조 프로필`, 300), text } };
}

function sourceText(record: StructuredRecord, ordinalAnchor = false): string {
  const text = `${record.context ? `${record.context}${record.context.endsWith('\n') ? '' : '\n'}` : ''}${record.raw}`;
  // A clearly marked parser ordinal distinguishes identical observations without inventing a
  // business key. It is stable across batch boundaries, and the original row remains verbatim.
  if (ordinalAnchor) return `자료 메타데이터: 레코드 순번 ${record.ordinal}\n${text}`;
  return text.length >= 8 ? text : `원본 레코드 ${record.ordinal}:\n${text}`;
}
function propertyValue(value: unknown, property: PropertyDefinition): string {
  // CSV conversion is explicit and lossless. Ambiguous forms (yes, localized numbers) go to Codex.
  if (typeof value === 'string') {
    if (property.baseType === 'boolean') {
      if (!['true', 'false'].includes(value.trim())) throw new Error('ambiguous boolean');
      return value.trim();
    }
    if (['integer', 'short', 'byte', 'float', 'double'].includes(property.baseType)) {
      const raw = value.trim();
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) throw new Error('ambiguous number');
      const number = Number(raw);
      if (!Number.isFinite(number) || (['integer', 'short', 'byte'].includes(property.baseType) && !Number.isSafeInteger(number))) throw new Error('unsafe number');
      return JSON.stringify(number);
    }
    return value;
  }
  if (typeof value === 'number' && (!Number.isFinite(value) || (Math.abs(value) >= Number.MAX_SAFE_INTEGER && !Number.isSafeInteger(value)))) throw new Error('unsafe JSON number');
  if (property.baseType === 'decimal' && typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('exact decimal requires original text review');
  if (property.baseType === 'string' && typeof value !== 'string') throw new Error('string conversion requires review');
  return stringify(value);
}
function evidenceFor(text: string, documentId: string, values: string[]): { documentId: string; quote: string }[] {
  const quotes = new Set<string>([text.slice(0, 1600)]);
  for (const value of values) {
    const needles = [value, value.replaceAll('"', '""'), JSON.stringify(value).slice(1, -1)];
    const at = needles.map(needle => text.indexOf(needle)).find(index => index >= 0);
    if (at === undefined) continue;
    quotes.add(text.slice(Math.max(0, Math.min(at - 50, text.length - 8)), Math.max(0, Math.min(at - 50, text.length - 8)) + 1600));
  }
  return [...quotes].filter(quote => quote.length >= 8).slice(0, 8).map(quote => ({ documentId, quote }));
}

function mapRecord(record: StructuredRecord, mappings: StructuredSourceMapping[], definition: OntologyDefinition, document: EvidenceDocument): { entities: ExtractedEntity[]; relationships: ExtractedRelationship[] } | undefined {
  if (!object(record.value) || !mappings.length) return undefined;
  const row = record.value; const text = document.text; const documentId = document.id; const entities = new Map<string, ExtractedEntity>();
  const mapped = new Map<StructuredSourceMapping, ExtractedEntity>(); const covered = new Set<string>();
  try {
    for (const mapping of mappings) {
      const type = definition.objectTypes.find(item => item.apiName === mapping.objectType)!;
      for (const column of mapping.columns) covered.add(column.column);
      for (const column of mapping.semanticColumns ?? []) covered.add(column);
      for (const column of mapping.retainedColumns ?? []) covered.add(column);
      const available = mapping.columns.filter(column => Object.hasOwn(row, column.column) && row[column.column] !== null && row[column.column] !== '');
      if (!available.length && type.properties.some(property => property.required && (property.valueSource ?? 'evidence') === 'evidence')) continue;
      const properties = available.map(column => {
        const property = type.properties.find(item => item.apiName === column.property)!;
        const value = propertyValue(row[column.column], property);
        if (value.length > 500) throw new Error('property exceeds extraction bound');
        return { key: property.apiName, value };
      });
      if (mapping.identityColumns.some(column => !Object.hasOwn(row, column) || row[column] === '' || row[column] === null)) throw new Error('missing identity');
      let entity: ExtractedEntity = {
        id: `pending-${type.apiName}`,
        type: type.apiName, label: type.displayName, description: `${type.displayName}: 원본의 명시된 속성 값.`, identifiers: [], properties,
        evidence: evidenceFor(text, documentId, properties.map(property => property.value)),
      };
      if (type.properties.some(property => (property.valueSource ?? 'evidence') !== 'evidence')) {
        entity = parseExtraction({ title: type.displayName, summary: '구조화 레코드 메타데이터 검증', entities: [entity], relationships: [], events: [], findings: [], limitations: [] }, { question: '전체 자료 변환', documents: [document] }, definition).entities[0];
      }
      typedValuesFor(entity, definition);
      const label = entity.properties.find(property => property.key === type.titleProperty)?.value;
      const primaryKey = entity.properties.find(property => property.key === type.primaryKey)?.value;
      if (!label || label.length > 180 || !primaryKey) throw new Error('missing identity');
      entity.label = label;
      entity.id = `object-${digest(`${definition.id}\n${definition.version}\n${type.apiName}\n${primaryKey}`)}`;
      const prior = entities.get(entity.id);
      if (prior && JSON.stringify(prior.properties) !== JSON.stringify(entity.properties)) throw new Error('conflicting mapping');
      entities.set(entity.id, entity); mapped.set(mapping, entity);
    }
    // New/unsupported columns must receive semantic review; retain the complete row for that review.
    for (const key of Object.keys(row)) if (!covered.has(key) && !mappings.some(mapping => mapping.relations.some(relation => relation.sourceColumn === key))) throw new Error('unmapped column');
    const relationships = new Map<string, ExtractedRelationship>();
    for (const [mapping, source] of mapped) {
      for (const relation of mapping.relations) {
        const raw = row[relation.sourceColumn]; if (raw === undefined || raw === null || raw === '') continue;
        const type = definition.objectTypes.find(item => item.apiName === relation.targetType)!;
        const property = type.properties.find(item => item.apiName === relation.targetProperty)!;
        const targetValue = propertyValue(raw, property);
        let targets = [...entities.values()].filter(entity => entity.type === relation.targetType && entity.properties.some(item => item.key === relation.targetProperty && item.value === targetValue));
        if (!targets.length && relation.targetProperty === type.primaryKey && type.titleProperty === type.primaryKey && type.properties.every(item => !item.required || item.apiName === type.primaryKey)) {
          if (targetValue.length > 180) throw new Error('target exceeds extraction bound');
          const target: ExtractedEntity = {
            id: `object-${digest(`${definition.id}\n${definition.version}\n${type.apiName}\n${targetValue}`)}`, type: type.apiName,
            label: targetValue, description: `${type.displayName}: 명시된 외래 키로 확인된 객체.`, identifiers: [],
            properties: [{ key: type.primaryKey, value: targetValue }], evidence: evidenceFor(text, documentId, [targetValue]),
          };
          typedValuesFor(target, definition); entities.set(target.id, target); targets = [target];
        }
        if (targets.length !== 1) throw new Error('unresolved reference');
        const target = targets[0]; const link = definition.linkTypes.find(item => item.apiName === relation.linkType)!;
        const id = `link-${digest(`${link.apiName}\n${source.id}\n${target.id}`)}`;
        relationships.set(id, { id, source: source.id, target: target.id, type: link.apiName, label: link.displayName,
          description: `원본 ${relation.sourceColumn} 필드와 ${relation.targetProperty} 키의 일치.`, status: 'reported', evidence: evidenceFor(text, documentId, [targetValue]) });
      }
    }
    if (!entities.size) return undefined;
    return { entities: [...entities.values()], relationships: [...relationships.values()] };
  } catch { return undefined; }
}

/** Data-only column mappings; irregular records retain exact source text for Codex, never heuristic types. */
export async function* genericStructuredBatches(source: StructuredSource, chunks: AsyncIterable<string> | Iterable<string>, definition: OntologyDefinition, options: { signal?: AbortSignal; analysisBrief?: AnalysisBrief } = {}): AsyncGenerator<GenericStructuredBatch> {
  const mappings = definition.sourceMappings.filter(mapping => mapping.sourceName === source.name && mapping.format === formatOf(source.name));
  const mappedTypes = mappings.map(mapping => definition.objectTypes.find(type => type.apiName === mapping.objectType)!);
  const ordinalAnchor = mappedTypes.some(type => type.properties.some(property => property.valueSource === 'evidenceId'));
  const oneDocumentPerRow = mappedTypes.some(type => type.properties.find(property => property.apiName === type.primaryKey)?.valueSource === 'documentId');
  const semanticColumns = [...new Set(mappings.flatMap(mapping => mapping.semanticColumns ?? []))];
  let count = 0; let first = 0; let texts: string[] = []; let textSize = 0;
  let reviews: { text: string; ordinal: number; extraction: OntologyExtraction }[] = [];
  let entities = new Map<string, ExtractedEntity>(); let relationships = new Map<string, ExtractedRelationship>();
  let deterministic: boolean | undefined;
  const documentId = () => `mapped-${digest(`${source.id}\n${definition.id}\n${definition.version}`)}-${first}`;
  const documentFor = (text: string): EvidenceDocument => ({ id: documentId(), name: clip(source.name, 300), text, identityScope: source.identityScope ?? source.id });
  const flush = (): GenericStructuredBatch[] => {
    const documents = [documentFor(texts.join('\n'))];
    const extraction: OntologyExtraction = {
      title: clip(`${source.name} · 레코드 ${first}–${first + count - 1}`, 200),
      summary: `${count}개 레코드를 생성된 온톨로지의 명시적 컬럼 매핑으로 변환했습니다.`,
      entities: [...entities.values()], relationships: [...relationships.values()], events: [], findings: [],
      limitations: ['관계는 스키마에 선언된 키와 원본 값의 일치로만 생성했습니다. 원본 레코드와 업로드 전체 자료를 보존합니다.', ...(mappings.some(mapping => mapping.retainedColumns?.length) ? ['관리용 컬럼 일부는 그래프 속성으로 생성하지 않고 원문 기록에 보관했습니다. 온톨로지 매핑에서 목록을 확인할 수 있습니다.'] : [])],
    };
    let result: GenericStructuredBatch | undefined;
    if (deterministic) {
      try { result = { documents, records: count, extraction: parseExtraction(extraction, { question: '전체 자료 변환', documents }, definition) }; }
      catch { /* Conflicting/cardinality-invalid mappings receive Codex review with all original rows. */ }
    }
    const batches: GenericStructuredBatch[] = [];
    if (result) {
      batches.push(result);
      for (const review of reviews) {
        const original = documentFor(review.text);
        // documentId primary keys already force one full row per document. Retain that ID only
        // when both passes use the same complete text; all other excerpts have distinct IDs.
        const document = { ...original, id: oneDocumentPerRow ? original.id : `${original.id}-semantic-${review.ordinal}` };
        const semanticContext = rebindExtractionSources(review.extraction, { question: '원본 기록', documents: [original] }, { question: '서술 의미 분석', documents: [document] }, definition);
        batches.push({ documents: [document], records: 0, semanticReview: true, semanticContext,
          decisionSource: { sourceName: source.name, semanticColumns } });
      }
    } else {
      // Only the irregular rows require model output. A failed cross-row validation must not
      // accidentally send the full 100-record deterministic batch to Codex again.
      for (let index = 0; index < texts.length; index += 8) batches.push({ documents: [{ ...documentFor(texts.slice(index, index + 8).join('\n')), id: `${documentId()}-review-${index / 8 + 1}` }], records: Math.min(8, texts.length - index) });
    }
    count = 0; texts = []; textSize = 0; reviews = []; entities = new Map(); relationships = new Map(); deterministic = undefined;
    return batches;
  };
  for await (const record of structuredRecords(source, chunks, options)) {
    const exclusion = scopeExclusion(source.name, record.raw, options.analysisBrief, record.value);
    if (exclusion) {
      if (count) yield* flush();
      const document = { id: `scope-${digest(source.id)}-${record.ordinal}`, name: source.name, text: `${record.context ?? ''}\n${record.raw}`, identityScope: source.identityScope ?? source.id };
      yield { documents: [document], records: 1, extraction: { title: '범위 밖 원문 보존', summary: exclusion, entities: [], relationships: [], events: [], findings: [], limitations: ['[범위 제외] ' + exclusion] } };
      continue;
    }
    const maxRecords = oneDocumentPerRow ? 1 : deterministic === false ? 8 : 100;
    if (count && (count >= maxRecords || textSize >= (deterministic === false ? 6_000 : 24_000) || entities.size + definition.objectTypes.length > 170)) yield* flush();
    if (!count) first = record.ordinal;
    const text = sourceText(record, ordinalAnchor);
    let mapped = mapRecord(record, mappings, definition, documentFor(text));
    if (count && deterministic !== Boolean(mapped)) { yield* flush(); first = record.ordinal; mapped = mapRecord(record, mappings, definition, documentFor(text)); }
    if (count && mapped?.entities.some(entity => {
      const prior = entities.get(entity.id); return prior && JSON.stringify(prior.properties) !== JSON.stringify(entity.properties);
    })) { yield* flush(); first = record.ordinal; mapped = mapRecord(record, mappings, definition, documentFor(text)); }
    if (!count) first = record.ordinal;
    count++; deterministic = Boolean(mapped); texts.push(text); textSize += text.length;
    if (mapped) {
      const row = object(record.value) ? record.value : undefined;
      if (row && semanticColumns.some(column => Object.hasOwn(row, column) && row[column] !== null && row[column] !== '')) {
        reviews.push({ text, ordinal: record.ordinal, extraction: structuredClone({ title: clip(`${source.name} · 레코드 ${record.ordinal}`, 200), summary: '코드로 검증한 기존 객체입니다. 원본 서술의 추가 관계와 주장만 분석합니다.', ...mapped, events: [], findings: [], limitations: [] }) });
      }
      for (const entity of mapped.entities) {
        const prior = entities.get(entity.id);
        if (prior) prior.evidence = [...prior.evidence, ...entity.evidence].filter((item, index, all) => all.findIndex(other => other.documentId === item.documentId && other.quote === item.quote) === index).slice(0, 8);
        else entities.set(entity.id, entity);
      }
      for (const relation of mapped.relationships) relationships.set(relation.id, relation);
    }
  }
  if (count) yield* flush();
}
