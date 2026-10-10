/** User-approved requirements. This is analysis intent, never factual evidence. */
export interface ClarificationAnswer { question: string; answer: string }
export interface AnalysisBrief {
  ontologyTemplateId?: string;
  filters?: { sourceNames: string[]; dateField: string; dateFrom: string; dateTo: string };
  objective: string;
  scope: string;
  output: string;
  answers: ClarificationAnswer[];
}
export interface ClarificationSource { id: string; name: string; size: number; excerpt: string }
export interface ClarificationInput {
  question: string;
  sources: ClarificationSource[];
  answers: ClarificationAnswer[];
  round: number;
}
export interface ClarificationOption { id: string; label: string; description: string }
export interface ClarificationQuestion {
  id: string;
  question: string;
  reason: string;
  /** The client always adds a separate free-text 'Other' answer. */
  options: ClarificationOption[];
}
export interface ClarificationResult {
  status: 'questions' | 'ready';
  introduction: string;
  questions: ClarificationQuestion[];
  brief: AnalysisBrief;
  source: 'codex' | 'guided';
}
export type ClarificationRequest = ClarificationInput;
export type ClarificationResponse = ClarificationResult;
