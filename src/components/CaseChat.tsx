import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { apiRequest } from '../services/api-client';
import type { CaseChatState, CaseChatTurn } from '../types/case-chat';
import type { GraphSelection } from '../types/graph';
import { BrandMark } from './BrandLogo';
import './case-chat.css';

export default function CaseChat({ jobId, question, selection, selectedLabel, onRecord }: {
  jobId: string; question: string; selection: GraphSelection; selectedLabel?: string; onRecord: (number: number) => void;
}) {
  const [state, setState] = useState<CaseChatState>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [includeSelection, setIncludeSelection] = useState(false);
  const running = state?.turns.some(turn => turn.status === 'running') ?? false;
  useEffect(() => {
    const controller = new AbortController(); let timer: number | undefined;
    async function poll() {
      try {
        const result = await apiRequest<CaseChatState>(`/api/jobs/${encodeURIComponent(jobId)}/chat`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setState(result); setError('');
        if (result.turns.some(turn => turn.status === 'running')) timer = window.setTimeout(() => void poll(), 1500);
      } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '대화를 불러오지 못했습니다.'); }
    }
    void poll(); return () => { controller.abort(); window.clearTimeout(timer); };
  }, [jobId, refresh]);
  async function send(event: FormEvent) {
    event.preventDefault(); if (!draft.trim() || sending || running) return;
    setSending(true); setError('');
    try {
      const result = await apiRequest<{ turn: CaseChatTurn }>(`/api/jobs/${encodeURIComponent(jobId)}/chat`, { method: 'POST', body: JSON.stringify({ question: draft.trim(), selection: includeSelection ? selection : null }) });
      setState(previous => ({ model: previous?.model ?? 'gpt-6.1-sol', effort: previous?.effort ?? 'xhigh', turns: [...(previous?.turns ?? []), result.turn] }));
      setDraft(''); setRefresh(value => value + 1);
    } catch (error) { setError(error instanceof Error ? error.message : '질문을 보내지 못했습니다.'); }
    finally { setSending(false); }
  }
  return <section className="case-chat" aria-label="케이스 결과 대화">
    <div className="ws-assistant-label"><BrandMark size={18} /><span>CASE COPILOT</span></div>
    <h1>결과에 대해 물어보세요</h1><p className="case-chat-question">{question}</p>
    <p className="case-chat-intro">전체 그래프에서 질문에 관련된 기록과 원문을 찾아 답변합니다.</p>
    {state && <small className="case-chat-model">{state.model} · {state.effort}</small>}
    <div className="case-chat-turns" aria-live="polite">{state?.turns.map(turn => <article key={turn.id}>
      <p className="case-chat-user">{turn.question}</p>
      {turn.status === 'running' ? <p className="case-chat-working" role="status"><i className="aw-spinner" /> 그래프와 근거를 확인하고 있습니다…</p> : turn.status === 'failed' ? <div role="alert"><p>{turn.error}</p><button type="button" onClick={() => setDraft(turn.question)}>질문 다시 작성</button></div> : <>
        <p className="case-chat-answer">{turn.answer}</p>
        {!!turn.citations?.length && <details><summary>답변의 근거 · {turn.citations.length}</summary>{turn.citations.map((citation, index) => <blockquote key={index}><button type="button" onClick={() => onRecord(citation.record)}>기록 {citation.record} 열기 ↗</button><p>{citation.quote}</p></blockquote>)}</details>}
      </>}
      <small>검색 대상 {turn.indexedRecords ?? turn.totalRecords}개 · 답변에 제공한 원문 {turn.recordsUsed.length} / {turn.totalRecords}개 · 미제공 기록으로 부재를 단정하지 않습니다.</small>
    </article>)}</div>
    <form onSubmit={event => void send(event)}><label className="sr-only" htmlFor={`case-chat-${jobId}`}>케이스에 질문</label><textarea id={`case-chat-${jobId}`} value={draft} onChange={event => setDraft(event.target.value)} maxLength={2000} rows={3} placeholder="이 결과에서 확인된 사실과 불확실한 부분은?" />
      {selection && selectedLabel && <label className="case-chat-selection"><input type="checkbox" checked={includeSelection} onChange={event => setIncludeSelection(event.target.checked)} />선택한 항목 함께 보기 · {selectedLabel}</label>}
      <button className="case-chat-send" type="submit" disabled={!state || !draft.trim() || sending || running}>{sending || running ? '답변 생성 중…' : '질문 보내기 →'}</button>
    </form>
    {error && <div className="case-chat-error" role="alert"><p>{error}</p><button type="button" onClick={() => setRefresh(value => value + 1)}>대화 다시 불러오기</button></div>}
  </section>;
}
