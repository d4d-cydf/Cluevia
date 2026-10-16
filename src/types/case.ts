export type ObjectGroup = 'domain' | 'infra' | 'artifact' | 'money';
export type WorkspaceView = 'overview' | 'board' | 'lanes';

export interface CaseObject {
  id: string;
  type: string;
  group: ObjectGroup;
  stage: number;
  value: string;
  src: string;
  conf: string;
  note: string;
  props: [string, string][];
  actions: string[];
}

export interface CaseLink {
  id: string;
  source: string;
  target: string;
  label: string;
  kind: 'obs' | 'ans' | 'inf';
}

export interface TimelineRow {
  id: string;
  name: string;
  group: ObjectGroup;
  type: string;
  actions: string[];
}

export interface TimelineEvent {
  id: string;
  row: string;
  d: number;
  label: string;
  ev: string;
  note: string;
  ans?: boolean;
  inf?: boolean;
}

export interface TimelineConnector { d: number; a: string; b: string; ans: boolean }
export interface Attachment { id: string; name: string; size: number }
export interface CaseDraft { question: string; files: Attachment[] }
export interface CaseMessage { id: string; role: 'user' | 'assistant'; text: string; files?: Attachment[] }
export interface CaseAction { id: string; objectId: string; label: string; status: 'queued'; createdAt: string }

export interface InvestigationCase {
  id: string;
  title: string;
  question: string;
  objects: Record<string, CaseObject>;
  links: CaseLink[];
  timeline: {
    rows: TimelineRow[];
    events: TimelineEvent[];
    connectors: TimelineConnector[];
    payments: [number, number][];
  };
}

/** Replace this boundary with an OSDK implementation when connecting live data. */
export interface CaseRepository {
  getCase(id: string): Promise<InvestigationCase | null>;
  listObjects(caseId: string): Promise<CaseObject[]>;
  listLinks(caseId: string): Promise<CaseLink[]>;
  runAction(caseId: string, objectId: string, label: string): Promise<CaseAction>;
  sendMessage(caseId: string, text: string, files: Attachment[]): Promise<CaseMessage>;
}
