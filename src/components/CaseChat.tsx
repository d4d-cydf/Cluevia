import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { apiRequest, ApiError } from '../services/api-client';
import type { CaseChatState, CaseChatTurn } from '../types/case-chat';
import type { GraphSelection } from '../types/graph';
import { BrandMark } from './BrandLogo';
import { Icon } from './Icon';
import './case-chat.css';

function ChatThinking({ turn }: { turn: CaseChatTurn }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const started = Date.parse(turn.createdAt);
  const seconds = Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 1000)) : 0;
  const duration = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return <details className="case-chat-thinking" open>
    <summary aria-label="답변 준비 과정"><span className="case-chat-thinking-label">Thinking</span><time aria-live="off">{duration}</time><span className="case-chat-chevron" aria-hidden="true">⌄</span></summary>
    <div className="case-chat-thinking-copy" role="status">
      <p>자료를 확인하고 답변을 준비하고 있습니다.</p>
      {turn.recordsUsed.length > 0 && <span>관련 기록 {turn.recordsUsed.length}개를 참고하고 있습니다.</span>}
    </div>
  </details>;
}

export default function CaseChat({ jobId, question, selection, selectedLabel, onRecord, activity }: {
  jobId: string; question: string; selection: GraphSelection; selectedLabel?: string; onRecord: (number: number) => void;
  activity?: ReactNode;
}) {
  const [state, setState] = useState<CaseChatState>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [sendError, setSendError] = useState('');
  const [sending, setSending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [includeSelection, setIncludeSelection] = useState(false);
  const pollController = useRef<AbortController | null>(null);
  const sendController = useRef<AbortController | null>(null);
  const turnsRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const running = state?.turns.some(turn => turn.status === 'running') ?? false;
  const latestTurn = state?.turns.at(-1);
  useEffect(() => {
    const element = turnsRef.current;
    if (element && element.clientHeight > 0 && followLatest.current) element.scrollTop = element.scrollHeight;
  }, [state?.turns.length, latestTurn?.status, latestTurn?.answer, error, sendError]);
  useEffect(() => {
    const controller = new AbortController(); let timer: number | undefined;
    pollController.current = controller;
    async function poll() {
      if (controller.signal.aborted) return;
      try {
        const result = await apiRequest<CaseChatState>(`/api/jobs/${encodeURIComponent(jobId)}/chat`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setState(result); setError('');
        if (result.turns.some(turn => turn.status === 'running')) timer = window.setTimeout(() => void poll(), 1500);
      } catch (error) {
        if (controller.signal.aborted) return;
        setError(error instanceof Error ? error.message : '대화를 불러오지 못했습니다.');
        if (!(error instanceof ApiError && [401, 404].includes(error.status))) timer = window.setTimeout(() => void poll(), 5000);
      }
    }
    void poll(); return () => { controller.abort(); window.clearTimeout(timer); };
  }, [jobId, refresh]);
  useEffect(() => () => sendController.current?.abort(), []);
  async function send(event: FormEvent) {
    event.preventDefault(); if (!state || !draft.trim() || sendController.current || running) return;
    const submittedDraft = draft;
    const controller = new AbortController(); sendController.current = controller;
    pollController.current?.abort();
    setSending(true); setSendError('');
    try {
      const result = await apiRequest<{ turn: CaseChatTurn }>(`/api/jobs/${encodeURIComponent(jobId)}/chat`, { method: 'POST', body: JSON.stringify({ question: submittedDraft.trim(), selection: includeSelection ? selection : null }), signal: controller.signal });
      if (controller.signal.aborted) return;
      followLatest.current = true;
      setState(previous => ({ model: previous?.model ?? '', effort: previous?.effort ?? '', turns: [...(previous?.turns.filter(turn => turn.id !== result.turn.id) ?? []), result.turn] }));
      setDraft(current => current === submittedDraft ? '' : current); setError('');
    } catch (error) { if (!controller.signal.aborted) setSendError(error instanceof Error ? error.message : '질문을 보내지 못했습니다.'); }
    finally {
      if (!controller.signal.aborted) { sendController.current = null; setSending(false); setRefresh(value => value + 1); }
    }
  }
  return <section className="case-chat" aria-label="케이스 결과 대화">
    <header className="case-chat-heading"><div className="case-chat-brand"><BrandMark size={20} /><strong>Cluevia</strong></div><span>Chat</span></header>
    <div ref={turnsRef} className="case-chat-turns" aria-live="polite" onScroll={event => { const element = event.currentTarget; followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64; }}>
      <details className="case-chat-context"><summary><span>Case context</span><span className="case-chat-chevron" aria-hidden="true">⌄</span></summary><p className="case-chat-question">{question}</p></details>
      {activity && <details className="case-chat-activity"><summary aria-label="분석 처리 내역">Activity<span className="case-chat-chevron" aria-hidden="true">⌄</span></summary>{activity}</details>}
      {!state && !error && <p className="case-chat-loading" role="status">대화 기록을 불러오고 있습니다…</p>}
      {state && !state.turns.length && <div className="case-chat-empty"><h1 aria-label="결과에 대해 물어보세요">Ask your case.</h1><p className="case-chat-intro">궁금한 점을 물어보세요.<br />자료 속 근거를 함께 살펴볼게요.</p><button type="button" onClick={() => setDraft('이 결과에서 확인된 사실과 불확실한 부분은?')}>확인된 사실과 남은 공백 <span aria-hidden="true">↗</span></button></div>}
      {state?.turns.map(turn => <article className="case-chat-turn" key={turn.id}>
      <p className="case-chat-user">{turn.question}</p>
      <div className="case-chat-answer-heading"><BrandMark size={17} /><strong>Cluevia</strong></div>
      {turn.status === 'running' ? error ? <p className="case-chat-working">연결을 복구하면 답변 상태를 다시 확인합니다.</p> : <ChatThinking turn={turn} /> : turn.status === 'failed' ? <div className="case-chat-error" role="alert"><p>{turn.error}</p><button type="button" onClick={() => setDraft(turn.question)}>Retry</button></div> : <>
        <p className="case-chat-answer">{turn.answer}</p>
      </>}
      {turn.status !== 'running' && <details className="case-chat-sources"><summary aria-label={`답변의 근거 · ${turn.citations?.length ?? 0}`}><svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M5 2.5h6l4 4v11H5zM11 2.5v4h4M7.5 10h5M7.5 13h4" /></svg><span>{turn.citations?.length ? 'Sources' : 'Context'}</span><span className="case-chat-source-count">{turn.citations?.length || turn.recordsUsed.length}</span><span className="case-chat-chevron" aria-hidden="true">⌄</span></summary>
        {turn.citations?.map((citation, index) => <blockquote key={index}><button type="button" aria-label={`기록 ${citation.record} 열기 ↗`} onClick={() => onRecord(citation.record)}>Record {citation.record}<span aria-hidden="true">↗</span></button><p>{citation.quote}</p></blockquote>)}
        <small>검색 대상 {turn.indexedRecords ?? turn.totalRecords}개 · 답변에 제공한 원문 {turn.recordsUsed.length} / {turn.totalRecords}개<br />미제공 기록으로 부재를 단정하지 않습니다.</small>
      </details>}
    </article>)}
    {sending && <p className="case-chat-sending" role="status">질문을 보내고 있습니다…</p>}
    {error && <div className="case-chat-error" role="alert"><p>{error}</p><button type="button" aria-label="대화 다시 불러오기" disabled={sending} onClick={() => setRefresh(value => value + 1)}>Reconnect</button></div>}
    {sendError && <div className="case-chat-error" role="alert"><p>{sendError}</p><p>대화 기록을 확인한 뒤 다시 시도해주세요.</p></div>}
    </div>
    <form className="case-chat-compose" onSubmit={event => void send(event)}>
      {selection && selectedLabel && <label className="case-chat-selection" title={`선택한 항목 함께 보기 · ${selectedLabel}`}><input type="checkbox" checked={includeSelection} onChange={event => setIncludeSelection(event.target.checked)} /><span>선택한 항목 함께 보기 · {selectedLabel}</span></label>}
      <div className="case-chat-compose-field"><label className="sr-only" htmlFor={`case-chat-${jobId}`}>케이스에 질문</label><textarea id={`case-chat-${jobId}`} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} maxLength={2000} rows={2} placeholder="이 케이스에 대해 물어보세요" />
      <div className="case-chat-compose-actions">{state && <small className="case-chat-model" title={`${state.model} · ${state.effort}`}>{state.model} · {state.effort}</small>}<button className="case-chat-send" type="submit" disabled={!state || !draft.trim() || sending || running} aria-label={sending || running ? '답변 생성 중…' : '질문 보내기 →'} title="질문 보내기 (Ctrl/⌘ + Enter)"><Icon name="send" size={15} /><span className="sr-only">{sending || running ? '답변 생성 중…' : '질문 보내기 →'}</span></button></div></div>
    </form>
  </section>;
}
