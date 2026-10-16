export type LogicOperator = 'AND' | 'OR' | 'NOT_SUPPORT';
export type EvidenceVerdict = 'SUPPORTED' | 'REFUTED' | 'INSUFFICIENT' | 'IRRELEVANT' | 'UNREVIEWED';
export type GapType = 'EVIDENCE_MISSING' | 'EVIDENCE_INSUFFICIENT' | 'EVENT_MISMATCH' | 'TRUST_WEAK' | 'PROVENANCE_UNKNOWN' | 'CHAIN_UNKNOWN';
export type WhyLikelihoodBasis = 'CALIBRATED' | 'EXPERT_ESTIMATE' | 'MODEL_ESTIMATE' | 'UNASSESSED';
export interface WhyModelEstimation {
  model: string; effort: 'low'; estimatedAt: string;
  anchors: { evidenceId: string; quote: string; start: number; end: number }[];
}

export interface WhyNode {
  id: string; kind: 'claim' | 'requirement'; statement: string; operator: LogicOperator;
  children: string[]; inferenceRule: string; negativeOf: string | null; eventRuleId: string | null;
  threshold: number | null;
  need: { kinds: string[]; fields: string[]; criteria: string[]; eventScope: string } | null;
}
export interface WhyEvidence {
  id: string; name: string; kind: 'DOCUMENT' | 'STRUCTURED_RECORD' | 'WEB_PAGE' | 'OTHER';
  text: string; contentHash: string; record: number | null; documentId: string | null;
  url: string | null; processingStatus: 'READY' | 'PENDING' | 'FAILED';
  sourceGrade: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | null;
  sourceCoefficient: number | null; sourceReason: string; sourceType: string | null;
  originalVerified: boolean;
  sourceEstimation?: WhyModelEstimation;
}
export interface WhyBinding {
  id: string; evidenceId: string; requirementId: string; quote: string;
  start: number; end: number;
  verdict: EvidenceVerdict; reason: string; missingRequirements: string[];
  evaluator: string; decisionVersion: string;
  materialCoefficient: number | null; materialReason: string;
  /** Explicitly confirmed shared observation; a source URL is never an atom ID. */
  atomId: string | null;
  likelihood?: { ratio: number | null; reason: string; basis: WhyLikelihoodBasis; hypothesisId?: string; estimation?: WhyModelEstimation };
  metadata: { fields: { key: string; value: string; quote: string }[]; start: string | null; end: string | null; timeQuote: string | null };
}
export interface WhyEventRule {
  id: string; version: string; kind: 'SAME_EVENT' | 'SAME_ENTITY' | 'ORDERED_EVENTS';
  fields: string[]; expected: { key: string; value: string }[]; requireTime: boolean;
  order: string[];
}
export interface WhyDuplicate {
  parentId: string; left: string; right: string;
  verdict: 'EXACT_DUPLICATE' | 'SAME_OBSERVATION' | 'PARTIAL_OVERLAP' | 'DISTINCT' | 'UNKNOWN';
  reason: string; leftQuote: string; rightQuote: string;
}
export interface WhyProvenance {
  from: string; to: string; verified: boolean; quote: string;
  likelihood: { kind: 'ESTIMATED_LR' | 'NO_NEW_INFORMATION' | 'UNKNOWN'; value: number | null; reason: string };
}
export interface WhyPolicy {
  version: string; threshold: number | null;
  independence: { atomIds: string[]; reason: string }[];
  trustedSourceTypes: { type: string; verification: string }[];
  maxCandidates: number; maxStates: number; maxDepth: number; maxVisits: number;
  bayes?: {
    target?: 'GOAL';
    estimationNotes?: string[];
    priors: { nodeId: string; probability: number | null; reason: string; basis?: WhyLikelihoodBasis; estimation?: WhyModelEstimation }[];
    /** Joint conditional independence under BOTH the requirement hypothesis and its negation. */
    conditionalIndependence: { requirementId: string; bindingIds: string[]; reason: string }[];
  };
}
export interface WhySnapshot {
  version: 'why-not-1.0'; treeVersion: string; evidenceVersion: string; decisionVersion: string;
  goal: string; rootId: string; nodes: WhyNode[]; evidence: WhyEvidence[]; bindings: WhyBinding[];
  eventRules: WhyEventRule[]; duplicates: WhyDuplicate[]; provenance: WhyProvenance[];
  policy: WhyPolicy; coverage: { complete: boolean; note: string };
}
export interface WhyGap {
  id: string; type: GapType; stage: string; claimId: string; requirementIds: string[];
  witnessIds: string[]; evidenceIds: string[]; reasonCode: string; explanation: string;
  expected: unknown; observed: unknown; blockingScope: 'ALTERNATIVE' | 'SUBCLAIM' | 'ROOT';
  causeGapIds: string[]; evaluationState: 'COMPLETE' | 'PENDING';
}
export interface WhyWitness {
  id: string; bindingIds: string[]; chosenBranches: Record<string, string[]>;
  bindingsByRequirement: Record<string, string[]>; evidenceIds: string[];
  status: 'ACTIVE' | 'REJECTED' | 'PENDING' | 'DUPLICATE'; gapIds: string[]; duplicateOf?: string;
  eventResults: { ruleId: string; result: 'MATCH' | 'MISMATCH' | 'UNKNOWN'; expected: unknown; observed: unknown }[];
}
export interface WhyConfidence {
  supportScore: number | null; range: [number, number] | null; threshold: number | null;
  sufficient: boolean | null; reason: string; method: 'SHARED_ATOMS' | 'CONSERVATIVE_BOUNDS' | 'UNASSESSED';
  atoms: { id: string; bindingIds: string[]; score: number | null }[];
  trace: { nodeId: string; operator: LogicOperator; expression: string; supportScore: number | null; range: [number, number] | null; threshold: number | null }[];
  bayesian?: BayesianConfidence;
}
export interface BayesianNodeTrace {
  nodeId: string; operator: LogicOperator; prior: number | null; posterior: number | null;
  range: [number, number] | null; logLikelihoodRatio: number | null; bindingIds: string[]; reason: string;
  priorBasis?: 'PROVIDED' | 'BASELINE';
}
export interface BayesianBindingTrace {
  bindingId: string; evidenceId: string; requirementId: string; observationId: string | null;
  rawLikelihoodRatio: number | null; basis: WhyLikelihoodBasis;
  sourceCoefficient: number | null; materialCoefficient: number | null; weight: number | null;
  adjustedLogLikelihoodRatio: number | null; adjustedLikelihoodRatio: number | null;
  likelihoodBasis?: 'PROVIDED' | 'BASELINE';
  status: 'USED' | 'DUPLICATE' | 'EXCLUDED' | 'UNASSESSED'; reason: string;
}
/** Conditional on explicit priors, LR estimates and dependence assumptions;
 * linear reliability discounting is a product policy, not empirical calibration. */
export interface BayesianConfidence {
  status: 'ASSESSED' | 'PARTIAL' | 'UNASSESSED'; method: 'LINEAR_RELIABILITY_BAYES';
  score: number; grade: import('../lib/confidence-grade').ConfidenceGrade;
  /** Same eligible, deduplicated goal observations before source reliability discounting. */
  baselineScore: number;
  scoreBasis: 'POSTERIOR' | 'CONSERVATIVE_LOWER_BOUND';
  posterior: number | null; range: [number, number] | null; threshold: number | null; sufficient: boolean | null;
  reason: string; unknownReasons: string[]; assumptions: string[];
  trace: BayesianNodeTrace[]; bindings: BayesianBindingTrace[];
}
export interface WhyAction {
  id: string; gapIds: string[]; type: 'SEARCH_EVIDENCE' | 'REQUEST_EVIDENCE' | 'EXPLAIN_MISMATCH' | 'EXPLAIN_TRUST' | 'TRACE_SOURCE' | 'REQUEST_SOURCE' | 'PROPOSE_CHAINS';
  title: string; reason: string; requirementIds: string[]; kinds: string[]; fields: string[];
  criteria: string[]; query: string; status: 'PROPOSED' | 'WAITING_USER';
  strategies?: { title: string; requiredEvidence: string[]; closedGapIds: string[]; remainingGaps: string[]; eventJoinRules: string[]; sourceIndependenceNeeds: string; availability: string }[];
}
export interface WhyResult {
  evaluationStatus: 'COMPLETE' | 'INCOMPLETE'; chainStatus: 'COMPLETE_CHAIN_FOUND' | 'NO_COMPLETE_CHAIN' | 'UNDETERMINED';
  accepted: boolean; witnesses: WhyWitness[]; gaps: WhyGap[]; actions: WhyAction[];
  confidence: WhyConfidence; limits: string[];
  provenance: { evidenceId: string; visited: string[]; stop: string; likelihoods: WhyProvenance['likelihood'][] }[];
}
export interface WhyRunStage {
  stage: 'drafting' | 'validating' | 'evaluating' | 'estimating' | 'saving';
  startedAt: string;
  completedAt?: string;
}
export interface WhyPreparation {
  version: 'cluevia-preparation-1'; ready: boolean;
  /** Display points on a 0–100 scale; BayesianConfidence.score remains 0–1. */
  baselineScore: number | null; score: number | null; grade: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | null;
  preparedAt: string | null;
  animation: { gapId: string; delayMs: number; durationMs: number }[];
  gapFill: { actionId: string; status: 'PLANNED' }[];
}
export interface WhyRun {
  id: string; jobId: string; previousId: string | null; createdAt: string; updatedAt: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled'; stage: string;
  snapshot?: WhySnapshot; result?: WhyResult; error?: string; inputHash?: string;
  /** Immutable analysis state used to select this assessment's evidence. */
  analysisRevision?: string;
  /** Actual execution steps; fast steps remain visible after polling skips them. */
  stages?: WhyRunStage[];
  /** Identifies the first automatic attempt; failed attempts are never auto-retried. */
  attemptKey?: string;
  /** Persisted deterministic diagnostics and fill plans, prepared independently of the UI. */
  preparation?: WhyPreparation;
  /** Graph generation completes durably before the diagnostic worker starts. */
  phase?: 'building-graph' | 'graph-ready' | 'diagnosing' | 'ready';
  /** Immutable graph before diagnostic verdicts, retained across review and replay. */
  baseSnapshot?: WhySnapshot;
  graphReadyAt?: string;
  /** Early graph-only work waits for main analysis of the same material. */
  awaitingAnalysis?: boolean;
  baselineInputHash?: string;
  /** Explicit supplementary URL reads; fetched text is separate evidence. */
  urlReads?: { documentId: string; url: string; status: 'fetched' | 'failed'; finalUrl?: string; title?: string; characters?: number; truncated?: boolean; reason?: string }[];
  estimation?: {
    status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
    model: string; effort: 'low'; requestedFrom?: string; completedAt?: string; error?: string;
  };
}
export interface WhyRunList { runs: WhyRun[] }

/** Display positions only. Saved diagnostic links and gaps remain in WhyRun. */
export interface WhyOverviewLayout {
  jobId: string;
  revision: number;
  updatedAt: string | null;
  positions: Record<string, { x: number; y: number }>;
}

/** Read-only overview of the last saved assessment, never a truth probability. */
export interface OverviewConfidenceSummary {
  state: 'ready' | 'unassessed' | 'pending' | 'incomplete' | 'stale';
  confidence: WhyConfidence | null;
  goal: string | null;
  reason: string;
  unknownReasons: string[];
  inputs: {
    id: string; label: string;
    sourceCoefficient: number | null; materialCoefficient: number | null;
    sourceReason?: string; materialReason?: string; excludedReason?: string;
  }[];
  policyVersion: string | null;
  assessmentVersion: string | null;
  evaluatedAt: string | null;
  assumptions: string[];
  coverageNote: string;
  accepted: boolean;
  nodeLabels?: Record<string, string>;
}
