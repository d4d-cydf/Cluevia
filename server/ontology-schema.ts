import { randomUUID } from 'node:crypto';
import { GraphValidationError } from '../src/lib/graph-document.ts';
import type { ExtractedEntity, JsonValue, OntologyDefinition, PropertyBaseType, PropertyDefinition, ValueConstraints } from '../src/types/ontology.ts';

export const PROPERTY_BASE_TYPES: PropertyBaseType[] = ['string', 'integer', 'short', 'date', 'timestamp', 'boolean', 'byte', 'long', 'float', 'double', 'decimal', 'vector', 'array', 'struct', 'mediaReference', 'timeSeries', 'geotemporalSeries', 'attachment', 'geopoint', 'geoshape', 'marking', 'cipher'];
const visibility = ['normal', 'prominent', 'hidden'] as const;
const lifecycle = ['active', 'experimental', 'deprecated'] as const;
const colors = ['#54b5af', '#7399d5', '#e5a34f', '#9a8dde', '#dc7880', '#a9b666'];
const scalarKeyTypes = new Set<PropertyBaseType>(['string', 'integer', 'short', 'byte', 'long', 'date', 'timestamp', 'boolean']);
function fail(path: string, message: string): never { throw new GraphValidationError(`${path}: ${message}`); }
function obj(value: unknown, path: string, allowed?: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, '객체가 필요합니다.');
  const result = value as Record<string, unknown>;
  if (allowed) for (const key of Object.keys(result)) if (!allowed.includes(key)) fail(`${path}.${key}`, '정의되지 않은 필드입니다.');
  return result;
}
function list(value: unknown, path: string, max = 40, min = 0): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(path, `${min}–${max}개 배열이 필요합니다.`);
  return value;
}
function text(value: unknown, path: string, max = 2000, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) fail(path, '문자열 길이가 올바르지 않습니다.');
  return value.trim();
}
function api(value: unknown, path: string): string {
  const name = text(value, path, 64);
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name) || ['constructor', 'prototype', '__proto__'].includes(name)) fail(path, '영문자로 시작하는 안전한 API 이름이 필요합니다.');
  return name;
}
function enumeration<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail(path, `허용 값: ${allowed.join(', ')}`);
  return value as T;
}
function bool(value: unknown, path: string): boolean { if (typeof value !== 'boolean') fail(path, 'boolean이 필요합니다.'); return value; }
function names(value: unknown, path: string, max = 40): string[] {
  const result = list(value ?? [], path, max).map((v, i) => api(v, `${path}[${i}]`));
  if (new Set(result).size !== result.length) fail(path, '중복 참조입니다.');
  return result;
}
function unique<T extends { apiName: string }>(items: T[], path: string): Map<string, T> {
  const result = new Map(items.map(item => [item.apiName, item]));
  if (items.length !== result.size) fail(path, '중복 API 이름입니다.');
  return result;
}
function constraintDefinition(value: unknown, path: string, baseType?: PropertyBaseType): ValueConstraints {
  const raw = obj(value ?? {}, path, ['enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'format', 'uniqueItems']);
  const result: ValueConstraints = {};
  if (raw.enum != null) {
    result.enum = list(raw.enum, `${path}.enum`, 100, 1).map(v => {
      if (!['string', 'number', 'boolean'].includes(typeof v) || (typeof v === 'number' && !Number.isFinite(v))) fail(path, 'enum 값은 문자열·수·boolean이어야 합니다.');
      return v as string | number | boolean;
    });
    if (new Set(result.enum.map(v => JSON.stringify(v))).size !== result.enum.length) fail(path, '중복 enum 값입니다.');
    if (baseType && !['string', 'boolean', 'byte', 'short', 'integer', 'float', 'double', 'long', 'decimal', 'date', 'timestamp'].includes(baseType)) fail(path, 'enum 제약은 스칼라 타입에만 지원합니다.');
    if (baseType && result.enum.some(v => typeof v !== (baseType === 'boolean' ? 'boolean' : ['byte', 'short', 'integer', 'float', 'double'].includes(baseType) ? 'number' : 'string'))) fail(path, 'enum 값이 기본 타입과 일치하지 않습니다.');
  }
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength'] as const) if (raw[key] != null) {
    const number = raw[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || (key.endsWith('Length') && (!Number.isSafeInteger(number) || number < 0 || number > 500))) fail(path, '제약 수치가 올바르지 않습니다.');
    result[key] = number;
  }
  if (result.minimum !== undefined && result.maximum !== undefined && result.minimum > result.maximum) fail(path, '최솟값이 최댓값보다 큽니다.');
  if (result.minLength !== undefined && result.maxLength !== undefined && result.minLength > result.maxLength) fail(path, '최소 길이가 최대 길이보다 큽니다.');
  if (raw.pattern != null) {
    result.pattern = text(raw.pattern, `${path}.pattern`, 160);
    // This declarative subset intentionally excludes branches, groups, backreferences and lookarounds.
    if (/[()|]/.test(result.pattern) || /\\[1-9]/.test(result.pattern)) fail(path, '정규식은 그룹·분기·역참조 없이 정의해야 합니다.');
    const operators = result.pattern.replace(/\\./g, 'X').replace(/\[[^\]]*\]/g, 'X');
    if ((operators.match(/[?*+]|\{\d+,\d*\}/g) ?? []).length > 1) fail(path, '정규식에는 가변 반복 연산자를 하나만 사용할 수 있습니다.');
    try { new RegExp(result.pattern, 'u'); } catch { fail(path, '올바르지 않은 정규식입니다.'); }
  }
  if (raw.format != null) result.format = enumeration(raw.format, ['uuid'] as const, `${path}.format`);
  if (raw.uniqueItems != null) result.uniqueItems = bool(raw.uniqueItems, `${path}.uniqueItems`);
  if (baseType) {
    if ((result.minimum !== undefined || result.maximum !== undefined) && !['byte', 'short', 'integer', 'float', 'double'].includes(baseType)) fail(path, '범위 제약은 정확히 표현 가능한 숫자 타입에만 지원합니다.');
    if ((result.pattern || result.format) && !['string', 'long', 'decimal'].includes(baseType)) fail(path, '문자 패턴 제약의 기본 타입이 올바르지 않습니다.');
    if ((result.minLength !== undefined || result.maxLength !== undefined) && !['string', 'array', 'vector', 'long', 'decimal'].includes(baseType)) fail(path, '길이 제약의 기본 타입이 올바르지 않습니다.');
    if (result.uniqueItems !== undefined && !['array', 'vector'].includes(baseType)) fail(path, '고유 원소 제약은 배열에만 사용할 수 있습니다.');
  }
  return result;
}
function property(value: unknown, path: string, nested = false): PropertyDefinition {
  const raw = obj(value, path, ['apiName', 'displayName', 'description', 'baseType', 'required', 'valueSource', 'visibility', 'sharedProperty', 'valueType', 'elementType', 'fields', 'constraints', 'renderHints', 'typeClasses']);
  const name = api(raw.apiName, `${path}.apiName`);
  const baseType = enumeration(raw.baseType, PROPERTY_BASE_TYPES, `${path}.baseType`);
  const valueSource = enumeration(raw.valueSource ?? 'evidence', ['evidence', 'documentId', 'documentName', 'evidenceId'] as const, `${path}.valueSource`);
  if (valueSource !== 'evidence' && (baseType !== 'string' || nested)) fail(path, '자료 메타데이터 속성은 최상위 String 속성이어야 합니다.');
  if (nested && ['array', 'struct'].includes(baseType)) fail(path, 'Struct 필드의 중첩 Struct·Array는 지원하지 않습니다.');
  const result: PropertyDefinition = {
    apiName: name, displayName: text(raw.displayName ?? name, `${path}.displayName`, 100), description: text(raw.description ?? '', `${path}.description`, 2000, true), baseType,
    required: bool(raw.required ?? false, `${path}.required`), valueSource, visibility: enumeration(raw.visibility ?? 'normal', visibility, `${path}.visibility`),
    renderHints: list(raw.renderHints ?? [], `${path}.renderHints`, 10).map(v => text(v, path, 80)),
    typeClasses: list(raw.typeClasses ?? [], `${path}.typeClasses`, 20).map(v => { const item = obj(v, path, ['kind', 'name']); return { kind: text(item.kind, path, 80), name: text(item.name, path, 100) }; }),
  };
  if (raw.sharedProperty != null) result.sharedProperty = api(raw.sharedProperty, `${path}.sharedProperty`);
  if (raw.valueType != null) result.valueType = api(raw.valueType, `${path}.valueType`);
  if (baseType === 'array') {
    result.elementType = enumeration(raw.elementType, PROPERTY_BASE_TYPES.filter(t => !['array', 'struct'].includes(t)), `${path}.elementType`);
  } else if (raw.elementType != null) fail(path, 'elementType은 Array 속성에만 사용할 수 있습니다.');
  if (baseType === 'struct') { result.fields = list(raw.fields, `${path}.fields`, 20, 1).map((v, i) => property(v, `${path}.fields[${i}]`, true)); unique(result.fields, `${path}.fields`); }
  else if (raw.fields != null && list(raw.fields, `${path}.fields`, 0).length) fail(path, 'fields는 Struct 속성에만 사용할 수 있습니다.');
  if (raw.constraints != null) result.constraints = constraintDefinition(raw.constraints, `${path}.constraints`, baseType);
  return result;
}

/** Local ontology schema. IDs are local UUIDs and are never represented as Foundry RIDs. */
export function parseOntologyDefinition(value: unknown, options: { id?: string; version?: number } = {}): OntologyDefinition {
  const raw = obj(value, 'ontology', ['schemaVersion', 'id', 'version', 'apiName', 'displayName', 'description', 'status', 'objectTypes', 'linkTypes', 'sharedProperties', 'interfaces', 'valueTypes', 'groups', 'actionTypes', 'functions', 'processing', 'sourceMappings']);
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== '1.0') fail('schemaVersion', '지원하지 않는 온톨로지 버전입니다.');
  const localId = options.id ?? raw.id ?? `ontology-${randomUUID()}`;
  if (typeof localId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(localId)) fail('id', '로컬 ID 형식이 올바르지 않습니다.');
  const version = options.version ?? raw.version ?? 1;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) fail('version', '양의 정수 버전이 필요합니다.');
  const result: OntologyDefinition = {
    schemaVersion: '1.0', id: localId, version, apiName: api(raw.apiName, 'apiName'), displayName: text(raw.displayName, 'displayName', 150), description: text(raw.description ?? '', 'description', 4000, true), status: enumeration(raw.status ?? 'active', ['draft', 'active', 'deprecated'], 'status'),
    objectTypes: list(raw.objectTypes, 'objectTypes', 12, 1).map((v, index) => {
      const p = `objectTypes[${index}]`; const item = obj(v, p, ['apiName', 'displayName', 'pluralDisplayName', 'description', 'primaryKey', 'titleProperty', 'identityScope', 'properties', 'color', 'icon', 'visibility', 'status', 'implementsInterfaces', 'groups']);
      const name = api(item.apiName, `${p}.apiName`); const properties = list(item.properties, `${p}.properties`, 20, 1).map((x, i) => property(x, `${p}.properties[${i}]`)); const map = unique(properties, `${p}.properties`);
      const primaryKey = api(item.primaryKey, `${p}.primaryKey`); const titleProperty = api(item.titleProperty, `${p}.titleProperty`);
      for (const [key, label] of [[primaryKey, 'primaryKey'], [titleProperty, 'titleProperty']]) {
        const prop = map.get(key); if (!prop) fail(p, `${label} 속성이 존재하지 않습니다.`);
        if (!scalarKeyTypes.has(prop.baseType)) fail(p, `${label}는 스칼라 식별자 타입이어야 합니다.`);
        prop.required = true;
      }
      const color = text(item.color ?? colors[index % colors.length], `${p}.color`, 7); if (!/^#[0-9a-fA-F]{6}$/.test(color)) fail(p, '#RRGGBB 색상이 필요합니다.');
      return { apiName: name, displayName: text(item.displayName ?? name, p, 100), pluralDisplayName: text(item.pluralDisplayName ?? item.displayName ?? name, p, 100), description: text(item.description ?? '', p, 2000, true), primaryKey, titleProperty, identityScope: enumeration(item.identityScope ?? (primaryKey === titleProperty && map.get(primaryKey)!.baseType === 'string' ? 'source' : 'ontology'), ['ontology', 'source'] as const, `${p}.identityScope`), properties, color, icon: text(item.icon ?? 'object', p, 50), visibility: enumeration(item.visibility ?? 'normal', visibility, p), status: enumeration(item.status ?? 'active', lifecycle, p), implementsInterfaces: names(item.implementsInterfaces, `${p}.implementsInterfaces`), groups: names(item.groups, `${p}.groups`) };
    }),
    linkTypes: list(raw.linkTypes ?? [], 'linkTypes', 40).map((v, i) => {
      const p = `linkTypes[${i}]`; const item = obj(v, p, ['apiName', 'displayName', 'inverseDisplayName', 'description', 'sourceType', 'targetType', 'sourceCardinality', 'targetCardinality', 'visibility', 'status']);
      const name = api(item.apiName, p);
      return { apiName: name, displayName: text(item.displayName ?? name, p, 100), inverseDisplayName: text(item.inverseDisplayName ?? item.displayName ?? name, p, 100), description: text(item.description ?? '', p, 2000, true), sourceType: api(item.sourceType, p), targetType: api(item.targetType, p), sourceCardinality: enumeration(item.sourceCardinality, ['one', 'many'], p), targetCardinality: enumeration(item.targetCardinality, ['one', 'many'], p), visibility: enumeration(item.visibility ?? 'normal', visibility, p), status: enumeration(item.status ?? 'active', lifecycle, p) };
    }),
    sharedProperties: list(raw.sharedProperties ?? [], 'sharedProperties', 40).map((v, i) => property(v, `sharedProperties[${i}]`)),
    interfaces: list(raw.interfaces ?? [], 'interfaces', 20).map((v, i) => {
      const p = `interfaces[${i}]`; const item = obj(v, p, ['apiName', 'displayName', 'description', 'properties', 'extendsInterfaces', 'linkTypes', 'searchable']); const name = api(item.apiName, p);
      return { apiName: name, displayName: text(item.displayName ?? name, p, 100), description: text(item.description ?? '', p, 2000, true), properties: list(item.properties ?? [], p, 20).map((x, j) => property(x, `${p}.properties[${j}]`)), extendsInterfaces: names(item.extendsInterfaces, p), linkTypes: names(item.linkTypes, p), searchable: bool(item.searchable ?? false, p) };
    }),
    valueTypes: list(raw.valueTypes ?? [], 'valueTypes', 40).map((v, i) => {
      const p = `valueTypes[${i}]`; const item = obj(v, p, ['apiName', 'displayName', 'description', 'baseType', 'constraints']); const name = api(item.apiName, p); const baseType = enumeration(item.baseType, PROPERTY_BASE_TYPES, p);
      return { apiName: name, displayName: text(item.displayName ?? name, p, 100), description: text(item.description ?? '', p, 2000, true), baseType, constraints: constraintDefinition(item.constraints, p, baseType) };
    }),
    groups: list(raw.groups ?? [], 'groups', 20).map(v => { const item = obj(v, 'group', ['apiName', 'displayName', 'description']); const name = api(item.apiName, 'group'); return { apiName: name, displayName: text(item.displayName ?? name, 'group', 100), description: text(item.description ?? '', 'group', 2000, true) }; }),
    actionTypes: [], functions: [], processing: { textStrategy: 'codex', jevEligibleLinkTypes: [], rationale: '' }, sourceMappings: [],
  };
  const types = unique(result.objectTypes, 'objectTypes'); const links = unique(result.linkTypes, 'linkTypes'); const shared = unique(result.sharedProperties, 'sharedProperties'); const interfaces = unique(result.interfaces, 'interfaces'); const values = unique(result.valueTypes, 'valueTypes'); const groups = unique(result.groups, 'groups');
  for (const link of links.values()) if (!types.has(link.sourceType) || !types.has(link.targetType)) fail(link.apiName, 'Link Type의 객체 타입이 존재하지 않습니다.');
  const checkProperties = (props: PropertyDefinition[], path: string) => {
    unique(props, path);
    for (const prop of props) {
      if (prop.sharedProperty) {
        const target = shared.get(prop.sharedProperty);
        if (!target || target.baseType !== prop.baseType || target.valueSource !== prop.valueSource || target.elementType !== prop.elementType || JSON.stringify(target.fields ?? []) !== JSON.stringify(prop.fields ?? [])) fail(path, '공유 속성 참조 또는 기본 타입이 올바르지 않습니다.');
        if (target.sharedProperty) fail(path, '공유 속성 간 중첩 참조는 지원하지 않습니다.');
      }
      if (prop.valueType) { const target = values.get(prop.valueType); if (!target || target.baseType !== prop.baseType) fail(path, 'Value Type 참조 또는 기본 타입이 올바르지 않습니다.'); }
      if (prop.fields) checkProperties(prop.fields, `${path}.${prop.apiName}`);
    }
  };
  checkProperties(result.sharedProperties, 'sharedProperties');
  const inheritedCache = new Map<string, PropertyDefinition[]>();
  const inherited = (name: string, stack: string[] = []): PropertyDefinition[] => {
    if (stack.includes(name)) fail(name, 'Interface 상속 순환입니다.');
    const cached = inheritedCache.get(name); if (cached) return cached;
    const iface = interfaces.get(name); if (!iface) fail(name, '존재하지 않는 Interface입니다.');
    checkProperties(iface.properties, name);
    for (const link of iface.linkTypes) if (!links.has(link)) fail(name, '존재하지 않는 Link 계약입니다.');
    const properties = [...iface.extendsInterfaces.flatMap(parent => inherited(parent, [...stack, name])), ...iface.properties];
    const byName = new Map<string, PropertyDefinition>();
    for (const prop of properties) { const old = byName.get(prop.apiName); if (old && (old.baseType !== prop.baseType || old.valueSource !== prop.valueSource || old.elementType !== prop.elementType)) fail(name, 'Interface 속성 계약이 충돌합니다.'); byName.set(prop.apiName, prop); }
    const result = [...byName.values()]; inheritedCache.set(name, result); return result;
  };
  for (const iface of interfaces.keys()) inherited(iface);
  for (const type of types.values()) {
    checkProperties(type.properties, type.apiName);
    for (const group of type.groups) if (!groups.has(group)) fail(type.apiName, '존재하지 않는 Object Type Group입니다.');
    for (const interfaceName of type.implementsInterfaces) for (const contract of inherited(interfaceName)) {
      const prop = type.properties.find(p => p.apiName === contract.apiName);
      if (!prop || prop.baseType !== contract.baseType || prop.valueSource !== contract.valueSource || prop.elementType !== contract.elementType || JSON.stringify(prop.fields ?? []) !== JSON.stringify(contract.fields ?? []) || (contract.required && !prop.required)) fail(type.apiName, 'Interface Property 계약을 충족하지 못합니다.');
    }
  }
  for (const kind of ['actionTypes', 'functions'] as const) {
    result[kind] = list(raw[kind] ?? [], kind, 20).map(v => {
      const item = obj(v, kind, ['apiName', 'displayName', 'description', 'executable', 'status', 'parameters', 'objectTypes']); const name = api(item.apiName, kind);
      if (item.executable !== undefined && item.executable !== false) fail(kind, '실행 가능한 모델 생성 로직은 지원하지 않습니다.');
      if (item.status !== undefined && item.status !== 'draft') fail(kind, 'Action·Function은 draft 선언만 지원합니다.');
      const objectTypes = names(item.objectTypes, kind); for (const type of objectTypes) if (!types.has(type)) fail(kind, '존재하지 않는 객체 타입 참조입니다.');
      const parameters = list(item.parameters ?? [], kind, 20).map((v, i) => property(v, `${kind}.parameters[${i}]`)); checkProperties(parameters, kind);
      return { apiName: name, displayName: text(item.displayName ?? name, kind, 100), description: text(item.description ?? '', kind, 2000, true), executable: false, status: 'draft', parameters, objectTypes };
    }); unique(result[kind], kind);
  }
  const processing = obj(raw.processing ?? {}, 'processing', ['textStrategy', 'jevEligibleLinkTypes', 'rationale', 'decisionRules']);
  result.processing = { textStrategy: enumeration(processing.textStrategy ?? 'codex', ['codex', 'jev-assisted'], 'processing.textStrategy'), jevEligibleLinkTypes: names(processing.jevEligibleLinkTypes, 'processing.jevEligibleLinkTypes'), rationale: text(processing.rationale ?? '복잡하거나 검증되지 않은 판단은 Codex로 처리합니다.', 'processing.rationale', 2000), decisionRules: [] };
  for (const link of result.processing.jevEligibleLinkTypes) if (!links.has(link)) fail('processing', 'Jev 처리 대상으로 등록한 Link Type이 없습니다.');
  if (result.processing.textStrategy === 'codex' && result.processing.jevEligibleLinkTypes.length) fail('processing', 'Codex 전략에는 Jev Link Type을 지정할 수 없습니다.');
  result.sourceMappings = list(raw.sourceMappings ?? [], 'sourceMappings', 30).map((v, index) => {
    const p = `sourceMappings[${index}]`; const item = obj(v, p, ['sourceName', 'format', 'objectType', 'columns', 'identityColumns', 'semanticColumns', 'retainedColumns', 'relations']); const objectType = api(item.objectType, p); const type = types.get(objectType); if (!type) fail(p, '매핑 대상 객체 타입이 없습니다.');
    const columns = list(item.columns, `${p}.columns`, 20).map(v => { const column = obj(v, p, ['column', 'property']); const prop = api(column.property, p); const target = type.properties.find(p => p.apiName === prop); if (!target) fail(p, '매핑 대상 속성이 없습니다.'); if (target.valueSource !== 'evidence') fail(p, '자료 메타데이터 속성을 원문 컬럼에 매핑할 수 없습니다.'); return { column: text(column.column, p, 150), property: prop }; });
    if (new Set(columns.map(c => c.column)).size !== columns.length || new Set(columns.map(c => c.property)).size !== columns.length) fail(p, '중복 컬럼 매핑입니다.');
    const identityColumns = list(item.identityColumns ?? [], p, 5).map(v => text(v, p, 150));
    if (new Set(identityColumns).size !== identityColumns.length) fail(p, '중복 식별 컬럼입니다.');
    for (const column of identityColumns) if (!columns.some(c => c.column === column)) fail(p, '식별 컬럼을 속성에 매핑해야 합니다.');
    const primary = type.properties.find(property => property.apiName === type.primaryKey)!;
    if (primary.valueSource === 'evidence') {
      const identity = columns.find(column => column.property === type.primaryKey);
      if (!identity || !identityColumns.includes(identity.column)) fail(p, '원문 Primary Key는 식별 컬럼에 직접 매핑해야 합니다.');
    }
    const semanticColumns = list(item.semanticColumns ?? [], `${p}.semanticColumns`, 20).map(value => text(value, p, 150));
    if (new Set(semanticColumns).size !== semanticColumns.length) fail(p, '중복 의미 분석 컬럼입니다.');
    const retainedColumns = list(item.retainedColumns ?? [], `${p}.retainedColumns`, 200).map(value => text(value, p, 150));
    if (new Set(retainedColumns).size !== retainedColumns.length || retainedColumns.some(column => columns.some(mapped => mapped.column === column) || identityColumns.includes(column) || semanticColumns.includes(column))) fail(p, '원문 보존 컬럼은 속성·식별·의미 분석 컬럼과 겹칠 수 없습니다.');
    const relations = list(item.relations ?? [], p, 20).map(v => {
      const relation = obj(v, p, ['linkType', 'targetType', 'sourceColumn', 'targetProperty']); const linkType = api(relation.linkType, p); const targetType = api(relation.targetType, p); const link = links.get(linkType); const target = types.get(targetType); const targetProperty = api(relation.targetProperty, p);
      if (!link || link.sourceType !== objectType || link.targetType !== targetType || !target?.properties.some(prop => prop.apiName === targetProperty)) fail(p, '매핑 관계의 타입 또는 대상 속성이 올바르지 않습니다.');
      return { linkType, targetType, sourceColumn: text(relation.sourceColumn, p, 150), targetProperty };
    });
    return { sourceName: text(item.sourceName, p, 300), format: enumeration(item.format, ['csv', 'json', 'jsonl'], p), objectType, columns, identityColumns, semanticColumns, relations, ...(item.retainedColumns != null ? { retainedColumns } : {}) };
  });
  result.processing.decisionRules = list(processing.decisionRules ?? [], 'processing.decisionRules', 8).map((value, index) => {
    const path = `processing.decisionRules[${index}]`;
    const rule = obj(value, path, ['apiName', 'displayName', 'purpose', 'sourceName', 'columns', 'question', 'choices']);
    const sourceName = text(rule.sourceName, `${path}.sourceName`, 300);
    const semanticColumns = new Set(result.sourceMappings.filter(mapping => mapping.sourceName === sourceName).flatMap(mapping => mapping.semanticColumns ?? []));
    const columns = list(rule.columns, `${path}.columns`, 20, 1).map(column => text(column, `${path}.columns`, 150));
    if (new Set(columns).size !== columns.length) fail(path, '중복 판정 컬럼입니다.');
    if (columns.some(column => !semanticColumns.has(column))) fail(path, '판정 규칙은 해당 자료의 의미 분석 컬럼만 참조할 수 있습니다.');
    const choices = list(rule.choices, `${path}.choices`, 8, 2).map(value => {
      const choice = obj(value, `${path}.choices`, ['apiName', 'description']);
      return { apiName: api(choice.apiName, `${path}.choices.apiName`), description: text(choice.description, `${path}.choices.description`, 500) };
    });
    const choiceNames = unique(choices, `${path}.choices`);
    if (!choiceNames.has('uncertain')) fail(path, '판정 규칙에는 uncertain 선택지가 필요합니다.');
    return { apiName: api(rule.apiName, `${path}.apiName`), displayName: text(rule.displayName, `${path}.displayName`, 100), purpose: enumeration(rule.purpose, ['classification'] as const, `${path}.purpose`), sourceName, columns, question: text(rule.question, `${path}.question`, 1000), choices };
  });
  unique(result.processing.decisionRules, 'processing.decisionRules');
  return result;
}

function checkConstraints(value: JsonValue, constraints: ValueConstraints | undefined, path: string): void {
  if (!constraints) return;
  if (constraints.enum && !constraints.enum.some(v => Object.is(v, value))) fail(path, '허용 enum 값이 아닙니다.');
  if (typeof value === 'number' && ((constraints.minimum !== undefined && value < constraints.minimum) || (constraints.maximum !== undefined && value > constraints.maximum))) fail(path, '허용 범위를 벗어납니다.');
  if ((typeof value === 'string' || Array.isArray(value)) && ((constraints.minLength !== undefined && value.length < constraints.minLength) || (constraints.maxLength !== undefined && value.length > constraints.maxLength))) fail(path, '허용 길이를 벗어납니다.');
  if (typeof value === 'string' && constraints.pattern && !new RegExp(constraints.pattern, 'u').test(value)) fail(path, '값이 패턴 제약과 일치하지 않습니다.');
  if (typeof value === 'string' && constraints.format === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) fail(path, 'UUID 형식이 필요합니다.');
  if (Array.isArray(value) && constraints.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length) fail(path, '배열 원소가 중복됩니다.');
}
function validDate(value: unknown, timestamp: boolean, path: string): string {
  if (typeof value !== 'string' || !(timestamp ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/ : /^\d{4}-\d{2}-\d{2}$/).test(value) || !Number.isFinite(Date.parse(value))) fail(path, '유효한 ISO 날짜·시각이 필요합니다.');
  if (new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) fail(path, '존재하지 않는 날짜입니다.');
  if (timestamp && (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59)) fail(path, '존재하지 않는 시각입니다.');
  return value;
}
function geoShape(value: unknown, path: string): JsonValue {
  const raw = obj(value, path, ['type', 'coordinates']);
  const kind = enumeration(raw.type, ['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'], path);
  const point = (v: unknown): number[] => {
    const result = list(v, path, 3, 2);
    if (!result.every(x => typeof x === 'number' && Number.isFinite(x)) || Math.abs(result[0] as number) > 180 || Math.abs(result[1] as number) > 90) fail(path, '유효한 경위도 좌표가 필요합니다.');
    return result as number[];
  };
  const line = (v: unknown, min = 2) => list(v, path, 100, min).map(point);
  const ring = (v: unknown) => { const points = line(v, 4); if (JSON.stringify(points[0]) !== JSON.stringify(points.at(-1))) fail(path, 'Polygon 고리는 닫혀 있어야 합니다.'); return points; };
  const polygon = (v: unknown) => list(v, path, 20, 1).map(ring);
  const coordinates = kind === 'Point' ? point(raw.coordinates) : kind === 'MultiPoint' ? line(raw.coordinates, 1) : kind === 'LineString' ? line(raw.coordinates) : kind === 'MultiLineString' ? list(raw.coordinates, path, 20, 1).map(v => line(v)) : kind === 'Polygon' ? polygon(raw.coordinates) : list(raw.coordinates, path, 20, 1).map(polygon);
  return { type: kind, coordinates };
}
function typedValue(value: unknown, property: PropertyDefinition, definition: OntologyDefinition, path: string): JsonValue {
  const kind = property.baseType; let result: JsonValue;
  if (kind === 'string') { if (typeof value !== 'string' || value.length > 500) fail(path, '문자열이 필요합니다.'); result = value; }
  else if (kind === 'long') {
    if (typeof value !== 'string' || !/^-?(0|[1-9]\d*)$/.test(value)) fail(path, 'Long은 정밀도를 보존하는 정수 문자열이어야 합니다.');
    const integer = BigInt(value); if (integer < -9223372036854775808n || integer > 9223372036854775807n) fail(path, 'Long 범위를 벗어납니다.'); result = value;
  } else if (kind === 'decimal') { if (typeof value !== 'string' || !/^-?(0|[1-9]\d*)(?:\.\d+)?$/.test(value)) fail(path, 'Decimal은 정밀도를 보존하는 십진수 문자열이어야 합니다.'); result = value; }
  else if (['integer', 'short', 'byte', 'float', 'double'].includes(kind)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, '유한한 숫자가 필요합니다.');
    const limits: Record<string, [number, number]> = { integer: [-2147483648, 2147483647], short: [-32768, 32767], byte: [-128, 127] };
    if (limits[kind] && (!Number.isInteger(value) || value < limits[kind][0] || value > limits[kind][1])) fail(path, '정수 타입 범위를 벗어납니다.');
    if (kind === 'float' && !Number.isFinite(Math.fround(value))) fail(path, 'Float 범위를 벗어납니다.');
    result = value;
  } else if (kind === 'boolean') { if (typeof value !== 'boolean') fail(path, 'boolean이 필요합니다.'); result = value; }
  else if (kind === 'date' || kind === 'timestamp') result = validDate(value, kind === 'timestamp', path);
  else if (kind === 'vector') { result = list(value, path, 128, 1).map(v => { if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'Vector는 유한한 숫자 배열이어야 합니다.'); return v; }); }
  else if (kind === 'array') {
    result = list(value, path, 100).map((v, i) => typedValue(v, { ...property, baseType: property.elementType!, constraints: undefined, valueType: undefined, sharedProperty: undefined }, definition, `${path}[${i}]`));
  } else if (kind === 'struct') {
    const raw = obj(value, path, property.fields!.map(p => p.apiName)); const values: [string, JsonValue][] = [];
    for (const field of property.fields!) { if (!Object.hasOwn(raw, field.apiName)) { if (field.required) fail(`${path}.${field.apiName}`, '필수 속성이 누락되었습니다.'); continue; } values.push([field.apiName, typedValue(raw[field.apiName], field, definition, `${path}.${field.apiName}`)]); }
    result = Object.fromEntries(values);
  } else if (kind === 'geopoint') {
    const raw = obj(value, path, ['latitude', 'longitude']);
    if (typeof raw.latitude !== 'number' || !Number.isFinite(raw.latitude) || Math.abs(raw.latitude) > 90 || typeof raw.longitude !== 'number' || !Number.isFinite(raw.longitude) || Math.abs(raw.longitude) > 180) fail(path, '유효한 latitude·longitude가 필요합니다.');
    result = { latitude: raw.latitude, longitude: raw.longitude };
  } else if (kind === 'geoshape') result = geoShape(value, path);
  else {
    // These types are opaque references only. Declaring a Marking/Cipher does not add access control/encryption.
    const raw = obj(value, path, ['reference']); result = { reference: text(raw.reference, path, 450) };
  }
  checkConstraints(result, property.constraints, path);
  if (property.valueType) checkConstraints(result, definition.valueTypes.find(v => v.apiName === property.valueType)!.constraints, path);
  if (property.sharedProperty) {
    const shared = definition.sharedProperties.find(p => p.apiName === property.sharedProperty)!;
    checkConstraints(result, shared.constraints, path);
    if (shared.valueType) checkConstraints(result, definition.valueTypes.find(v => v.apiName === shared.valueType)!.constraints, path);
  }
  return result;
}
/** Extraction strings encode non-string values as JSON; Long/Decimal remain exact text. */
export function typedValuesFor(entity: ExtractedEntity, definition: OntologyDefinition): Record<string, JsonValue> {
  const type = definition.objectTypes.find(t => t.apiName === entity.type);
  if (!type) fail(entity.id, '등록되지 않은 객체 타입입니다.');
  const result: [string, JsonValue][] = []; const seen = new Set<string>();
  for (const supplied of entity.properties) {
    if (typeof supplied.value !== 'string' || supplied.value.length > 500) fail(entity.id, '속성 값은 최대 500자 문자열이어야 합니다.');
    if (seen.has(supplied.key)) fail(entity.id, '중복 속성입니다.'); seen.add(supplied.key);
    const property = type.properties.find(p => p.apiName === supplied.key);
    if (!property) fail(entity.id, `등록되지 않은 속성: ${supplied.key}`);
    let value: unknown = supplied.value;
    if (!['string', 'date', 'timestamp', 'long', 'decimal'].includes(property.baseType)) {
      try { value = JSON.parse(supplied.value); } catch { fail(`${entity.id}.${supplied.key}`, '속성 타입에 맞는 JSON 값이 필요합니다.'); }
    }
    result.push([supplied.key, typedValue(value, property, definition, `${entity.id}.${supplied.key}`)]);
  }
  for (const property of type.properties) if ((property.required || property.apiName === type.primaryKey || property.apiName === type.titleProperty) && !seen.has(property.apiName)) fail(`${entity.id}.${property.apiName}`, '필수 속성이 누락되었습니다.');
  const values = Object.fromEntries(result);
  for (const key of [type.primaryKey, type.titleProperty]) if (typeof values[key] === 'string' && !values[key].trim()) fail(`${entity.id}.${key}`, 'Primary Key·Title Property는 비어 있을 수 없습니다.');
  return values;
}

// Closed JSON schemas for Codex output. Nullable optional fields keep strict structured output compatible.
const s = (max = 2000) => ({ type: 'string', maxLength: max });
const a = (items: unknown, maxItems = 40) => ({ type: 'array', items, maxItems });
const o = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const nullable = (schema: unknown) => ({ anyOf: [schema, { type: 'null' }] });
const nameSchema = { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_]*$', maxLength: 64 };
const constraintsSchema = o({ enum: nullable(a({ anyOf: [s(500), { type: 'number' }, { type: 'boolean' }] }, 100)), minimum: nullable({ type: 'number' }), maximum: nullable({ type: 'number' }), minLength: nullable({ type: 'integer', minimum: 0, maximum: 500 }), maxLength: nullable({ type: 'integer', minimum: 0, maximum: 500 }), pattern: nullable(s(160)), format: nullable({ type: 'string', enum: ['uuid'] }), uniqueItems: nullable({ type: 'boolean' }) });
const propertyFields = { apiName: nameSchema, displayName: s(100), description: s(), baseType: { type: 'string', enum: PROPERTY_BASE_TYPES }, required: { type: 'boolean' }, valueSource: { type: 'string', enum: ['evidence', 'documentId', 'documentName', 'evidenceId'] }, visibility: { type: 'string', enum: visibility }, sharedProperty: nullable(nameSchema), valueType: nullable(nameSchema), constraints: nullable(constraintsSchema), renderHints: a(s(80), 10), typeClasses: a(o({ kind: s(80), name: s(100) }), 20) };
const fieldSchema = o({ ...propertyFields, baseType: { type: 'string', enum: PROPERTY_BASE_TYPES.filter(v => !['array', 'struct'].includes(v)) }, valueSource: { type: 'string', enum: ['evidence'] }, elementType: { type: 'null' }, fields: { type: 'null' } });
const propertySchema = o({ ...propertyFields, elementType: nullable({ type: 'string', enum: PROPERTY_BASE_TYPES.filter(v => !['array', 'struct'].includes(v)) }), fields: nullable(a(fieldSchema, 20)) });
const capabilitySchema = o({ apiName: nameSchema, displayName: s(100), description: s(), executable: { type: 'boolean', enum: [false] }, status: { type: 'string', enum: ['draft'] }, parameters: a(propertySchema, 20), objectTypes: a(nameSchema, 12) });
const decisionRuleSchema = o({ apiName: nameSchema, displayName: s(100), purpose: { type: 'string', enum: ['classification'] }, sourceName: s(300), columns: { ...a(s(150), 20), minItems: 1 }, question: s(1000), choices: { ...a(o({ apiName: nameSchema, description: s(500) }), 8), minItems: 2 } });
export const jevDecisionPlanSchema: Record<string, unknown> = o({ decisionRules: a(decisionRuleSchema, 8) });
export const ontologyDefinitionSchema: Record<string, unknown> = o({
  schemaVersion: { type: 'string', enum: ['1.0'] }, apiName: nameSchema, displayName: s(150), description: s(4000), status: { type: 'string', enum: ['active'] },
  objectTypes: { ...a(o({ apiName: nameSchema, displayName: s(100), pluralDisplayName: s(100), description: s(), primaryKey: nameSchema, titleProperty: nameSchema, identityScope: { type: 'string', enum: ['ontology', 'source'] }, properties: a(propertySchema, 20), color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, icon: s(50), visibility: { type: 'string', enum: visibility }, status: { type: 'string', enum: lifecycle }, implementsInterfaces: a(nameSchema, 20), groups: a(nameSchema, 20) }), 12), minItems: 1 },
  linkTypes: a(o({ apiName: nameSchema, displayName: s(100), inverseDisplayName: s(100), description: s(), sourceType: nameSchema, targetType: nameSchema, sourceCardinality: { type: 'string', enum: ['one', 'many'] }, targetCardinality: { type: 'string', enum: ['one', 'many'] }, visibility: { type: 'string', enum: visibility }, status: { type: 'string', enum: lifecycle } })),
  sharedProperties: a(propertySchema), interfaces: a(o({ apiName: nameSchema, displayName: s(100), description: s(), properties: a(propertySchema, 20), extendsInterfaces: a(nameSchema, 20), linkTypes: a(nameSchema), searchable: { type: 'boolean' } }), 20),
  valueTypes: a(o({ apiName: nameSchema, displayName: s(100), description: s(), baseType: { type: 'string', enum: PROPERTY_BASE_TYPES }, constraints: constraintsSchema })),
  groups: a(o({ apiName: nameSchema, displayName: s(100), description: s() }), 20), actionTypes: a(capabilitySchema, 20), functions: a(capabilitySchema, 20),
  processing: o({ textStrategy: { type: 'string', enum: ['codex', 'jev-assisted'] }, jevEligibleLinkTypes: a(nameSchema), rationale: s(), decisionRules: a(decisionRuleSchema, 8) }),
  sourceMappings: a(o({ sourceName: s(300), format: { type: 'string', enum: ['csv', 'json', 'jsonl'] }, objectType: nameSchema, columns: a(o({ column: s(150), property: nameSchema }), 20), identityColumns: a(s(150), 5), semanticColumns: a(s(150), 20), retainedColumns: nullable(a(s(150), 200)), relations: a(o({ linkType: nameSchema, targetType: nameSchema, sourceColumn: s(150), targetProperty: nameSchema }), 20) }), 30),
});
