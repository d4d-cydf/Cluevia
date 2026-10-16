import type { RelationClaim, ClaimReview } from './claims';
import type { AnalysisBrief } from './clarification';
import type { GapType } from './why-not';

/** View-only annotations. Never persisted as extracted facts or evidence. */
export interface GraphDecorations {
  centerNodeId?: string;
  runKey?: string;
  nodes: Record<string, { kind: 'goal' | 'gap'; gapType?: GapType; state?: 'idle' | 'checking' | 'found' | 'resolved'; revealIndex?: number; delayMs?: number; durationMs?: number }>;
  edges: Record<string, { gapType: GapType; revealIndex?: number; delayMs?: number; durationMs?: number }>;
}

export interface GraphSource {
  id: string;
  title: string;
  url?: string;
  publisher?: string;
  publishedAt?: string;
  accessedAt?: string;
  excerpt?: string;
  contentHash?: string; sourceFamily?: string;
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
  claim?: RelationClaim; review?: ClaimReview;
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
  ontologyId?: string;
  ontologyVersion?: number;
  id: string;
  title: string;
  question: string;
  summary: string;
  origin: 'published-source' | 'imported' | 'aip' | 'codex' | 'jev' | 'structured' | 'demo';
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
export interface EvidenceDocument { id: string; name: string; text: string; url?: string; /** Trusted server-assigned scope linking chunks from one original file. */ identityScope?: string; sourceOffset?: number }
export interface GraphGenerationInput { question: string; documents: EvidenceDocument[]; uploadIds?: string[]; analysisBrief?: AnalysisBrief }
