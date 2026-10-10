import type { AnalysisBrief } from '../types/clarification';

const tokenKey = 'cluevia.workspace.token';

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.name = 'ApiError'; this.status = status; }
}
export class ApiUnavailableError extends ApiError {
  constructor() { super('서버에 연결할 수 없습니다. 서버 실행 상태를 확인해주세요.', 0); this.name = 'ApiUnavailableError'; }
}

export function getWorkspaceToken(): string {
  try { return sessionStorage.getItem(tokenKey) || ''; } catch { return ''; }
}
export function setWorkspaceToken(value: string): void {
  try { if (value) sessionStorage.setItem(tokenKey, value.trim()); else sessionStorage.removeItem(tokenKey); }
  catch { throw new Error('이 탭에서 접속 키를 저장할 수 없습니다. 브라우저 저장소 설정을 확인해주세요.'); }
}

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const token = getWorkspaceToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let response: Response;
  try { response = await fetch(path, { ...options, headers }); }
  catch (error) { if (error instanceof DOMException && error.name === 'AbortError') throw error; throw new ApiUnavailableError(); }
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  if (response.status === 404 && !payload) throw new ApiUnavailableError();
  if (!response.ok) throw new ApiError(payload?.error || (response.status === 401 ? '워크스페이스 접속 키를 확인해주세요.' : '요청을 처리하지 못했습니다.'), response.status);
  if (!payload) throw new ApiUnavailableError();
  return payload as T;
}

export interface GenerationJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  stage: 'designing' | 'preparing' | 'extracting' | 'validating' | 'saving';
  message: string;
  question: string;
  analysisBrief?: AnalysisBrief;
  createdAt: string;
  updatedAt: string;
  ontologyId?: string;
  ontologyVersion?: number;
  ontologyName?: string;
  schemaOnly?: boolean;
  graphId?: string;
  graphIds?: string[];
  completedChunks?: number;
  totalChunks?: number;
  emptyChunks?: number;
  currentSource?: string;
  resumable?: boolean;
  error?: string;
  processingMode?: 'hybrid' | 'codex';
  jevRouting?: { message: string };
  firstGraphMs?: number; elapsedMs?: number; startedAt?: string;
  metrics?: {
    scopeSkippedParts?: number; codexRunMs?: number; codexQueueMs?: number; preparationMs?: number; jevRoutingMs?: number; designMs?: number; designTimeoutRetries?: number; validationRetries?: number; timeoutSplits?: number;
    structuredRecords: number;
    deterministicParts: number;
    jevRequests: number;
    jevInputTokens: number;
    jevDecisions?: number;
    jevAssistedParts?: number;
    jevFallbackParts?: number;
    codexBatches?: number;
    codexCalls: number;
    cacheHits: number;
    reviewParts: number;
  };
}
export interface GraphSummary { id: string; title: string; createdAt?: string; origin?: string; nodeCount?: number; edgeCount?: number }
export interface JevDecisionRecord {
  sourceName: string;
  characters: number;
  cached: boolean;
  createdAt: string;
  result: {
    route: 'batch' | 'individual';
    reason: string;
    decisions: {
      id: string;
      selection: string;
      confidence: number;
      accepted: boolean;
      displayName?: string;
      selectionLabel?: string;
    }[];
  };
}
export interface SystemStatus {
  authenticated: boolean;
  authRequired: boolean;
  provider?: {
    kind: 'hybrid' | 'codex';
    ontologyPlanning?: boolean;
    available: boolean;
    authenticated: boolean | null;
    message: string;
    jev?: { configured: boolean; model: string };
    codex?: { available: boolean; authenticated: boolean | null; message: string };
  };
  ontology?: { entities: number; relationships: number; documents: number; graphs: number };
  activeJobs?: GenerationJob[];
  resumableJobs?: GenerationJob[];
  upload?: { maxFileBytes: number; chunkChars: number };
}
export const isActiveJob = (job: GenerationJob | null) => !!job && (job.status === 'queued' || job.status === 'running');

export interface UploadedDocument { id: string; name: string; bytes: number; characters: number; chunkCount: number; createdAt: string }
export interface GraphCollection { jobId: string | null; graphs: { id: string; title: string }[]; index: number; total: number; status?: GenerationJob['status']; completedChunks?: number; totalChunks?: number; emptyChunks?: number; resumable?: boolean }
export async function uploadDocument(file: Blob, name: string, signal?: AbortSignal): Promise<UploadedDocument> {
  const result = await apiRequest<{ document: UploadedDocument }>('/api/documents/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) }, body: file, signal });
  return result.document;
}
