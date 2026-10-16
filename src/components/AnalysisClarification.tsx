import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { apiRequest } from '../services/api-client';
import { saveClarificationDraft } from '../services/analysis-draft';
import type { ClarificationDraft } from '../services/analysis-draft';
import type { AnalysisBrief, ClarificationAnswer, ClarificationInput, ClarificationResult, ClarificationSource } from '../types/clarification';
import ProcessingIndicator from './ProcessingIndicator';
import './analysis-clarification.css';

interface Props {
  question: string;
  sources: ClarificationSource[];
  initialDraft?: ClarificationDraft;
  busy: boolean;
  error: string;
  uploadProgress: { name: string; index: number; total: number } | null;
  onCancel: () => void;
  onConfirm: (brief?: AnalysisBrief) => Promise<void>;
  onCancelUpload: () => void;
}

export default function AnalysisClarification({ question, sources, initialDraft, busy, error: submissionError, uploadProgress, onCancel, onConfirm, onCancelUpload }: Props) {
  const [result, setResult] = useState<ClarificationResult | null>(initialDraft?.result ?? null);
  const [answers, setAnswers] = useState<ClarificationAnswer[]>(initialDraft?.answers ?? []);
  const [selections, setSelections] = useState<Record<string, { option: string; text: string }>>(initialDraft?.selections ?? {});
  const [brief, setBrief] = useState<AnalysisBrief | null>(initialDraft?.brief ?? null);
  const [loading, setLoading] = useState(initialDraft?.pending ?? !initialDraft?.result);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const latestRequest = useRef<ClarificationInput>(initialDraft?.request ?? { question, sources, answers: [], round: 0 });
  const initial = useRef(initialDraft);
  const heading = useRef<HTMLHeadingElement>(null);
  const [templates, setTemplates] = useState<{ id: string; displayName: string; version: number }[]>([]);
  useEffect(() => { const controller = new AbortController(); void apiRequest<{ definitions?: typeof templates }>('/api/ontology', { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setTemplates(value.definitions ?? []); }).catch(() => undefined); return () => controller.abort(); }, []);

  async function ask(input: ClarificationInput) {
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    latestRequest.current = input;
    setLoading(true); setError(''); setAnswers(input.answers);
    try {
      await saveClarificationDraft({ request: input, result, answers: input.answers, selections, brief, pending: true });
      if (current.signal.aborted) return;
      const response = await apiRequest<ClarificationResult>('/api/analysis/clarify', { method: 'POST', body: JSON.stringify(input), signal: current.signal });
      if (current.signal.aborted) return;
      const nextBrief = response.status === 'ready' ? { ...response.brief, answers: input.answers } : null;
      await saveClarificationDraft({ request: input, result: response, answers: input.answers, selections: {}, brief: nextBrief, pending: false });
      if (current.signal.aborted) return;
      setResult(response); setAnswers(input.answers); setSelections({});
      setBrief(nextBrief);
    } catch (cause) {
      if (!current.signal.aborted) setError(cause instanceof Error ? cause.message : '확인 질문을 불러오지 못했습니다. 다시 시도해주세요.');
    } finally {
      if (!current.signal.aborted) { setLoading(false); controller.current = null; }
    }
  }

  useEffect(() => {
    // Scheduling avoids duplicate initial requests during development's effect replay.
    const timer = initial.current?.result && !initial.current.pending ? undefined : window.setTimeout(() => void ask(latestRequest.current), 0);
    return () => { window.clearTimeout(timer); controller.current?.abort(); };
  }, [question, sources]);
  useEffect(() => {
    if (!loading && !error && result) void saveClarificationDraft({ request: latestRequest.current, result, answers, selections, brief, pending: false });
  }, [result, answers, selections, brief, loading, error]);
  useEffect(() => { if (!loading) heading.current?.focus(); }, [loading]);

  const complete = result?.status === 'questions' && result.questions.every(item => {
    const selection = selections[item.id];
    return selection && (selection.option === '__other' ? !!selection.text.trim() : item.options.some(option => option.id === selection.option));
  });
  const canConfirm = brief && !!brief.objective.trim() && !!brief.scope.trim() && !!brief.output.trim();

  function submitAnswers(event: FormEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (!result || result.status !== 'questions' || !complete || loading || busy || controller.current) return;
    const next = result.questions.map(item => {
      const selection = selections[item.id];
      const option = item.options.find(value => value.id === selection.option);
      return { question: item.question, answer: selection.option === '__other' ? selection.text.trim() : `${option!.label}${option!.description ? ` — ${option!.description}` : ''}`.slice(0, 1500) };
    });
    void ask({ question, sources, answers: [...answers, ...next], round: Math.min(2, latestRequest.current.round + 1) as ClarificationInput['round'] });
  }

  function leave() { controller.current?.abort(); onCancel(); }
  function bypass() { controller.current?.abort(); setLoading(false); void onConfirm(); }

  return <section className="analysis-clarification" aria-label="분석 범위 확인" aria-busy={loading || busy}>
    <div className="clarification-file-tab"><svg width="15" height="17" viewBox="0 0 18 20" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M11 1H3a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6l-5-5Z" /><path d="M11 1v5h5M5 10h8M5 13h8M5 16h5" /></svg><span>ANALYSIS BRIEF</span></div>
    <div className="clarification-sheet">
    <div className="clarification-topline"><span className="clarification-file-state"><i aria-hidden="true" />{loading ? 'Preparing' : error ? 'Needs attention' : result?.status === 'ready' ? 'Ready for review' : 'Draft'}</span><ol className="clarification-steps" aria-label="분석 준비 단계"><li aria-current={result?.status !== 'ready' ? 'step' : undefined}><span>01</span> Questions</li><li aria-current={result?.status === 'ready' ? 'step' : undefined}><span>02</span> Review</li></ol></div>
    <header className="clarification-heading"><h1 ref={heading} tabIndex={-1}>{result?.status === 'ready' ? '이 범위로 분석할까요?' : '분석할 내용을 정리해 볼까요?'}</h1><p>{result?.introduction || '몇 가지 확인으로 분석할 대상과 원하는 결과를 정리합니다.'}</p></header>
    <div className="clarification-request"><span className="clarification-section-label">Your request</span><p>{question}</p>{sources.length > 0 && <div className="clarification-sources"><span>Sources <b>{sources.length}</b></span><ul aria-label="첨부 자료">{sources.map(source => <li key={source.id}>{source.name}</li>)}</ul></div>}</div>
    {result?.source === 'guided' && <p className="clarification-guided">기본 확인 질문 · 선택한 내용은 분석 범위에 반영됩니다.</p>}
    {loading && <div className="clarification-loading"><ProcessingIndicator phase="clarification" title={answers.length || latestRequest.current.answers.length ? '답변에 맞춰 범위를 정리하고 있습니다' : '요청에 맞는 확인 질문을 준비하고 있습니다'} /></div>}
    {!loading && error && <div className="clarification-error" role="alert"><p>{error}</p><button type="button" className="clarification-secondary" aria-label="질문 다시 불러오기" onClick={() => void ask(latestRequest.current)} disabled={busy}>Retry</button></div>}
    {!error && result?.status === 'questions' && <form className="clarification-questions" onSubmit={submitAnswers} aria-busy={loading || busy}>
      {result.questions.map((item, index) => <fieldset key={item.id} disabled={loading || busy} aria-describedby={`clarification-reason-${index}`}>
        <legend><span>{String(index + 1).padStart(2, '0')}</span>{item.question}</legend><p id={`clarification-reason-${index}`} className="clarification-reason">{item.reason}</p>
        <div className="clarification-options">{[...item.options, { id: '__other', label: '기타 · 직접 입력', description: '원하는 조건이나 다른 방향을 적어주세요.' }].map(option => <label key={option.id} className={`clarification-option${selections[item.id]?.option === option.id ? ' is-selected' : ''}`}><input type="radio" name={`clarification-${item.id}`} value={option.id} checked={selections[item.id]?.option === option.id} onChange={() => setSelections(previous => ({ ...previous, [item.id]: { option: option.id, text: previous[item.id]?.text || '' } }))} /><span><strong>{option.label}</strong><small>{option.description}</small></span></label>)}</div>
        {selections[item.id]?.option === '__other' && <label className="clarification-other"><span id={`clarification-other-label-${index}`}>{item.question} — 직접 입력</span><textarea aria-labelledby={`clarification-other-label-${index}`} aria-describedby={`clarification-other-count-${index}`} rows={3} maxLength={1500} value={selections[item.id]?.text || ''} placeholder="분석할 대상, 기간, 꼭 확인하고 싶은 내용을 적어주세요." onChange={event => setSelections(previous => ({ ...previous, [item.id]: { option: '__other', text: event.target.value } }))} required /><small id={`clarification-other-count-${index}`}>{selections[item.id]?.text.length || 0} / 1,500</small></label>}
      </fieldset>)}
      <div className="clarification-submit-row"><span>{loading ? '선택한 답변으로 범위를 정리하고 있습니다.' : '답변을 고른 뒤 최종 범위를 확인합니다.'}</span><button type="submit" className="clarification-primary" aria-label={loading ? '답변 정리 중…' : '답변으로 범위 정리'} disabled={!complete || loading || busy}>{loading ? 'Preparing…' : 'Continue'} <span aria-hidden="true">→</span></button></div>
    </form>}
    {!loading && !error && result?.status === 'ready' && brief && <form className="clarification-brief" onSubmit={event => { event.preventDefault(); if (canConfirm && !busy) void onConfirm({ ...brief, objective: brief.objective.trim(), scope: brief.scope.trim(), output: brief.output.trim() }); }}>
      <p className="clarification-brief-hint">필요한 부분을 직접 수정한 뒤 시작하세요.</p>
      {([{ key: 'objective', label: '분석 목적', title: 'Objective', limit: 2000 }, { key: 'scope', label: '분석 범위', title: 'Scope', limit: 2000 }, { key: 'output', label: '원하는 결과', title: 'Output', limit: 1000 }] as const).map((field, index) => <label key={field.key} className="clarification-document-field"><span><small>{String(index + 1).padStart(2, '0')}</small>{field.title}</span><textarea aria-label={field.label} rows={field.key === 'scope' ? 4 : 2} required maxLength={field.limit} disabled={busy} value={brief[field.key]} onChange={event => setBrief(previous => previous ? { ...previous, [field.key]: event.target.value } : null)} /></label>)}
      {!!templates.length && <label className="clarification-template"><span>Ontology</span><select aria-label="온톨로지 설계" value={brief.ontologyTemplateId ?? ""} disabled={busy} onChange={event => setBrief({ ...brief, ontologyTemplateId: event.target.value || undefined })}><option value="">자료에 맞게 새로 설계</option>{templates.map(template => <option key={template.id} value={template.id}>{template.displayName} · v{template.version} 재사용</option>)}</select><small>재사용은 설계 호출을 생략합니다. 원본 열 구조와 관계 의미가 같은 자료에 선택하세요.</small></label>}
      <details className="clarification-filters"><summary aria-label="실제 처리 범위 설정">Source & date filters</summary><p>선택하지 않은 자료와 기간 밖의 행도 원문 검색에 보존됩니다. 날짜가 없거나 정정·반증을 포함한 행은 계속 분석합니다.</p>
        {sources.map(source => <label key={source.id} className="clarification-source-filter"><input type="checkbox" checked={!brief.filters || !brief.filters.sourceNames.length || brief.filters.sourceNames.includes(source.name)} onChange={event => { const current = brief.filters ?? { sourceNames: sources.map(source => source.name), dateField: '', dateFrom: '', dateTo: '' }; const names = event.target.checked ? [...new Set([...current.sourceNames, source.name])] : current.sourceNames.filter(name => name !== source.name); if (names.length) setBrief({ ...brief, filters: { ...current, sourceNames: names } }); }} disabled={busy} />{source.name}</label>)}
        <div className="clarification-date-filters">
        {([{ key: 'dateField', label: '원본 날짜 열 이름', type: 'text' }, { key: 'dateFrom', label: '시작일', type: 'date' }, { key: 'dateTo', label: '종료일', type: 'date' }] as const).map(field => <label key={field.key}><span>{field.label}</span><input type={field.type} value={brief.filters?.[field.key] ?? ''} disabled={busy} onChange={event => setBrief({ ...brief, filters: { sourceNames: sources.map(source => source.name), dateField: '', dateFrom: '', dateTo: '', ...brief.filters, [field.key]: event.target.value } })} /></label>)}
        </div>
      </details>
      {answers.length > 0 && <details className="clarification-answer-history"><summary>확인한 질문과 답변 {answers.length}개</summary><dl>{answers.map((answer, index) => <div key={`${index}-${answer.question}`}><dt>{answer.question}</dt><dd>{answer.answer}</dd></div>)}</dl></details>}
      <div className="clarification-submit-row"><span>이 내용과 첨부 자료를 기준으로 분석합니다.</span><button type="submit" className="clarification-primary" aria-label={busy ? '분석 준비 중…' : '이 범위로 분석 시작'} disabled={!canConfirm || busy}>{busy ? 'Preparing…' : 'Start analysis'} <span aria-hidden="true">→</span></button></div>
    </form>}
    {uploadProgress && <div className="clarification-upload" role="status"><div><strong>자료 전송 {uploadProgress.index} / {uploadProgress.total}</strong><button type="button" className="clarification-secondary" aria-label="업로드 취소" onClick={onCancelUpload}>Cancel</button></div><p>{uploadProgress.name}</p></div>}
    {submissionError && <p className="clarification-error" role="alert">{submissionError}</p>}
    <footer className="clarification-footer"><button type="button" className="clarification-back" aria-label="요청 수정하기" onClick={leave} disabled={busy}><span aria-hidden="true">← </span>Edit request</button>{result?.status !== 'ready' && <button type="button" className="clarification-skip" aria-label="질문 없이 현재 요청으로 분석" onClick={bypass} disabled={busy}>Skip questions</button>}</footer>
    <details className="clarification-privacy"><summary>About this brief</summary><p>범위 확인에는 요청과 자료의 일부 미리보기만 사용합니다. 답변과 첨부 자료는 이 브라우저에 임시 보관해 새로고침 후 이어갈 수 있습니다. 분석을 시작하거나 요청 수정하기를 누르면 임시 사본을 지웁니다.</p></details>
    </div>
  </section>;
}
