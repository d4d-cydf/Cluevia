export interface CaseChatTurn {
  id: string; question: string; createdAt: string; status: 'running' | 'completed' | 'failed';
  answer?: string; citations?: { record: number; quote: string }[]; error?: string;
  recordsUsed: number[]; totalRecords: number; indexedRecords?: number;
}
export interface CaseChatState { turns: CaseChatTurn[]; model: string; effort: string }
