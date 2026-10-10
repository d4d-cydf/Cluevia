import type { ClaimReview } from '../types/claims';
import ClaimReviewPanel from '../components/ClaimReviewPanel';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, Navigate, NavLink, useNavigate, useParams } from 'react-router-dom';
import BrandLogo, { BrandMark } from '../components/BrandLogo';
import { CaseSidebarToggle } from '../components/CaseSidebar';
import { Icon } from '../components/Icon';
import GraphRenderer from '../components/graph/GraphRenderer';
import CaseChat from '../components/CaseChat';
import AnalysisRecords, { downloadCase } from '../components/AnalysisRecords';
import type { AnalysisCase } from '../types/analysis-case';
import { downloadGraph, getGraph, importGraphFile } from '../services/graph-repository';
import { apiRequest, ApiError, ApiUnavailableError } from '../services/api-client';
import type { GenerationJob, GraphCollection } from '../services/api-client';
import type { GraphDocument, GraphSelection } from '../types/graph';
import type { WorkspaceView } from '../types/case';
import './workspace.css';
import './graph-workspace.css';

const views: WorkspaceView[] = ['board', 'lanes', 'timeline'];
const origins = { 'published-source': 'PUBLIC SOURCES', imported: 'IMPORTED GRAPH', aip: 'AIP GENERATED', codex: 'CODEX GENERATED', jev: 'JEV ANALYZED', structured: 'STRUCTURED DATA', demo: 'DEMO' };

export default function GraphWorkspace() {
  const { id = '', view = 'board' } = useParams();
  const [graph, setGraph] = useState<GraphDocument | null>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true; setGraph(undefined); setError('');
    getGraph(id).then(value => { if (active) setGraph(value); }).catch(error => { if (active) setError(error instanceof Error ? error.message : '그래프를 열지 못했습니다.'); });
    return () => { active = false; };
  }, [id]);
  if (!views.includes(view as WorkspaceView)) return <Navigate to={`/case/${id}/board`} replace />;
  if (error || graph === null) return <main className="empty-state"><p className="eyebrow">GRAPH NOT FOUND</p><h1>그래프를 열 수 없습니다.</h1><p role={error ? 'alert' : undefined}>{error || '이 워크스페이스에서 그래프를 찾을 수 없습니다. 서버와 접속 키를 확인하거나 JSON 파일을 불러와 주세요.'}</p><Link to="/">자료 입력으로 돌아가기 →</Link><Link to="/case/gfw-galapagos/board">GFW 공개 사례 열기</Link></main>;
  if (!graph) return <main className="empty-state" role="status"><BrandMark size={32} /><p>그래프 데이터를 불러오고 있습니다…</p></main>;
  return <GraphWorkspaceContent key={graph.id} graph={graph} view={view as WorkspaceView} />;
}

export function GraphWorkspaceContent({ graph, view, activityPanel, analysisJob, onGraphChange, onViewChange, caseData }: {
  graph: GraphDocument;
  view: WorkspaceView;
  activityPanel?: ReactNode;
  analysisJob?: GenerationJob;
  onGraphChange?: (id: string) => void;
  onViewChange?: (view: WorkspaceView) => void;
  caseData?: AnalysisCase;
}) {
  const navigate = useNavigate();
  const [panelOpen, setPanelOpen] = useState(() => { try { return localStorage.getItem(`cluevia.case-panel.${graph.id}`) !== 'closed'; } catch { return true; } });
  function togglePanel() { setPanelOpen(value => { try { localStorage.setItem(`cluevia.case-panel.${graph.id}`, value ? 'closed' : 'open'); } catch { /* Optional preference. */ } return !value; }); }
  const [selection, setSelection] = useState<GraphSelection>(graph.nodes[0] ? { kind: 'node', id: graph.nodes[0].id } : null);
  const [selectedRecord, setSelectedRecord] = useState<number | null>(null);
  const [recordRevision, setRecordRevision] = useState(0);
  function openRecord(number: number) { setSelectedRecord(number); setRecordRevision(value => value + 1); }
  const [query, setQuery] = useState('');
  const [showPath, setShowPath] = useState(true);
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [reviewOverrides, setReviewOverrides] = useState<Record<string, ClaimReview>>({});
  const [importing, setImporting] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  const sourcesRef = useRef<HTMLDetailsElement>(null);
  const node = selection?.kind === 'node' ? graph.nodes.find(node => node.id === selection.id) : undefined;
  const edge = selection?.kind === 'edge' ? graph.edges.find(edge => edge.id === selection.id) : undefined;
  const event = selection?.kind === 'event' ? graph.events.find(event => event.id === selection.id) : undefined;
  const selected = node || edge || event;
  const selectedSources = selected?.sourceIds ?? [];
  const relatedEdges = node ? graph.edges.filter(edge => edge.source === node.id || edge.target === node.id) : [];
  const group = node ? graph.groups.find(group => group.id === node.group) : undefined;
  const [offlineImport, setOfflineImport] = useState<File | null>(null);
  const [fetchedCollection, setCollection] = useState<GraphCollection | null>(null);
  const [collectionError, setCollectionError] = useState('');
  const [collectionRefresh, setCollectionRefresh] = useState(0);

  useEffect(() => {
    if (analysisJob || !['codex', 'jev', 'structured'].includes(graph.origin)) return;
    const controller = new AbortController();
    let timer: number;
    async function loadCollection() {
      try {
        const result = await apiRequest<GraphCollection>(`/api/graphs/${encodeURIComponent(graph.id)}/collection`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setCollection(result); setCollectionError('');
        if (result.jobId) { navigate(`/analysis/${encodeURIComponent(result.jobId)}`, { replace: true }); return; }
        if (result.status === 'running' || result.status === 'queued') timer = window.setTimeout(() => void loadCollection(), 2500);
      } catch (error) {
        if (controller.signal.aborted) return;
        setCollectionError(error instanceof Error ? error.message : '부분 그래프 목록을 불러오지 못했습니다.');
        if (!(error instanceof ApiError && [401, 404].includes(error.status))) timer = window.setTimeout(() => void loadCollection(), 5000);
      }
    }
    void loadCollection();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [graph.id, graph.origin, collectionRefresh, analysisJob?.id]);

  const analysisGraphIds = analysisJob?.graphIds?.length ? analysisJob.graphIds : analysisJob?.graphId ? [analysisJob.graphId] : [];
  const collection: GraphCollection | null = analysisJob ? {
    jobId: analysisJob.id, graphs: analysisGraphIds.map((id, index) => ({ id, title: id === graph.id ? graph.title : `부분 그래프 ${index + 1}` })),
    index: analysisGraphIds.indexOf(graph.id), total: analysisGraphIds.length, status: analysisJob.status,
    completedChunks: analysisJob.completedChunks, totalChunks: analysisJob.totalChunks, emptyChunks: analysisJob.emptyChunks, resumable: analysisJob.resumable,
  } : fetchedCollection;
  const openPart = (id: string) => onGraphChange ? onGraphChange(id) : navigate(`/case/${id}/${view}`);
  const recordRefs = caseData && selected ? [...new Set((caseData.provenance[selected.id] ?? []).map(ref => ref.record))] : [];
  const conflicts = caseData?.conflicts.filter(conflict => conflict.nodeId === node?.id) ?? [];
  const searchResults = caseData && query.trim() ? graph.nodes.filter(node => `${node.label} ${node.type} ${Object.values(node.properties).join(' ')}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) : [];

  useEffect(() => { if (notice) { const timer = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timer); } }, [notice]);

  function openSource(id: string) {
    setActiveSource(id);
    const record = caseData?.provenance[id]?.[0]?.record;
    if (record !== undefined) { openRecord(record); return; }
    if (sourcesRef.current) { sourcesRef.current.open = true; sourcesRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  }
  function citations(ids: string[]) {
    return <span className="gw-citations">{ids.map(id => <button type="button" key={id} className={activeSource === id ? 'is-active' : ''} onClick={() => openSource(id)} aria-label={`출처 ${id} 보기`}>{caseData?.provenance[id]?.[0] ? `기록 ${caseData.provenance[id][0].record}` : id}</button>)}</span>;
  }
  function select(value: GraphSelection) { setSelection(value); setActiveSource(null); }
  async function importFile(file: File, browserOnly = false) {
    setImporting(true); setOfflineImport(null);
    try { const imported = await importGraphFile(file, browserOnly); navigate(`/case/${imported.id}/board`); }
    catch (error) { setNotice(error instanceof Error ? error.message : '그래프 가져오기에 실패했습니다.'); if (error instanceof ApiUnavailableError) setOfflineImport(file); }
    finally { setImporting(false); }
  }

  return <div className={`workspace gw-workspace${activityPanel ? ' aw-workspace' : ''}`}>
    <header className="ws-header">
      <div className="ws-header-left"><CaseSidebarToggle /><Link to="/" className="ws-brand" aria-label="Cluevia home"><BrandLogo /></Link><span className="ws-header-rule" /><div className="ws-case-title"><span>CASE FILE</span><strong title={graph.title}>{graph.title}</strong></div></div>
      <div className="ws-header-actions"><span className="gw-origin">{caseData ? 'INTEGRATED CASE' : origins[graph.origin]}</span><Link to={graph.ontologyId ? `/ontology?definition=${encodeURIComponent(graph.ontologyId)}` : '/ontology'}>ONTOLOGY{graph.ontologyVersion ? ` · v${graph.ontologyVersion}` : ''}</Link><Link to="/"><Icon name="plus" size={14} />NEW CASE</Link><button type="button" disabled={importing} onClick={() => importInput.current?.click()}>IMPORT</button><button type="button" onClick={() => { if (caseData) { downloadCase(caseData); setNotice('통합 그래프·기록 목록·근거 연결을 내보냈습니다. 원문은 기록에서 조회할 수 있습니다.'); } else { downloadGraph(graph); setNotice('완성된 그래프 JSON을 내보냈습니다.'); } }}>EXPORT</button><input className="sr-only" ref={importInput} type="file" accept="application/json,.json" aria-label="Import graph JSON" onChange={event => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ''; }} /></div>
    </header>
    {offlineImport && <div className="gw-offline-import" role="alert"><span>서버 연결이 없어 다른 기기와 공유할 수 없습니다.</span><button type="button" disabled={importing} onClick={() => void importFile(offlineImport, true)}>이 브라우저에만 불러오기</button><button type="button" onClick={() => setOfflineImport(null)}>닫기</button></div>}
    {!caseData && collection && collection.jobId && <nav className="gw-collection" aria-label="Analysis graph parts"><div className="gw-collection-summary"><strong>전체 자료 분석 · 그래프 {collection.index + 1} / {collection.total}</strong><span>{collection.completedChunks || 0} / {collection.totalChunks || 0} 구간 처리{collection.emptyChunks ? ` · 객체·관계 없음 ${collection.emptyChunks}구간` : ''}{collection.status === 'cancelled' ? ' · 중단됨' : collection.status === 'failed' ? ' · 일부 구간 실패' : collection.status === 'completed' ? ' · 완료' : ' · 진행 중'}</span><p>현재 화면은 분석 결과 중 하나입니다. 다른 구간의 결과도 함께 확인하세요.</p></div><div className="gw-collection-controls">{collection.index > 0 ? <button type="button" onClick={() => openPart(collection.graphs[collection.index - 1].id)} aria-label="Previous graph part">← 이전</button> : <span aria-disabled="true">← 이전</span>}<label><span className="sr-only">Graph part</span><select value={graph.id} onChange={event => openPart(event.target.value)}>{collection.graphs.map((item, index) => <option key={item.id} value={item.id}>{index + 1}. {item.title}</option>)}</select></label>{collection.index + 1 < collection.graphs.length ? <button type="button" onClick={() => openPart(collection.graphs[collection.index + 1].id)} aria-label="Next graph part">다음 →</button> : <span aria-disabled="true">다음 →</span>}{!analysisJob && <Link className="gw-collection-job" to={`/analysis/${encodeURIComponent(collection.jobId)}`}>진행 내용 / 이어서 분석 ↗</Link>}</div></nav>}
    {collectionError && <div className="gw-collection-error" role="status">부분 그래프 목록: {collectionError}<button type="button" onClick={() => setCollectionRefresh(value => value + 1)}>다시 확인</button></div>}
    {caseData && <section className="cr-overview" aria-label="통합 분석 그래프"><strong>전체 자료 · 통합 그래프</strong><span>{caseData.records.filter(record => record.status !== 'pending').length} / {analysisJob?.totalChunks ?? caseData.records.length} 기록 처리 · 객체 {graph.nodes.length} · 관계 주장 {graph.edges.length}{caseData.conflicts.length ? ` · 속성 차이 ${caseData.conflicts.length}건` : ''}</span></section>}
    <div className="ws-body gw-body">
      <aside id={`case-panel-${graph.id}`} className="ws-conversation gw-conversation" aria-label="Case evidence" hidden={!panelOpen}>
        {caseData && analysisJob?.status === 'completed' ? <><CaseChat jobId={caseData.jobId} question={graph.question} selection={selection} selectedLabel={selected?.label} onRecord={openRecord} /><details className="case-chat-activity"><summary>분석 처리 내역</summary>{activityPanel}</details></> : activityPanel || <div className="gw-case-question">{graph.question}</div>}
        {caseData && <AnalysisRecords value={caseData} selected={selectedRecord} onSelect={openRecord} revision={recordRevision} />}
        <div className="ws-assistant-label"><BrandMark size={16} /><span>CASE BRIEF</span></div>
        <p className="gw-summary">{graph.summary}</p>
        <div className="gw-stat-strip"><span><strong>{graph.nodes.length}</strong> objects</span><span><strong>{graph.edges.length}</strong> links</span><span><strong>{graph.sources.length}</strong> sources</span></div>
        {!!graph.findings.length && <ol className="gw-findings">{graph.findings.map((finding, index) => <li key={index}><span>{String(index + 1).padStart(2, '0')}</span><div><p>{finding.text} {citations(finding.sourceIds)}</p><div className="gw-finding-objects">{finding.nodeIds.slice(0, 3).map(id => <button key={id} type="button" onClick={() => select({ kind: 'node', id })}>{graph.nodes.find(node => node.id === id)?.label}</button>)}{finding.edgeIds?.slice(0, 2).map(id => <button key={id} type="button" onClick={() => select({ kind: 'edge', id })}>{graph.edges.find(edge => edge.id === id)?.label} ↗</button>)}</div></div></li>)}</ol>}
        {!!graph.limitations.length && <div className="gw-limitations"><h2>READ WITH CONTEXT</h2>{graph.limitations.map(limit => <p key={limit}>{limit}</p>)}</div>}
        <details className="gw-sources" ref={sourcesRef}><summary>SOURCES · {graph.sources.length}</summary>{graph.sources.map(source => <article key={source.id} className={activeSource === source.id || selectedSources.includes(source.id) ? 'is-active' : ''}><span>{source.id} · {source.publisher || '제공된 자료'}</span><h3>{source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title} ↗</a> : source.title}</h3>{source.publishedAt && <time dateTime={source.publishedAt}>{source.publishedAt.slice(0, 10)}</time>}{source.excerpt && <p>{source.excerpt}</p>}</article>)}</details>
        <div className="gw-data-note">{['aip', 'codex', 'jev'].includes(graph.origin) ? '모델이 자료와 저장된 지식에서 구조화한 결과입니다. 각 연결의 근거를 원문과 대조해주세요.' : graph.origin === 'structured' ? '표의 필드와 명시된 관계를 코드로 변환했습니다. 원문 행과 연결 기준을 확인하세요.' : graph.origin === 'published-source' ? '공개 문헌을 구조화한 역사적 사례입니다. 실시간 선박 위치가 아닙니다.' : '가져온 그래프의 구조와 참조를 검증했습니다. 내용의 사실성은 원문에서 확인하세요.'}</div>
      </aside>
      <main className="gw-main">
        <div className="gw-toolbar"><button type="button" className="gw-panel-toggle" onClick={togglePanel} aria-expanded={panelOpen} aria-controls={`case-panel-${graph.id}`} aria-label={panelOpen ? '케이스 패널 접기' : '케이스 패널 열기'} title={panelOpen ? '케이스 패널 접기' : '케이스 패널 열기'}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /><path d={panelOpen ? 'm16 9-3 3 3 3' : 'm13 9 3 3-3 3'} /></svg></button><nav aria-label="Graph views">{views.map(item => onViewChange ? <button key={item} type="button" aria-label={item.charAt(0).toUpperCase() + item.slice(1)} aria-pressed={view === item} className={view === item ? 'active' : ''} onClick={() => onViewChange(item)}>{item.toUpperCase()}</button> : <NavLink key={item} aria-label={item.charAt(0).toUpperCase() + item.slice(1)} to={`/case/${graph.id}/${item}`}>{item.toUpperCase()}</NavLink>)}</nav><label className="gw-search"><span className="sr-only">Search graph</span><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></svg><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find an object…" /></label><button type="button" className="gw-path-toggle" role="switch" aria-checked={showPath} onClick={() => setShowPath(value => !value)}><i style={{ borderColor: showPath ? '#b8321a' : '#b9aa8a' }} />Key connections</button></div>
        {caseData && query.trim() && <div className="cr-search-results" aria-label="전체 그래프 검색 결과"><span>{searchResults.length}개 객체 일치{searchResults.length > 50 ? ' · 앞 50개 표시, 검색어로 좁혀주세요' : ''}</span>{searchResults.slice(0, 50).map(node => <button key={node.id} type="button" onClick={() => select({ kind: 'node', id: node.id })}>{node.label} · {node.type}</button>)}</div>}
        <GraphRenderer graph={graph} view={view} selection={selection} onSelect={select} showPath={showPath} query={query} />
        <section className="gw-inspector" aria-label="Selected graph item">
          {selected ? <><div className="gw-inspector-summary"><div className="gw-item-kind"><i style={{ background: group?.color || (edge ? '#b8321a' : '#1baf7a') }} />{node ? node.type : edge ? 'RELATIONSHIP' : 'EVENT'}{edge && <span className={edge.status === 'inferred' ? 'gw-inferred' : ''}>{edge.status === 'inferred' ? 'INFERRED · 추론' : 'SOURCE-REPORTED · 출처 보고'}</span>}</div><h1>{selected.label}</h1><p>{selected.description}</p>{event && <p className="gw-event-date">{event.date.slice(0, 10)}{event.endDate ? ` → ${event.endDate.slice(0, 10)}` : ''}</p>}{edge && <div className="gw-endpoints"><button type="button" onClick={() => select({ kind: 'node', id: edge.source })}>{graph.nodes.find(node => node.id === edge.source)?.label}</button><span>→</span><button type="button" onClick={() => select({ kind: 'node', id: edge.target })}>{graph.nodes.find(node => node.id === edge.target)?.label}</button></div>}{event && <div className="gw-endpoints">{event.nodeIds.map(id => <button key={id} type="button" onClick={() => select({ kind: 'node', id })}>{graph.nodes.find(node => node.id === id)?.label}</button>)}</div>}<div className="gw-item-evidence">EVIDENCE {citations(selected.sourceIds)}</div></div><div className="gw-inspector-details">{node && Object.keys(node.properties).length > 0 && <><h2>PROPERTIES</h2><dl>{Object.entries(node.properties).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl></>}{node && <><h2>CONNECTIONS · {relatedEdges.length}</h2><div className="gw-related-edges">{relatedEdges.map(edge => <button key={edge.id} type="button" onClick={() => select({ kind: 'edge', id: edge.id })}>{edge.label}<span>{graph.nodes.find(other => other.id === (edge.source === node.id ? edge.target : edge.source))?.label}</span></button>)}</div></>}</div></> : <p>노드·관계·사건을 선택하면 속성과 근거를 볼 수 있습니다.</p>}
          {edge && <ClaimReviewPanel key={edge.id} edge={reviewOverrides[edge.id] ? { ...edge, review: reviewOverrides[edge.id] } : edge} jobId={caseData?.jobId} onSaved={review => setReviewOverrides(previous => ({ ...previous, [edge.id]: review }))} />}
          {caseData && selected && <div className="cr-evidence" aria-label="선택한 항목의 근거 기록"><h2>근거 기록 · {recordRefs.length}</h2>{recordRefs.map(number => <button type="button" key={number} onClick={() => openRecord(number)}>기록 {number} 열기</button>)}{conflicts.map(conflict => <div key={conflict.property} className="cr-conflict"><strong>{conflict.property} · 서로 다른 값</strong>{conflict.values.map(item => <p key={item.value}>{item.value} <small>(기록 {item.records.join(', ')})</small></p>)}</div>)}</div>}
        </section>
      </main>
    </div>
    <div className={`ws-toast${notice ? ' is-visible' : ''}`} role="status" aria-live="polite">{notice}</div>
  </div>;
}
