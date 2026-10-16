import type { GraphDocument, GraphEdge, GraphNode } from './graph';
import type { EvidenceVerdict, GapType, WhyEvidence } from './why-not';

export interface ReportCitation {
  id: string;
  evidenceId: string;
  sourceName: string;
  url: string | null;
  quote: string;
  sourceGrade: WhyEvidence['sourceGrade'];
  record: number | null;
}
export interface ReportGap {
  id: string;
  type: GapType;
  title: string;
  explanation: string;
  evaluationState: string;
  blockingScope: string;
  requirements: string[];
  recommendations: string[];
}
export interface ReportSnapshot {
  question: string;
  caseTitle: string;
  analysisUpdatedAt: string;
  whyRunId: string;
  graph: GraphDocument;
  confidence: { score: number | null; baselineScore: number | null; grade: string | null; accepted: boolean; status: string; note: string };
  gaps: ReportGap[];
  citations: ReportCitation[];
  assessments?: { citationId: string; bindingId: string; requirement: string; verdict: EvidenceVerdict; reason: string; rawLikelihoodRatio: number | null; adjustedLikelihoodRatio: number | null; contributionStatus: string; contributionReason: string }[];
  associationSummary?: { summary: string; nodes: Pick<GraphNode, 'id' | 'label' | 'type' | 'description'>[]; edges: (Pick<GraphEdge, 'id' | 'source' | 'target' | 'label' | 'description' | 'status' | 'claim'> & { citationIds: string[] })[]; totalNodes: number; totalEdges: number; limitations: string[] };
  coverage: { sources: number; citations: number; nodes: number; edges: number; notes: string[] };
}
export interface ReportParagraph { text: string; citationIds: string[] }
export interface ReportSection { heading: string; paragraphs: ReportParagraph[] }
export interface ReportContent {
  title: string;
  subtitle: string;
  conclusion: ReportParagraph[];
  sections: ReportSection[];
  gapAnalysis: { gapId: string; analysis: string; recommendation: string }[];
  limitations: string[];
  nextSteps: string[];
}
export interface ReportRun {
  id: string;
  jobId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  stage: 'preparing' | 'writing' | 'verifying' | 'completed';
  createdAt: string;
  updatedAt: string;
  model: string;
  effort: string;
  inputHash: string;
  snapshot: ReportSnapshot;
  content?: ReportContent;
  error?: string;
}
export interface ReportList {
  reports: ReportRun[];
  canGenerate: boolean;
  blockingReason: string | null;
  currentInputHash: string | null;
}
