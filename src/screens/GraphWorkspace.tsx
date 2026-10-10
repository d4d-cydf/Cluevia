import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, NavLink, useNavigate, useParams } from 'react-router-dom';
import BrandLogo, { BrandMark } from '../components/BrandLogo';
import { Icon } from '../components/Icon';
import GraphRenderer from '../components/graph/GraphRenderer';
import { downloadGraph, getGraph, importGraphFile, recentGraphs } from '../services/graph-repository';
import type { GraphDocument, GraphSelection } from '../types/graph';
import type { WorkspaceView } from '../types/case';
import './workspace.css';
import './graph-workspace.css';

const views: WorkspaceView[] = ['board', 'lanes', 'timeline'];
const origins = { 'published-source': 'PUBLIC SOURCES', imported: 'IMPORTED GRAPH', aip: 'AIP GENERATED', demo: 'DEMO' };

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
  if (error || graph === null) return <main className="empty-state"><p className="eyebrow">GRAPH NOT FOUND</p><h1>그래프를 열 수 없습니다.</h1><p role={error ? 'alert' : undefined}>{error || '이 브라우저에 저장되지 않은 그래프입니다. JSON 파일을 다시 불러와 주세요.'}</p><Link to="/">자료 입력으로 돌아가기 →</Link><Link to="/case/gfw-galapagos/board">GFW 공개 사례 열기</Link></main>;
  if (!graph) return <main className="empty-state" role="status"><BrandMark size={32} /><p>그래프 데이터를 불러오고 있습니다…</p></main>;
  return <CompletedGraph key={graph.id} graph={graph} view={view as WorkspaceView} />;
}

function CompletedGraph({ graph, view }: { graph: GraphDocument; view: WorkspaceView }) {
  const navigate = useNavigate();
  const [selection, setSelection] = useState<GraphSelection>({ kind: 'node', id: graph.nodes[0].id });
  const [query, setQuery] = useState('');
  const [showPath, setShowPath] = useState(true);
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
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
  const saved = recentGraphs();

  useEffect(() => { if (notice) { const timer = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timer); } }, [notice]);

  function openSource(id: string) {
    setActiveSource(id);
    if (sourcesRef.current) { sourcesRef.current.open = true; sourcesRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  }
  function citations(ids: string[]) {
    return <span className="gw-citations">{ids.map(id => <button type="button" key={id} className={activeSource === id ? 'is-active' : ''} onClick={() => openSource(id)} aria-label={`출처 ${id} 보기`}>{id}</button>)}</span>;
  }
  function select(value: GraphSelection) { setSelection(value); setActiveSource(null); }
  async function importFile(file: File) {
    setImporting(true);
    try { const imported = await importGraphFile(file); navigate(`/case/${imported.id}/board`); }
    catch (error) { setNotice(error instanceof Error ? error.message : '그래프 가져오기에 실패했습니다.'); }
    finally { setImporting(false); }
  }

  return <div className="workspace gw-workspace">
    <header className="ws-header">
      <div className="ws-header-left"><Link to="/" className="ws-brand" aria-label="Cluevia home"><BrandLogo /></Link><span className="ws-header-rule" /><div className="ws-case-title"><span>CASE FILE</span><strong title={graph.title}>{graph.title}</strong></div></div>
      <div className="ws-header-actions"><span className="gw-origin">{origins[graph.origin]}</span><Link to="/"><Icon name="plus" size={14} />NEW CASE</Link><details className="ws-menu"><summary>MY CASES</summary><div><Link to="/case/gfw-galapagos/board">GFW · Galápagos 2017</Link>{saved.map(item => <Link key={item.id} to={`/case/${item.id}/board`}>{item.title}</Link>)}<Link to="/case/0143/board">Original design demo</Link></div></details><button type="button" disabled={importing} onClick={() => importInput.current?.click()}>IMPORT</button><button type="button" onClick={() => { downloadGraph(graph); setNotice('완성된 그래프 JSON을 내보냈습니다.'); }}>EXPORT</button><input className="sr-only" ref={importInput} type="file" accept="application/json,.json" aria-label="Import graph JSON" onChange={event => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ''; }} /></div>
    </header>
    <div className="ws-body gw-body">
      <aside className="ws-conversation gw-conversation" aria-label="Case evidence">
        <div className="gw-case-question">{graph.question}</div>
        <div className="ws-assistant-label"><BrandMark size={16} /><span>CASE BRIEF</span></div>
        <p className="gw-summary">{graph.summary}</p>
        <div className="gw-stat-strip"><span><strong>{graph.nodes.length}</strong> objects</span><span><strong>{graph.edges.length}</strong> links</span><span><strong>{graph.sources.length}</strong> sources</span></div>
        {!!graph.findings.length && <ol className="gw-findings">{graph.findings.map((finding, index) => <li key={index}><span>{String(index + 1).padStart(2, '0')}</span><div><p>{finding.text} {citations(finding.sourceIds)}</p><div className="gw-finding-objects">{finding.nodeIds.slice(0, 3).map(id => <button key={id} type="button" onClick={() => select({ kind: 'node', id })}>{graph.nodes.find(node => node.id === id)?.label}</button>)}{finding.edgeIds?.slice(0, 2).map(id => <button key={id} type="button" onClick={() => select({ kind: 'edge', id })}>{graph.edges.find(edge => edge.id === id)?.label} ↗</button>)}</div></div></li>)}</ol>}
        {!!graph.limitations.length && <div className="gw-limitations"><h2>READ WITH CONTEXT</h2>{graph.limitations.map(limit => <p key={limit}>{limit}</p>)}</div>}
        <details className="gw-sources" ref={sourcesRef} open><summary>SOURCES · {graph.sources.length}</summary>{graph.sources.map(source => <article key={source.id} className={activeSource === source.id || selectedSources.includes(source.id) ? 'is-active' : ''}><span>{source.id} · {source.publisher || '제공된 자료'}</span><h3>{source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title} ↗</a> : source.title}</h3>{source.publishedAt && <time dateTime={source.publishedAt}>{source.publishedAt.slice(0, 10)}</time>}{source.excerpt && <p>{source.excerpt}</p>}</article>)}</details>
        <div className="gw-data-note">{graph.origin === 'aip' ? 'AIP가 구조화한 결과입니다. 원문과 대조한 검토가 필요합니다.' : graph.origin === 'published-source' ? '공개 문헌을 구조화한 역사적 사례입니다. 실시간 선박 위치가 아닙니다.' : '가져온 그래프의 구조와 참조를 검증했습니다. 내용의 사실성은 원문에서 확인하세요.'}</div>
      </aside>
      <main className="gw-main">
        <div className="gw-toolbar"><nav aria-label="Graph views">{views.map(item => <NavLink key={item} aria-label={item.charAt(0).toUpperCase() + item.slice(1)} to={`/case/${graph.id}/${item}`}>{item.toUpperCase()}</NavLink>)}</nav><label className="gw-search"><span className="sr-only">Search graph</span><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></svg><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find an object…" /></label><button type="button" className="gw-path-toggle" role="switch" aria-checked={showPath} onClick={() => setShowPath(value => !value)}><i style={{ borderColor: showPath ? '#b8321a' : '#b9aa8a' }} />Key connections</button></div>
        <GraphRenderer graph={graph} view={view} selection={selection} onSelect={select} showPath={showPath} query={query} />
        <section className="gw-inspector" aria-label="Selected graph item">
          {selected ? <><div className="gw-inspector-summary"><div className="gw-item-kind"><i style={{ background: group?.color || (edge ? '#b8321a' : '#1baf7a') }} />{node ? node.type : edge ? 'RELATIONSHIP' : 'EVENT'}{edge && <span className={edge.status === 'inferred' ? 'gw-inferred' : ''}>{edge.status === 'inferred' ? 'INFERRED · 추론' : 'SOURCE-REPORTED · 출처 보고'}</span>}</div><h1>{selected.label}</h1><p>{selected.description}</p>{event && <p className="gw-event-date">{event.date.slice(0, 10)}{event.endDate ? ` → ${event.endDate.slice(0, 10)}` : ''}</p>}{edge && <div className="gw-endpoints"><button type="button" onClick={() => select({ kind: 'node', id: edge.source })}>{graph.nodes.find(node => node.id === edge.source)?.label}</button><span>→</span><button type="button" onClick={() => select({ kind: 'node', id: edge.target })}>{graph.nodes.find(node => node.id === edge.target)?.label}</button></div>}{event && <div className="gw-endpoints">{event.nodeIds.map(id => <button key={id} type="button" onClick={() => select({ kind: 'node', id })}>{graph.nodes.find(node => node.id === id)?.label}</button>)}</div>}<div className="gw-item-evidence">EVIDENCE {citations(selected.sourceIds)}</div></div><div className="gw-inspector-details">{node && Object.keys(node.properties).length > 0 && <><h2>PROPERTIES</h2><dl>{Object.entries(node.properties).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl></>}{node && <><h2>CONNECTIONS · {relatedEdges.length}</h2><div className="gw-related-edges">{relatedEdges.map(edge => <button key={edge.id} type="button" onClick={() => select({ kind: 'edge', id: edge.id })}>{edge.label}<span>{graph.nodes.find(other => other.id === (edge.source === node.id ? edge.target : edge.source))?.label}</span></button>)}</div></>}</div></> : <p>노드·관계·사건을 선택하면 속성과 근거를 볼 수 있습니다.</p>}
        </section>
      </main>
    </div>
    <div className={`ws-toast${notice ? ' is-visible' : ''}`} role="status" aria-live="polite">{notice}</div>
  </div>;
}
