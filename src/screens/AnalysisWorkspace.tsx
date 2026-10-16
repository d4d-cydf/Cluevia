import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import BrandLogo, { BrandMark } from '../components/BrandLogo';
import { CaseSidebarPanel, CaseSidebarToggle } from '../components/CaseSidebar';
import ProcessingIndicator from '../components/ProcessingIndicator';
import { apiRequest, ApiError, isActiveJob } from '../services/api-client';
import type { GenerationJob, JevDecisionRecord } from '../services/api-client';
import type { AnalysisCase } from '../types/analysis-case';
import type { WorkspaceView } from '../types/case';
import { GraphWorkspaceContent } from './GraphWorkspace';
import './analysis-workspace.css';

const pendingJobKey = 'cluevia.active-job';
const stages = [
  { id: 'designing', label: '온톨로지 설계', detail: '자료에 맞는 객체·속성·관계 정의' },
  { id: 'preparing', label: '자료 준비', detail: '전체 자료를 분석 구간으로 준비' },
  { id: 'extracting', label: '객체·관계 분석', detail: '원문에서 객체와 연결 확인' },
  { id: 'validating', label: '근거 검증', detail: '출처·식별 키·관계 구조 검증' },
  { id: 'saving', label: '그래프 저장', detail: '검증한 결과를 저장하고 화면에 표시' },
] as const;

type Activity = Pick<GenerationJob, 'updatedAt' | 'message' | 'stage' | 'status'>;
function activityOf({ updatedAt, message, stage, status }: GenerationJob): Activity { return { updatedAt, message, stage, status }; }
function remember(job: GenerationJob) {
  try {
    if (isActiveJob(job)) localStorage.setItem(pendingJobKey, job.id);
    else if (localStorage.getItem(pendingJobKey) === job.id) localStorage.removeItem(pendingJobKey);
  } catch { /* The job URL also restores the server state. */ }
}
function jobHeading(job: GenerationJob) {
  if (job.status === 'failed') return '분석을 완료하지 못했습니다';
  if (job.status === 'cancelled') return '분석이 중단되었습니다';
  if (job.status === 'completed') return job.schemaOnly ? '온톨로지 저장 완료' : '그래프 생성 완료';
  if (job.status === 'queued') return '분석 시작을 기다리고 있습니다';
  return stages.find(stage => stage.id === job.stage)?.label || '자료를 분석하고 있습니다';
}

const decisionNames: Record<string, string> = { stance: '서술 태도', complexity: '독립 처리 가능성', candidateLinkType: '관계 유형 후보' };
const decisionChoices: Record<string, string> = {
  direct_assertion: '직접 서술', attributed_claim: '출처가 명시된 주장', denial_or_correction: '부정·정정', mixed_or_uncertain: '혼합·불확실',
  self_contained: '독립적으로 해석 가능', context_required: '추가 문맥 필요', multiple_claims: '복수 주장', uncertain: '불확실',
  none: '단일 관계 유형을 고르기 어려움', multiple_or_uncertain: '복수 후보·불확실',
};

function JevDecisionHistory({ jobId, open, setOpen }: { jobId: string; open: boolean; setOpen: (open: boolean) => void }) {
  const [records, setRecords] = useState<JevDecisionRecord[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true); setError('');
    void apiRequest<{ decisions: JevDecisionRecord[] }>(`/api/jobs/${encodeURIComponent(jobId)}/decisions`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setRecords(result.decisions);
    }).catch(error => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Jev 판정 내역을 불러오지 못했습니다.');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [jobId, open, refresh]);
  return <details className="aw-decisions" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Jev 판정 내역</summary>
    {open && <div className="aw-decision-content" aria-label="Jev decision history" aria-busy={loading}>
      <div className="aw-decision-controls"><span>{loading ? '판정 내역을 불러오는 중…' : records ? `${records.length.toLocaleString('ko-KR')}개 기록 조회` : '판정 기록'}</span><button type="button" disabled={loading} onClick={() => setRefresh(value => value + 1)}>내역 새로고침</button></div>
      {error && <p className="aw-decision-error" role="alert">{error}</p>}
      {records?.length === 0 && <p className="aw-metrics-note">저장된 반복 판정 내역이 없습니다.</p>}
      {!!records?.length && <>
        <ol>{records.slice(0, 20).map((record, index) => <li key={`${record.createdAt}-${index}`}>
          <header><strong>{record.sourceName}</strong><span>{record.result.route === 'batch' ? '묶음 분석 가능' : '개별 분석'}{record.cached ? ' · 재사용' : ''}</span></header>
          <p>{record.result.reason}</p>
          <dl>{record.result.decisions.map((decision, decisionIndex) => <div key={`${decision.id}-${decisionIndex}`}>
            <dt>{decision.displayName || decisionNames[decision.id] || '추가 분류'}</dt>
            <dd><span>{decision.selectionLabel || decisionChoices[decision.selection] || '후보 선택'}</span><small>{Number.isFinite(decision.confidence) ? `확신도 ${Math.round(Math.max(0, Math.min(1, decision.confidence)) * 100)}%` : '확신도 미제공'}{decision.accepted ? '' : ' · 추가 확인'}</small></dd>
          </div>)}</dl>
        </li>)}</ol>
        <p className="aw-metrics-note">{records.length > 20 ? '조회한 기록 중 앞 20개를 표시합니다. ' : ''}기록은 최대 100개를 조회합니다. 확신도는 사실의 정확도를 뜻하지 않으며, 원문을 확인하는 데 참고합니다.</p>
      </>}
    </div>}
  </details>;
}

type Disclosures = { metrics: boolean; history: boolean; decisions: boolean; brief: boolean };

function AnalysisFooter({ job, open, onToggle, updating, caseData }: { job: GenerationJob | null; open: boolean; onToggle: (open: boolean) => void; updating: boolean; caseData?: AnalysisCase }) {
  return <section className="aw-session-footer" aria-label="분석 세션 설명">
    <details className="aw-session-details" open={open} onToggle={event => onToggle(event.currentTarget.open)}>
      <summary><span className="aw-footer-label">SESSION BRIEF</span><span className="aw-footer-question">{job?.question || '분석 상태 확인 중'}</span><span className="aw-footer-expand" aria-hidden="true">⌃</span></summary>
      <div className="aw-session-description"><p>{job?.question}</p>{job?.analysisBrief && <dl><div><dt>분석 목적</dt><dd>{job.analysisBrief.objective}</dd></div><div><dt>분석 범위</dt><dd>{job.analysisBrief.scope}</dd></div><div><dt>원하는 결과</dt><dd>{job.analysisBrief.output}</dd></div></dl>}
        {job?.ontologyId && <Link to={`/ontology?definition=${encodeURIComponent(job.ontologyId)}`}>{job.ontologyName || '이번 분석의 온톨로지'} · v{job.ontologyVersion || 1} ↗</Link>}
        <small>진행 기록은 서버에서 확인한 작업 상태입니다. 저장된 결과는 이 세션에서 이어서 확인할 수 있습니다.</small>
      </div>
    </details>
    <span className="aw-footer-sync" role="status">{updating ? <><i className="aw-spinner" aria-hidden="true" />결과 반영 중</> : caseData ? <><i className="aw-saved-dot" aria-hidden="true" />객체 {caseData.graph.nodes.length.toLocaleString('ko-KR')} · 관계 {caseData.graph.edges.length.toLocaleString('ko-KR')}</> : job?.schemaOnly && job.status === 'completed' ? '온톨로지 저장 완료' : job && !isActiveJob(job) ? '저장된 그래프 없음' : '첫 근거를 기다리는 중'}</span>
  </section>;
}

function ActivityFeed({ activities, working }: { activities: Activity[]; working: boolean }) {
  const visible = activities.slice(-6);
  return <div className="aw-feed" aria-label="실시간 분석 활동">
    <div className="aw-feed-heading"><span>ACTIVITY</span><small>서버 진행 기록</small></div>
    <ol role="log" aria-label="분석 활동 기록" aria-live="polite" aria-relevant="additions text">{visible.map((activity, index) => <li key={`${activity.updatedAt}-${activity.stage}-${activity.status}-${activity.message}-${activities.length - visible.length + index}`} className={index === visible.length - 1 ? 'is-latest' : ''}>
      <span className="aw-feed-marker" aria-hidden="true">{index === visible.length - 1 && working ? <i className="aw-spinner" /> : activity.status === 'failed' || activity.status === 'cancelled' ? '·' : '✓'}</span>
      <div><header><strong>{stages.find(stage => stage.id === activity.stage)?.label || '분석 상태'}</strong><time dateTime={activity.updatedAt}>{new Date(activity.updatedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}</time></header><p>{activity.message}</p></div>
    </li>)}</ol>
  </div>;
}

function AnalysisActivity({ job, activities, error, actionError, actionPending, onAction, onRefresh, disclosures, onDisclosure }: {
  job: GenerationJob | null;
  activities: Activity[];
  error: string;
  actionError: string;
  actionPending: boolean;
  onAction: (action: 'cancel' | 'resume') => void;
  onRefresh: () => void;
  disclosures: Disclosures;
  onDisclosure: (key: keyof Disclosures, open: boolean) => void;
}) {
  const active = isActiveJob(job);
  const graphCount = job?.graphIds?.length || (job?.graphId ? 1 : 0);
  const completed = job?.completedChunks || 0;
  const total = job?.totalChunks || 0;
  const steps = job?.schemaOnly ? stages.filter(stage => stage.id === 'designing' || stage.id === 'saving') : stages;
  const stageIndex = stages.findIndex(stage => stage.id === job?.stage);
  const working = !error && (active || !job);
  const statusLabel = error ? 'CONNECTION ISSUE' : job?.status === 'completed' ? 'COMPLETE' : job?.status === 'failed' ? 'NEEDS ATTENTION' : job?.status === 'cancelled' ? 'PAUSED' : job?.status === 'queued' ? 'QUEUED' : job ? 'WORKING' : 'CONNECTING';
  return <section className="aw-activity" aria-label="AI analysis activity" aria-busy={working}>
    <div className="aw-agent-heading"><div className="ws-assistant-label"><BrandMark size={18} /><span>CLUEVIA AGENT</span></div><span className={`aw-status aw-status-${error ? 'failed' : job?.status || 'loading'}`}>{working ? <i className="aw-spinner" aria-hidden="true" /> : <i aria-hidden="true">{!error && job?.status === 'completed' ? '✓' : '!'}</i>}{statusLabel}</span></div>
    <h1>{error ? '분석 상태를 확인할 수 없습니다' : job ? jobHeading(job) : '분석 상태를 불러오고 있습니다'}</h1>
    {working && <ProcessingIndicator compact key={`${job?.id || 'connecting'}-${job?.status}`} phase={!job ? 'connecting' : job.status === 'queued' ? 'queued' : job.stage} since={job?.status === 'queued' ? job.createdAt : job?.startedAt} />}
    {job && <>
      {error && <p className="aw-current-message">마지막 확인 상태 · {job.message}</p>}
      <ol className="aw-stages" aria-label="Analysis stages">{steps.map(stage => {
        const current = job.status !== 'completed' && job.status !== 'queued' && stage.id === job.stage;
        const done = job.status === 'completed' || (stage.id === 'designing' ? !!job.ontologyId : stage.id === 'preparing' ? total > 0 : stages.findIndex(item => item.id === stage.id) < stageIndex && stageIndex >= 2);
        return <li key={stage.id} aria-current={current ? 'step' : undefined} className={current ? `is-current${working ? '' : ' is-paused'}` : done ? 'is-done' : ''}><span className="aw-stage-marker" aria-hidden="true">{current && working ? <i className="aw-spinner" /> : done && !current ? '✓' : String(stages.indexOf(stage) + 1).padStart(2, '0')}</span><div><strong>{stage.label}</strong><small>{current && error ? '서버 상태 확인 필요' : current && job.status === 'failed' ? '오류 확인 필요' : current && job.status === 'cancelled' ? '이 단계에서 중단됨' : stage.detail}</small></div></li>;
      })}</ol>
      {!job.schemaOnly && <div className="aw-progress"><div><strong>{total > 0 ? `${completed.toLocaleString('ko-KR')} / ${total.toLocaleString('ko-KR')} 구간 처리` : '전체 분석 구간 확인 중'}</strong><span>{graphCount.toLocaleString('ko-KR')}개 결과</span></div>{total > 0 ? <progress max={total} value={Math.min(completed, total)} aria-label="Analyzed source chunks" /> : working ? <progress aria-label="Preparing source chunks" /> : null}{job.currentSource && <p title={job.currentSource}><span aria-hidden="true">↳</span> {job.currentSource}</p>}{!!job.emptyChunks && <small>객체·관계가 확인되지 않은 구간 {job.emptyChunks}개</small>}</div>}
      <ActivityFeed activities={activities} working={working} />
      {job.jevRouting?.message && <div className="aw-routing" aria-label="Jev processing route"><strong>Jev 처리</strong><p>{job.jevRouting.message}</p></div>}
      {job.error && <div className="aw-error" role="alert"><strong>{graphCount > 0 ? '일부 구간 분석 중단' : '분석 오류'}</strong><p>{job.error}</p>{graphCount > 0 && <small>{total > 0 ? `${completed.toLocaleString('ko-KR')} / ${total.toLocaleString('ko-KR')} 구간 처리. ` : `${completed.toLocaleString('ko-KR')}개 구간 처리. `}이미 저장된 {graphCount.toLocaleString('ko-KR')}개 기록은 통합 그래프에서 계속 확인할 수 있습니다. {total > completed ? `남은 ${(total - completed).toLocaleString('ko-KR')}개 구간은 추가 분석이 필요합니다.` : '오류가 발생한 구간은 추가 확인이 필요합니다.'}</small>}</div>}
      <div className="aw-actions">{active && <button type="button" disabled={actionPending} onClick={() => onAction('cancel')}>{actionPending ? '요청 중…' : '생성 취소'}</button>}{job.resumable && !active && <button className="aw-primary-action" type="button" disabled={actionPending} onClick={() => onAction('resume')}>{actionPending ? '요청 중…' : '남은 구간 이어서 분석'}</button>}</div>
      {job.metrics && <details className="aw-metrics" open={disclosures.metrics} onToggle={event => onDisclosure('metrics', event.currentTarget.open)}><summary aria-label="처리 내역">Processing details</summary><dl aria-label="Analysis processing statistics">{[
        ['표 데이터 처리', job.metrics.structuredRecords, '행'], ['자동 변환', job.metrics.deterministicParts, '구간'], ['Jev 호출', job.metrics.jevRequests, '회'],
        ...(job.metrics.jevDecisions === undefined ? [] : [['Jev 분류·후보 판정', job.metrics.jevDecisions, '건']]),
        ...(job.metrics.jevAssistedParts === undefined ? [] : [['Jev 보조 분석', job.metrics.jevAssistedParts, '구간']]),
        ...(job.metrics.jevFallbackParts === undefined ? [] : [['Jev 개별 검토 판정', job.metrics.jevFallbackParts, '구간']]),
        ['AI 설계·분석', job.metrics.codexCalls, '회'],
        ...(job.metrics.codexBatches === undefined ? [] : [['AI 묶음 분석', job.metrics.codexBatches, '회']]),
        ['범위 밖 원문 보존', job.metrics.scopeSkippedParts ?? 0, '구간'],
        ['모델 처리 시간', Math.round((job.metrics.codexRunMs ?? 0) / 1000), '초'], ['모델 대기 시간', Math.round((job.metrics.codexQueueMs ?? 0) / 1000), '초'],
        ['자료 준비 시간', Math.round((job.metrics.preparationMs ?? 0) / 1000), '초'], ['Jev 판정 시간 합계', Math.round((job.metrics.jevRoutingMs ?? 0) / 1000), '초'],
        ['온톨로지 설계 시간', Math.round((job.metrics.designMs ?? 0) / 1000), '초'],
        ...(job.metrics.ontologyProfileMs === undefined ? [] : [['설계 · 자료 프로필', Math.round(job.metrics.ontologyProfileMs / 100) / 10, '초']]),
        ...(job.metrics.ontologyModelMs === undefined ? [] : [['설계 · 모델 응답', Math.round(job.metrics.ontologyModelMs / 100) / 10, '초']]),
        ...(job.metrics.ontologyValidationMs === undefined ? [] : [['설계 · 스키마 검증', Math.round(job.metrics.ontologyValidationMs / 100) / 10, '초']]),
        ...(job.metrics.ontologyRulesMs === undefined ? [] : [['설계 · Jev 규칙', Math.round(job.metrics.ontologyRulesMs / 100) / 10, '초']]),
        ...(job.metrics.ontologyCacheHits === undefined ? [] : [['설계 캐시 재사용', job.metrics.ontologyCacheHits, '회']]),
        ['설계 시간 초과 재시도', job.metrics.designTimeoutRetries ?? 0, '회'],
        ['검증 재시도', job.metrics.validationRetries ?? 0, '회'], ['시간 초과 재분할', job.metrics.timeoutSplits ?? 0, '회'],
        ...(job.firstGraphMs === undefined ? [] : [['첫 결과까지', Math.round(job.firstGraphMs / 1000), '초']]),
        ['기존 분석 재사용', job.metrics.cacheHits, '구간'], ['추가 검토 대상', job.metrics.reviewParts, '구간'],
      ].map(([label, count, unit]) => <div key={label}><dt>{label}</dt><dd>{Number(count).toLocaleString('ko-KR')}<span>{unit}</span></dd></div>)}</dl>{job.metrics.jevDecisions !== undefined && <p className="aw-metrics-note">병렬 호출의 처리 시간은 합계이므로 전체 경과 시간과 다릅니다. 한 번의 Jev 호출에 여러 판정을 요청할 수 있습니다. 불확실 판정도 건수에 포함되며, 원문 해석과 그래프 검증은 계속 진행합니다.</p>}</details>}
      {job.metrics && ((job.metrics.jevAssistedParts || 0) > 0 || (job.metrics.jevDecisions || 0) > 0 || job.metrics.cacheHits > 0) && <JevDecisionHistory jobId={job.id} open={disclosures.decisions} setOpen={open => onDisclosure('decisions', open)} />}
      {activities.length > 6 && <details className="aw-history" open={disclosures.history} onToggle={event => onDisclosure('history', event.currentTarget.open)}><summary>Earlier activity · {activities.length - 6}</summary><ol>{activities.slice(0, -6).reverse().map((activity, index) => <li key={`${activity.updatedAt}-${index}`}><time dateTime={activity.updatedAt}>{new Date(activity.updatedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</time><p>{activity.message}</p></li>)}</ol></details>}
    </>}
    {error && <div className="aw-error" role="alert"><p>{error}</p><button type="button" onClick={onRefresh} aria-label="상태 다시 확인">Retry</button><Link to="/">홈에서 연결 확인 ↗</Link></div>}
    {actionError && <div className="aw-error" role="alert"><p>{actionError}</p></div>}
    {active && <p className="aw-persistence-note">이 화면을 다시 열면 서버에서 진행 상태를 이어서 불러옵니다.</p>}
  </section>;
}

export default function AnalysisWorkspace() {
  const { jobId = '' } = useParams();
  const location = useLocation();
  const initial = (location.state as { job?: GenerationJob } | null)?.job;
  return <AnalysisSession key={jobId} jobId={jobId} initialJob={initial?.id === jobId ? initial : undefined} />;
}

function AnalysisSession({ jobId, initialJob }: { jobId: string; initialJob?: GenerationJob }) {
  const [job, setJob] = useState<GenerationJob | null>(initialJob || null);
  const [error, setError] = useState('');
  const [activities, setActivities] = useState<Activity[]>(initialJob ? [activityOf(initialJob)] : []);
  const [refresh, setRefresh] = useState(0);
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState('');
  const pollController = useRef<AbortController | null>(null);
  const actionController = useRef<AbortController | null>(null);
  const lastJobSnapshot = useRef('');
  const [disclosures, setDisclosures] = useState<Disclosures>({ metrics: false, history: false, decisions: false, brief: false });
  const [caseData, setCaseData] = useState<AnalysisCase>();
  const [graphError, setGraphError] = useState('');
  const [graphUpdating, setGraphUpdating] = useState(false);
  const [graphRefresh, setGraphRefresh] = useState(0);
  const graphRequest = useRef<{ controller: AbortController; desired: string; loaded: string; running: boolean } | null>(null);
  const [view, setView] = useState<WorkspaceView>('overview');
  const graphIds = job?.graphIds?.length ? job.graphIds : job?.graphId ? [job.graphId] : [];
  const graphId = graphIds[0];
  const completed = job?.completedChunks ?? 0;
  const graphRevision = JSON.stringify([graphIds, completed, job?.totalChunks, job?.status, graphRefresh]);

  function receive(next: GenerationJob) {
    // A status poll with no new data should not redraw the graph or its activity panel.
    const snapshot = JSON.stringify(next);
    if (snapshot === lastJobSnapshot.current) return;
    lastJobSnapshot.current = snapshot;
    setJob(next); remember(next);
    setActivities(previous => {
      const last = previous.at(-1);
      return last?.message === next.message && last?.stage === next.stage && last?.status === next.status ? previous : [...previous.slice(-39), activityOf(next)];
    });
  }
  useEffect(() => {
    const controller = new AbortController();
    pollController.current = controller;
    let timer: number | undefined;
    async function poll() {
      if (controller.signal.aborted) return;
      try {
        const result = await apiRequest<{ job: GenerationJob }>(`/api/jobs/${encodeURIComponent(jobId)}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        receive(result.job); setError('');
        if (isActiveJob(result.job)) timer = window.setTimeout(() => void poll(), document.visibilityState === 'hidden' ? 5000 : 1000);
      } catch (error) {
        if (controller.signal.aborted) return;
        setError(error instanceof Error ? error.message : '작업 상태를 확인하지 못했습니다.');
        if (!(error instanceof ApiError && [401, 404].includes(error.status))) timer = window.setTimeout(() => void poll(), 5000);
      }
    }
    void poll();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [jobId, refresh]);

  useEffect(() => () => actionController.current?.abort(), []);

  useEffect(() => {
    const controller = new AbortController();
    graphRequest.current = { controller, desired: '', loaded: '', running: false };
    return () => controller.abort();
  }, [jobId]);

  useEffect(() => {
    // The empty case shell hosts the independent Why graph before factual
    // extraction has produced its first graph or completed chunk.
    if (!job || job.schemaOnly) return;
    const request = graphRequest.current;
    if (!request || request.controller.signal.aborted) return;
    request.desired = graphRevision;
    if (request.running) return;
    // Let an in-flight projection finish. Coalesce newer revisions into one follow-up,
    // instead of repeatedly aborting a slow response whenever another chunk is saved.
    async function load() {
      if (!request) return;
      request.running = true;
      setGraphUpdating(true);
      try {
        while (!request.controller.signal.aborted && request.desired !== request.loaded) {
          const revision = request.desired;
          try {
            const value = await apiRequest<AnalysisCase>(`/api/jobs/${encodeURIComponent(jobId)}/case`, { signal: request.controller.signal });
            if (request.controller.signal.aborted) return;
            setCaseData(value); setGraphError('');
            request.loaded = revision;
          } catch (error) {
            if (request.controller.signal.aborted) return;
            setGraphError(error instanceof Error ? error.message : '통합 그래프를 불러오지 못했습니다.');
            if (revision === request.desired) break;
          }
        }
      } finally {
        request.running = false;
        if (!request.controller.signal.aborted) setGraphUpdating(false);
      }
    }
    void load();
  }, [jobId, graphId, completed, graphRevision, job?.schemaOnly]);

  async function act(action: 'cancel' | 'resume') {
    if (!job || actionController.current) return;
    const controller = new AbortController(); actionController.current = controller;
    // A poll started before cancellation must never overwrite its response.
    pollController.current?.abort();
    setActionPending(true); setActionError('');
    try {
      const result = await apiRequest<{ job: GenerationJob }>(`/api/jobs/${encodeURIComponent(job.id)}/${action}`, { method: 'POST', signal: controller.signal });
      if (!controller.signal.aborted) { receive(result.job); setError(''); }
    } catch (error) { if (!controller.signal.aborted) setActionError(error instanceof Error ? error.message : '작업 요청을 처리하지 못했습니다.'); }
    finally {
      if (!controller.signal.aborted) { actionController.current = null; setActionPending(false); setRefresh(value => value + 1); }
    }
  }

  const activityPanel = <AnalysisActivity disclosures={disclosures} onDisclosure={(key, open) => setDisclosures(previous => previous[key] === open ? previous : { ...previous, [key]: open })} job={job} activities={activities} error={error} actionError={actionError} actionPending={actionPending} onAction={action => void act(action)} onRefresh={() => { if (!actionController.current) setRefresh(value => value + 1); }} />;
  const footer = <AnalysisFooter job={job} caseData={caseData} updating={graphUpdating} open={disclosures.brief} onToggle={open => setDisclosures(previous => previous.brief === open ? previous : { ...previous, brief: open })} />;
  if (caseData && job) return <GraphWorkspaceContent key={job.id} graph={caseData.graph} caseData={caseData} view={view} footer={footer} activityPanel={<>{activityPanel}{graphError && <div className="aw-error" role="alert"><p>통합 그래프 갱신 실패: {graphError} 이전 결과를 표시합니다.</p><button type="button" onClick={() => setGraphRefresh(value => value + 1)}>다시 불러오기</button></div>}</>} analysisJob={job} onViewChange={setView} />;
  const active = isActiveJob(job);
  const waiting = !error && !graphError && (active || !job);
  const schemaReady = job?.schemaOnly && job.status === 'completed';
  const waitingTitle = error ? '서버 연결을 확인해주세요' : !job ? '분석 상태를 불러오고 있습니다' : job.status === 'queued' ? '분석 시작을 기다리고 있습니다' : graphId ? '저장된 그래프를 불러오고 있습니다' : schemaReady ? '온톨로지 구조가 준비되었습니다' : job.status === 'failed' ? '분석 내용을 확인해주세요' : job.status === 'cancelled' ? '분석이 중단되었습니다' : job.status === 'completed' ? '분석을 마쳤습니다' : job.stage === 'designing' ? '온톨로지를 설계하고 있습니다' : '근거를 그래프로 연결하고 있습니다';
  return <div className="workspace gw-workspace aw-workspace">
    <header className="ws-header"><div className="ws-header-left"><CaseSidebarToggle /><Link to="/" className="ws-brand" aria-label="Cluevia home"><BrandLogo /></Link><span className="ws-header-rule" /><div className="ws-case-title"><span>ANALYSIS</span><strong title={job?.question}>{job?.question || '새로운 분석'}</strong></div></div><div className="ws-header-actions"><Link to={job?.ontologyId ? `/ontology?definition=${encodeURIComponent(job.ontologyId)}` : '/ontology'}>ONTOLOGY</Link><Link to="/new">NEW CASE</Link></div></header>
    <div className="ws-body gw-body">
      <CaseSidebarPanel caseId={job?.id ?? jobId ?? 'pending-analysis'} title={job?.question || '새로운 분석'}><section className="ws-conversation gw-conversation aw-pending-sidebar">{activityPanel}<div className="aw-sidebar-context">{footer}</div></section></CaseSidebarPanel>
      <main className="gw-main aw-pending-main" aria-label="Graph workspace">
        <div className="gw-toolbar aw-waiting-toolbar"><span>BOARD</span><div><i className={waiting ? 'aw-live-dot is-active' : 'aw-live-dot'} aria-hidden="true" />{error ? 'CONNECTION ISSUE' : schemaReady ? 'ONTOLOGY READY' : job?.status === 'queued' ? 'QUEUED' : active ? 'LIVE ANALYSIS' : job ? 'ANALYSIS STATUS' : 'CONNECTING'}</div></div>
        <div className="aw-canvas"><span className="aw-canvas-label">EVIDENCE GRAPH <span>검증된 근거부터 연결됩니다</span></span>
          <div className="aw-canvas-center">
            <div className={`aw-canvas-visual${waiting ? ' is-active' : ''}`} aria-hidden="true">
              <svg className="aw-canvas-network" viewBox="0 0 320 160" fill="none">
                <path d="M42 44 160 80 278 35M52 130 160 80 270 125" />
                <path className="aw-network-flow" d="M42 44 160 80 278 35M52 130 160 80 270 125" />
                <circle cx="42" cy="44" r="7" /><circle cx="278" cy="35" r="6" /><circle cx="52" cy="130" r="5" /><circle cx="270" cy="125" r="8" />
              </svg>
              <div className="aw-canvas-mark"><BrandMark size={36} />{waiting && <span />}</div>
            </div>
            <h2>{graphError ? '그래프를 열 수 없습니다' : waitingTitle}</h2>
            {graphError ? <><p role="alert">{graphError}</p><button type="button" onClick={() => setGraphRefresh(value => value + 1)}>그래프 다시 불러오기</button></>
              : error ? <p>진행 상태를 가져오지 못했습니다. 분석 활동의 연결 안내를 확인해주세요.</p>
              : schemaReady ? <><p>객체 유형과 관계를 저장했습니다.<br />자료를 분석하면 실제 객체와 연결이 이 화면에 표시됩니다.</p><Link className="aw-primary-action" to={`/ontology?definition=${encodeURIComponent(job?.ontologyId || '')}`}>온톨로지 열기 ↗</Link></>
              : <p>{job?.status === 'failed' || job?.status === 'cancelled' ? '분석 활동에서 처리 상황과 오류를 확인하고 분석을 이어갈 수 있습니다.' : job?.status === 'completed' && !graphId ? '이번 분석에서 그래프로 표시할 객체와 관계가 확인되지 않았습니다.' : job?.status === 'queued' ? '실행 순서가 되면 진행 상태가 자동으로 갱신됩니다.' : !job ? '서버에서 저장된 작업을 확인하고 있습니다.' : '첫 결과가 준비되면 이 화면에 자동으로 나타납니다.'}</p>}
            {waiting && <div className="aw-preview-note"><span aria-hidden="true">◌</span> 그래프 준비 화면 · 아직 표시할 근거가 없습니다</div>}
          </div>
        </div>
      </main>
    </div>
  </div>;
}
