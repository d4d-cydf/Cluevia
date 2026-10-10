import type { OntologyEvidence } from './ontology';
import type { GraphDocument } from './graph';

export interface AnalysisRecord {
  number: number;
  title: string;
  status: 'saved' | 'empty' | 'pending';
  graphId?: string;
  nodeCount: number;
  edgeCount: number;
  archived: boolean;
}
export interface RecordReference { record: number; localId: string }
/** A case projection is not subject to the per-extraction/model output limits. */
export interface AnalysisCase {
  schemaVersion: 'case-1.0';
  jobId: string;
  updatedAt: string;
  status: string;
  graph: GraphDocument;
  records: AnalysisRecord[];
  provenance: Record<string, RecordReference[]>;
  conflicts: { nodeId: string; property: string; values: { value: string; records: number[] }[] }[];
}
export interface RecordDocument {
  id: string; name: string; text: string; totalChars: number; offset: number;
}
export interface AnalysisRecordDetail {
  record: AnalysisRecord;
  graph?: GraphDocument;
  summary: string;
  limitations: string[];
  documents: RecordDocument[];
  claims: { nodeId: string; description: string; properties: Record<string, string>; evidence: OntologyEvidence[] }[];
  relationClaims: { localId: string; evidence: OntologyEvidence[] }[];
}
