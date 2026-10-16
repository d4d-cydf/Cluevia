import { GraphValidationError } from '../src/lib/graph-document.ts';
import type { OntologyDefinition, StructuredSourceMapping } from '../src/types/ontology.ts';
import { ontologyDefinitionSchema, parseOntologyDefinition } from './ontology-schema.ts';

type Schema = Record<string, unknown>;
const object = (properties: Record<string, unknown>): Schema => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const array = (items: unknown, maxItems = 40): Schema => ({ type: 'array', items, maxItems });
const nullable = (schema: unknown): Schema => ({ anyOf: [schema, { type: 'null' }] });
const reference = (name: string): Schema => ({ $ref: `#/$defs/${name}` });
const propertiesOf = (schema: Schema): Record<string, Schema> => schema.properties as Record<string, Schema>;
const itemsOf = (schema: Schema): Schema => schema.items as Schema;
const full = propertiesOf(ontologyDefinitionSchema);
const originalObject = itemsOf(full.objectTypes);
const originalObjectFields = propertiesOf(originalObject);
const originalProperty = itemsOf(originalObjectFields.properties);
const originalPropertyFields = propertiesOf(originalProperty);
const originalField = itemsOf((originalPropertyFields.fields.anyOf as Schema[])[0]);
const originalConstraints = (originalPropertyFields.constraints.anyOf as Schema[])[0];
const extensionNames = ['sharedProperties', 'interfaces', 'valueTypes', 'groups', 'actionTypes', 'functions'] as const;

// Full optional resources retain their existing contracts. Reuse their repeated property/field
// schemas through references instead of sending copies of the same schema to the model.
const reusable = new Map([
  [JSON.stringify(originalProperty), 'fullProperty'],
  [JSON.stringify(originalField), 'fullField'],
  [JSON.stringify(originalConstraints), 'constraints'],
]);
function withReferences(value: unknown, allowReference = true): unknown {
  if (value === null || typeof value !== 'object') return value;
  const target = allowReference ? reusable.get(JSON.stringify(value)) : undefined;
  if (target) return reference(target);
  if (Array.isArray(value)) return value.map(item => withReferences(item));
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, withReferences(child)]));
}

const compactPropertyFields = {
  apiName: originalPropertyFields.apiName,
  displayName: originalPropertyFields.displayName,
  baseType: originalPropertyFields.baseType,
  required: originalPropertyFields.required,
  valueSource: originalPropertyFields.valueSource,
  sharedProperty: originalPropertyFields.sharedProperty,
  valueType: originalPropertyFields.valueType,
  constraints: nullable(reference('constraints')),
  elementType: originalPropertyFields.elementType,
  fields: nullable(array(reference('compactField'), 20)),
};
const compactField = object({
  apiName: originalPropertyFields.apiName,
  displayName: originalPropertyFields.displayName,
  baseType: propertiesOf(originalField).baseType,
  required: originalPropertyFields.required,
  sharedProperty: originalPropertyFields.sharedProperty,
  valueType: originalPropertyFields.valueType,
  constraints: nullable(reference('constraints')),
});
const originalLinkFields = propertiesOf(itemsOf(full.linkTypes));
const compactLink = object(Object.fromEntries([
  'apiName', 'displayName', 'description', 'sourceType', 'targetType', 'sourceCardinality', 'targetCardinality',
].map(name => [name, originalLinkFields[name]])));
const originalMapping = itemsOf(full.sourceMappings);
const originalMappingFields = propertiesOf(originalMapping);
const compactMapping = object({
  ...originalMappingFields,
  // A same-name column/property mapping is written once. Renamed columns retain the explicit form.
  columns: { ...originalMappingFields.columns, items: { anyOf: [originalPropertyFields.apiName, itemsOf(originalMappingFields.columns)] } },
});

/** Codex writes the domain decisions. The deterministic builder fills display/status metadata. */
export const ontologyBlueprintSchema: Record<string, unknown> = {
  ...object({
    blueprintVersion: { type: 'string', enum: ['1.0'] },
    apiName: full.apiName, displayName: full.displayName, description: full.description,
    objectTypes: { ...array(object({
      apiName: originalObjectFields.apiName,
      displayName: originalObjectFields.displayName,
      description: originalObjectFields.description,
      primaryKey: originalObjectFields.primaryKey,
      titleProperty: originalObjectFields.titleProperty,
      identityScope: originalObjectFields.identityScope,
      implementsInterfaces: nullable(originalObjectFields.implementsInterfaces),
      groups: nullable(originalObjectFields.groups),
      properties: { ...array(reference('compactProperty'), 20), minItems: 1 },
    }), 12), minItems: 1 },
    linkTypes: array(compactLink), processing: full.processing,
    sourceMappings: array(compactMapping, 30),
    extensions: nullable(object(Object.fromEntries(extensionNames.map(name => [name, withReferences(full[name])])))),
  }),
  $defs: {
    compactProperty: object(compactPropertyFields), compactField,
    constraints: originalConstraints,
    fullProperty: withReferences(originalProperty, false),
    fullField: withReferences(originalField, false),
  },
};

/** Ordinary graph design does not ask the model to emit unused enterprise extensions
 * or null fields for every scalar property. Manual advanced blueprints remain supported. */
export const leanOntologyBlueprintSchema: Record<string, unknown> = {
  ...object({
    blueprintVersion: { type: 'string', enum: ['1.0'] }, apiName: full.apiName, displayName: full.displayName, description: full.description,
    objectTypes: { ...array(object({
      apiName: originalObjectFields.apiName, displayName: originalObjectFields.displayName,
      description: originalObjectFields.description, primaryKey: originalObjectFields.primaryKey,
      titleProperty: originalObjectFields.titleProperty, identityScope: originalObjectFields.identityScope,
      properties: { ...array({ anyOf: [reference('scalar'), reference('arrayProperty'), reference('structProperty'), reference('constrained')] }, 20), minItems: 1 },
    }), 12), minItems: 1 },
    linkTypes: array(compactLink), processing: full.processing, sourceMappings: array(compactMapping, 30), extensions: { type: 'null' },
  }),
  $defs: (() => {
    const scalar = { apiName: originalPropertyFields.apiName, displayName: originalPropertyFields.displayName,
      baseType: { type: 'string', enum: (originalPropertyFields.baseType.enum as string[]).filter(type => !['struct', 'array'].includes(type)) },
      required: originalPropertyFields.required, valueSource: originalPropertyFields.valueSource };
    return {
      scalar: object(scalar), arrayProperty: object({ ...scalar, baseType: { type: 'string', enum: ['array'] }, elementType: originalPropertyFields.elementType }),
      structProperty: object({ ...scalar, baseType: { type: 'string', enum: ['struct'] }, fields: { ...array(reference('scalar'), 20), minItems: 1 } }),
      constrained: object({ ...scalar, constraints: reference('constraints') }), constraints: originalConstraints,
    };
  })(),
};

/** The design stage cannot produce Jev rules or mappings for sources without columns.
 * Keep the editable blueprint contracts above intact; send only the applicable contract
 * to the model and leave optional rule planning to its own validated stage. */
const planningSchemas = new Map<string, Record<string, unknown>>();
export function ontologyPlanningSchema(options: { advanced: boolean; structured: boolean }): Record<string, unknown> {
  const key = `${options.advanced}:${options.structured}`;
  const existing = planningSchemas.get(key);
  if (existing) return existing;
  const schema = structuredClone(options.advanced ? ontologyBlueprintSchema : leanOntologyBlueprintSchema);
  const fields = propertiesOf(schema);
  const processing = propertiesOf(full.processing);
  const emptyArray = array({ type: 'null' }, 0);
  fields.processing = object({
    textStrategy: processing.textStrategy,
    jevEligibleLinkTypes: processing.jevEligibleLinkTypes,
    rationale: { type: 'string', maxLength: 240 },
    decisionRules: emptyArray,
  });
  if (!options.structured) fields.sourceMappings = structuredClone(emptyArray);
  // Explanations clarify domain decisions, but do not repeat the supplied evidence.
  fields.description = { type: 'string', maxLength: 400 };
  propertiesOf(itemsOf(fields.objectTypes)).description = { type: 'string', maxLength: 240 };
  propertiesOf(itemsOf(fields.linkTypes)).description = { type: 'string', maxLength: 200 };
  planningSchemas.set(key, schema);
  return schema;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GraphValidationError(`${path}: 객체가 필요합니다.`);
  return value as Record<string, unknown>;
}

/** Bulk mapping shorthand. This creates declarations; it never reads a file or transforms facts. */
export function buildColumnMappings(columns: readonly (string | { column: string; property: string })[]): StructuredSourceMapping['columns'] {
  return columns.map(column => typeof column === 'string' ? { column, property: column } : { ...column });
}

/** Accept compact blueprints and the earlier full definition wire format. Both use one validator. */
export function buildOntologyDefinition(value: unknown, options: { id?: string; version?: number } = {}): OntologyDefinition {
  const raw = record(value, 'ontology');
  if (!Object.hasOwn(raw, 'blueprintVersion')) return parseOntologyDefinition(raw, options);
  if (raw.blueprintVersion !== '1.0') throw new GraphValidationError('blueprintVersion: 지원하지 않는 설계도 버전입니다.');
  const allowed = new Set(['blueprintVersion', 'apiName', 'displayName', 'description', 'objectTypes', 'linkTypes', 'processing', 'sourceMappings', 'extensions']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new GraphValidationError(`ontology.${key}: 정의되지 않은 필드입니다.`);
  const extensions = raw.extensions == null ? {} : record(raw.extensions, 'extensions');
  for (const key of Object.keys(extensions)) if (!(extensionNames as readonly string[]).includes(key)) throw new GraphValidationError(`extensions.${key}: 정의되지 않은 확장 리소스입니다.`);
  const { blueprintVersion: _version, extensions: _extensions, ...core } = raw;
  if (Array.isArray(core.sourceMappings)) core.sourceMappings = core.sourceMappings.map((value, index) => {
    const mapping = record(value, `sourceMappings[${index}]`);
    return { ...mapping, ...(Array.isArray(mapping.columns) ? { columns: mapping.columns.map(column => typeof column === 'string' ? { column, property: column } : column) } : {}) };
  });
  return parseOntologyDefinition({ ...core, ...extensions }, options);
}

/** A small editable example for the local builder CLI. It is never used as a domain fallback. */
export function commerceBlueprintTemplate(): Record<string, unknown> {
  const property = (apiName: string, baseType = 'string') => ({ apiName, displayName: apiName, baseType, required: true, valueSource: 'evidence', sharedProperty: null, valueType: null, constraints: null, elementType: null, fields: null });
  return {
    blueprintVersion: '1.0', apiName: 'CustomerOrders', displayName: '고객과 주문', description: '고객 식별자와 주문 식별자가 명시된 CSV를 연결합니다.',
    objectTypes: [
      { apiName: 'Customer', displayName: '고객', description: '명시된 고객 식별자를 가진 고객', primaryKey: 'customerId', titleProperty: 'name', identityScope: 'ontology', implementsInterfaces: null, groups: null, properties: [property('customerId'), property('name')] },
      { apiName: 'Order', displayName: '주문', description: '명시된 주문 식별자를 가진 주문', primaryKey: 'orderId', titleProperty: 'orderId', identityScope: 'ontology', implementsInterfaces: null, groups: null, properties: [property('orderId'), property('amount', 'double')] },
    ],
    linkTypes: [{ apiName: 'placed', displayName: '주문', description: '고객이 주문을 생성했다는 명시적 연결', sourceType: 'Customer', targetType: 'Order', sourceCardinality: 'one', targetCardinality: 'many' }],
    processing: { textStrategy: 'codex', jevEligibleLinkTypes: [], decisionRules: [], rationale: '정확한 컬럼 매핑은 코드로 변환하고 추가 문맥 해석은 Codex가 처리합니다.' },
    sourceMappings: [
      { sourceName: 'orders.csv', format: 'csv', objectType: 'Customer', columns: ['customerId', 'name'], identityColumns: ['customerId'], semanticColumns: [], relations: [{ linkType: 'placed', targetType: 'Order', sourceColumn: 'orderId', targetProperty: 'orderId' }] },
      { sourceName: 'orders.csv', format: 'csv', objectType: 'Order', columns: ['orderId', 'amount'], identityColumns: ['orderId'], semanticColumns: [], relations: [] },
    ], extensions: null,
  };
}
