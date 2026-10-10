export interface GraphSource {
  id: string;
  title: string;
  url?: string;
  publisher?: string;
  publishedAt?: string;
  accessedAt?: string;
  excerpt?: string;
}

export interface GraphGroup { id: string; label: string; color: string }
export interface GraphNode {
  id: string;
  label: string;
  type: string;
  group: string;
  description: string;
  sourceIds: string[];
  properties: Record<string, string>;
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  description: string;
  status: 'reported' | 'inferred';
  sourceIds: string[];
  highlighted?: boolean;
}
export interface GraphEvent {
  id: string;
  label: string;
  date: string;
  endDate?: string;
  description: string;
  nodeIds: string[];
  sourceIds: string[];
}
export interface GraphFinding { text: string; sourceIds: string[]; nodeIds: string[]; edgeIds?: string[] }

/** Shared data contract: imported files, AIP responses, and examples use this shape. */
export interface GraphDocument {
  schemaVersion: '1.0';
  id: string;
  title: string;
  question: string;
  summary: string;
  origin: 'published-source' | 'imported' | 'aip' | 'demo';
  createdAt: string;
  limitations: string[];
  groups: GraphGroup[];
  sources: GraphSource[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  events: GraphEvent[];
  findings: GraphFinding[];
}

export type GraphSelection = { kind: 'node' | 'edge' | 'event'; id: string } | null;
export interface EvidenceDocument { id: string; name: string; text: string; url?: string }
export interface GraphGenerationInput { question: string; documents: EvidenceDocument[] }
