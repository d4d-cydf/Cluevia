import type { AnalysisBrief, ClarificationAnswer, ClarificationInput, ClarificationResult, ClarificationSource } from '../types/clarification';
import type { UploadedDocument } from './api-client';

export interface AnalysisIntakeDraft {
  question: string;
  sourceText: string;
  files: { id: string; name: string; size: number; file: File }[];
  sources: ClarificationSource[];
  uploadedFiles: Record<string, UploadedDocument>;
}
export interface ClarificationDraft {
  request: ClarificationInput;
  result: ClarificationResult | null;
  answers: ClarificationAnswer[];
  selections: Record<string, { option: string; text: string }>;
  brief: AnalysisBrief | null;
  pending: boolean;
}

const sessionKey = 'cluevia.analysis-draft';
let queue: Promise<unknown> = Promise.resolve();

// File/Blob structured cloning keeps original bytes, including large files, out of
// localStorage. Serialize writes so a delayed save cannot undo a newer answer or clear.
function storage<T>(operation: (store: IDBObjectStore) => IDBRequest<T>, mode: IDBTransactionMode = 'readonly'): Promise<T> {
  const next = queue.then(() => new Promise<T>((resolve, reject) => {
    const opening = indexedDB.open('cluevia-analysis-drafts', 1);
    opening.onupgradeneeded = () => {
      const store = opening.result.createObjectStore('drafts');
      store.createIndex('updatedAt', 'updatedAt');
    };
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const transaction = db.transaction('drafts', mode);
      const store = transaction.objectStore('drafts');
      let request: IDBRequest<T>;
      try { request = operation(store); } catch (error) { transaction.abort(); db.close(); reject(error); return; }
      if (mode === 'readwrite') {
        const expired = store.index('updatedAt').openKeyCursor(IDBKeyRange.upperBound(Date.now() - 24 * 60 * 60 * 1000));
        expired.onsuccess = () => { const cursor = expired.result; if (cursor) { store.delete(cursor.primaryKey); cursor.continue(); } };
      }
      transaction.oncomplete = () => { db.close(); resolve(request.result); };
      transaction.onabort = transaction.onerror = () => { db.close(); reject(transaction.error); };
    };
  }));
  queue = next.catch(() => undefined);
  return next;
}

export async function saveAnalysisDraft(intake: AnalysisIntakeDraft): Promise<void> {
  try {
    let id = sessionStorage.getItem(sessionKey);
    if (!id) { id = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join(''); sessionStorage.setItem(sessionKey, id); }
    await storage(store => store.put({ value: intake, updatedAt: Date.now() }, `${id}:intake`), 'readwrite');
  } catch { /* Storage may be unavailable; the current in-memory workflow still works. */ }
}

export async function saveClarificationDraft(progress: ClarificationDraft): Promise<void> {
  try {
    const id = sessionStorage.getItem(sessionKey);
    if (id) await storage(store => store.put({ value: progress, updatedAt: Date.now() }, `${id}:progress`), 'readwrite');
  } catch { /* Do not block answering when browser storage is unavailable. */ }
}

export async function readAnalysisDraft(): Promise<{ intake: AnalysisIntakeDraft; progress?: ClarificationDraft } | null> {
  try {
    const id = sessionStorage.getItem(sessionKey);
    if (!id) return null;
    const intake = await storage(store => store.get(`${id}:intake`));
    if (!intake || intake.updatedAt < Date.now() - 24 * 60 * 60 * 1000) { await clearAnalysisDraft(); return null; }
    const progress = await storage(store => store.get(`${id}:progress`));
    return { intake: intake.value, progress: progress?.value };
  } catch { return null; }
}

export async function clearAnalysisDraft(): Promise<void> {
  try {
    const id = sessionStorage.getItem(sessionKey);
    sessionStorage.removeItem(sessionKey);
    if (id) await storage(store => { store.delete(`${id}:intake`); return store.delete(`${id}:progress`); }, 'readwrite');
  } catch { /* The session pointer is cleared even if browser database cleanup fails. */ }
}
