import { useEffect, useMemo, useRef, useState } from 'react';
import { BrandMark } from './BrandLogo';
import { Icon } from './Icon';
import { apiRequest } from '../services/api-client';
import type { ReportList, ReportParagraph, ReportRun } from '../types/report';
import { renderReportGraphSvg, renderReportHtml, renderReportMarkdown, reportFilename } from '../lib/report-export';
import './case-report.css';

const stageLabels = { preparing: '자료와 분석 결과를 정리하고 있습니다.', writing: '근거와 공백을 연결해 보고서를 작성하고 있습니다.', verifying: '인용 출처와 보고서 내용을 대조하고 있습니다.', completed: '보고서를 저장했습니다.' };
const date = (value: string) => new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const score = (value: number) => value > 99.9 && value < 100 ? '>99.9' : value > 0 && value < .1 ? '<0.1' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);
const safeUrl = (value: string | null) => { try { if (!value || /[\u0000-\u0020\u007f]/.test(value)) return null; const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; } };

function Paper({ moving = false }: { moving?: boolean }) {
  return <div className={`report-paper-mark${moving ? ' is-writing' : ''}`} aria-hidden="true"><span /><i /><i /><i /><i /><b /></div>;
}

export default function CaseReport({ jobId, open, onClose }: { jobId: string; open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  const [list, setList] = useState<ReportList | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [activeCitation, setActiveCitation] = useState('');
  const endpoint = `/api/jobs/${encodeURIComponent(jobId)}/reports`;
  const active = list?.reports.find(report => report.status === 'running');
  const latestCompleted = list?.reports.find(report => report.status === 'completed' && report.content);
  const selected = list?.reports.find(report => report.id === selectedId) ?? latestCompleted;
  const report = selected?.status === 'completed' && selected.content ? selected : undefined;
  const completedReports = list?.reports.filter(item => item.status === 'completed' && item.content) ?? [];
  const reportVersion = report ? completedReports.length - completedReports.findIndex(item => item.id === report.id) : 0;
  const lastAttempt = list?.reports[0];
  const stale = !!report && !!list?.currentInputHash && report.inputHash !== list.currentInputHash;
  const graphSvg = useMemo(() => report ? renderReportGraphSvg(report) : '', [report]);
  const sourceIds = useMemo(() => new Map(report?.snapshot.citations.map((citation, index) => [citation.id, index + 1])), [report]);

  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!element?.open) element?.showModal();
    closeButton.current?.focus({ preventScroll: true });
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); onCloseRef.current(); return; }
      if (event.key !== 'Tab' || !element) return;
      const targets = [...element.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], select:not([disabled]), input:not([disabled]), textarea:not([disabled]), summary, [tabindex]')]
        .filter(target => target.tabIndex >= 0 && target.getClientRects().length > 0 && !target.closest('[hidden]'));
      const first = targets[0]; const last = targets.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !element.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !element.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', keyboard, true);
    return () => { window.removeEventListener('keydown', keyboard, true); element?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let timer: number;
    async function read() {
      let delay = 4000;
      try {
        const value = await apiRequest<ReportList>(endpoint, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setList(value); setError('');
        delay = value.reports.some(item => item.status === 'running') ? 1000 : 4000;
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : '보고서를 불러오지 못했습니다.');
      }
      if (!controller.signal.aborted) timer = window.setTimeout(() => void read(), delay);
    }
    void read();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [open, endpoint, refresh]);

  async function generate() {
    if (busy || active || !list?.canGenerate) return;
    setBusy(true); setError('');
    try {
      const value = await apiRequest<{ report: ReportRun }>(endpoint, { method: 'POST', body: JSON.stringify(latestCompleted ? { force: true } : {}) });
      setSelectedId('');
      setList(previous => previous ? { ...previous, reports: [value.report, ...previous.reports.filter(item => item.id !== value.report.id)] } : null);
      setRefresh(value => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '보고서 생성을 시작하지 못했습니다.'); }
    finally { setBusy(false); }
  }

  async function cancel() {
    if (busy || !active) return;
    setBusy(true); setError('');
    try {
      const value = await apiRequest<{ report?: ReportRun }>(`${endpoint}/cancel`, { method: 'POST', body: '{}' });
      if (value.report) setList(previous => previous ? { ...previous, reports: previous.reports.map(item => item.id === value.report!.id ? value.report! : item) } : null);
      setRefresh(value => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '보고서 생성을 중지하지 못했습니다.'); }
    finally { setBusy(false); }
  }

  function download(kind: 'html' | 'md') {
    if (!report) return;
    const text = kind === 'html' ? renderReportHtml(report) : renderReportMarkdown(report);
    const url = URL.createObjectURL(new Blob([text], { type: kind === 'html' ? 'text/html;charset=utf-8' : 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = reportFilename(report, kind); anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function print() {
    if (!report) return;
    const frame = document.createElement('iframe');
    frame.title = '보고서 인쇄'; frame.className = 'report-print-frame';
    // Only the escaped, self-contained report document reaches the print frame.
    frame.onload = () => {
      const target = frame.contentWindow;
      if (!target) { frame.remove(); return; }
      target.addEventListener('afterprint', () => frame.remove(), { once: true });
      target.focus(); target.print();
      window.setTimeout(() => frame.remove(), 60000);
    };
    frame.srcdoc = renderReportHtml(report); document.body.append(frame);
  }

  function cite(id: string) {
    setActiveCitation(id);
    const target = dialog.current?.querySelector<HTMLElement>(`[data-report-source="${sourceIds.get(id)}"]`);
    target?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' });
    target?.focus({ preventScroll: true });
  }
  const paragraph = (item: ReportParagraph, key: number) => <p key={key}>{item.text}{[...new Set(item.citationIds)].map(id => sourceIds.has(id) ? <button className="report-citation" key={id} type="button" aria-label={`출처 ${sourceIds.get(id)} 보기`} onClick={() => cite(id)}>[{sourceIds.get(id)}]</button> : <small key={id}> [인용 연결 확인 필요]</small>)}</p>;

  return <dialog ref={dialog} className="case-report" aria-labelledby="case-report-label" onCancel={event => { event.preventDefault(); onCloseRef.current(); }} onClick={event => { if (event.target === event.currentTarget) onCloseRef.current(); }}>
    <div className="report-shell">
      <header className="report-toolbar"><div className="report-brand"><BrandMark size={23} /><div><strong id="case-report-label">Case report</strong><span>CLUEVIA · RESEARCH FILE</span></div></div><div className="report-tools">
        {report && <><button type="button" onClick={() => download('html')}>HTML</button><button type="button" onClick={() => download('md')}>Markdown</button><button type="button" onClick={print}>Print / PDF</button></>}
        <button ref={closeButton} className="report-close" type="button" aria-label="보고서 닫기" onClick={onClose}><Icon name="close" size={20} /></button>
      </div></header>
      <div className="report-body">
        <aside className="report-index"><span className="report-eyebrow">THE REPORT</span><p>자료에서 결론까지,<br />근거를 따라 읽는 기록.</p>
          {report && <nav aria-label="Report sections"><a href="#report-conclusion">01 · Conclusion</a><a href="#report-findings">02 · Findings</a><a href="#report-graph">03 · Evidence map</a><a href="#report-gaps">04 · Gaps</a><a href="#report-sources">05 · Sources</a></nav>}
          {!!list?.reports.length && <label className="report-history">Version<select aria-label="Report version" value={selectedId || latestCompleted?.id || ''} onChange={event => { setSelectedId(event.target.value); setActiveCitation(''); }}>{!latestCompleted && <option value="">Current attempt</option>}{list.reports.filter(item => item.status === 'completed' && item.content).map((item, index, items) => <option key={item.id} value={item.id}>v{items.length - index} · {date(item.createdAt)}</option>)}</select></label>}
          <div className="report-generate"><button className="report-primary" type="button" disabled={!list?.canGenerate || !!active || busy} onClick={() => void generate()}>{busy && !active ? 'Starting…' : latestCompleted ? 'Generate again' : 'Generate report'}<span aria-hidden="true">↗</span></button>{!active && list?.blockingReason && <p>{list.blockingReason}</p>}<small>생성된 보고서는 저장됩니다.<br />창을 닫아도 작성은 계속됩니다.</small></div>
        </aside>
        <main className="report-scroll" aria-label="보고서 내용">
          {error && <div className="report-notice is-error" role="alert"><span>{error}</span><button type="button" onClick={() => setRefresh(value => value + 1)}>Retry</button></div>}
          {!list && !error && <div className="report-empty" role="status"><Paper moving /><p>저장된 보고서를 불러오고 있습니다.</p></div>}
          {active && <section className="report-progress" role="status" aria-live="polite" aria-label="보고서 생성 상태"><Paper moving /><div><span className="report-eyebrow">{active.stage.toUpperCase()}<span className="report-dots">...</span></span><h2>{stageLabels[active.stage]}</h2><p>현재 자료와 저장된 분석을 기준으로 작성합니다. 화면을 닫아도 작업은 유지됩니다.</p></div><button type="button" disabled={busy} onClick={() => void cancel()}>Cancel</button></section>}
          {active && !report && <div className="report-draft" data-report-draft aria-hidden="true"><div className="report-draft-page"><div className="report-draft-top"><span /><span /></div><div className="report-draft-title"><i /><i /></div><span className="report-draft-subtitle" /><div className="report-draft-rule" /><div className="report-draft-paragraph"><i /><i /><i /></div><div className="report-draft-columns"><span /><span /><span /></div><div className="report-draft-rule" /><div className="report-draft-paragraph"><i /><i /><i /><i /></div><div className="report-draft-seal"><BrandMark size={20} /><span>CLUEVIA / DRAFT</span></div></div></div>}
          {!active && lastAttempt && ['failed', 'cancelled'].includes(lastAttempt.status) && <div className="report-notice" role="status"><span>{lastAttempt.status === 'failed' ? `보고서를 완성하지 못했습니다. ${lastAttempt.error ?? ''}` : '보고서 작성을 중지했습니다.'}{latestCompleted ? ' 이전 보고서는 그대로 보관되어 있습니다.' : ''}</span></div>}
          {stale && <div className="report-notice" role="status"><span>이 보고서 작성 후 자료 또는 분석이 변경되었습니다. 최신 결과로 새 보고서를 생성할 수 있습니다.</span></div>}
          {list && !report && !active && <section className="report-empty"><Paper /><span className="report-eyebrow">A CLEARER PICTURE</span><h1>분석을 하나의 보고서로.</h1><p>질문에 대한 결론, 근거와 인용, 남은 공백을<br />현재 케이스의 기록으로 정리합니다.</p><div className="report-empty-rule" /><span>Conclusion · Evidence · Open questions</span></section>}
          {report && <article className="report-document" data-report-id={report.id}>
            <header className="report-cover"><div className="report-cover-meta"><span>CASE STUDY / VERSION {String(reportVersion).padStart(2, '0')}</span><time dateTime={report.createdAt}>{date(report.createdAt)}</time></div><h1>{report.content!.title}</h1><p className="report-subtitle">{report.content!.subtitle}</p><div className="report-question"><span>THE QUESTION</span><p>{report.snapshot.question}</p></div></header>
            <section id="report-conclusion" className="report-conclusion"><span className="report-eyebrow">01 / CONCLUSION</span>{report.content!.conclusion.map(paragraph)}</section>
            <div className="report-metrics"><div><span>Model score</span><strong>{report.snapshot.confidence.score === null ? '—' : score(report.snapshot.confidence.score)}<small>{report.snapshot.confidence.grade ?? ''}</small></strong></div><div><span>Sources</span><strong>{report.snapshot.coverage.sources}</strong></div><div><span>Open gaps</span><strong>{report.snapshot.gaps.length}</strong></div><p>{report.snapshot.confidence.note || '자료와 설정한 모형에 따른 지지 점수이며, 결론이 참일 확률이 아닙니다.'}</p></div>
            <section id="report-findings" className="report-section"><span className="report-eyebrow">02 / FINDINGS</span>{report.content!.sections.map((section, index) => <div className="report-finding" key={index}><h2>{section.heading}</h2>{section.paragraphs.map(paragraph)}</div>)}</section>
            <section id="report-graph" className="report-section"><span className="report-eyebrow">03 / EVIDENCE MAP</span><h2>결론으로 이어지는 근거</h2><figure className="report-graph"><div dangerouslySetInnerHTML={{ __html: graphSvg }} /><figcaption>보고서 생성 시점에 저장된 그래프 · {report.snapshot.coverage.nodes} nodes · {report.snapshot.coverage.edges} links</figcaption></figure></section>
            <section id="report-gaps" className="report-section"><span className="report-eyebrow">04 / GAPS & NEXT STEPS</span><h2>아직 확인이 필요한 부분</h2>{!report.snapshot.gaps.length && <p>이 보고서에 저장된 공백은 없습니다. 아래 한계와 인용 자료를 함께 확인해주세요.</p>}{report.snapshot.gaps.map((gap, index) => { const analysis = report.content!.gapAnalysis.find(item => item.gapId === gap.id); return <article className="report-gap" key={gap.id}><div className="report-gap-heading"><span>{String(index + 1).padStart(2, '0')}</span><h3>{gap.title}</h3><small>{gap.evaluationState === 'PENDING' ? '확인 대기' : '검토 필요'}</small></div><p>{gap.explanation}</p>{analysis && <p>{analysis.analysis}</p>}{(analysis?.recommendation || gap.recommendations.length > 0) && <div className="report-next"><span>NEXT</span>{analysis?.recommendation || gap.recommendations.join(' ')}</div>}{gap.requirements.length > 0 && <details><summary>관련 조건 · {gap.requirements.length}</summary><ul>{gap.requirements.map((item, i) => <li key={i}>{item}</li>)}</ul></details>}</article>; })}
              {report.content!.nextSteps.length > 0 && <div className="report-next-steps"><h3>다음 확인 순서</h3><ol>{report.content!.nextSteps.map((item, index) => <li key={index}>{item}</li>)}</ol></div>}
              {(report.content!.limitations.length > 0 || report.snapshot.coverage.notes.length > 0) && <aside className="report-limits"><h3>해석의 범위와 한계</h3><ul>{[...new Set([...report.content!.limitations, ...report.snapshot.coverage.notes])].map((item, index) => <li key={index}>{item}</li>)}</ul></aside>}
            </section>
            <section id="report-sources" className="report-section"><span className="report-eyebrow">05 / SOURCES</span><h2>근거를 원문에서 확인하기</h2>{report.snapshot.citations.map((citation, index) => <article key={citation.id} tabIndex={-1} data-report-source={index + 1} className={`report-source${activeCitation === citation.id ? ' is-active' : ''}`}><div><span className="report-source-number">{String(index + 1).padStart(2, '0')}</span><h3>{citation.sourceName}</h3>{citation.sourceGrade && <small>Grade {citation.sourceGrade}</small>}</div><blockquote>{citation.quote}</blockquote>{safeUrl(citation.url) ? <a href={safeUrl(citation.url)!} target="_blank" rel="noopener noreferrer">Open source ↗</a> : <span className="report-source-local">{citation.record === null ? '제공된 자료' : `기록 ${citation.record}`}</span>}</article>)}</section>
            <footer className="report-method"><BrandMark size={19} /><div><strong>Cluevia / Research record</strong><p>{report.model} · {report.effort} · {date(report.updatedAt)}</p><details><summary>Method & version</summary><p>자료와 저장된 그래프·공백 진단을 기준으로 작성한 AI 보고서입니다. 모델 점수는 사실의 확률을 뜻하지 않습니다. 인용문은 각 출처에서 확인할 수 있습니다.</p><dl><dt>Report</dt><dd>{report.id}</dd><dt>Assessment</dt><dd>{report.snapshot.whyRunId}</dd><dt>Analysis</dt><dd>{date(report.snapshot.analysisUpdatedAt)}</dd></dl></details></div></footer>
          </article>}
        </main>
      </div>
    </div>
  </dialog>;
}
