import { case0143 } from '../mock/case-0143';
import type { CaseAction, CaseDraft, CaseMessage, CaseRepository } from '../types/case';

export function readSession<T>(key: string, fallback: T): T {
  try {
    const value = sessionStorage.getItem(key);
    return value ? JSON.parse(value) as T : fallback;
  } catch { return fallback; }
}

export function writeSession(key: string, value: unknown): void {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Memory state still works when storage is unavailable. */ }
}

export function readCaseDraft(): CaseDraft | null {
  const value = readSession<CaseDraft | null>('cluevia.case-draft', null);
  if (!value || typeof value.question !== 'string' || !Array.isArray(value.files)) return null;
  return { question: value.question, files: value.files.filter(file => file && typeof file.name === 'string' && typeof file.id === 'string' && typeof file.size === 'number') };
}

/** Local adapter only: actions and questions never issue external requests. */
export const caseRepository: CaseRepository = {
  async getCase(id) { return id === case0143.id ? structuredClone(case0143) : null; },
  async listObjects(caseId) { return caseId === case0143.id ? structuredClone(Object.values(case0143.objects)) : []; },
  async listLinks(caseId) { return caseId === case0143.id ? structuredClone(case0143.links) : []; },
  async runAction(caseId, objectId, label) {
    const object = case0143.objects[objectId];
    if (caseId !== case0143.id || !object?.actions.includes(label)) throw new Error('This action is unavailable.');
    const action: CaseAction = { id: crypto.randomUUID(), objectId, label, status: 'queued', createdAt: new Date().toISOString() };
    return action;
  },
  async sendMessage(caseId, text, files) {
    if (caseId !== case0143.id || (!text.trim() && !files.length)) throw new Error('Add a question or a file first.');
    const message: CaseMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      text: files.length
        ? 'Added your question and file names to this demo case. Files have not been uploaded or analyzed. Live research is not available in this preview.'
        : 'Your question is saved in this demo case. Explore the linked evidence on the board or timeline. Live research is not available in this preview.',
    };
    return message;
  },
};
