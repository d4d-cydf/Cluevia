import BayesReviewFields, { estimateBasisLabels } from './BayesReviewFields';
import { sourceGradeCoefficient } from '../lib/confidence-grade';
const sourceGradeLabels = { A: '검증된 원자료', B: '비당사자 정부기관 공식발표', C: '당사자 정부기관 발표·연구자료', D: '원출처 미검증 기사·뉴스', E: '원출처 미검증 SNS·블로그', F: 'AI 생성 데이터·허위정보' };
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { apiRequest, ApiError } from '../services/api-client';
import type { WhyGap, WhyRun, WhyRunList, WhySnapshot } from '../types/why-not';
import { Icon } from './Icon';
import ProcessingIndicator from './ProcessingIndicator';
import './why-not-panel.css';

const gapLabels = { EVIDENCE_MISSING: '자료가 필요해요', EVIDENCE_INSUFFICIENT: '근거를 더 확인해요', EVENT_MISMATCH: '사건이 일치하지 않아요', TRUST_WEAK: '지지 수준을 확인해요', PROVENANCE_UNKNOWN: '원출처를 확인해요', CHAIN_UNKNOWN: '입증 경로를 완성해요' };
const verdictLabels = { SUPPORTED: '지지', REFUTED: '반증', INSUFFICIENT: '불충분', IRRELEVANT: '무관', UNREVIEWED: '미검토' };
const operatorLabels = { AND: '모두 필요', OR: '하나 이상', NOT_SUPPORT: '부정 입증' };
const scopeLabels = { ROOT: '결론에 필요', SUBCLAIM: '하위 주장', ALTERNATIVE: '대안 경로' };
const gapPriority = (gap: WhyGap) => (gap.blockingScope === 'ALTERNATIVE' ? 10 : 0) + (gap.type === 'CHAIN_UNKNOWN' ? 1 : 0);
const numberOrNull = (value: string) => value === '' ? null : Number(value);
const scoreText = (run: WhyRun) => {
  const confidence = run.result?.confidence;
  const bayesian = confidence?.bayesian;
  const range = bayesian ? bayesian.range : confidence?.range;
  const score = bayesian ? bayesian.posterior : confidence?.supportScore;
  return !range ? '평가 보류' : score != null ? `${(score * 100).toFixed(1)} / 100` : `${(range[0] * 100).toFixed(1)}–${(range[1] * 100).toFixed(1)} / 100`;
};
function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type })); const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function WhyTree({ snapshot, gaps, selectedGap, onSelect }: { snapshot: WhySnapshot; gaps: WhyGap[]; selectedGap?: WhyGap; onSelect: (gap: WhyGap) => void }) {
  const seen = new Set<string>();
  const nodes = new Map(snapshot.nodes.map(node => [node.id, node]));
  const bindings = new Map(snapshot.bindings.map(binding => [binding.id, binding]));
  function render(nodeId: string, depth: number): ReactNode {
    const node = nodes.get(nodeId);
    if (!node) return null;
    if (seen.has(nodeId) || depth >= 20) return <li className="wn-tree-reference" key={nodeId}>↳ {node.statement} · 연결된 조건</li>;
    seen.add(nodeId);
    const related = gaps.filter(gap => gap.requirementIds.includes(nodeId) || gap.claimId === nodeId);
    const active = selectedGap && (selectedGap.requirementIds.includes(nodeId) || selectedGap.claimId === nodeId);
    const connected = node.children.flatMap(child => bindings.has(child) ? [bindings.get(child)!] : []);
    const childNodes = node.children.filter(child => nodes.has(child));
    const content = <><span className="wn-tree-node-meta"><span className="wn-operator">{operatorLabels[node.operator]}</span>{related.length > 0 && <span className="wn-node-gap-count">확인 {related.length}</span>}</span><strong>{node.statement}</strong><small>{node.inferenceRule}</small>
      {node.kind === 'requirement' && <span className={connected.length ? 'wn-linked' : 'wn-missing'}>{connected.length ? `자료 ${connected.length}개 연결 · 지지 판정 ${connected.filter(binding => binding.verdict === 'SUPPORTED').length}개` : '연결된 자료 없음'}</span>}</>;
    return <li key={nodeId}><div className={`wn-tree-node${active ? ' is-selected' : ''}`}>
      {related.length ? <button type="button" className="wn-tree-select" aria-label={`${node.statement} 공백 확인`} aria-pressed={!!active} onClick={() => onSelect(related.find(gap => gap.claimId === nodeId) ?? related[0])}>{content}</button> : <div className="wn-tree-content">{content}</div>}
      {node.need && (node.need.fields.length > 0 || node.need.criteria.length > 0) && <details className="wn-tree-need"><summary>필요한 자료 조건</summary>{!!node.need.fields.length && <p>확인할 항목: {node.need.fields.join(', ')}</p>}{!!node.need.criteria.length && <p>{node.need.criteria.join(' / ')}</p>}</details>}
    </div>{childNodes.length > 0 && <ul>{childNodes.map(child => render(child, depth + 1))}</ul>}</li>;
  }
  return <ul>{render(snapshot.rootId, 0)}</ul>;
}

function GapChoice({ gap, selected, onSelect, index }: { gap: WhyGap; selected: boolean; onSelect: () => void; index: number }) {
  return <button type="button" className={`wn-gap-choice${selected ? ' is-selected' : ''}`} aria-pressed={selected} onClick={onSelect}>
    <span className="wn-gap-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
    <span className="wn-gap-choice-text"><span className="wn-gap-choice-title">{gapLabels[gap.type]}</span><span className="wn-gap-choice-description">{gap.explanation}</span></span>
    <span className="wn-gap-scope">{scopeLabels[gap.blockingScope]}{gap.evaluationState === 'PENDING' && <small>확인 대기</small>}</span>
    <span className="wn-gap-arrow" aria-hidden="true">↗</span>
  </button>;
}

type SearchResult = { indexedRecords: number; hits: { number: number; excerpts: string[]; evidenceTexts: string[] }[]; supplements?: { id: string; name: string; text: string }[] };
export default function WhyNotPanel({ jobId, question, onRecord, compact = false, focusGapId = null, active = true, onRunChange }: {
  jobId: string; question: string; onRecord: (number: number) => void;
  compact?: boolean; focusGapId?: string | null; active?: boolean; onRunChange?: (run: WhyRun) => void;
}) {
  const endpoint = `/api/jobs/${encodeURIComponent(jobId)}/why-not`;
  const [runs, setRuns] = useState<WhyRun[]>([]); const [selected, setSelected] = useState<WhyRun | null>(null);
  const [draft, setDraft] = useState<WhySnapshot | null>(null); const [goal, setGoal] = useState(question);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [connectionError, setConnectionError] = useState(''); const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0); const [supplement, setSupplement] = useState({ name: '', text: '', url: '' });
  const [submittedSupplement, setSubmittedSupplement] = useState<{ runId: string; previousEvidenceIds: string[] } | null>(null);
  const [searchQuery, setSearchQuery] = useState(''); const [search, setSearch] = useState<SearchResult | null>(null); const [searching, setSearching] = useState(false);
  const [advanced, setAdvanced] = useState(''); const [independenceReason, setIndependenceReason] = useState('');
  const [selectedGapId, setSelectedGapId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false); const [supplementOpen, setSupplementOpen] = useState(false);
  const searchSection = useRef<HTMLDetailsElement | null>(null); const supplementSection = useRef<HTMLDetailsElement | null>(null);
  const guard = useRef(false); const read = useRef<AbortController | null>(null); const mounted = useRef(false);
  const selectedRef = useRef<WhyRun | null>(null);
  const onRunChangeRef = useRef(onRunChange); onRunChangeRef.current = onRunChange;
  const searchRead = useRef<AbortController | null>(null); const mutation = useRef<AbortController | null>(null);
  const latest = runs[0]; const running = latest?.status === 'running'; const historical = !!selected && selected.id !== latest?.id;
  const dirty = useMemo(() => !!draft && JSON.stringify(draft) !== JSON.stringify(selected?.snapshot), [draft, selected?.snapshot]);
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const locked = busy || running || historical;
  const gaps = useMemo(() => [...(selected?.result?.gaps ?? [])].sort((a, b) => gapPriority(a) - gapPriority(b)), [selected?.result]);
  const selectedGap = gaps.find(gap => gap.id === selectedGapId) ?? gaps[0];
  const blockingGaps = gaps.filter(gap => gap.blockingScope !== 'ALTERNATIVE');
  const alternatives = gaps.filter(gap => gap.blockingScope === 'ALTERNATIVE');
  const selectedActions = selected?.result?.actions.filter(action => selectedGap && action.gapIds.includes(selectedGap.id)) ?? [];
  const activeChains = selected?.result?.witnesses.filter(witness => witness.status === 'ACTIVE').length ?? 0;
  function choose(run: WhyRun) { selectedRef.current = run; setSelected(run); setDraft(run.snapshot ? structuredClone(run.snapshot) : null); setAdvanced(''); setIndependenceReason(''); setSelectedGapId(focusGapId); }
  useEffect(() => { setSelectedGapId(focusGapId); }, [focusGapId]);
  useEffect(() => { if (latest) onRunChangeRef.current?.(latest); }, [latest?.id, latest?.updatedAt, latest?.status]);
  useEffect(() => {
    if (!submittedSupplement) return;
    const run = runs.find(item => item.id === submittedSupplement.runId);
    if (!run || run.status === 'running') return;
    const failedReads = run.urlReads?.filter(read => read.status === 'failed') ?? [];
    const fetchedReads = run.urlReads?.filter(read => read.status === 'fetched') ?? [];
    const readNotice = failedReads.length
      ? `URL 원문 ${failedReads.length}개를 읽지 못했습니다. ${failedReads.map(read => read.reason).filter(Boolean).join(' ')} 읽지 못한 링크는 증거로 사용하지 않았습니다. `
      : fetchedReads.length ? `URL 원문 ${fetchedReads.length}개를 읽었습니다. ` : '';
    if (run.status === 'completed' && run.snapshot) {
      const previousIds = new Set(submittedSupplement.previousEvidenceIds);
      const added = run.snapshot.evidence.filter(source => !previousIds.has(source.id));
      const boundIds = new Set(run.snapshot.bindings.map(binding => binding.evidenceId));
      const linked = added.filter(source => boundIds.has(source.id)).length;
      setNotice(readNotice + (added.length
        ? linked
          ? `추가 자료 ${added.length}개를 저장하고 ${linked}개를 주장에 연결했습니다.${linked < added.length ? ` ${added.length - linked}개는 아직 연결 근거를 찾지 못했습니다.` : ' 새 진단과 점수에 반영했습니다.'}`
          : `추가 자료 ${added.length}개를 저장했습니다. 결론과 연결할 근거를 찾지 못해 그래프 연결은 그대로 유지됩니다. 사건·대상·시점이 드러나는 원문을 추가해주세요.`
        : '새로 추가된 원문이 없어 기존 진단과 점수를 유지했습니다.'));
      if (!failedReads.length) setSupplement({ name: '', text: '', url: '' });
    } else if (run.status === 'failed' || run.status === 'cancelled') {
      setNotice(failedReads.length ? `${readNotice}입력한 링크와 원문은 유지됩니다.` : run.status === 'failed' ? '자료 추가 진단을 완료하지 못했습니다. 입력한 원문은 유지됩니다.' : '자료 추가 진단을 중단했습니다. 입력한 원문은 유지됩니다.');
    } else return;
    setSubmittedSupplement(null);
  }, [runs, submittedSupplement]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; read.current?.abort(); searchRead.current?.abort(); mutation.current?.abort(); }; }, []);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(); read.current?.abort(); read.current = controller; let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const data = await apiRequest<WhyRunList>(endpoint, { signal: controller.signal }); if (controller.signal.aborted) return;
        setRuns(data.runs); setConnectionError('');
        const old = selectedRef.current; const fresh = data.runs[0];
        if (fresh && (!old || old.id === fresh.id && old.status === 'running' && fresh.status !== 'running'
          || compact && !dirtyRef.current && old.id !== fresh.id)) choose(fresh);
        if (data.runs[0]?.status === 'running') timer = setTimeout(load, 2000);
      } catch (e) {
        if (!controller.signal.aborted) { setConnectionError(e instanceof Error ? e.message : '진단을 불러오지 못했습니다.'); if (!(e instanceof ApiError && [401, 404].includes(e.status))) timer = setTimeout(load, 5000); }
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [endpoint, revision, active]);
  function edit(change: (copy: WhySnapshot) => void) { setDraft(value => { if (!value) return value; const copy = structuredClone(value); change(copy); return copy; }); setNotice(''); }
  async function perform(action: '' | '/evaluate' | '/cancel', body?: unknown) {
    if (guard.current) return; guard.current = true; setBusy(true); setError(''); setNotice(''); read.current?.abort();
    const controller = new AbortController(); mutation.current = controller;
    try {
      const result = await apiRequest<{ run: WhyRun } & WhyRunList>(endpoint + action, { method: 'POST', body: JSON.stringify(body ?? {}), signal: controller.signal });
      if (!mounted.current) return;
      const run = result.run ?? result.runs[0]; if (run) { choose(run); setRuns(old => [run, ...old.filter(item => item.id !== run.id)]); }
      setNotice(action === '/evaluate' ? '서버에 진단 버전을 저장했습니다.' : action === '/cancel' ? '검증을 중단했습니다.' : '검증을 시작했습니다. 완료 후 결과를 확인하세요.');
      return run;
    } catch (e) { if (mounted.current && !controller.signal.aborted) setError(e instanceof Error ? e.message : '요청에 실패했습니다.'); }
    finally { guard.current = false; if (mounted.current) { setBusy(false); setRevision(v => v + 1); } }
  }
  async function addSupplement() {
    if (locked || dirty || !supplement.name.trim() || !supplement.text.trim() && !supplement.url.trim()) return;
    const previousEvidenceIds = selected?.snapshot?.evidence.map(source => source.id) ?? [];
    const run = await perform('', { previousId: latest?.id, supplement });
    if (run && mounted.current) setSubmittedSupplement({ runId: run.id, previousEvidenceIds });
  }
  async function selectVersion(id: string) {
    if (guard.current) return; guard.current = true; setBusy(true); setError('');
    const controller = new AbortController(); mutation.current = controller;
    try { const data = await apiRequest<{ run: WhyRun }>(`${endpoint}/runs/${encodeURIComponent(id)}`, { signal: controller.signal }); if (mounted.current) choose(data.run); }
    catch (e) { if (!controller.signal.aborted && mounted.current) setError(e instanceof Error ? e.message : '버전을 불러오지 못했습니다.'); }
    finally { guard.current = false; if (mounted.current) setBusy(false); }
  }
  async function findEvidence(query: string) {
    searchRead.current?.abort(); const controller = new AbortController(); searchRead.current = controller; setSearching(true); setError(''); setSearch(null); setSearchQuery(query); setSearchOpen(true);
    searchSection.current?.scrollIntoView({ block: 'nearest' });
    try { const data = await apiRequest<SearchResult>(`${endpoint}/search?q=${encodeURIComponent(query)}`, { signal: controller.signal }); if (!controller.signal.aborted) setSearch(data); }
    catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '검색에 실패했습니다.'); }
    finally { if (!controller.signal.aborted) setSearching(false); }
  }
  function openSupplement(value?: typeof supplement) {
    if (value) setSupplement(value);
    setSupplementOpen(true);
    requestAnimationFrame(() => { supplementSection.current?.scrollIntoView({ block: 'nearest' }); supplementSection.current?.querySelector('input')?.focus({ preventScroll: true }); });
  }
  function exportRun(format: 'json' | 'md') {
    if (!selected?.snapshot || !selected.result) return;
    const s = selected.snapshot; const r = selected.result;
    const content = format === 'json' ? JSON.stringify(selected, null, 2) : [`# 주장 검증 보고서`, s.goal, `버전: ${selected.id} · ${selected.updatedAt}`, `판정: ${r.accepted ? '설정한 기준 충족' : '추가 확인 필요'} · ${r.chainStatus} · ${r.evaluationStatus}`, `${r.confidence.bayesian ? '보정 우도비 신뢰도' : '기존 품질 지지 점수'}: ${scoreText(selected)} (모형에 조건부인 값)`, r.confidence.bayesian?.reason ?? r.confidence.reason, ...(r.confidence.bayesian ? ['## 우도비 보정 기록', ...r.confidence.bayesian.bindings.map(b => `- ${b.bindingId}: LR ${b.rawLikelihoodRatio ?? '미상'} → 보정 LR ${b.adjustedLikelihoodRatio ?? '미상'} · ${b.status} · ${b.reason}`), ...r.confidence.bayesian.assumptions] : []), `검색 범위: ${s.coverage.note}`, '## 논리 구조', ...s.nodes.map(n => `- ${n.id} [${n.operator}] ${n.statement}\n  연결: ${n.children.join(', ')}\n  규칙: ${n.inferenceRule}`), '## 증거 공백', ...r.gaps.map(g => `- [${gapLabels[g.type]} / ${g.blockingScope}] ${g.explanation}`), '## 근거 및 검토', ...s.bindings.map(b => `### ${b.requirementId} · ${verdictLabels[b.verdict]}\n${b.reason}\n\n> ${b.quote.replaceAll('\n', '\n> ')}\n\n자료: ${b.evidenceId} · 위치 ${b.start}–${b.end}`), '## 출처 평가', ...s.evidence.map(e => `- ${e.name} · ${e.url ?? 'URL 미지정'} · 등급 ${e.sourceGrade ?? '미평가'} · ${e.sourceReason || '근거 미입력'}`), '## 제한', ...r.limits].join('\n\n');
    download(`${selected.id}.${format}`, content, format === 'json' ? 'application/json' : 'text/markdown;charset=utf-8'); setNotice('저장된 진단의 다운로드를 시작했습니다.');
  }
  return <section className={`wn-panel${compact ? ' wn-panel-overlay' : ''}${compact && focusGapId ? ' is-gap-focused' : ''}`} aria-label="주장 검증">
    <header className="wn-heading">
      <div><span className="wn-kicker">{compact ? 'GAP DETAILS' : 'EVIDENCE REVIEW'}</span><h2>{compact && selectedGap ? gapLabels[selectedGap.type] : '결론까지, 남은 연결.'}</h2><p>어떤 근거가 부족한지 확인하고 다음 자료를 연결하세요.</p></div>
      {selected?.result && <div className="wn-export"><button type="button" onClick={() => exportRun('md')}>보고서 받기 <span aria-hidden="true">↓</span></button><details><summary aria-label="내보내기 더 보기">···</summary><button type="button" onClick={() => exportRun('json')}>진단 JSON</button></details></div>}
    </header>
    {connectionError && <div role="alert" className="wn-error">{connectionError}<button type="button" onClick={() => setRevision(v => v + 1)}>다시 불러오기</button></div>}
    {error && <p role="alert" className="wn-error">{error}</p>}{notice && <p role="status" className="wn-notice"><Icon name="check" />{notice}</p>}
    {loading ? <div className="wn-loading" role="status"><span className="wn-loading-mark" aria-hidden="true" /><strong>저장된 진단을 불러옵니다</strong><span>주장과 연결된 근거를 준비하고 있어요.</span></div> : <>
      <details className="wn-goal-editor" open={!selected?.result}><summary><span>검증할 주장</span><strong>{goal.trim() || '확인하려는 주장을 입력하세요'}</strong><small>수정 · 검증</small></summary><form className="wn-start" onSubmit={e => { e.preventDefault(); void perform('', { goal, previousId: latest?.id ?? null }); }}>
        <label><span className="wn-field-heading">검증할 주장</span><textarea aria-label="검증할 주장" value={goal} onChange={e => setGoal(e.target.value)} maxLength={2000} required rows={2} disabled={busy || running} placeholder="예: 이 거래가 같은 사건의 기록으로 확인되는가?" /></label>
        <button type="submit" className="wn-primary" disabled={busy || running || !goal.trim() || dirty}><Icon name={runs.length ? 'replay' : 'send'} />{running ? '검증 진행 중' : '주장 검증 시작'}</button>
      </form></details>
      {running && <div className="wn-running"><div className="wn-section-title"><span className="wn-live-dot" aria-hidden="true" /><strong>근거를 대조하고 있습니다</strong><button type="button" disabled={busy} onClick={() => void perform('/cancel')}>검증 중단</button></div>{connectionError ? <p>연결 복구 후 진행 상태를 확인합니다.</p> : <ProcessingIndicator phase="whyNot" since={latest.createdAt} title={latest.stage} />}</div>}
      {!!runs.length && <div className="wn-version"><label><span>진단 버전</span><select value={selected?.id ?? latest?.id} disabled={busy || dirty} onChange={e => void selectVersion(e.target.value)}>{runs.map((run, i) => <option key={run.id} value={run.id}>{new Date(run.createdAt).toLocaleString('ko-KR')} · {run.status === 'completed' ? '완료' : run.status === 'running' ? '진행 중' : run.status === 'cancelled' ? '중단' : '실패'}{i === 0 ? ' · 최신' : ''}</option>)}</select></label>{historical ? <span>이전 버전 열람 중 · 수정하려면 최신 버전을 선택하세요.</span> : <small>저장된 결과 기준</small>}</div>}
      {dirty && <p className="wn-draft-notice" role="status">저장하지 않은 검토가 있습니다. 아래 결과는 마지막 저장 버전이며, 재평가 후 반영됩니다.</p>}
      {selected?.error && <p className="wn-error" role="alert">{selected.error}</p>}
      {selected?.result && selected.snapshot && <>
        <div className={`wn-metrics${selected.result.accepted ? ' is-accepted' : ''}`}>
          <div className="wn-result-metric"><small>진단 결과</small><strong>{selected.result.accepted ? '설정한 기준 충족' : '추가 확인 필요'}</strong><span>{selected.result.chainStatus === 'COMPLETE_CHAIN_FOUND' ? `적격 입증 경로 ${activeChains}개 발견` : selected.result.chainStatus === 'UNDETERMINED' ? '입증 경로 판정 보류' : '완성된 입증 경로를 찾지 못함'}</span></div>
          <div><small>먼저 확인할 공백</small><strong>{blockingGaps.length}<em>개</em></strong><span>{alternatives.length ? `대안 경로 ${alternatives.length}개 별도 확인` : '현재 진단 범위 기준'}</span></div>
          <div><small>{selected.result.confidence.bayesian ? '우도비 기반 신뢰도' : '기존 품질 지지 점수'}</small><strong>{scoreText(selected)}</strong><span>명시한 모형과 입력에 따른 값</span></div>
        </div>
        <p className="wn-caption">{selected.result.confidence.bayesian?.reason ?? selected.result.confidence.reason} {selected.result.evaluationStatus === 'INCOMPLETE' && '미확정 항목이 있어 일부 평가를 보류했습니다.'}</p>
        <div className="wn-columns">
          <details className="wn-logic-fold" open={!compact}>{compact && <summary>Logic · 주장과 필수 근거</summary>}<section className="wn-tree" aria-label="주장과 필수 근거"><div className="wn-section-title"><div><span className="wn-step-label">01 / LOGIC</span><h3>주장과 필수 근거</h3></div><span className="wn-count">{selected.snapshot.nodes.length}</span></div><p className="wn-section-description">확인이 필요한 조건을 누르면 연결된 공백을 볼 수 있어요.</p><WhyTree snapshot={selected.snapshot} gaps={gaps} selectedGap={selectedGap} onSelect={gap => setSelectedGapId(gap.id)} /></section></details>
          <section className="wn-gaps" aria-label="근거 공백">
            <div className="wn-section-title"><div><span className="wn-step-label">02 / NEXT STEPS</span><h3>결론을 위한 다음 단계</h3></div><span className="wn-count">{gaps.length}</span></div>
            {!gaps.length ? <div className="wn-clear-state"><span className="wn-clear-icon"><Icon name="check" size={22} /></span><h4>차단 공백이 없습니다</h4><p>현재 평가 범위와 설정한 기준에서 필요한 근거가 연결되어 있어요.</p><small>원문과 출처 검토는 아래에서 계속할 수 있습니다.</small></div> : <>
              <div className="wn-gap-list" aria-label="먼저 확인할 공백">{blockingGaps.map((gap, index) => <GapChoice key={gap.id} gap={gap} selected={selectedGap?.id === gap.id} onSelect={() => setSelectedGapId(gap.id)} index={index} />)}</div>
              {!!alternatives.length && <details className="wn-alternatives" open={selectedGap?.blockingScope === 'ALTERNATIVE'}><summary>대안 경로에서 확인할 항목 <span>{alternatives.length}</span></summary><p>다른 입증 경로에서 발생한 공백입니다. 결론 전체의 차단 여부와 구분해서 검토하세요.</p>{alternatives.map((gap, index) => <GapChoice key={gap.id} gap={gap} selected={selectedGap?.id === gap.id} onSelect={() => setSelectedGapId(gap.id)} index={blockingGaps.length + index} />)}</details>}
              {selectedGap && <section className="wn-gap-detail" aria-label="선택한 공백 상세">
                <div className="wn-detail-meta"><span className="wn-tag">{scopeLabels[selectedGap.blockingScope]}</span>{selectedGap.evaluationState === 'PENDING' && <span className="wn-tag wn-pending">평가 대기</span>}</div>
                <h4>{gapLabels[selectedGap.type]}</h4><p>{selectedGap.explanation}</p>
                {!!selectedGap.requirementIds.length && <div className="wn-related"><small>연결된 필수 조건</small>{selected.snapshot.nodes.filter(node => selectedGap.requirementIds.includes(node.id)).map(node => <span key={node.id}>{node.statement}</span>)}</div>}
                {selectedActions.map(action => <div className="wn-next-action" key={action.id}><h5><span aria-hidden="true">↳</span> {action.title}</h5>{action.reason !== selectedGap.explanation && <p>{action.reason}</p>}
                  {(action.fields.length > 0 || action.criteria.length > 0) && <dl className="wn-requirements">{!!action.fields.length && <div><dt>확인할 항목</dt><dd>{action.fields.join(' · ')}</dd></div>}{!!action.criteria.length && <div><dt>충족 기준</dt><dd>{action.criteria.join(' / ')}</dd></div>}</dl>}
                  {action.strategies?.map((strategy, index) => <details className="wn-strategy" key={strategy.title}><summary><span>{String(index + 1).padStart(2, '0')}</span>{strategy.title}</summary><p>{strategy.requiredEvidence.join(' · ')}</p><p>{strategy.availability}</p><small>자료를 확보한 후 재평가하면 공백 해소 여부를 확인할 수 있습니다.</small></details>)}
                  <div className="wn-actions">{action.query && <><button type="button" disabled={searching} onClick={() => void findEvidence(action.query)}>현재 자료 검색 <span aria-hidden="true">↗</span></button><a href={`https://www.google.com/search?q=${encodeURIComponent(action.query)}`} target="_blank" rel="noopener noreferrer">공개 웹 검색 ↗</a></>}{draft && <button type="button" disabled={locked || dirty} onClick={() => openSupplement()}><Icon name="plus" size={14} />자료 보완</button>}</div>
                </div>)}
                {!selectedActions.length && <p className="wn-caption">연결된 원문과 검토 내용을 확인해 이 공백의 해소 조건을 구체화하세요.</p>}
              </section>}
            </>}
          </section>
        </div>
      </>}
      {!runs.length && !connectionError && <div className="wn-empty"><span className="wn-empty-symbol" aria-hidden="true">∴</span><h3>주장과 근거 사이를 살펴보세요.</h3><p>검증할 주장을 입력하면 현재 자료에서 입증 조건을 찾고,<br />부족한 근거와 보완 방법을 정리합니다.</p><ol><li><span>01</span>필수 조건 연결</li><li><span>02</span>근거 공백 확인</li><li><span>03</span>추가 자료로 보완</li></ol></div>}
      <div className="wn-tools"><div className="wn-tools-heading"><span className="wn-step-label">{compact ? 'EVIDENCE TOOLS' : 'REVIEW TOOLS'}</span><p>원문을 확인하고, 검토 내용을 다음 진단에 반영하세요.</p></div>
        <details ref={searchSection} open={searchOpen} onToggle={e => setSearchOpen(e.currentTarget.open)} className="wn-search wn-tool"><summary><span className="wn-tool-number">01</span><span>저장된 원문에서 보완 자료 찾기<small>현재 분석의 원문과 추가 자료 검색</small></span></summary>
          <form onSubmit={e => { e.preventDefault(); void findEvidence(searchQuery); }}><label>원문 검색어<input value={searchQuery} maxLength={1000} onChange={e => setSearchQuery(e.target.value)} placeholder="사건명, 식별자 또는 확인할 조건" required /></label><button disabled={searching || !searchQuery.trim()}>{searching ? '검색 중…' : '원문 검색'}</button></form>
          {search && <><p role="status" className="wn-search-count">검색 대상 {search.indexedRecords}개 기록 · {search.hits.length}개 일치</p>{!search.hits.length && <p>일치하는 발췌를 찾지 못했습니다. 검색어를 바꾸거나 자료를 보완하세요.</p>}{search.hits.map(hit => <article key={hit.number}><div className="wn-section-title"><button type="button" className="wn-text-button" onClick={() => onRecord(hit.number)}>기록 {hit.number} 열기 ↗</button><button type="button" disabled={locked || !draft || !hit.evidenceTexts.length} onClick={() => openSupplement({ name: `기록 ${hit.number} · 추가 검색`, text: hit.evidenceTexts.join('\n\n').slice(0, 30000), url: '' })}>보완 입력에 가져오기</button></div>{hit.excerpts.map((text, i) => <blockquote key={i}>{text}</blockquote>)}</article>)}{search.supplements?.map(item => <article key={item.id}><h4>{item.name} <span className="wn-tag">이미 추가한 자료</span></h4><blockquote>{item.text}</blockquote><small>출처·판정 검토에서 기존 연결을 확인할 수 있습니다.</small></article>)}</>}
        </details>
        {draft && <>
          <details className="wn-review wn-tool"><summary><span className="wn-tool-number">02</span><span>출처·판정·점수 검토{dirty ? ' · 미저장' : ''}<small>원문 인용과 출처를 확인하고 평가 조정</small></span></summary><p>출처 등급을 검토하면 고정 계수가 적용됩니다. A 1.0 · B 0.8 · C 0.6 · D 0.4 · E 0.2 · F 0.0. 등급의 판단 근거를 함께 남겨주세요.</p>
            <fieldset disabled={locked}><legend>출처 검토 <span>{draft.evidence.length}</span></legend>{draft.evidence.map((source, i) => <article key={source.id}>
              <div className="wn-section-title"><h4>{source.name}</h4>{source.record && <button type="button" onClick={() => onRecord(source.record!)}>기록 {source.record} 열기 ↗</button>}</div>
              <details><summary>원문 확인</summary><blockquote>{source.text}</blockquote></details>
              <div className="wn-fields"><label>출처 등급<select aria-label={`${source.name} 출처 등급`} value={source.sourceGrade ?? ''} onChange={e => edit(s => {
                s.evidence[i].sourceGrade = e.target.value as typeof source.sourceGrade || null;
                s.evidence[i].sourceCoefficient = sourceGradeCoefficient(s.evidence[i].sourceGrade);
                delete s.evidence[i].sourceEstimation;
              })}><option value="">미평가</option>{Object.entries(sourceGradeLabels).map(([grade, label]) => <option key={grade} value={grade}>{grade} · {label}</option>)}</select>
              <small aria-label={`${source.name} 출처 등급 산정 방식`}>{estimateBasisLabels[source.sourceEstimation ? 'MODEL_ESTIMATE' : source.sourceGrade ? 'EXPERT_ESTIMATE' : 'UNASSESSED']}</small></label>
              <label>출처 계수<input aria-label={`${source.name} 출처 계수`} type="number" min="0" max="1" step="0.01" value={sourceGradeCoefficient(source.sourceGrade)} readOnly title="출처 등급에 따라 고정됩니다." /></label>
              <label className="wn-wide">출처 평가 근거<textarea aria-label="출처 평가 근거" value={source.sourceReason} maxLength={2000} onChange={e => edit(s => { s.evidence[i].sourceReason = e.target.value; delete s.evidence[i].sourceEstimation; })} /></label></div>
            </article>)}</fieldset>
            <fieldset disabled={locked}><legend>인용 판정 <span>{draft.bindings.length}</span></legend>{draft.bindings.map((binding, i) => <article key={binding.id}><h4>{draft.nodes.find(n => n.id === binding.requirementId)?.statement}</h4><blockquote>{binding.quote}</blockquote><div className="wn-fields"><label>판정<select value={binding.verdict} onChange={e => edit(s => { s.bindings[i].verdict = e.target.value as typeof binding.verdict; s.bindings[i].evaluator = 'user-review'; })}>{Object.entries(verdictLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>이전 품질 계수 · LR 계산 제외<input type="number" min="0" max="1" step="0.01" value={binding.materialCoefficient ?? ''} onChange={e => edit(s => { s.bindings[i].materialCoefficient = numberOrNull(e.target.value); })} /></label><label className="wn-wide">판정 이유<textarea aria-label="판정 이유" value={binding.reason} maxLength={2000} onChange={e => edit(s => { s.bindings[i].reason = e.target.value; s.bindings[i].evaluator = 'user-review'; })} /></label><label className="wn-wide">품질 점수 근거<textarea aria-label="품질 점수 근거" value={binding.materialReason} maxLength={2000} onChange={e => edit(s => { s.bindings[i].materialReason = e.target.value; })} /></label></div></article>)}</fieldset>
            <BayesReviewFields snapshot={draft} locked={locked} edit={edit} />
            <fieldset disabled={locked}><legend>평가 기준</legend><label>결론 지지 임계값 (미입력 시 판정 보류)<input type="number" min="0" max="1" step="0.01" value={draft.policy.threshold ?? ''} onChange={e => edit(s => { s.policy.threshold = numberOrNull(e.target.value); })} /></label><p>아래는 기존 품질 지지 모형의 독립성 설정입니다. 우도비의 조건부 독립성은 위 Likelihood model에서 별도로 지정하며 이 가정을 자동 재사용하지 않습니다.</p><label>관측 독립성 확인 근거<textarea aria-label="관측 독립성 확인 근거" value={independenceReason} maxLength={2000} disabled={!selected?.result?.confidence.atoms.length} onChange={e => setIndependenceReason(e.target.value)} /></label><div className="wn-actions"><button type="button" disabled={!independenceReason.trim() || !selected?.result?.confidence.atoms.length} onClick={() => { edit(s => { s.policy.independence = [{ atomIds: selected!.result!.confidence.atoms.map(a => a.id), reason: independenceReason.trim() }]; }); setIndependenceReason(''); }}>현재 관측의 독립성 가정 적용</button><button type="button" disabled={!draft.policy.independence.length} onClick={() => edit(s => { s.policy.independence = []; })}>독립성 가정 해제</button></div><small>등록된 가정 {draft.policy.independence.length}개 · 새로운 관측은 별도 확인 필요</small></fieldset>
            <details><summary>고급: 논리·사건 규칙·메타데이터 검토</summary><p>새 자료는 아래 자료 보완에서 추가하세요. 원문과 해시는 수정할 수 없습니다.</p><button type="button" disabled={locked} onClick={() => setAdvanced(JSON.stringify(draft, null, 2))}>현재 검토 JSON 열기</button>{advanced && <><label>검토 JSON<textarea aria-label="검토 JSON" className="wn-json" value={advanced} onChange={e => setAdvanced(e.target.value)} disabled={locked} /></label><button type="button" disabled={locked} onClick={() => { try { const value: unknown = JSON.parse(advanced); void perform('/evaluate', { previousId: latest?.id, snapshot: value }); } catch { setError('올바른 검토 JSON을 입력해주세요.'); } }}>JSON 검토 저장 및 재평가</button></>}</details>
            <div className="wn-save-bar"><div><strong>{dirty ? '검토를 반영할 준비가 됐어요' : '검토 내용이 저장되어 있어요'}</strong><small>재평가하면 기존 기록을 보존하고 새 버전을 만듭니다.</small></div><div className="wn-actions"><button type="button" disabled={busy || running || !dirty} onClick={() => selected && choose(selected)}>검토 변경 취소</button><button type="button" className="wn-primary" disabled={locked || !dirty} onClick={() => void perform('/evaluate', { previousId: latest?.id, snapshot: draft })}>{busy ? '저장 중…' : '검토 저장 및 재평가'}</button></div></div>
          </details>
          <details ref={supplementSection} className="wn-tool wn-supplement-section" open={supplementOpen} onToggle={e => setSupplementOpen(e.currentTarget.open)}><summary><span className="wn-tool-number">03</span><span>부족한 자료 보완<small>새 원문을 연결해 다음 진단 만들기</small></span></summary>
            <form className="wn-supplement" onSubmit={e => { e.preventDefault(); void addSupplement(); }}><p>원문이나 URL을 입력해주세요. 링크의 본문을 읽어 저장한 뒤 기존 주장과의 연결을 검토하고, 읽지 못한 링크나 연결 근거가 없는 자료는 이유를 알려드립니다.</p><fieldset disabled={locked || dirty}><legend className="sr-only">추가 자료</legend><div className="wn-fields"><label>자료 제목<input value={supplement.name} maxLength={300} required onChange={e => setSupplement(s => ({ ...s, name: e.target.value }))} /></label><label>원출처 URL (선택)<input type="url" placeholder="https://" value={supplement.url} maxLength={2000} onChange={e => setSupplement(s => ({ ...s, url: e.target.value }))} /></label><label className="wn-wide">추가 원문<textarea aria-label="추가 원문" rows={5} value={supplement.text} maxLength={30000} required={!supplement.url.trim()} onChange={e => setSupplement(s => ({ ...s, text: e.target.value }))} /></label></div><button className="wn-primary" disabled={!supplement.name.trim() || !supplement.text.trim() && !supplement.url.trim()}><Icon name="plus" size={15} />자료 추가 및 새 버전 평가</button></fieldset>{dirty && <small>검토 변경을 먼저 저장하거나 취소해주세요.</small>}</form>
          </details>
        </>}
        {selected?.result && <details className="wn-tool wn-diagnostics"><summary><span className="wn-tool-number">04</span><span>진단 계산 상세<small>입증 경로·점수·출처 추적 기록</small></span></summary>{!!selected.result.limits.length && <ul className="wn-limits">{selected.result.limits.map((limit, i) => <li key={i}>{limit}</li>)}</ul>}<pre className="wn-data">{JSON.stringify({ witnesses: selected.result.witnesses, confidence: selected.result.confidence, provenance: selected.result.provenance, limits: selected.result.limits }, null, 2)}</pre></details>}
      </div>
      {selected?.result && <p className="wn-footnote">모델이 제안한 논리와 인용 판정은 원문과 함께 검토해주세요. 자료를 추가한 뒤에는 새 진단에서 결과를 확인할 수 있습니다.</p>}
    </>}
  </section>;
}
