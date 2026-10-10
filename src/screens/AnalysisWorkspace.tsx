import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import BrandLogo, { BrandMark } from '../components/BrandLogo';
import { CaseSidebarToggle } from '../components/CaseSidebar';
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
function AnalysisActivity({ job, activities, error, actionPending, onAction, onRefresh, disclosures, onDisclosure }: {
  job: GenerationJob | null;
  activities: Activity[];
  error: string;
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
  return <section className="aw-activity" aria-label="AI analysis activity" aria-busy={active || (!job && !error)}>
    {job && <div className="gw-case-question">{job.question}</div>}
    {job?.analysisBrief && <details className="aw-analysis-brief" open={disclosures.brief} onToggle={event => onDisclosure('brief', event.currentTarget.open)}><summary>확정한 분석 범위</summary><dl><div><dt>분석 목적</dt><dd>{job.analysisBrief.objective}</dd></div><div><dt>분석 범위</dt><dd>{job.analysisBrief.scope}</dd></div><div><dt>원하는 결과</dt><dd>{job.analysisBrief.output}</dd></div></dl></details>}
    <div className="aw-agent-heading"><div className="ws-assistant-label"><BrandMark size={18} /><span>CLUEVIA AGENT</span></div><span className={`aw-status aw-status-${job?.status || 'loading'}`}>{active || (!job && !error) ? <i className="aw-spinner" aria-hidden="true" /> : <i aria-hidden="true">{job?.status === 'completed' ? '✓' : '!'}</i>}{job?.status === 'completed' ? 'COMPLETE' : job?.status === 'failed' ? 'NEEDS ATTENTION' : job?.status === 'cancelled' ? 'PAUSED' : 'WORKING'}</span></div>
    <h1>{job ? jobHeading(job) : error ? '분석 상태를 확인할 수 없습니다' : '분석 상태를 불러오고 있습니다'}</h1>
    {job && <>
      <p className="aw-current-message" role="status">{job.message}</p>
      <ol className="aw-stages" aria-label="Analysis stages">{steps.map(stage => {
        const current = job.status !== 'completed' && job.status !== 'queued' && stage.id === job.stage;
        const done = job.status === 'completed' || (stage.id === 'designing' ? !!job.ontologyId : stage.id === 'preparing' ? total > 0 : stages.findIndex(item => item.id === stage.id) < stageIndex && stageIndex >= 2);
        return <li key={stage.id} aria-current={current ? 'step' : undefined} className={current ? `is-current${active ? '' : ' is-paused'}` : done ? 'is-done' : ''}><span className="aw-stage-marker" aria-hidden="true">{current && active ? <i className="aw-spinner" /> : done && !current ? '✓' : String(stages.indexOf(stage) + 1).padStart(2, '0')}</span><div><strong>{stage.label}</strong><small>{current && job.status === 'failed' ? '오류 확인 필요' : current && job.status === 'cancelled' ? '이 단계에서 중단됨' : stage.detail}</small></div></li>;
      })}</ol>
      {!job.schemaOnly && <div className="aw-progress"><div><strong>{total > 0 ? `${completed.toLocaleString('ko-KR')} / ${total.toLocaleString('ko-KR')} 구간 처리` : '전체 분석 구간 확인 중'}</strong><span>{graphCount.toLocaleString('ko-KR')}개 결과를 통합</span></div>{total > 0 ? <progress max={total} value={Math.min(completed, total)} aria-label="Analyzed source chunks" /> : active ? <progress aria-label="Preparing source chunks" /> : null}<small>{total > 0 ? '각 구간마다 분석 → 검증 → 저장을 진행합니다.' : '자료 준비가 끝나면 처리한 구간 수를 표시합니다.'}</small>{job.currentSource && <p title={job.currentSource}>현재 자료 · {job.currentSource}</p>}{!!job.emptyChunks && <small>객체·관계가 확인되지 않은 구간 {job.emptyChunks}개</small>}</div>}
      {job.jevRouting?.message && <div className="aw-routing" aria-label="Jev processing route"><strong>Jev 처리</strong><p>{job.jevRouting.message}</p></div>}
      {job.ontologyId && <Link className="aw-ontology" to={`/ontology?definition=${encodeURIComponent(job.ontologyId)}`}><span>이번 분석의 온톨로지</span><strong>{job.ontologyName || '설계된 온톨로지'} <small>v{job.ontologyVersion || 1} ↗</small></strong></Link>}
      {job.error && <div className="aw-error" role="alert"><strong>분석 오류</strong><p>{job.error}</p>{graphCount > 0 && <small>이미 저장된 {graphCount}개 기록은 통합 그래프에서 계속 확인할 수 있습니다.</small>}</div>}
      <div className="aw-actions">{active && <button type="button" disabled={actionPending} onClick={() => onAction('cancel')}>{actionPending ? '요청 중…' : '생성 취소'}</button>}{job.resumable && !active && <button className="aw-primary-action" type="button" disabled={actionPending} onClick={() => onAction('resume')}>{actionPending ? '요청 중…' : '남은 구간 이어서 분석'}</button>}</div>
      {job.metrics && <details className="aw-metrics" open={disclosures.metrics} onToggle={event => onDisclosure('metrics', event.currentTarget.open)}><summary>처리 내역</summary><dl aria-label="Analysis processing statistics">{[
        ['표 데이터 처리', job.metrics.structuredRecords, '행'], ['자동 변환', job.metrics.deterministicParts, '구간'], ['Jev 호출', job.metrics.jevRequests, '회'],
        ...(job.metrics.jevDecisions === undefined ? [] : [['Jev 분류·후보 판정', job.metrics.jevDecisions, '건']]),
        ...(job.metrics.jevAssistedParts === undefined ? [] : [['Jev 보조 분석', job.metrics.jevAssistedParts, '구간']]),
        ...(job.metrics.jevFallbackParts === undefined ? [] : [['Jev 개별 검토 판정', job.metrics.jevFallbackParts, '구간']]),
        ['Codex 설계·분석', job.metrics.codexCalls, '회'],
        ...(job.metrics.codexBatches === undefined ? [] : [['Codex 묶음 분석', job.metrics.codexBatches, '회']]),
        ['범위 밖 원문 보존', job.metrics.scopeSkippedParts ?? 0, '구간'],
        ['모델 처리 시간', Math.round((job.metrics.codexRunMs ?? 0) / 1000), '초'], ['모델 대기 시간', Math.round((job.metrics.codexQueueMs ?? 0) / 1000), '초'],
        ['자료 준비 시간', Math.round((job.metrics.preparationMs ?? 0) / 1000), '초'], ['Jev 판정 시간 합계', Math.round((job.metrics.jevRoutingMs ?? 0) / 1000), '초'],
        ['온톨로지 설계 시간', Math.round((job.metrics.designMs ?? 0) / 1000), '초'], ['설계 시간 초과 재시도', job.metrics.designTimeoutRetries ?? 0, '회'],
        ['검증 재시도', job.metrics.validationRetries ?? 0, '회'], ['시간 초과 재분할', job.metrics.timeoutSplits ?? 0, '회'],
        ...(job.firstGraphMs === undefined ? [] : [['첫 결과까지', Math.round(job.firstGraphMs / 1000), '초']]),
        ['기존 분석 재사용', job.metrics.cacheHits, '구간'], ['추가 검토 대상', job.metrics.reviewParts, '구간'],
      ].map(([label, count, unit]) => <div key={label}><dt>{label}</dt><dd>{Number(count).toLocaleString('ko-KR')}<span>{unit}</span></dd></div>)}</dl>{job.metrics.jevDecisions !== undefined && <p className="aw-metrics-note">병렬 호출의 처리 시간은 합계이므로 전체 경과 시간과 다릅니다. 한 번의 Jev 호출에 여러 판정을 요청할 수 있습니다. 불확실 판정도 건수에 포함되며, 원문 해석과 그래프 검증은 계속 진행합니다.</p>}</details>}
      {job.metrics && ((job.metrics.jevAssistedParts || 0) > 0 || (job.metrics.jevDecisions || 0) > 0 || job.metrics.cacheHits > 0) && <JevDecisionHistory jobId={job.id} open={disclosures.decisions} setOpen={open => onDisclosure('decisions', open)} />}
      {activities.length > 1 && <details className="aw-history" open={disclosures.history} onToggle={event => onDisclosure('history', event.currentTarget.open)}><summary>최근 진행 기록</summary><ol>{activities.slice().reverse().map((activity, index) => <li key={`${activity.updatedAt}-${index}`}><time dateTime={activity.updatedAt}>{new Date(activity.updatedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</time><p>{activity.message}</p></li>)}</ol></details>}
    </>}
    {error && <div className="aw-error" role="alert"><p>{error}</p><button type="button" onClick={onRefresh}>상태 다시 확인</button><Link to="/">홈에서 연결 확인 ↗</Link></div>}
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
  const [activities, setActivities] = useState<Activity[]>(initialJob ? [initialJob] : []);
  const [refresh, setRefresh] = useState(0);
  const [actionPending, setActionPending] = useState(false);
  const [disclosures, setDisclosures] = useState<Disclosures>({ metrics: false, history: false, decisions: false, brief: false });
  const [caseData, setCaseData] = useState<AnalysisCase>();
  const [graphError, setGraphError] = useState('');
  const [graphRefresh, setGraphRefresh] = useState(0);
  const [view, setView] = useState<WorkspaceView>('board');
  const graphIds = job?.graphIds?.length ? job.graphIds : job?.graphId ? [job.graphId] : [];
  const graphId = graphIds[0];
  const completed = job?.completedChunks ?? 0;

  function receive(next: GenerationJob) {
    setJob(next); remember(next);
    setActivities(previous => {
      const last = previous.at(-1);
      return last?.message === next.message && last?.stage === next.stage && last?.status === next.status ? previous : [...previous.slice(-11), next];
    });
  }
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    async function poll() {
      try {
        const result = await apiRequest<{ job: GenerationJob }>(`/api/jobs/${encodeURIComponent(jobId)}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        receive(result.job); setError('');
        if (isActiveJob(result.job)) timer = window.setTimeout(() => void poll(), 1500);
      } catch (error) {
        if (controller.signal.aborted) return;
        setError(error instanceof Error ? error.message : '작업 상태를 확인하지 못했습니다.');
        if (!(error instanceof ApiError && [401, 404].includes(error.status))) timer = window.setTimeout(() => void poll(), 5000);
      }
    }
    void poll();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [jobId, refresh]);

  useEffect(() => {
    if (!graphId && !completed) return;
    const controller = new AbortController(); setGraphError('');
    void apiRequest<AnalysisCase>(`/api/jobs/${encodeURIComponent(jobId)}/case`, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setCaseData(value);
    }).catch(error => { if (!controller.signal.aborted) setGraphError(error instanceof Error ? error.message : '통합 그래프를 불러오지 못했습니다.'); });
    return () => controller.abort();
  }, [jobId, graphId, completed, job?.totalChunks, job?.status, graphRefresh]);

  async function act(action: 'cancel' | 'resume') {
    if (!job || actionPending) return;
    setActionPending(true); setError('');
    try {
      const result = await apiRequest<{ job: GenerationJob }>(`/api/jobs/${encodeURIComponent(job.id)}/${action}`, { method: 'POST' });
      receive(result.job); setRefresh(value => value + 1);
    } catch (error) { setError(error instanceof Error ? error.message : '작업 요청을 처리하지 못했습니다.'); }
    finally { setActionPending(false); }
  }

  const activityPanel = <AnalysisActivity disclosures={disclosures} onDisclosure={(key, open) => setDisclosures(previous => previous[key] === open ? previous : { ...previous, [key]: open })} job={job} activities={activities} error={error} actionPending={actionPending} onAction={action => void act(action)} onRefresh={() => setRefresh(value => value + 1)} />;
  if (caseData && job) return <GraphWorkspaceContent key={job.id} graph={caseData.graph} caseData={caseData} view={view} activityPanel={<>{activityPanel}{graphError && <div className="aw-error" role="alert"><p>통합 그래프 갱신 실패: {graphError} 이전 결과를 표시합니다.</p><button type="button" onClick={() => setGraphRefresh(value => value + 1)}>다시 불러오기</button></div>}</>} analysisJob={job} onViewChange={setView} />;
  const active = isActiveJob(job);
  const waitingTitle = graphId ? '저장된 그래프를 불러오고 있습니다' : job?.schemaOnly ? '온톨로지 구조가 준비되었습니다' : job?.status === 'failed' ? '분석 내용을 확인해주세요' : job?.status === 'cancelled' ? '분석이 중단되었습니다' : job?.status === 'completed' ? '분석을 마쳤습니다' : job?.stage === 'designing' ? '온톨로지를 설계하고 있습니다' : '근거를 그래프로 연결하고 있습니다';
  return <div className="workspace gw-workspace aw-workspace">
    <header className="ws-header"><div className="ws-header-left"><CaseSidebarToggle /><Link to="/" className="ws-brand" aria-label="Cluevia home"><BrandLogo /></Link><span className="ws-header-rule" /><div className="ws-case-title"><span>ANALYSIS</span><strong title={job?.question}>{job?.question || '새로운 분석'}</strong></div></div><div className="ws-header-actions"><Link to={job?.ontologyId ? `/ontology?definition=${encodeURIComponent(job.ontologyId)}` : '/ontology'}>ONTOLOGY</Link><Link to="/">NEW CASE</Link></div></header>
    <div className="ws-body gw-body"><aside className="ws-conversation gw-conversation aw-pending-sidebar">{activityPanel}</aside><main className="gw-main aw-pending-main" aria-label="Graph workspace"><div className="gw-toolbar aw-waiting-toolbar"><span>BOARD</span><div>{job?.schemaOnly ? 'ONTOLOGY READY' : active ? 'ANALYSIS IN PROGRESS' : job ? 'ANALYSIS STATUS' : 'CONNECTING'}</div></div><div className="aw-canvas"><span className="aw-canvas-label">EVIDENCE GRAPH</span><div className="aw-canvas-center"><div className={`aw-canvas-mark${active ? ' is-active' : ''}`}><BrandMark size={36} />{active && <span aria-hidden="true" />}</div><h2>{graphError ? '그래프를 열 수 없습니다' : waitingTitle}</h2>{graphError ? <><p role="alert">{graphError}</p><button type="button" onClick={() => setGraphRefresh(value => value + 1)}>그래프 다시 불러오기</button></> : job?.schemaOnly ? <><p>객체 유형과 관계를 저장했습니다.<br />자료를 분석하면 실제 객체와 연결이 이 화면에 표시됩니다.</p><Link className="aw-primary-action" to={`/ontology?definition=${encodeURIComponent(job.ontologyId || '')}`}>온톨로지 열기 ↗</Link></> : <p>{job?.status === 'failed' || job?.status === 'cancelled' ? '왼쪽에서 처리 상황과 오류를 확인하고 분석을 이어갈 수 있습니다.' : '근거가 확인된 그래프가 여기에 표시됩니다'}</p>}</div><div className="aw-canvas-footer"><span>{job?.ontologyId ? 'ONTOLOGY DEFINED' : 'AWAITING ONTOLOGY'}</span><span>{graphIds.length} SAVED RECORDS</span></div></div></main></div>
  </div>;
}
