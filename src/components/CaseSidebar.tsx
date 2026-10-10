import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { apiRequest, isActiveJob } from '../services/api-client';
import type { GenerationJob, GraphSummary } from '../services/api-client';
import { GFW_CASE_ID, recentGraphs, deleteCase } from '../services/graph-repository';
import './case-sidebar.css';

const preferenceKey = 'cluevia.case-sidebar.open';
const mobileQuery = '(max-width: 899px)';
const sidebarId = 'cluevia-case-sidebar';

interface SidebarContextValue { open: boolean; toggle: (event: MouseEvent<HTMLButtonElement>) => void }
const SidebarContext = createContext<SidebarContextValue | null>(null);

function PanelIcon({ open = false }: { open?: boolean }) {
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M9 4v16" /><path d={open ? 'm16 9-3 3 3 3' : 'm13 9 3 3-3 3'} /></svg>;
}

function FolderIcon({ analysis = false }: { analysis?: boolean }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{analysis ? <><circle cx="6" cy="7" r="2.5" /><circle cx="18" cy="8" r="2.5" /><circle cx="12" cy="18" r="2.5" /><path d="m8.5 7.2 7 .6M7.2 9.2l3.6 6.6m6-5.6-3.6 5.6" /></> : <path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9H3Z" />}</svg>;
}

export function CaseSidebarToggle({ className = '' }: { className?: string }) {
  const context = useContext(SidebarContext);
  if (!context) return null;
  const label = context.open ? '사이드바 닫기' : '사이드바 열기';
  return <button type="button" className={`case-sidebar-toggle ${className}`.trim()} data-case-sidebar-toggle aria-label={label} title={label} aria-controls={sidebarId} aria-expanded={context.open} onClick={context.toggle}><PanelIcon open={context.open} /></button>;
}

interface CaseEntry {
  id: string;
  title: string;
  href: string;
  date?: string;
  status?: GenerationJob['status'];
  graphIds: string[];
  nodeCount?: number;
  edgeCount?: number;
  analysis: boolean;
}

const statusLabels: Record<GenerationJob['status'], string> = { queued: '대기 중', running: '분석 중', completed: '분석 완료', failed: '확인 필요', cancelled: '중단됨' };
function shortDate(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('ko-KR', { month: '2-digit', day: '2-digit' }).format(date).replace(/\.$/, '');
}

function buildEntries(graphs: GraphSummary[], jobs: GenerationJob[]): CaseEntry[] {
  const graphMap = new Map(graphs.map(graph => [graph.id, graph]));
  const covered = new Set<string>();
  const entries: CaseEntry[] = jobs.map(job => {
    const ids = [...new Set([...(job.graphIds ?? []), ...(job.graphId ? [job.graphId] : [])])];
    ids.forEach(id => covered.add(id));
    const members = ids.map(id => graphMap.get(id));
    const countsAvailable = members.length > 0 && members.every(graph => graph?.nodeCount !== undefined && graph?.edgeCount !== undefined);
    return {
      id: job.id, title: job.question.trim().replace(/\s+/g, ' ') || job.ontologyName || '자료 분석', href: `/analysis/${encodeURIComponent(job.id)}`,
      date: job.createdAt, status: job.status, graphIds: ids, analysis: true,
      nodeCount: countsAvailable ? members.reduce((count, graph) => count + graph!.nodeCount!, 0) : undefined,
      edgeCount: countsAvailable ? members.reduce((count, graph) => count + graph!.edgeCount!, 0) : undefined,
    };
  });
  for (const graph of graphs) {
    if (covered.has(graph.id) || graph.id === GFW_CASE_ID || graph.id === '0143') continue;
    entries.push({ id: graph.id, title: graph.title, href: `/case/${encodeURIComponent(graph.id)}/board`, date: graph.createdAt, graphIds: [graph.id], nodeCount: graph.nodeCount, edgeCount: graph.edgeCount, analysis: false });
  }
  return entries.sort((left, right) => (right.date ?? '').localeCompare(left.date ?? ''));
}

export function CaseSidebarLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState('');
  const [mobile, setMobile] = useState(() => window.matchMedia(mobileQuery).matches);
  const [desktopOpen, setDesktopOpen] = useState(() => { try { return localStorage.getItem(preferenceKey) === 'true'; } catch { return false; } });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [graphs, setGraphs] = useState<GraphSummary[]>([]);
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const sidebarRef = useRef<HTMLElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const wasOpenRef = useRef(false);
  const pathRef = useRef(location.pathname);
  const open = mobile ? mobileOpen : desktopOpen;

  const setOpen = useCallback((value: boolean) => {
    if (mobile) setMobileOpen(value);
    else {
      setDesktopOpen(value);
      try { localStorage.setItem(preferenceKey, String(value)); } catch { /* Navigation remains usable without storage. */ }
    }
  }, [mobile]);
  const restoreFocus = useCallback(() => {
    requestAnimationFrame(() => {
      const target = openerRef.current?.isConnected ? openerRef.current : document.querySelector<HTMLButtonElement>('[data-case-sidebar-toggle]');
      target?.focus({ preventScroll: true });
    });
  }, []);
  const close = useCallback(() => { setOpen(false); }, [setOpen]);
  const toggle = useCallback((event: MouseEvent<HTMLButtonElement>) => { openerRef.current = event.currentTarget; setOpen(!open); }, [open, setOpen]);

  // Restore focus after React removes `inert` from the page content.
  useLayoutEffect(() => {
    if (wasOpenRef.current && !open) restoreFocus();
    wasOpenRef.current = open;
  }, [open, restoreFocus]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    let header: HTMLElement | null = null;
    const measure = () => shellRef.current?.style.setProperty('--case-shell-header-height', `${header?.getBoundingClientRect().height ?? 0}px`);
    const resize = new ResizeObserver(measure);
    const observeHeader = () => {
      const next = content.querySelector<HTMLElement>('.home-header, .ws-header, .onto-header');
      if (next === header) return;
      resize.disconnect(); header = next;
      if (header) resize.observe(header);
      measure();
    };
    // Analysis screens replace their pending header when the first graph arrives.
    const changes = new MutationObserver(observeHeader);
    changes.observe(content, { childList: true, subtree: true });
    observeHeader();
    return () => { resize.disconnect(); changes.disconnect(); };
  }, []);

  useEffect(() => {
    const media = window.matchMedia(mobileQuery);
    const update = () => { setMobile(media.matches); setMobileOpen(false); };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (pathRef.current !== location.pathname) {
      pathRef.current = location.pathname;
      setQuery('');
      if (mobile) setMobileOpen(false);
    }
  }, [location.pathname, mobile]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    void Promise.allSettled([recentGraphs(100), apiRequest<{ jobs: GenerationJob[] }>('/api/jobs', { signal: controller.signal })]).then(([graphResult, jobResult]) => {
      if (cancelled) return;
      if (graphResult.status === 'fulfilled') setGraphs(graphResult.value);
      if (jobResult.status === 'fulfilled') setJobs(jobResult.value.jobs);
      const messages: string[] = [];
      if (graphResult.status === 'rejected') messages.push('저장된 그래프를 불러오지 못했습니다.');
      if (jobResult.status === 'rejected') messages.push('분석 목록에 연결하지 못했습니다.');
      setError(messages.join(' ')); setLoaded(true); setLoading(false);
    });
    return () => { cancelled = true; controller.abort(); };
  }, [open, location.pathname, refresh]);

  useEffect(() => {
    if (!open) return;
    const update = () => setRefresh(value => value + 1);
    window.addEventListener('focus', update);
    window.addEventListener('storage', update);
    window.addEventListener('cluevia:cases-changed', update);
    const interval = jobs.some(isActiveJob) ? window.setInterval(update, 8000) : undefined;
    return () => { window.removeEventListener('focus', update); window.removeEventListener('storage', update); window.removeEventListener('cluevia:cases-changed', update); if (interval) window.clearInterval(interval); };
  }, [open, jobs]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab' || !mobile) return;
      const targets = sidebarRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), [tabindex="0"]');
      if (!targets?.length) return;
      const first = targets[0]; const last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, mobile, close]);

  useEffect(() => {
    if (!mobile || !open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    sidebarRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    return () => { document.body.style.overflow = previous; };
  }, [mobile, open]);

  const entries = useMemo(() => buildEntries(graphs, jobs), [graphs, jobs]);
  const filtered = entries.filter(entry => `${entry.title} ${entry.status ? statusLabels[entry.status] : ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const activeEntries = filtered.filter(entry => entry.status === 'running' || entry.status === 'queued');
  const recentEntries = filtered.filter(entry => entry.status !== 'running' && entry.status !== 'queued');
  let activeGraphId: string | null = null;
  if (location.pathname.startsWith('/case/')) {
    const segment = location.pathname.split('/')[2] ?? '';
    try { activeGraphId = decodeURIComponent(segment); } catch { activeGraphId = segment; }
  }
  async function removeEntry(entry: CaseEntry) {
    if (deleting || !window.confirm(`“${entry.title.slice(0, 160)}” 케이스를 영구 삭제할까요?\n결과·분석 기록·대화와 전용 자료가 삭제되며 복구할 수 없습니다. 진행 중이면 중단합니다. 다른 케이스에서 함께 사용하는 자료는 유지됩니다.`)) return;
    setDeleting(entry.id); setError('');
    try {
      const deletedId = await deleteCase(entry.id, entry.analysis, entry.graphIds);
      setJobs(previous => previous.filter(job => job.id !== entry.id));
      setGraphs(previous => previous.filter(graph => !entry.graphIds.includes(graph.id)));
      if (location.pathname === entry.href || location.pathname === `/analysis/${encodeURIComponent(deletedId)}` || activeGraphId && entry.graphIds.includes(activeGraphId)) navigate('/', { replace: true });
      setRefresh(value => value + 1);
    } catch (error) { setError(error instanceof Error ? error.message : '케이스를 삭제하지 못했습니다.'); }
    finally { setDeleting(''); }
  }
  const renderEntry = (entry: CaseEntry) => {
    const active = location.pathname === entry.href || !!activeGraphId && entry.graphIds.includes(activeGraphId);
    return <li key={entry.id} className="case-sidebar-entry-row"><Link to={entry.href} className={`case-sidebar-entry${active ? ' is-active' : ''}`} aria-current={active ? 'page' : undefined} title={entry.title}>
      <span className="case-sidebar-entry-icon"><FolderIcon analysis={entry.analysis} /></span>
      <span className="case-sidebar-entry-body"><strong>{entry.title}</strong><span className="case-sidebar-entry-meta">{entry.status ? <span className={`case-sidebar-status is-${entry.status}`}><i />{statusLabels[entry.status]}</span> : <span>저장된 그래프</span>}{entry.date && <time dateTime={entry.date}>{shortDate(entry.date)}</time>}</span>
        {(entry.nodeCount !== undefined || entry.analysis && entry.graphIds.length > 0) && <span className="case-sidebar-entry-counts">{entry.analysis ? `결과 기록 ${entry.graphIds.length}개 · 통합 그래프` : `객체 ${(entry.nodeCount ?? 0).toLocaleString()} · 관계 ${(entry.edgeCount ?? 0).toLocaleString()}`}</span>}
      </span>
    </Link><button type="button" className="case-sidebar-delete" disabled={!!deleting} onClick={() => void removeEntry(entry)} aria-label={`${entry.title} 영구 삭제`} title="케이스 영구 삭제">{deleting === entry.id ? '…' : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg>}</button></li>;
  };

  return <SidebarContext.Provider value={{ open, toggle }}><div ref={shellRef} className={`case-shell${open ? ' case-shell-open' : ''}`}>
    {mobile && open && <button type="button" className="case-sidebar-backdrop" aria-label="사이드바 바깥 영역 닫기" tabIndex={-1} onClick={close} />}
    <aside id={sidebarId} ref={sidebarRef} className="case-sidebar" role={mobile ? 'dialog' : 'complementary'} aria-label="케이스 사이드바" aria-modal={mobile && open ? true : undefined} aria-hidden={!open} inert={!open}>
      <header className="case-sidebar-heading"><div><span>WORKSPACE</span><h2>케이스 보관함<span className="case-sidebar-heading-dot" /></h2></div><button type="button" className="case-sidebar-collapse" aria-label="케이스 목록 닫기" title="사이드바 접기" onClick={close}><PanelIcon open /></button></header>
      <div className="case-sidebar-tools"><Link to="/" className="case-sidebar-new" onClick={() => { setQuery(''); if (mobile) close(); }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg><span>새 케이스</span><span aria-hidden="true">↗</span></Link>
        <label className="case-sidebar-search"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 5 5" /></svg><input type="search" aria-label="케이스 검색" placeholder="케이스 검색" value={query} onChange={event => setQuery(event.target.value)} /></label>
      </div>
      <div className="case-sidebar-scroll">
        {error && <div className="case-sidebar-error" role="status"><p>{error}</p><button type="button" onClick={() => setRefresh(value => value + 1)} disabled={loading}>다시 불러오기 <span aria-hidden="true">↻</span></button></div>}
        {!loaded && loading ? <div className="case-sidebar-loading" role="status"><span />케이스를 불러오는 중</div> : <nav aria-label="내 케이스" aria-busy={loading}>
          {activeEntries.length > 0 && <section className="case-sidebar-section"><h3>진행 중<span>{activeEntries.length}</span></h3><ul>{activeEntries.map(renderEntry)}</ul></section>}
          <section className="case-sidebar-section"><h3>최근 케이스<span>{recentEntries.length}</span></h3><ul>{recentEntries.map(renderEntry)}</ul>
            {filtered.length === 0 && <div className="case-sidebar-empty"><FolderIcon /><p>{query.trim() ? '검색 결과가 없습니다.' : '아직 저장된 케이스가 없습니다.'}</p><span>{query.trim() ? '다른 검색어로 찾아보세요.' : '자료를 추가하고 첫 분석을 시작하세요.'}</span></div>}
          </section>
        </nav>}
        <section className="case-sidebar-examples"><h3>둘러보기<span>EXAMPLES</span></h3><Link to="/case/gfw-galapagos/board" aria-current={activeGraphId === GFW_CASE_ID ? 'page' : undefined}><span className="case-sidebar-example-icon">G</span><span><strong>GFW · Galápagos 2017</strong><small>공개 자료 사례</small></span><span aria-hidden="true">↗</span></Link><Link to="/case/0143/board" aria-current={activeGraphId === '0143' ? 'page' : undefined}><span className="case-sidebar-example-icon">C</span><span><strong>Original design demo</strong><small>디자인 데모</small></span><span aria-hidden="true">↗</span></Link></section>
      </div>
      <footer className="case-sidebar-footer"><Link to="/ontology" aria-current={location.pathname === '/ontology' ? 'page' : undefined}><FolderIcon analysis /><span>온톨로지</span><span aria-hidden="true">↗</span></Link><span>CLUEVIA · CONNECT THE EVIDENCE</span></footer>
    </aside>
    <div ref={contentRef} className="case-shell-content" inert={mobile && open}>{children}</div>
  </div></SidebarContext.Provider>;
}
