import { createHash } from 'node:crypto';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import type { EvidenceDocument } from '../src/types/graph.ts';
import type { EntityType, ExtractedEntity, ExtractedRelationship, OntologyExtraction } from '../src/types/ontology.ts';

export interface StructuredSource { id: string; name: string; identityScope?: string }
export interface StructuredBatch { documents: EvidenceDocument[]; extraction: OntologyExtraction; records: number }
export interface StructuredRecord { raw: string; value: unknown; ordinal: number; context?: string; representation?: boolean }
type RecordValue = StructuredRecord;
interface Decoder { feed(text: string, end?: boolean): RecordValue[] }
export class StructuredDataError extends Error {
  constructor(message: string) { super(message); this.name = 'StructuredDataError'; }
}
export function isStructuredName(name: string): boolean { return /\.(?:csv|tsv|jsonl|ndjson|json)$/i.test(name.trim()); }
function abort(signal?: AbortSignal): void { if (signal?.aborted) throw new StructuredDataError('구조화 자료 처리를 취소했습니다.'); }
const hasContent = (raw: string) => Boolean(raw.replace(/^\uFEFF/, '').trim());

/** Shared framing only: callers provide their own domain schema and mapping policy. */
export async function* structuredRecords(source: StructuredSource, chunks: AsyncIterable<string> | Iterable<string>, options: { signal?: AbortSignal } = {}): AsyncGenerator<StructuredRecord> {
  if (!isStructuredName(source.name)) throw new StructuredDataError('지원하는 구조화 확장자는 CSV, TSV, JSONL, NDJSON, JSON입니다.');
  const extension = source.name.trim().toLowerCase().split('.').at(-1);
  const decoder: Decoder = extension === 'csv' || extension === 'tsv' ? new CsvDecoder(extension === 'tsv' ? '\t' : ',') : extension === 'json' ? new JsonDecoder() : new LinesDecoder();
  for await (const chunk of chunks) {
    abort(options.signal);
    if (typeof chunk !== 'string') throw new StructuredDataError('구조화 자료 입력은 문자열이어야 합니다.');
    for (let offset = 0; offset < chunk.length; offset += 8192) {
      abort(options.signal);
      for (const record of decoder.feed(chunk.slice(offset, offset + 8192))) yield record;
      await yieldImmediate();
    }
  }
  abort(options.signal);
  for (const record of decoder.feed('', true)) yield record;
}

/** RFC 4180 records, including quoted CR/LF and escaped quotes across arbitrary input boundaries. */
class CsvDecoder implements Decoder {
  private delimiter: string;
  private header?: string[];
  private headerRaw = '';
  private raw = '';
  private field = '';
  private fields: string[] = [];
  private quoted = false;
  private closingQuote = false;
  private pendingCR = false;
  private beginning = true;
  private ordinal = 0;
  private physicalRow = 1;
  constructor(delimiter: string) { this.delimiter = delimiter; }
  feed(text: string, end = false): RecordValue[] {
    const result: RecordValue[] = [];
    const finish = () => {
      const raw = this.raw; const cells = [...this.fields, this.field];
      this.raw = ''; this.field = ''; this.fields = []; this.closingQuote = false; this.pendingCR = false;
      const row = this.physicalRow++;
      if (!hasContent(raw)) return;
      if (!this.header) {
        const used = new Set<string>();
        this.header = cells.map((cell, index) => {
          const base = cell.trim() || `column_${index + 1}`; let name = base; let suffix = 2;
          while (used.has(name)) name = `${base} [${suffix++}]`;
          used.add(name); return name;
        });
        this.headerRaw = raw; return;
      }
      if (cells.length !== this.header.length) throw new StructuredDataError(`CSV 레코드 ${row}: 열 ${this.header.length}개가 필요하지만 ${cells.length}개입니다.`);
      result.push({ raw, value: Object.fromEntries(this.header.map((key, index) => [key, cells[index]])), ordinal: ++this.ordinal, context: this.headerRaw });
    };
    for (const char of text) {
      if (this.beginning) { this.beginning = false; if (char === '\uFEFF') { this.raw += char; continue; } }
      if (this.pendingCR) { if (char === '\n') { this.raw += char; finish(); continue; } finish(); }
      this.raw += char;
      if (this.quoted) {
        if (char === '"') { this.quoted = false; this.closingQuote = true; } else this.field += char;
        continue;
      }
      if (this.closingQuote && char === '"') { this.field += '"'; this.quoted = true; this.closingQuote = false; continue; }
      if (char === this.delimiter) { this.fields.push(this.field); this.field = ''; this.closingQuote = false; continue; }
      if (char === '\r') { this.pendingCR = true; continue; }
      if (char === '\n') { finish(); continue; }
      if (this.closingQuote) throw new StructuredDataError(`CSV 레코드 ${this.physicalRow}: 닫는 따옴표 뒤에 구분자나 줄바꿈이 필요합니다.`);
      if (char === '"') {
        if (this.field.length) throw new StructuredDataError(`CSV 레코드 ${this.physicalRow}: 따옴표는 필드 시작에 있어야 합니다.`);
        this.quoted = true;
      } else this.field += char;
    }
    if (end) {
      if (this.quoted) throw new StructuredDataError(`CSV 레코드 ${this.physicalRow}: 닫히지 않은 따옴표입니다.`);
      if (this.raw.length) finish();
    }
    return result;
  }
}

function parsed(raw: string, context: string): unknown {
  try { return JSON.parse(raw); }
  catch { throw new StructuredDataError(`${context}: 올바른 JSON이 아닙니다.`); }
}
class LinesDecoder implements Decoder {
  private pending = ''; private line = 0; private ordinal = 0; private first = true;
  feed(text: string, end = false): RecordValue[] {
    if (this.first && text.length) { this.first = false; text = text.replace(/^\uFEFF/, ''); }
    this.pending += text;
    const result: RecordValue[] = []; let start = 0; let newline: number;
    const append = (raw: string) => {
      this.line++;
      if (hasContent(raw)) result.push({ raw, value: parsed(raw, `JSONL ${this.line}번째 줄`), ordinal: ++this.ordinal });
    };
    while ((newline = this.pending.indexOf('\n', start)) !== -1) { append(this.pending.slice(start, newline + 1)); start = newline + 1; }
    this.pending = this.pending.slice(start);
    if (end && this.pending.length) { append(this.pending); this.pending = ''; }
    return result;
  }
}

/** Incremental JSON value framing; JSON.parse validates each complete value. */
class ValueFrame {
  raw = ''; private nesting = 0; private quoted = false; private escaped = false; private kind: 'container' | 'string' | 'primitive';
  constructor(first: string) { this.kind = first === '{' || first === '[' ? 'container' : first === '"' ? 'string' : 'primitive'; }
  consume(char: string): 'more' | 'done' | 'delimiter' {
    if (this.kind === 'primitive' && this.raw && /[\s,\]}]/u.test(char)) return 'delimiter';
    this.raw += char;
    if (this.quoted) {
      if (this.escaped) this.escaped = false;
      else if (char === '\\') this.escaped = true;
      else if (char === '"') { this.quoted = false; if (this.kind === 'string') return 'done'; }
      return 'more';
    }
    if (char === '"') this.quoted = true;
    else if (char === '{' || char === '[') this.nesting++;
    else if (char === '}' || char === ']') { this.nesting--; if (this.kind === 'container' && this.nesting === 0) return 'done'; }
    return 'more';
  }
}

type JsonState = 'start' | 'array-first' | 'array-value' | 'array-comma' | 'object-first' | 'object-key' | 'object-colon' | 'object-value' | 'object-comma' | 'end';
/** Streams root arrays and each top-level array of an object (data/features/records wrappers included).
 * Non-array wrapper fields are retained in one explicitly marked metadata record. */
class JsonDecoder implements Decoder {
  private state: JsonState = 'start'; private frame?: ValueFrame;
  private frameUse: 'element' | 'key' | 'member' | 'root' = 'root';
  private wrapped = false; private key = ''; private keyRaw = ''; private memberPrefix = '';
  private metadata: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  private metadataRaw: string[] = []; private objectRaw = ''; private sawArray = false;
  private keys = new Set<string>(); private ordinal = 0; private offset = 0; private beginning = true; private arrayCount = 0;
  feed(text: string, end = false): RecordValue[] {
    const result: RecordValue[] = [];
    const problem = (message: string): never => { throw new StructuredDataError(`JSON 문자 ${this.offset + 1}: ${message}`); };
    const emit = (raw: string, value: unknown, context?: string, representation?: boolean) => result.push({ raw, value, ordinal: ++this.ordinal, context, representation });
    const finishObject = () => {
      if (!this.sawArray) emit(this.objectRaw, this.metadata);
      else if (Object.keys(this.metadata).length) emit(this.metadataRaw.join('\n'), this.metadata, '배열 외 상위 필드의 원문 발췌', true);
      this.state = 'end';
    };
    const finishFrame = () => {
      const raw = this.frame!.raw; const value = parsed(raw, `JSON 문자 ${this.offset + 1}`); this.frame = undefined;
      if (this.frameUse === 'key') {
        if (typeof value !== 'string') problem('객체 키는 문자열이어야 합니다.');
        this.key = value as string; this.keyRaw = raw;
        if (this.keys.has(this.key)) problem(`중복 상위 키 "${this.key.slice(0, 80)}"입니다.`);
        this.keys.add(this.key); this.memberPrefix = raw; this.state = 'object-colon';
      } else if (this.frameUse === 'member') {
        this.metadata[this.key] = value; this.metadataRaw.push(`${this.memberPrefix}${raw}`); this.state = 'object-comma';
      } else if (this.frameUse === 'element') {
        emit(raw, value, this.wrapped ? `JSON 배열 경로: ${this.keyRaw}` : undefined); this.arrayCount++; this.state = 'array-comma';
      } else { emit(raw, value); this.state = 'end'; }
    };
    const begin = (char: string, use: typeof this.frameUse) => { this.frame = new ValueFrame(char); this.frameUse = use; if (this.frame.consume(char) === 'done') finishFrame(); };
    for (const char of text) {
      this.offset++;
      if (this.beginning) { this.beginning = false; if (char === '\uFEFF') continue; }
      // Keep a flat object verbatim. Once an array starts, release its prefix and retain only metadata fields.
      if (!this.sawArray && (this.state.startsWith('object') || (this.frame && this.frameUse !== 'root' && this.frameUse !== 'element'))) this.objectRaw += char;
      if (this.frame) {
        const consumed = this.frame.consume(char);
        if (consumed === 'done') { finishFrame(); continue; }
        if (consumed === 'more') continue;
        finishFrame(); // Primitive terminator also belongs to the enclosing container.
      }
      const whitespace = /[ \t\r\n]/u.test(char);
      if (this.state === 'object-colon' || this.state === 'object-value') this.memberPrefix += char;
      if (whitespace) continue;
      switch (this.state) {
        case 'start':
          if (char === '[') { this.state = 'array-first'; this.wrapped = false; this.arrayCount = 0; }
          else if (char === '{') { this.state = 'object-first'; this.objectRaw = '{'; }
          else begin(char, 'root');
          break;
        case 'array-first': case 'array-value':
          if (char === ']') {
            if (this.state === 'array-value') problem('배열 끝에 불필요한 쉼표가 있습니다.');
            if (!this.arrayCount) emit('[]', [], this.wrapped ? `JSON 배열 경로: ${this.keyRaw}` : undefined);
            this.state = this.wrapped ? 'object-comma' : 'end';
          } else begin(char, 'element');
          break;
        case 'array-comma':
          if (char === ',') this.state = 'array-value';
          else if (char === ']') this.state = this.wrapped ? 'object-comma' : 'end';
          else problem('배열 값 뒤에 쉼표 또는 ]가 필요합니다.');
          break;
        case 'object-first': case 'object-key':
          if (char === '}' && this.state === 'object-first') finishObject();
          else if (char === '"') begin(char, 'key');
          else problem('객체 키 문자열이 필요합니다.');
          break;
        case 'object-colon':
          if (char !== ':') problem('객체 키 뒤에 :가 필요합니다.');
          this.state = 'object-value'; break;
        case 'object-value':
          this.memberPrefix = this.memberPrefix.slice(0, -1);
          if (char === '[') { this.sawArray = true; this.objectRaw = ''; this.wrapped = true; this.arrayCount = 0; this.state = 'array-first'; }
          else begin(char, 'member');
          break;
        case 'object-comma':
          if (char === ',') this.state = 'object-key';
          else if (char === '}') finishObject();
          else problem('객체 값 뒤에 쉼표 또는 }가 필요합니다.');
          break;
        case 'end': problem('최상위 JSON 값 뒤에 다른 내용이 있습니다.');
      }
    }
    if (end) {
      if (this.frame) finishFrame();
      if (this.state !== 'end') problem('JSON이 완성되지 않았습니다.');
    }
    return result;
  }
}

const normalized = (name: string) => name.normalize('NFKC').toLowerCase().replace(/[\s_\-.()]/gu, '');
const labels = {
  vessel: ['vesselname', 'shipname', '선박명', '선명'],
  person: ['personname', '성명', '인물명'], organization: ['organizationname', 'companyname', '기관명', '회사명'],
  place: ['placename', 'locationname', '장소명'], imo: ['imo', 'imonumber', 'imo번호'], mmsi: ['mmsi', 'mmsinumber'],
  owner: ['owner', 'registeredowner', 'ownername', '선주', '소유자'], ownerCompany: ['ownercompany', 'ownercompanyname', '소유회사'],
  operator: ['operator', 'operatorname', '운영자'], operatorCompany: ['operatorcompany', 'operatorcompanyname', '운영회사'],
  port: ['port', 'portname', '항구', '항구명', 'portofregistry'], currentPort: ['currentport', '현재항구'], visitedPort: ['visitedport', '방문항구'],
};
const shorten = (value: string, limit: number) => value.length <= limit ? value : `${value.slice(0, limit - 8)}… [생략]`;
/** Labels are also identity hints in the ontology store. Retain a fingerprint of the complete
 * value so two long values with the same displayed prefix cannot become one entity. */
function entityLabel(value: string): string {
  if (value.length <= 180) return value;
  const suffix = `… [생략·${createHash('sha256').update(value).digest('hex').slice(0, 20)}]`;
  return `${value.slice(0, 180 - suffix.length)}${suffix}`;
}
function stringValue(value: unknown): string { return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value); }
function pairs(value: unknown): [string, unknown][] { return value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : [['value', value]]; }
function quoted(text: string, values: string[] = []): string[] {
  const selected = new Set<string>();
  if (text.length >= 8) selected.add(text.slice(0, 1600));
  for (const value of values) {
    if (!value) continue;
    // Parsed CSV/JSON strings may be escaped in their original representation.
    const candidates = [value, value.replaceAll('"', '""'), JSON.stringify(value).slice(1, -1)];
    const position = candidates.map(candidate => text.indexOf(candidate)).find(index => index >= 0) ?? -1;
    if (position < 0) continue;
    const start = Math.max(0, Math.min(position - 30, text.length - 8));
    selected.add(text.slice(start, start + 1600));
  }
  return [...selected].filter(quote => quote.length >= 8).slice(0, 8);
}

/** Whole-file ingestion has no model calls or row cap. Memory is O(largest record + one graph batch);
 * original record text is retained even when display properties exceed graph presentation limits. */
export async function* structuredBatches(source: StructuredSource, chunks: AsyncIterable<string> | Iterable<string>, options: { signal?: AbortSignal } = {}): AsyncGenerator<StructuredBatch> {
  const namespace = createHash('sha256').update(source.id).digest('hex').slice(0, 20);
  let entities: ExtractedEntity[] = []; let relationships: ExtractedRelationship[] = []; let texts: string[] = []; let recordCount = 0; let firstRecord = 0; let batch = 0;
  let textSize = 0; let truncated = false; let represented = false;
  const documentId = () => `structured-${namespace}-${batch + 1}`;
  const flush = (): StructuredBatch => {
    const last = firstRecord + recordCount - 1;
    const result: StructuredBatch = {
      documents: [{ id: documentId(), name: shorten(`${source.name} · 레코드 ${firstRecord}–${last}`, 300), text: texts.join('\n'), identityScope: source.identityScope ?? source.id }], records: recordCount,
      extraction: {
        title: shorten(`${source.name} · 레코드 ${firstRecord}–${last}`, 200), summary: `${recordCount}개 구조화 레코드를 모델 호출 없이 변환했습니다. 명시된 필드에서만 객체와 관계를 만들었습니다.`,
        entities, relationships, events: [], findings: [], limitations: [
          '명시된 컬럼명과 값만 변환했습니다. 알 수 없는 스키마는 레코드 객체로 보존하며 의미 관계를 추정하지 않습니다.',
          '자료는 원본 레코드 발췌입니다. CSV 헤더와 JSON 배열 경로는 출처 문맥으로 함께 표시됩니다. 원본 파일은 업로드 저장소에 보존됩니다.',
          ...(truncated ? ['그래프 표시 한도로 긴 속성, 긴 이름 또는 18개를 초과한 필드는 일부 생략해 표시했습니다. 전체 값은 해당 레코드 원문에 보존됩니다.'] : []),
          ...(represented ? ['8자 미만 레코드는 인용 최소 길이를 위해 번호와 원문을 함께 표시합니다. JSON 래퍼의 배열 외 필드는 메타데이터 발췌로 표시됩니다.'] : []),
        ],
      },
    };
    entities = []; relationships = []; texts = []; recordCount = 0; textSize = 0; truncated = false; represented = false; batch++;
    return result;
  };
  const add = (record: RecordValue) => {
    if (!recordCount) firstRecord = record.ordinal;
    const entries = pairs(record.value);
    const byName = new Map(entries.filter(([, value]) => typeof value === 'string' || typeof value === 'number').map(([key, value]) => [normalized(key), stringValue(value).trim()]));
    const find = (role: keyof typeof labels) => labels[role].map(key => byName.get(key)).find(value => value && value !== 'null') ?? '';
    const imo = find('imo'); const mmsi = find('mmsi');
    const vessel = find('vessel'); const person = find('person'); const organization = find('organization'); const place = find('place');
    const type: EntityType = vessel || imo || mmsi ? 'vessel' : person ? 'person' : organization ? 'organization' : place ? 'place' : 'asset';
    const label = vessel || (imo ? `IMO ${imo}` : '') || (mmsi ? `MMSI ${mmsi}` : '') || person || organization || place || `레코드 ${record.ordinal} · ${source.name}`;
    const id = `row-${namespace}-${record.ordinal}`;
    let raw = record.raw;
    if (raw.length < 8) { raw = `원본 레코드 ${record.ordinal}:\n${raw}`; represented = true; }
    represented ||= Boolean(record.representation);
    const text = `${record.context ? `${record.context}\n` : ''}${raw}`;
    texts.push(text); textSize += text.length; recordCount++;
    const evidence = quoted(raw, [imo, mmsi, vessel, person, organization, place]).map(quote => ({ documentId: documentId(), quote }));
    const usedPropertyNames = new Set(['원본 레코드 번호', '생략 필드 수']);
    const properties = entries.slice(0, 18).map(([key, value], index) => {
      const base = shorten(key.trim() || `column_${index + 1}`, 85); let displayKey = base; let suffix = 2;
      while (usedPropertyNames.has(displayKey)) displayKey = `${base} [${suffix++}]`;
      usedPropertyNames.add(displayKey);
      return { key: displayKey, value: shorten(stringValue(value), 500) };
    });
    properties.push({ key: '원본 레코드 번호', value: String(record.ordinal) });
    if (entries.length > 18) properties.push({ key: '생략 필드 수', value: String(entries.length - 18) });
    truncated ||= label.length > 180 || entries.length > 18 || entries.some(([key, value]) => key.length > 90 || stringValue(value).length > 500);
    const identifiers = ([['imo', imo], ['mmsi', mmsi]] as const).filter(([, value]) => value && value.length <= 100 && evidence.some(item => item.quote.includes(value))).map(([namespace, value]) => ({ namespace, value }));
    entities.push({ id, label: entityLabel(label), type, description: `구조화 자료의 ${record.ordinal}번째 레코드.`, identifiers, properties, evidence });
    const secondary = (role: keyof typeof labels, entityType: EntityType, relation?: 'owns' | 'operates' | 'located_in' | 'visited') => {
      const value = find(role); if (!value || value === label) return;
      const otherId = `${id}-${role}`;
      const otherEvidence = quoted(raw, [value, vessel]).map(quote => ({ documentId: documentId(), quote }));
      entities.push({ id: otherId, label: entityLabel(value), type: entityType, description: `명시된 ${role} 필드의 값.`, identifiers: [], properties: [], evidence: otherEvidence });
      truncated ||= value.length > 180;
      if (relation && type === 'vessel') {
        const reversed = relation === 'owns' || relation === 'operates';
        relationships.push({ id: `rel-${otherId}`, source: reversed ? otherId : id, target: reversed ? id : otherId, type: relation, label: ({ owns: '소유', operates: '운영', located_in: '위치', visited: '방문' })[relation], description: `원본 ${role} 컬럼의 명시적 값.`, status: 'reported', evidence: otherEvidence });
      }
    };
    secondary('owner', 'asset', 'owns'); secondary('ownerCompany', 'organization', 'owns'); secondary('operator', 'asset', 'operates'); secondary('operatorCompany', 'organization', 'operates');
    secondary('port', 'place'); secondary('currentPort', 'place', 'located_in'); secondary('visitedPort', 'place', 'visited');
  };
  for await (const record of structuredRecords(source, chunks, options)) {
    abort(options.signal);
    // One record adds at most eight entities/seven edges. A giant record is never silently discarded.
    if (recordCount && (entities.length + 8 > 180 || textSize > 256_000 || recordCount >= 150)) yield flush();
    add(record);
  }
  if (recordCount) yield flush();
}
