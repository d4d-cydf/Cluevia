import { readRelationClaim } from '../src/lib/claim.ts';
import { createHash, randomUUID } from 'node:crypto';
import { typedValuesFor } from './ontology-schema.ts';
import { GraphValidationError, GRAPH_LIMITS, parseGraphDocument } from '../src/lib/graph-document.ts';
import type { GraphDocument, GraphGenerationInput } from '../src/types/graph.ts';
import type { EntityType, RelationType, OntologyEvidence, OntologyExtraction, OntologyIdentifier, OntologyDefinition, ExtractedEntity } from '../src/types/ontology.ts';

export const ONTOLOGY_ENTITY_TYPES: { id: EntityType; label: string; color: string }[] = [
  { id: 'vessel', label: '선박', color: '#e5a34f' }, { id: 'organization', label: '기관·회사', color: '#54b5af' },
  { id: 'person', label: '인물', color: '#7399d5' }, { id: 'place', label: '장소', color: '#9a8dde' },
  { id: 'event', label: '사건', color: '#dc7880' }, { id: 'document', label: '자료', color: '#879397' },
  { id: 'asset', label: '자산·대상', color: '#a9b666' },
];
export const ONTOLOGY_RELATION_TYPES: { id: RelationType; label: string }[] = [
  { id: 'operates', label: '운영' }, { id: 'owns', label: '소유' }, { id: 'located_in', label: '위치' },
  { id: 'participated_in', label: '참여' }, { id: 'reported_by', label: '보고 기관' }, { id: 'mentions', label: '언급' },
  { id: 'encountered', label: '조우' }, { id: 'visited', label: '방문' }, { id: 'part_of', label: '소속·구성' },
  { id: 'associated_with', label: '관련' },
];
const string = (maxLength: number, minLength = 1) => ({ type: 'string', minLength, maxLength });
const array = (items: unknown, maxItems: number, minItems = 0) => ({ type: 'array', items, minItems, maxItems });
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const id = { ...string(80), pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$' };
const evidence = array(object({ documentId: id, quote: string(1600, 8) }), 8, 1);
const refs = array(id, 200);

const claimSchema = object({ stance: { type: 'string', enum: ['asserted', 'denied', 'retracted', 'uncertain'] }, ...Object.fromEntries(['attributedTo', 'validFrom', 'validTo', 'publishedAt', 'derivedFrom'].map(key => [key, { anyOf: [string(500), { type: 'null' }] }])) });
const relationship = (type: unknown) => {
  const fields = { id, source: id, target: id, type, label: string(150), description: string(2000, 0), status: { type: 'string', enum: ['reported', 'inferred'] }, evidence };
  return { anyOf: [object({ ...fields, claim: claimSchema }), object(fields)] };
};

/** JSON Schema for constrained model output. Every object has an exact, closed shape. */
export const extractionSchema = object({
  title: string(200), summary: string(5000),
  entities: array(object({ id, label: string(180), type: { type: 'string', enum: ONTOLOGY_ENTITY_TYPES.map(t => t.id) }, description: string(2000, 0), identifiers: array(object({ namespace: string(40), value: string(100) }), 8), properties: array(object({ key: string(100), value: string(500, 0) }), 20), evidence }), GRAPH_LIMITS.nodes),
  relationships: array(relationship({ type: 'string', enum: ONTOLOGY_RELATION_TYPES.map(t => t.id) }), GRAPH_LIMITS.edges),
  events: array(object({ id, label: string(180), date: string(40), endDate: { anyOf: [string(40), { type: 'null' }] }, description: string(2000, 0), entityIds: { ...refs, minItems: 1 }, evidence }), GRAPH_LIMITS.events),
  findings: array(object({ text: string(2000), entityIds: refs, relationshipIds: { ...refs, maxItems: 500 }, evidence }), 30),
  limitations: array(string(1000), 20),
});

/** A schema-bound extraction uses domain API names, never the legacy maritime vocabulary. */
export function extractionSchemaFor(definition: OntologyDefinition): Record<string, unknown> {
  const schema = structuredClone(extractionSchema);
  schema.properties.entities = array(object({ id, label: string(180), type: { type: 'string', enum: definition.objectTypes.map(t => t.apiName) }, description: string(2000, 0), identifiers: array(object({ namespace: string(40), value: string(100) }), 8), properties: array(object({ key: { ...string(64), enum: [...new Set(definition.objectTypes.flatMap(t => t.properties.map(p => p.apiName)))] }, value: string(500, 0) }), 20), evidence }), GRAPH_LIMITS.nodes);
  schema.properties.relationships = array(relationship({ type: 'string', enum: definition.linkTypes.length ? definition.linkTypes.map(t => t.apiName) : ['__none__'] }), definition.linkTypes.length ? GRAPH_LIMITS.edges : 0);
  return schema;
}

type JsonSchema = { type?: string; properties?: Record<string, JsonSchema>; required?: string[]; items?: JsonSchema; enum?: string[]; minLength?: number; maxLength?: number; minItems?: number; maxItems?: number; pattern?: string; anyOf?: JsonSchema[] };
function fail(path: string, message: string): never { throw new GraphValidationError(`${path}: ${message}`); }
function validate(value: unknown, schema: JsonSchema, path: string): void {
  if (schema.anyOf) {
    if (!schema.anyOf.some(candidate => { try { validate(value, candidate, path); return true; } catch { return false; } })) fail(path, '허용된 자료형이 아닙니다.');
    return;
  }
  if (schema.type === 'null') { if (value !== null) fail(path, 'null이 필요합니다.'); return; }
  if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity) || ((schema.minLength ?? 0) > 0 && !value.trim())) fail(path, '문자열 길이가 올바르지 않습니다.');
    if (schema.enum && !schema.enum.includes(value)) fail(path, '등록되지 않은 온톨로지 유형입니다.');
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail(path, 'ID 형식이 올바르지 않습니다.');
    return;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) fail(path, '배열 크기가 올바르지 않습니다.');
    value.forEach((entry, index) => validate(entry, schema.items!, `${path}[${index}]`)); return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, '객체가 필요합니다.');
  const entry = value as Record<string, unknown>;
  for (const key of Object.keys(entry)) if (!Object.hasOwn(schema.properties!, key)) fail(`${path}.${key}`, '정의되지 않은 필드입니다.');
  for (const key of schema.required ?? []) { if (!Object.hasOwn(entry, key)) fail(`${path}.${key}`, '필수 필드입니다.'); validate(entry[key], schema.properties![key], `${path}.${key}`); }
}
function exactDate(value: string, path: string): void {
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) fail(path, '실제 ISO 날짜가 필요합니다.');
}
function uniqueIds(items: { id: string }[], path: string): Set<string> {
  const ids = new Set(items.map(item => item.id)); if (ids.size !== items.length) fail(path, '중복 ID입니다.'); return ids;
}
function references(items: string[], allowed: Set<string>, path: string): void {
  if (new Set(items).size !== items.length) fail(path, '중복 참조입니다.');
  for (const item of items) if (!allowed.has(item)) fail(path, `존재하지 않는 ID: ${item}`);
}

/** Exact quotation checking establishes provenance, not the truth of the model's interpretation. */
export class InsufficientEvidenceError extends Error {
  constructor() { super('제공된 자료에서 질문에 답할 객체와 근거를 찾지 못했습니다. 관련 자료를 추가하거나 질문을 구체화해주세요.'); this.name = 'InsufficientEvidenceError'; }
}

/** Metadata keys identify the supplied source or an evidence-backed extraction. They do not
 * establish a business identifier and never weaken quotation checks on evidence properties. */
function assignSourceMetadata(entity: ExtractedEntity, input: GraphGenerationInput, definition: OntologyDefinition, replaceVerified = false): void {
  const type = definition.objectTypes.find(type => type.apiName === entity.type)!;
  const sourceIds = [...new Set(entity.evidence.map(item => item.documentId))];
  for (const property of type.properties) {
    const source = property.valueSource ?? 'evidence';
    if (source === 'evidence') continue;
    const supplied = entity.properties.find(item => item.key === property.apiName);
    let expected: string;
    if (source === 'evidenceId') {
      const anchors = [...new Set(entity.evidence.map(item => {
        const document = input.documents.find(document => document.id === item.documentId)!;
        return JSON.stringify([document.identityScope ?? document.id, item.quote]);
      }))].sort();
      expected = `evidence-${createHash('sha256').update(JSON.stringify([type.apiName, anchors])).digest('hex').slice(0, 32)}`;
    } else {
      if (sourceIds.length !== 1) {
        if (!supplied && !property.required && property.apiName !== type.primaryKey && property.apiName !== type.titleProperty) continue;
        fail(`entity ${entity.id}.${property.apiName}`, '자료 메타데이터 속성에는 하나의 명확한 출처가 필요합니다.');
      }
      const document = input.documents.find(document => document.id === sourceIds[0])!;
      expected = source === 'documentId' ? document.id : document.name;
    }
    if (supplied && supplied.value !== expected && !replaceVerified) fail(`entity ${entity.id}.${property.apiName}`, '자료 메타데이터 값이 검증된 출처와 일치하지 않습니다. 서버가 지정하는 속성은 생략해주세요.');
    if (replaceVerified && supplied && property.apiName === type.titleProperty && entity.label === supplied.value) entity.label = expected.slice(0, 180);
    if (supplied) supplied.value = expected;
    else entity.properties.push({ key: property.apiName, value: expected });
  }
}

export function parseExtraction(value: unknown, input: GraphGenerationInput, definition?: OntologyDefinition): OntologyExtraction {
  validate(value, (definition ? extractionSchemaFor(definition) : extractionSchema) as JsonSchema, 'extraction');
  const result = structuredClone(value) as OntologyExtraction;
  if (!result.entities.length) throw new InsufficientEvidenceError();
  const documents = new Map(input.documents.map(document => [document.id, document.text]));
  if (documents.size !== input.documents.length) fail('documents', '중복 자료 ID입니다.');
  function checkEvidence(items: OntologyEvidence[], path: string): void {
    for (const item of items) {
      const text = documents.get(item.documentId);
      if (text === undefined) fail(path, `등록되지 않은 출처: ${item.documentId}`);
      if (!text.includes(item.quote)) fail(path, '인용문이 원문과 정확히 일치하지 않습니다.');
    }
  }
  const entityIds = uniqueIds(result.entities, 'entities'); const relationIds = uniqueIds(result.relationships, 'relationships'); uniqueIds(result.events, 'events');
  for (const entity of result.entities) {
    checkEvidence(entity.evidence, `entity ${entity.id}.evidence`);
    if (new Set(entity.properties.map(p => p.key)).size !== entity.properties.length) fail(`entity ${entity.id}.properties`, '중복 속성입니다.');
    for (const identifier of entity.identifiers) {
      if (!entity.evidence.some(item => containsIdentifier(item.quote, identifier.value))) fail(`entity ${entity.id}.identifiers`, '식별자가 인용문에 없습니다.');
    }
  }
  if (definition) {
    const primaryKeys = new Map<string, string>();
    for (const entity of result.entities) {
      assignSourceMetadata(entity, input, definition);
      const values = typedValuesFor(entity, definition);
      const type = definition.objectTypes.find(type => type.apiName === entity.type)!;
      const primary = values[type.primaryKey];
      const primaryProperty = type.properties.find(property => property.apiName === type.primaryKey)!;
      if ((primaryProperty.valueSource ?? 'evidence') === 'evidence' && typeof primary === 'string' && ['string', 'long'].includes(primaryProperty.baseType) && !entity.evidence.some(item => groundedIdentity(item.quote, primary))) fail(`entity ${entity.id}.${type.primaryKey}`, 'Primary Key 값이 인용된 원문에 없습니다. 식별 키를 생성하거나 추측할 수 없습니다.');
      if (primary !== undefined) {
        const scopes = type.identityScope === 'source'
          ? [...new Set(entity.evidence.map(item => input.documents.find(document => document.id === item.documentId)!.identityScope ?? item.documentId))]
          : ['ontology'];
        for (const scope of scopes) {
          const key = JSON.stringify([type.apiName, scope, primary]);
          if (primaryKeys.has(key)) fail(`entity ${entity.id}`, `중복 Primary Key: ${type.primaryKey}`);
          primaryKeys.set(key, entity.id);
        }
      }
    }
  }
  const entityMap = new Map(result.entities.map(item => [item.id, item]));
  const cardinality = new Map<string, Set<string>>();
  for (const relation of result.relationships) {
    references([relation.source, relation.target], entityIds, `relationship ${relation.id}`);
    checkEvidence(relation.evidence, `relationship ${relation.id}.evidence`);
    if (relation.claim) {
      relation.claim = readRelationClaim(relation.claim);
      for (const field of ['attributedTo', 'derivedFrom'] as const) {
        const value = relation.claim[field];
        if (value && !relation.evidence.some(item => containsIdentifier(item.quote, value))) fail(`relationship ${relation.id}.claim.${field}`, '주장 주체와 재인용 출처는 인용문에 있어야 합니다.');
      }
      for (const field of ['validFrom', 'validTo', 'publishedAt'] as const) {
        const value = relation.claim[field];
        if (value && !relation.evidence.some(item => item.quote.includes(value.slice(0, 10)))) fail(`relationship ${relation.id}.claim.${field}`, '정규화한 날짜를 뒷받침하는 ISO 날짜 인용이 필요합니다. 불명확하면 null로 보존하세요.');
      }
    }
    const source = entityMap.get(relation.source)!; const target = entityMap.get(relation.target)!;
    if (definition) {
      const link = definition.linkTypes.find(type => type.apiName === relation.type)!;
      if (!link || source.type !== link.sourceType || target.type !== link.targetType) fail(`relationship ${relation.id}`, 'Link Type의 출발·대상 객체 유형이 일치하지 않습니다.');
      if (relation.claim && (relation.claim.stance !== 'asserted' || relation.claim.validFrom || relation.claim.validTo)) continue;
      for (const [side, multiplicity, fixed, other] of [['target', link.targetCardinality, source.id, target.id], ['source', link.sourceCardinality, target.id, source.id]]) {
        const key = `${link.apiName}:${side}:${fixed}`; const related = cardinality.get(key) ?? new Set<string>(); related.add(other); cardinality.set(key, related);
        if (multiplicity === 'one' && related.size > 1) fail(`relationship ${relation.id}`, 'Link Type의 one Cardinality 제약을 위반했습니다.');
      }
      continue;
    }
    if (relation.type === 'encountered' && (source.type !== 'vessel' || target.type !== 'vessel')) fail(`relationship ${relation.id}`, '조우 관계는 두 선박 사이에만 사용할 수 있습니다.');
    if (['located_in', 'visited'].includes(relation.type) && target.type !== 'place') fail(`relationship ${relation.id}`, '위치·방문 관계의 대상은 장소여야 합니다.');
    if (relation.type === 'participated_in' && target.type !== 'event') fail(`relationship ${relation.id}`, '참여 관계의 대상은 사건이어야 합니다.');
    if (relation.type === 'reported_by' && !['person', 'organization', 'document'].includes(target.type)) fail(`relationship ${relation.id}`, '보고 관계의 대상 유형이 올바르지 않습니다.');
  }
  for (const event of result.events) {
    references(event.entityIds, entityIds, `event ${event.id}`); checkEvidence(event.evidence, `event ${event.id}.evidence`); exactDate(event.date, `event ${event.id}.date`);
    if (event.endDate !== null) { exactDate(event.endDate, `event ${event.id}.endDate`); if (Date.parse(event.endDate) < Date.parse(event.date)) fail(`event ${event.id}`, '종료일이 시작일보다 빠릅니다.'); }
  }
  for (const finding of result.findings) { references(finding.entityIds, entityIds, 'finding.entityIds'); references(finding.relationshipIds, relationIds, 'finding.relationshipIds'); checkEvidence(finding.evidence, 'finding.evidence'); }
  return result;
}

/** Rebind a validated canonical extraction to the corresponding real source documents.
 * Only declared server metadata is recalculated after checking its original value. */
export function rebindExtractionSources(value: OntologyExtraction, from: GraphGenerationInput, to: GraphGenerationInput, definition?: OntologyDefinition): OntologyExtraction {
  if (from.documents.length !== to.documents.length) fail('documents', '출처 재연결 대상 수가 일치하지 않습니다.');
  const result = parseExtraction(value, from, definition);
  const byId = new Map(from.documents.map((document, index) => {
    if (document.text !== to.documents[index].text) fail('documents', '다른 원문으로 출처를 재연결할 수 없습니다.');
    return [document.id, to.documents[index].id];
  }));
  const reboundEvidence = new Set<OntologyEvidence>();
  for (const item of [...result.entities, ...result.relationships, ...result.events, ...result.findings]) {
    for (const evidence of item.evidence) {
      // In-process extractors may share one evidence object across several claims.
      if (reboundEvidence.has(evidence)) continue;
      evidence.documentId = byId.get(evidence.documentId)!;
      reboundEvidence.add(evidence);
    }
  }
  if (definition) for (const entity of result.entities) assignSourceMetadata(entity, to, definition, true);
  return parseExtraction(result, to, definition);
}

function sourceIds(items: OntologyEvidence[]): string[] { return [...new Set(items.map(item => item.documentId))]; }
export function compileExtraction(value: unknown, input: GraphGenerationInput, definition?: OntologyDefinition): GraphDocument {
  const extraction = parseExtraction(value, input, definition);
  const types = new Set(extraction.entities.map(entity => entity.type));
  return parseGraphDocument({
    schemaVersion: '1.0', id: `graph-${randomUUID()}`, origin: 'codex', createdAt: new Date().toISOString(),
    title: extraction.title, summary: extraction.summary, question: input.question,
    limitations: [...extraction.limitations.slice(0, 19), '인용문과 자료 구조를 자동 검증했습니다. 관계 해석과 사실 여부는 원문 검토가 필요합니다.'],
    groups: definition ? definition.objectTypes.filter(type => types.has(type.apiName)).map(type => ({ id: type.apiName, label: type.displayName, color: type.color })) : ONTOLOGY_ENTITY_TYPES.filter(type => types.has(type.id)).map(type => ({ id: type.id, label: type.label, color: type.color })),
    sources: input.documents.map(document => ({ id: document.id, title: document.name, contentHash: createHash('sha256').update(document.text).digest('hex'), sourceFamily: createHash('sha256').update(document.url ?? document.identityScope ?? document.text).digest('hex'), ...(document.url ? { url: document.url } : {}), excerpt: document.text.slice(0, 1200) })),
    nodes: extraction.entities.map(entity => ({ id: entity.id, label: entity.label, type: entity.type, group: entity.type, description: entity.description, sourceIds: sourceIds(entity.evidence), properties: Object.fromEntries([...entity.properties.map(p => [p.key, p.value]), ...entity.identifiers.slice(0, 5).map(i => [`ID · ${i.namespace}`, i.value])]) })),
    edges: extraction.relationships.map(relation => ({ id: relation.id, source: relation.source, target: relation.target, label: relation.label, description: relation.description, status: relation.status, ...(relation.claim ? { claim: relation.claim } : {}), sourceIds: sourceIds(relation.evidence) })),
    events: extraction.events.map(event => ({ id: event.id, label: event.label, date: event.date, ...(event.endDate ? { endDate: event.endDate } : {}), description: event.description, nodeIds: event.entityIds, sourceIds: sourceIds(event.evidence) })),
    findings: extraction.findings.map(finding => ({ text: finding.text, nodeIds: finding.entityIds, edgeIds: finding.relationshipIds, sourceIds: sourceIds(finding.evidence) })),
  });
}

/** Verify literal identity anchors, including CSV doubled quotes and JSON string escapes.
 * This checks occurrence, not that every semantic claim associated with the anchor is true. */
function groundedIdentity(quote: string, value: string): boolean {
  const forms = [...new Set([value, value.replaceAll('"', '""'), JSON.stringify(value).slice(1, -1)])];
  for (const form of forms) {
    let offset = quote.indexOf(form);
    while (offset >= 0) {
      const before = quote[offset - 1] ?? ''; const after = quote[offset + form.length] ?? '';
      const startsAscii = /^[A-Za-z0-9]/.test(form); const endsAscii = /[A-Za-z0-9]$/.test(form);
      if ((!startsAscii || !/[A-Za-z0-9]/.test(before)) && (!endsAscii || !/[A-Za-z0-9]/.test(after))) return true;
      offset = quote.indexOf(form, offset + 1);
    }
  }
  // JSON permits unicode escapes instead of the literal characters of a string value.
  for (const token of quote.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    try { if (JSON.parse(token[0]) === value) return true; } catch { /* Not a JSON string token. */ }
  }
  return false;
}

function containsIdentifier(quote: string, value: string): boolean {
  return quote.includes(value) && new RegExp(`(^|[^A-Za-z0-9])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9])`, 'u').test(quote);
}
/** Only identifiers with stable namespaces and exact quoted values can join unrelated sources. */
export function strongIdentifier(identifier: OntologyIdentifier, evidence: OntologyEvidence[]): string | undefined {
  const namespace = identifier.namespace.trim().toLowerCase(); const value = identifier.value.trim().toUpperCase();
  if (!evidence.some(item => containsIdentifier(item.quote, identifier.value))) return undefined;
  if (namespace === 'imo' && /^\d{7}$/.test(value) && [...value.slice(0, 6)].reduce((sum, digit, index) => sum + Number(digit) * (7 - index), 0) % 10 === Number(value[6])) return `imo:${value}`;
  if (namespace === 'wikidata' && /^Q[1-9]\d*$/.test(value)) return `wikidata:${value}`;
  if (namespace === 'lei' && /^[0-9A-Z]{18}\d{2}$/.test(value)) {
    const digits = [...value].map(char => /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char).join('');
    let modulus = 0; for (const digit of digits) modulus = (modulus * 10 + Number(digit)) % 97;
    if (modulus === 1) return `lei:${value}`;
  }
  return undefined;
}

export function coarseEntityType(type: string, group = ''): EntityType {
  const value = `${type} ${group}`.toLowerCase();
  if (/vessel|carrier|longliner|ship|선박/.test(value)) return 'vessel';
  if (/organization|agency|company|navy|기관|회사/.test(value)) return 'organization';
  if (/person|인물/.test(value)) return 'person';
  if (/place|region|port|reserve|location|장소/.test(value)) return 'place';
  if (/event|encounter|seizure|incident|사건/.test(value)) return 'event';
  if (/document|source|자료/.test(value)) return 'document';
  return 'asset';
}
