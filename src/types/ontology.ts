import type { RelationClaim } from './claims';
/** API names are scoped by an ontology definition. Legacy imports keep their original names. */
export type EntityType = string;
export type RelationType = string;
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type PropertyBaseType = 'string' | 'integer' | 'short' | 'date' | 'timestamp' | 'boolean' | 'byte' | 'long' | 'float' | 'double' | 'decimal' | 'vector' | 'array' | 'struct' | 'mediaReference' | 'timeSeries' | 'geotemporalSeries' | 'attachment' | 'geopoint' | 'geoshape' | 'marking' | 'cipher';
export interface ValueConstraints {
  enum?: (string | number | boolean)[]; minimum?: number; maximum?: number;
  minLength?: number; maxLength?: number; pattern?: string; format?: 'uuid'; uniqueItems?: boolean;
}
export interface PropertyDefinition {
  apiName: string; displayName: string; description: string; baseType: PropertyBaseType; required: boolean;
  /** Source metadata is assigned and verified by the server, never invented by the extractor. */
  valueSource?: 'evidence' | 'documentId' | 'documentName' | 'evidenceId';
  visibility: 'normal' | 'prominent' | 'hidden'; sharedProperty?: string; valueType?: string;
  elementType?: PropertyBaseType; fields?: PropertyDefinition[]; constraints?: ValueConstraints;
  renderHints: string[]; typeClasses: { kind: string; name: string }[];
}
export interface ObjectTypeDefinition {
  apiName: string; displayName: string; pluralDisplayName: string; description: string;
  primaryKey: string; titleProperty: string; identityScope: 'ontology' | 'source'; properties: PropertyDefinition[];
  color: string; icon: string; visibility: 'normal' | 'prominent' | 'hidden'; status: 'active' | 'experimental' | 'deprecated';
  implementsInterfaces: string[]; groups: string[];
}
export interface LinkTypeDefinition {
  apiName: string; displayName: string; inverseDisplayName: string; description: string;
  sourceType: string; targetType: string; sourceCardinality: 'one' | 'many'; targetCardinality: 'one' | 'many';
  visibility: 'normal' | 'prominent' | 'hidden'; status: 'active' | 'experimental' | 'deprecated';
}
export interface InterfaceDefinition {
  apiName: string; displayName: string; description: string; properties: PropertyDefinition[];
  extendsInterfaces: string[]; linkTypes: string[]; searchable: boolean;
}
export interface ValueTypeDefinition {
  apiName: string; displayName: string; description: string; baseType: PropertyBaseType; constraints: ValueConstraints;
}
/** Declarations document possible future capabilities; they never execute model generated code. */
export interface OntologyCapabilityDeclaration {
  apiName: string; displayName: string; description: string; executable: false; status: 'draft';
  parameters: PropertyDefinition[]; objectTypes: string[];
}
export interface StructuredSourceMapping {
  /** Non-analytic columns kept in the immutable raw row, not materialized as graph properties. */
  retainedColumns?: string[];
  sourceName: string; format: 'csv' | 'json' | 'jsonl'; objectType: string;
  columns: { column: string; property: string }[]; identityColumns: string[];
  /** Narrative columns reviewed separately; long text need not fit a graph property. */
  semanticColumns?: string[];
  relations: { linkType: string; targetType: string; sourceColumn: string; targetProperty: string }[];
}
/** Bounded advisory decisions. These never write facts, discard evidence, or execute code. */
export interface OntologyDecisionRule {
  apiName: string; displayName: string; purpose: 'classification';
  sourceName: string; columns: string[]; question: string;
  /** Every rule includes an uncertain option for incomplete or ambiguous evidence. */
  choices: { apiName: string; description: string }[];
}
export interface OntologyDefinition {
  schemaVersion: '1.0'; id: string; version: number; apiName: string; displayName: string; description: string;
  status: 'draft' | 'active' | 'deprecated'; objectTypes: ObjectTypeDefinition[]; linkTypes: LinkTypeDefinition[];
  sharedProperties: PropertyDefinition[]; interfaces: InterfaceDefinition[]; valueTypes: ValueTypeDefinition[];
  groups: { apiName: string; displayName: string; description: string }[];
  actionTypes: OntologyCapabilityDeclaration[]; functions: OntologyCapabilityDeclaration[];
  processing: { textStrategy: 'codex' | 'jev-assisted'; jevEligibleLinkTypes: string[]; rationale: string; decisionRules?: OntologyDecisionRule[] };
  sourceMappings: StructuredSourceMapping[];
}
export interface OntologyEvidence { documentId: string; quote: string; sourceId?: string; spans?: { start: number; end: number }[]; offsetUnit?: 'utf16'; textHash?: string; ambiguous?: boolean }
export interface OntologyIdentifier { namespace: string; value: string }
export interface ExtractedEntity {
  id: string; label: string; type: EntityType; description: string;
  identifiers: OntologyIdentifier[]; properties: { key: string; value: string }[]; evidence: OntologyEvidence[];
}
export interface ExtractedRelationship {
  id: string; source: string; target: string; type: RelationType; label: string;
  description: string; status: 'reported' | 'inferred'; evidence: OntologyEvidence[]; claim?: RelationClaim;
}
export interface OntologyExtraction {
  title: string; summary: string; entities: ExtractedEntity[]; relationships: ExtractedRelationship[];
  events: { id: string; label: string; date: string; endDate: string | null; description: string; entityIds: string[]; evidence: OntologyEvidence[] }[];
  findings: { text: string; entityIds: string[]; relationshipIds: string[]; evidence: OntologyEvidence[] }[];
  limitations: string[];
}
export interface OntologySummary {
  entities: number; relationships: number; documents: number; graphs: number;
  types: { type: EntityType; count: number }[];
}
export interface OntologyEntitySummary {
  id: string; label: string; type: EntityType; description: string; caseCount: number; updatedAt: string;
}
export interface OntologyEntityClaim {
  graphId: string; graphTitle: string; nodeId: string; label: string; description: string;
  properties: Record<string, string>; sourceIds: string[]; evidence: OntologyEvidence[]; createdAt: string;
  typedProperties?: Record<string, JsonValue>; ontologyId?: string; ontologyVersion?: number;
}
export interface OntologyRelationship {
  id: string; graphId: string; source: string; target: string; type: RelationType;
  label: string; description: string; status: 'reported' | 'inferred';
  sourceLabel: string; targetLabel: string; evidence: OntologyEvidence[];
}
export interface OntologyEntityDetail extends OntologyEntitySummary {
  identityCandidates?: { id: string; label: string; type: string; reasons: string[]; status: string; note: string }[];
  identifiers: OntologyIdentifier[]; claims: OntologyEntityClaim[]; relationships: OntologyRelationship[];
}
