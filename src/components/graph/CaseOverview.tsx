import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import type { WhyRun, WhyRunList } from '../../types/why-not';
import type { GraphSelection } from '../../types/graph';
import { apiRequest } from '../../services/api-client';
import { buildGapOverview } from '../../lib/gap-overview';
import ClaimOverview from './ClaimOverview';
import GraphRenderer from './GraphRenderer';
import GapReviewOverlay from './GapReviewOverlay';
import WhyNotPanel from '../WhyNotPanel';
import OverviewConfidence from './OverviewConfidence';
import { useOverviewConfidence } from './useOverviewConfidence';
import { useOverviewLayout } from './useOverviewLayout';
import './case-overview.css';

type Props = ComponentProps<typeof ClaimOverview> & {
  canBuild?: boolean;
  revision?: number;
  onInspectChange?: (open: boolean) => void;
  confidenceHidden?: boolean;
};
const validScore = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;

/** Generate the baseline first; reveal prepared diagnostics on that same canvas. */
export default function CaseOverview({ canBuild = false, revision = 0, onInspectChange, confidenceHidden = false, ...overview }: Props) {
  const { graph, jobId, active = true, pending = false, query = '', onRecord, onSelect } = overview;
  const layout = useOverviewLayout(jobId);
  const [stored, setStored] = useState<{ jobId: string; runs: WhyRun[]; loaded: boolean }>({ jobId: '', runs: [], loaded: false });
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [selection, setSelection] = useState<GraphSelection>(null);
  const [enabled, setEnabled] = useState(false);
  const [checksOpened, setChecksOpened] = useState(false);
  const [checksOpen, setChecksOpen] = useState(false);
  const [focusGapId, setFocusGapId] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [scoreComparison, setScoreComparison] = useState<{ runId: string; score: number } | null>(null);
  const read = useRef<AbortController | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const guard = useRef(false);
  const savedCache = useRef(new Map<string, WhyRun>());
  const lastRevealedScore = useRef<number | undefined>(undefined);
  const lastBaselineScore = useRef<number | undefined>(undefined);
  const inspectChange = useRef(onInspectChange); inspectChange.current = onInspectChange;
  const endpoint = jobId ? `/api/jobs/${encodeURIComponent(jobId)}/why-not` : '';
  const readable = !!jobId;
  const eligible = !!jobId && !pending && canBuild;
  const runs = stored.jobId === jobId ? stored.runs : [];
  const latest = runs[0];
  const saved = runs.find(run => run.status === 'completed' && run.snapshot && run.result);
  const running = latest?.status === 'running';
  const prepared = !pending && latest?.status === 'completed' && latest.preparation?.ready === true;
  const displayRun = latest?.baseSnapshot || latest?.snapshot ? latest : saved;
  const baseVisible = !!(displayRun?.baseSnapshot ?? displayRun?.snapshot);
  const phase = !baseVisible ? 'building-graph' : prepared ? 'ready' : latest?.phase === 'diagnosing' ? 'diagnosing' : 'graph-ready';
  const loading = readable && (stored.jobId !== jobId || !stored.loaded);
  const checksVisible = checksOpen && active && !confidenceHidden;
  const confidence = useOverviewConfidence({ jobId, goal: graph.question, active, pending,
    revision: `${revision}/${graph.id}/${graph.nodes.length}/${graph.edges.length}/${graph.sources.length}/${latest?.id}/${latest?.updatedAt}/${latest?.status}/${refresh}` });
  const model = useMemo(() => buildGapOverview(graph, displayRun, { checking: false, stale: false, evidenceOnly: true, showGaps: enabled && prepared }), [graph, displayRun, enabled, prepared]);
  const estimationPending = latest?.estimation?.status === 'pending' || latest?.estimation?.status === 'running';
  const scoreReady = prepared && !estimationPending && validScore(latest?.preparation?.baselineScore) && validScore(latest?.preparation?.score);
  const calculating = !scoreReady && (pending || loading || !latest || running || estimationPending);
  const previousAssessment = saved?.id !== latest?.id ? saved?.preparation : undefined;
  const previousScore = enabled ? lastRevealedScore.current ?? previousAssessment?.score : lastBaselineScore.current ?? previousAssessment?.baselineScore;

  useEffect(() => {
    setError(''); setActionError(''); setBusy(false); guard.current = false;
    setEnabled(false); setSelection(null); setChecksOpened(false); setChecksOpen(false); setFocusGapId(null);
    setRevealing(false); savedCache.current.clear();
    setScoreComparison(null);
    lastRevealedScore.current = undefined;
    lastBaselineScore.current = undefined;
    return () => { mutation.current?.abort(); };
  }, [jobId]);
  useEffect(() => {
    if (scoreReady && validScore(latest?.preparation?.baselineScore)) lastBaselineScore.current = latest.preparation.baselineScore;
  }, [scoreReady, latest?.preparation?.baselineScore]);
  useEffect(() => { inspectChange.current?.(checksVisible); }, [checksVisible]);
  useEffect(() => () => inspectChange.current?.(false), []);

  useEffect(() => {
    if (!active || !readable) return;
    const controller = new AbortController(); read.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const data = await apiRequest<WhyRunList>(endpoint, { signal: controller.signal });
        if (controller.signal.aborted) return;
        const completed = data.runs.find(run => run.status === 'completed');
        if (completed) {
          let complete = completed.snapshot && completed.result ? completed : savedCache.current.get(completed.id);
          if (!complete) complete = (await apiRequest<{ run: WhyRun }>(`${endpoint}/runs/${encodeURIComponent(completed.id)}`, { signal: controller.signal })).run;
          if (controller.signal.aborted) return;
          if (complete.snapshot && complete.result) {
            savedCache.current.set(complete.id, complete);
            data.runs = data.runs.map(run => run.id === complete.id ? complete : run);
          }
        }
        setStored({ jobId: jobId!, runs: data.runs, loaded: true }); setError('');
        // Keep observing saved versions while this canvas is visible. Evidence
        // can arrive from the inspector, case chat, or another open session.
        timer = setTimeout(() => void load(), data.runs[0]?.preparation?.ready || ['failed', 'cancelled'].includes(data.runs[0]?.status ?? '') ? 4000 : 1200);
      } catch (failure) {
        if (controller.signal.aborted) return;
        setError(failure instanceof Error ? failure.message : '저장된 공백 검사를 불러오지 못했습니다.');
        setStored(previous => ({ jobId: jobId!, runs: previous.jobId === jobId ? previous.runs : [], loaded: true }));
      }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [active, readable, endpoint, jobId, revision, refresh, running]);

  useLayoutEffect(() => {
    if (!enabled || !prepared) return;
    const before = lastRevealedScore.current ?? latest?.preparation?.baselineScore;
    setScoreComparison(latest && validScore(before) ? { runId: latest.id, score: before } : null);
    setRevealing(true);
    const timer = setTimeout(() => {
      if (typeof latest?.preparation?.score === 'number') lastRevealedScore.current = latest.preparation.score;
      setRevealing(false);
    }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1500);
    return () => { clearTimeout(timer); setRevealing(false); };
  }, [enabled, prepared, latest?.id]);
  // Keep the open review visible while supplementary evidence is processed so
  // its progress, cancellation control and completion notice stay accessible.

  const receiveRun = useCallback((run: WhyRun) => {
    read.current?.abort();
    setRefresh(value => value + 1);
    setStored(previous => {
      const old = previous.jobId === jobId ? previous.runs[0] : undefined;
      if (old?.id === run.id && old.updatedAt === run.updatedAt && old.status === run.status) return previous;
      if (run.snapshot && run.result) savedCache.current.set(run.id, run);
      return { jobId: jobId!, loaded: true, runs: [run, ...(previous.jobId === jobId ? previous.runs.filter(item => item.id !== run.id) : [])] };
    });
  }, [jobId]);

  async function build() {
    if (!eligible || guard.current || running || loading || error) return;
    guard.current = true; setBusy(true); setActionError(''); read.current?.abort();
    const controller = new AbortController(); mutation.current = controller;
    try {
      const data = await apiRequest<{ run: WhyRun }>(endpoint, {
        method: 'POST', signal: controller.signal,
        body: JSON.stringify({ goal: graph.question, previousId: latest?.id ?? null }),
      });
      if (!controller.signal.aborted) receiveRun(data.run);
    } catch (failure) {
      if (!controller.signal.aborted) setActionError(failure instanceof Error ? failure.message : '공백 검사를 시작하지 못했습니다.');
    } finally {
      if (!controller.signal.aborted) { guard.current = false; setBusy(false); setRefresh(value => value + 1); }
    }
  }
  function toggleChecks() {
    if (enabled) { setEnabled(false); setChecksOpen(false); setScoreComparison(null); lastRevealedScore.current = undefined; return; }
    if (prepared) setEnabled(true);
  }

  const openChecks = (gapId: string | null = null) => { setFocusGapId(gapId); setChecksOpened(true); setChecksOpen(true); onSelect(null); };
  const select = (next: GraphSelection) => {
    setSelection(next);
    const context = next && model.contextById[next.id];
    if (next && context && enabled) openChecks(context.kind === 'goal' ? null : model.gapByNode[next.id] ?? model.gapByEdge[next.id] ?? context.gapIds[0] ?? null);
    else { setChecksOpen(false); onSelect(context ? null : next); }
  };

  return <div className="case-overview" data-overview-phase={phase}>
    {jobId && <div className={`co-check-toolbar${!prepared ? ' is-checking' : ''}`}>
      <div className="co-check-actions">
        {layout.status === 'saving' && <span className="co-layout-state" role="status">Saving…</span>}
        {layout.status === 'error' && <button type="button" title={layout.error} aria-label="그래프 위치 저장 다시 시도" onClick={layout.retry}>Save retry</button>}
        {(error || actionError) && <button type="button" title={error || actionError} onClick={() => setRefresh(value => value + 1)}>Retry</button>}
        {['failed', 'cancelled'].includes(latest?.status ?? '') && <button type="button" disabled={busy} onClick={() => void build()}>Retry checks</button>}
        <button className="co-cluevia-toggle" type="button" aria-pressed={enabled && prepared} disabled={!prepared || loading || busy} onClick={toggleChecks}><i />{prepared ? `Cluevia ${enabled ? 'off' : 'on'}` : latest?.status === 'failed' ? (baseVisible ? 'Cluevia failed' : 'Overview failed') : phase === 'diagnosing' ? 'Cluevia loading' : baseVisible ? 'Overview ready' : 'Overview loading'}</button>
      </div>
    </div>}
    {jobId ? <section className="co-live-graph" aria-label="분석 결과 요약">
      <GraphRenderer graph={model.graph} decorations={model.decorations} persistedPositions={layout.positions} onPositionsChange={layout.save} view="board" selection={selection} onSelect={select} showPath={false} query={query} />
    </section> : <ClaimOverview {...overview} />}
    {checksOpened && jobId && <GapReviewOverlay hidden={!checksVisible} title="Evidence check" description="경고가 연결된 근거와 판정을 확인하고 보완하세요." onClose={() => setChecksOpen(false)}>
      <WhyNotPanel key={jobId} jobId={jobId} question={graph.question} compact focusGapId={focusGapId} active={checksVisible} onRunChange={receiveRun} onRecord={number => onRecord?.(number)} />
    </GapReviewOverlay>}
    <OverviewConfidence {...confidence} baselineScore={scoreReady ? enabled && scoreComparison?.runId === latest?.id ? scoreComparison.score : latest?.preparation?.baselineScore : null} preparedScore={scoreReady ? latest?.preparation?.score : null} previousScore={previousScore} computing={calculating} showResult={enabled && !revealing && scoreReady} hidden={!baseVisible || !active || confidenceHidden || checksVisible} />
  </div>;
}
