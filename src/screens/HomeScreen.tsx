import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import BrandLogo from '../components/BrandLogo';
import AnalysisClarification from '../components/AnalysisClarification';
import { clearAnalysisDraft, readAnalysisDraft, saveAnalysisDraft } from '../services/analysis-draft';
import type { ClarificationDraft } from '../services/analysis-draft';
import { CaseSidebarToggle } from '../components/CaseSidebar';
import { importGraphFile } from '../services/graph-repository';
import { apiRequest, ApiUnavailableError, isActiveJob, setWorkspaceToken, uploadDocument } from '../services/api-client';
import type { GenerationJob, SystemStatus, UploadedDocument } from '../services/api-client';
import { GRAPH_LIMITS } from '../lib/graph-document';
import type { EvidenceDocument } from '../types/graph';
import type { AnalysisBrief, ClarificationSource } from '../types/clarification';
import './home.css';

type Attachment = { id: string; name: string; size: number; file: File };

function Paperclip({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 11.5 12.6 18.9a5 5 0 0 1-7.1-7.1l7.8-7.8a3.3 3.3 0 0 1 4.7 4.7l-7.8 7.8a1.7 1.7 0 0 1-2.4-2.4l7.1-7.1" /></svg>;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function GraphBackdrop() {
  return <div className="home-graph-backdrop" aria-hidden="true"><svg width="100%" height="100%" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" fill="none" aria-hidden="true"><path d="M612 58L645 44M612 58L642 101M612 58L580 76M612 58L587 13M905 118L950 148M905 118L882 159M905 118L844 128M905 118L890 83M905 118L943 108M1250 92L1285 136M1250 92L1209 121M1250 92L1214 59M1250 92L1256 50M1250 92L1286 96M1180 300L1215 275M1180 300L1221 323M1180 300L1154 343M1180 300L1144 254M1365 455L1343 500M1365 455L1329 445M1365 455L1388 428M1365 455L1413 477M1270 690L1262 745M1270 690L1231 683M1270 690L1265 632M1270 690L1316 692M1010 812L1034 848M1010 812L958 815M1010 812L1052 776M700 862L731 889M700 862L647 868M700 862L704 815M420 826L410 887M420 826L364 813M420 826L424 762M420 826L462 805M420 826L455 857M160 740L118 772M160 740L170 690M160 740L186 765M250 520L283 551M250 520L212 568M250 520L220 481M250 520L277 484M70 330L120 371M70 330L48 376M70 330L10 304M70 330L79 289M70 330L122 303M210 170L192 227M210 170L156 145M210 170L212 129M210 170L240 152M210 170L243 196M430 110L364 112M430 110L413 73M430 110L465 89M430 110L433 171M580 76L950 148M645 44L1256 50M882 159L1256 50M882 159L1144 254M1214 59L1215 275M1144 254L1413 477M1316 692L1343 500M1052 776L1231 683M731 889L1034 848M731 889L212 568M277 484L186 765M118 772L455 857M277 484L212 129M156 145L413 73M120 371L192 227M120 371L212 568M1144 254L1034 848M413 73L645 44" stroke="#D2C4A3" strokeWidth="0.8"></path><path d="M612 58L905 118M612 58L1250 92M905 118L1250 92M905 118L1180 300M1250 92L1180 300M1180 300L1365 455M1270 690L1365 455M1010 812L1270 690M700 862L1010 812M700 862L250 520M250 520L160 740M160 740L420 826M250 520L210 170M210 170L430 110M70 330L210 170M70 330L250 520M1180 300L1010 812M430 110L612 58" stroke="#C4B48D" strokeWidth="1"></path><path className="home-graph-flow" d="M210 170L430 110M250 520L160 740M1010 812L1270 690M1250 92L1180 300" stroke="#B8321A" strokeOpacity="0.6" strokeWidth="1.3"></path><path d="M580 76h0M587 13h0M844 128h0M890 83h0M1209 121h0M1256 50h0M1286 96h0M1154 343h0M1329 445h0M1262 745h0M1231 683h0M1265 632h0M1034 848h0M1052 776h0M731 889h0M647 868h0M704 815h0M364 813h0M462 805h0M455 857h0M118 772h0M186 765h0M283 551h0M220 481h0M277 484h0M120 371h0M48 376h0M79 289h0M122 303h0M212 129h0M240 152h0M413 73h0M433 171h0" stroke="#BBA982" strokeWidth="4" strokeLinecap="round"></path><path d="M645 44h0M642 101h0M950 148h0M882 159h0M943 108h0M1285 136h0M1214 59h0M1215 275h0M1221 323h0M1144 254h0M1343 500h0M1388 428h0M1413 477h0M1316 692h0M958 815h0M410 887h0M424 762h0M170 690h0M212 568h0M10 304h0M192 227h0M156 145h0M243 196h0M364 112h0M465 89h0" stroke="#AE9C75" strokeWidth="5.5" strokeLinecap="round"></path><path d="M606.5 58a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0M899.5 118a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0M1244.5 92a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0M1174.5 300a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0M1359.5 455a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0M1264.5 690a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0M1004.5 812a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0M694.5 862a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0M414.5 826a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0M154.5 740a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0M244.5 520a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0M64.5 330a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0M204.5 170a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0M424.5 110a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0" fill="#E6DCC6" stroke="#9F8D67" strokeWidth="1.2"></path><path d="M612 58h0M905 118h0M1250 92h0M1180 300h0M1365 455h0M1270 690h0M1010 812h0M700 862h0M420 826h0M160 740h0M250 520h0M70 330h0M210 170h0M430 110h0" stroke="#8A7953" strokeWidth="4" strokeLinecap="round"></path><g fill="#998863" fontFamily="Courier Prime, monospace" fontSize="10" letterSpacing="1.5"><text x="624" y="62">SOURCE</text><text x="917" y="122">CLAIM</text><text x="1262" y="96">MEDIA</text><text x="1192" y="304">EVENT</text><text x="1353" y="459" textAnchor="end">LOCATION</text><text x="1282" y="694">PROJECT</text><text x="1022" y="816">PERSON</text><text x="712" y="866">DOCUMENT</text><text x="432" y="830">TRANSACTION</text><text x="172" y="744">WALLET</text><text x="262" y="524">ORGANIZATION</text><text x="82" y="334">CERTIFICATE</text><text x="222" y="174">DOMAIN</text><text x="442" y="114">IP ADDRESS</text></g><g fill="#AD9C77" fontFamily="Courier Prime, monospace" fontSize="9" letterSpacing="0.5"><text x="320" y="134" textAnchor="middle" transform="rotate(-15 320 140)">resolves_to</text><text x="140" y="244" textAnchor="middle" transform="rotate(-49 140 250)">issued_for</text><text x="205" y="624" textAnchor="middle" transform="rotate(-68 205 630)">controls</text><text x="1140" y="745" textAnchor="middle" transform="rotate(-25 1140 751)">participates_in</text><text x="1215" y="190" textAnchor="middle" transform="rotate(-71 1215 196)">depicts</text><text x="1077" y="99" textAnchor="middle" transform="rotate(-4 1077 105)">cites</text><text x="855" y="831" textAnchor="middle" transform="rotate(-9 855 837)">mentions</text><text x="758" y="82" textAnchor="middle" transform="rotate(12 758 88)">published</text></g></svg></div>;
}

const pendingJobKey = 'cluevia.active-job';
function rememberJob(id?: string) { try { if (id) localStorage.setItem(pendingJobKey, id); else localStorage.removeItem(pendingJobKey); } catch { /* Active jobs are also recoverable from the server. */ } }

export default function HomeScreen() {
  const navigate = useNavigate();
  const [question, setQuestion] = useState(() => (new URLSearchParams(window.location.search).get('question') || '').slice(0, 2000));
  const [files, setFiles] = useState<Attachment[]>([]);
  const [phase, setPhase] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 5 : 0);
  const [menu, setMenu] = useState<'account' | null>(null);
  const [dragging, setDragging] = useState(false);
  const [sourceText, setSourceText] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [job, setJob] = useState<GenerationJob | null>(null);
  const [accessKey, setAccessKey] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [offlineImport, setOfflineImport] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ name: string; index: number; total: number } | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<Record<string, UploadedDocument>>({});
  const [clarification, setClarification] = useState<{ question: string; sources: ClarificationSource[]; progress?: ClarificationDraft } | null>(null);
  const [restoringDraft, setRestoringDraft] = useState(true);
  const draftActive = useRef(false);
  const uploadedFilesRef = useRef<Record<string, UploadedDocument>>({});
  const pastedUpload = useRef<{ text: string; document: UploadedDocument } | null>(null);
  const uploadController = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const headerActions = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);
  const fileSequence = useRef(0);
  const busy = restoringDraft || submitting || isActiveJob(job);
  const ready = question.trim().length > 0 || files.length > 0 || sourceText.trim().length > 0;
  const locked = status?.authRequired && !status.authenticated;
  const provider = status?.provider;
  const codexReady = provider?.kind === 'hybrid' ? !!provider.codex?.available && provider.codex.authenticated !== false : !!provider?.available && provider.authenticated !== false;
  const providerReady = provider?.ontologyPlanning ? codexReady : !!provider?.available && (provider.kind === 'hybrid' || provider.authenticated !== false);
  const providerLabel = provider?.ontologyPlanning
    ? provider.jev?.configured ? 'Codex 설계·분석 · Jev 선택 판정 준비됨' : 'Codex 온톨로지 설계·분석 준비됨'
    : status?.provider?.kind === 'hybrid'
    ? status.provider.jev?.configured ? '하이브리드 분석 · Jev 설정됨' : status.provider.codex?.available && status.provider.codex.authenticated !== false ? '표 데이터 · 문서 분석 준비됨' : '표 데이터 분석 준비됨'
    : '분석 엔진 준비됨';

  async function loadWorkspace(signal?: AbortSignal) {
    const result = await apiRequest<SystemStatus>('/api/system/status', { signal });
    setStatus(result); setConnectionError('');
    if (!result.authenticated) return result;
    if (signal?.aborted) return result;
    let pending: string | null = null;
    try { pending = localStorage.getItem(pendingJobKey); } catch { /* Use server state. */ }
    const requestedJob = new URLSearchParams(window.location.search).get('job');
    if (requestedJob) { navigate(`/analysis/${encodeURIComponent(requestedJob)}`, { replace: true }); return result; }
    if (draftActive.current) return result;
    const active = result.activeJobs?.find(item => item.id === pending) || (!requestedJob ? result.activeJobs?.[0] : undefined);
    if (active) { setJob(active); setQuestion(active.question); rememberJob(active.id); }
    else if (pending) {
      try { const current = await apiRequest<{ job: GenerationJob }>(`/api/jobs/${encodeURIComponent(pending)}`, { signal }); if (!signal?.aborted) { setJob(current.job); setQuestion(current.job.question); } }
      catch (error) { if (error instanceof Error && error.name === 'AbortError') throw error; rememberJob(); }
    }
    return result;
  }

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const requested = new URLSearchParams(window.location.search);
      const draft = requested.has('job') || requested.has('question') ? null : await readAnalysisDraft();
      if (controller.signal.aborted) return;
      if (draft) {
        const { intake, progress } = draft;
        draftActive.current = true;
        setQuestion(intake.question); setSourceText(intake.sourceText); setFiles(intake.files);
        fileSequence.current = Math.max(0, ...intake.files.map(file => Number(file.id.replace('doc-', '')) || 0));
        uploadedFilesRef.current = intake.uploadedFiles; setUploadedFiles(intake.uploadedFiles);
        setClarification({ question: intake.question, sources: intake.sources, progress });
      }
      setRestoringDraft(false);
      await loadWorkspace(controller.signal);
    })().catch(error => { if (!controller.signal.aborted) { setRestoringDraft(false); setConnectionError(error instanceof Error ? error.message : '서버 연결을 확인해주세요.'); } });
    return () => { controller.abort(); uploadController.current?.abort(); };
  }, []);

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (preference.matches) return;
    const timers = [[1, 120], [2, 640], [3, 900], [4, 1440], [5, 1700]].map(([next, delay]) => window.setTimeout(() => setPhase(next), delay));
    const skipAnimation = () => { if (preference.matches) { timers.forEach(window.clearTimeout); setPhase(5); } };
    preference.addEventListener('change', skipAnimation);
    return () => { timers.forEach(window.clearTimeout); preference.removeEventListener('change', skipAnimation); };
  }, []);

  useEffect(() => {
    if (!menu) return;
    const closeOutside = (event: PointerEvent) => { if (!headerActions.current?.contains(event.target as Node)) setMenu(null); };
    const closeEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { headerActions.current?.querySelector<HTMLButtonElement>(`[aria-controls="home-${menu}-panel"]`)?.focus(); setMenu(null); } };
    document.addEventListener('pointerdown', closeOutside); document.addEventListener('keydown', closeEscape);
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeEscape); };
  }, [menu]);

  const resetClarification = () => { void clearAnalysisDraft(); draftActive.current = false; setClarification(null); };
  const addFiles = (incoming: FileList | File[]) => {
    if (busy) return;
    setError('');
    const candidates = Array.from(incoming);
    if (files.length + candidates.length > GRAPH_LIMITS.documents) { setError('자료는 최대 10개까지 첨부할 수 있습니다.'); return; }
    resetClarification();
    setFiles(previous => [...previous, ...candidates.map(file => ({ id: `doc-${++fileSequence.current}`, name: file.name, size: file.size, file }))]);
  };
  const onFiles = (event: ChangeEvent<HTMLInputElement>) => { if (event.target.files) addFiles(event.target.files); event.target.value = ''; };
  const onDrop = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); dragDepth.current = 0; setDragging(false); if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files); };
  const openImportedGraph = async (file: File, browserOnly = false) => {
    setSubmitting(true); setError(''); setOfflineImport(null);
    try { const graph = await importGraphFile(file, browserOnly); navigate(`/case/${graph.id}/board`); }
    catch (error) { setError(error instanceof Error ? error.message : '그래프를 불러오지 못했습니다.'); if (error instanceof ApiUnavailableError) setOfflineImport(file); }
    finally { setSubmitting(false); }
  };
  async function unlock(event: FormEvent) {
    event.preventDefault(); setUnlocking(true); setError('');
    try { setWorkspaceToken(accessKey); const result = await loadWorkspace(); if (!result.authenticated) throw new Error('접속 키를 확인해주세요.'); setAccessKey(''); }
    catch (error) { setError(error instanceof Error ? error.message : '연결하지 못했습니다.'); }
    finally { setUnlocking(false); }
  }
  async function resumeJob(id: string) {
    setSubmitting(true); setError('');
    try {
      const result = await apiRequest<{ job: GenerationJob }>(`/api/jobs/${encodeURIComponent(id)}/resume`, { method: 'POST' });
      rememberJob(result.job.id); navigate(`/analysis/${encodeURIComponent(result.job.id)}`, { state: { job: result.job } });
      setStatus(previous => previous ? { ...previous, resumableJobs: previous.resumableJobs?.filter(item => item.id !== id) } : previous);
    } catch (error) { setError(error instanceof Error ? error.message : '분석을 이어서 시작하지 못했습니다.'); }
    finally { setSubmitting(false); }
  }
  const startInvestigation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ready || busy) return;
    setSubmitting(true); setError(''); setOfflineImport(null); setJob(null);
    try {
      if (files.length === 1 && files[0].size <= GRAPH_LIMITS.jsonBytes && /\.json$/i.test(files[0].name)) {
        let candidate: unknown;
        try { candidate = JSON.parse(await files[0].file.text()); } catch { /* Non-graph JSON remains source material. */ }
        if (candidate && typeof candidate === 'object' && 'schemaVersion' in candidate && 'nodes' in candidate && Array.isArray(candidate.nodes) && 'edges' in candidate && Array.isArray(candidate.edges)) { await openImportedGraph(files[0].file); return; }
      }
      const analysisQuestion = question.trim() || '첨부 자료의 객체와 관계를 근거에 따라 정리해줘.';
      if (!question.trim()) setQuestion(analysisQuestion);
      const pasted = sourceText.trim();
      if (files.length + (pasted ? 1 : 0) > GRAPH_LIMITS.documents) throw new Error('붙여넣은 자료를 포함해 최대 10개까지 분석할 수 있습니다.');
      if (locked) throw new Error('워크스페이스 접속 키로 먼저 연결해주세요.');
      if (status?.provider && !providerReady) throw new Error(provider?.ontologyPlanning ? provider.codex?.message || '온톨로지 설계에 필요한 Codex 연결을 확인해주세요.' : status.provider.message || '분석 엔진을 사용할 수 없습니다. 서버의 연결 상태를 확인해주세요.');
      const previewChars = Math.floor(12000 / Math.max(1, files.length + (pasted ? 1 : 0)));
      const sources = await Promise.all(files.map(async attachment => ({
        id: attachment.id, name: attachment.name.slice(0, 300), size: attachment.size,
        excerpt: (await attachment.file.slice(0, previewChars * 4).text()).slice(0, previewChars),
      })));
      if (pasted) sources.push({ id: 'pasted-source', name: '붙여넣은 자료', size: new Blob([pasted]).size, excerpt: pasted.slice(0, previewChars) });
      await clearAnalysisDraft();
      await saveAnalysisDraft({ question: analysisQuestion, sourceText, files, sources, uploadedFiles: uploadedFilesRef.current });
      draftActive.current = true;
      setClarification({ question: analysisQuestion, sources });
    } catch (error) {
      setError(error instanceof Error ? error.message : '분석 범위를 확인하지 못했습니다.');
    } finally { setSubmitting(false); }
  };

  const confirmInvestigation = async (analysisBrief?: AnalysisBrief) => {
    if (!clarification || busy) return;
    setSubmitting(true); setError('');
    try {
      if (locked) throw new Error('워크스페이스 접속 키로 먼저 연결해주세요.');
      if (status?.provider && !providerReady) throw new Error('분석 엔진의 연결 상태를 확인해주세요.');
      const analysisQuestion = clarification.question;
      const pasted = sourceText.trim();
      const documents: EvidenceDocument[] = [];
      const uploadIds: string[] = [];
      const controller = new AbortController(); uploadController.current = controller;
      const largePaste = pasted.length > GRAPH_LIMITS.documentChars;
      const uploadCount = files.length + (largePaste ? 1 : 0);
      for (const [index, attachment] of files.entries()) {
        controller.signal.throwIfAborted();
        let uploaded = uploadedFilesRef.current[attachment.id];
        if (!uploaded) {
          setUploadProgress({ name: attachment.name, index: index + 1, total: uploadCount });
          uploaded = await uploadDocument(attachment.file, attachment.name, controller.signal);
          uploadedFilesRef.current[attachment.id] = uploaded;
          setUploadedFiles({ ...uploadedFilesRef.current });
        }
        uploadIds.push(uploaded.id);
      }
      if (largePaste) {
        controller.signal.throwIfAborted();
        setUploadProgress({ name: '붙여넣은 자료', index: uploadCount, total: uploadCount });
        const uploaded = pastedUpload.current?.text === pasted ? pastedUpload.current.document : await uploadDocument(new Blob([pasted], { type: 'text/plain' }), 'Pasted source text.txt', controller.signal);
        pastedUpload.current = { text: pasted, document: uploaded }; uploadIds.push(uploaded.id);
      } else if (pasted) documents.push({ id: 'pasted-source', name: 'Pasted source text', text: pasted });
      controller.signal.throwIfAborted();
      setUploadProgress(null); uploadController.current = null;
      await saveAnalysisDraft({ question: analysisQuestion, sourceText, files, sources: clarification.sources, uploadedFiles: uploadedFilesRef.current });
      const result = await apiRequest<{ job: GenerationJob }>('/api/jobs', { method: 'POST', body: JSON.stringify({ question: analysisQuestion, documents, ...(uploadIds.length ? { uploadIds } : {}), ...(analysisBrief ? { analysisBrief } : {}) }) });
      void clearAnalysisDraft(); draftActive.current = false;
      rememberJob(result.job.id); navigate(`/analysis/${encodeURIComponent(result.job.id)}`, { state: { job: result.job } });
    } catch (error) {
      setError(error instanceof Error && error.name === 'AbortError' ? '업로드를 취소했습니다. 전송이 끝난 자료는 다시 시작할 때 재사용합니다.' : error instanceof Error ? error.message : '그래프를 생성하지 못했습니다.');
    }
    finally { setSubmitting(false); setUploadProgress(null); uploadController.current = null; }
  };

  return <div className={`home-screen${dragging ? ' home-is-dragging' : ''}`} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }} onDragEnter={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current += 1; setDragging(true); } }} onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }} onDrop={onDrop}>
    <GraphBackdrop />
    <header className="home-header"><div className="home-header-left"><CaseSidebarToggle /><Link to="/" className="home-brand" aria-label="Cluevia home"><BrandLogo /></Link></div><div className="home-header-actions" ref={headerActions}>
      <Link className="home-ontology-link" to="/ontology">ONTOLOGY</Link>
      <button type="button" className="home-account-button" aria-label="Account" aria-expanded={menu === 'account'} aria-controls="home-account-panel" onClick={() => setMenu(menu === 'account' ? null : 'account')}><span>CV</span></button>
      {menu === 'account' && <div className="home-header-panel home-account-panel" id="home-account-panel"><span className="home-panel-caption">YOUR WORKSPACE</span><strong>Cluevia</strong><span>{status?.authenticated ? 'Connected workspace' : '연결 대기'}</span>{status?.authRequired && status.authenticated && <button type="button" onClick={() => { setWorkspaceToken(''); window.location.reload(); }}>워크스페이스 연결 해제</button>}<button type="button" onClick={() => setMenu(null)}>Close account menu</button></div>}
    </div></header>
    <main className="home-main"><div className="home-case-container">
      <div className="home-workspace-status"><div><span className={`home-provider-dot${providerReady && status?.authenticated ? ' is-ready' : ''}`} /><span>{locked ? '워크스페이스 잠김' : providerReady ? providerLabel : status ? '분석 엔진 연결 필요' : connectionError ? '서버 연결 안 됨' : '워크스페이스 연결 중…'}</span></div>{status?.ontology && <Link to="/ontology">객체 {status.ontology.entities} · 관계 {status.ontology.relationships} <span aria-hidden="true">↗</span></Link>}</div>
      {job && <section className="home-active-analysis" aria-label="Current analysis"><div><strong>{isActiveJob(job) ? '진행 중인 분석' : job.status === 'completed' ? '최근 분석 결과' : '이어서 확인할 분석'}</strong><span>{job.question}</span></div><Link to={`/analysis/${encodeURIComponent(job.id)}`}>분석 화면 열기 ↗</Link></section>}
      {locked && <form className="home-unlock" onSubmit={event => void unlock(event)}><label htmlFor="workspace-key">워크스페이스 접속 키</label><div><input id="workspace-key" type="password" value={accessKey} onChange={event => setAccessKey(event.target.value)} autoComplete="off" placeholder="서버에 설정한 접속 키" required /><button type="submit" disabled={unlocking}>{unlocking ? '연결 중…' : '연결'}</button></div><small>접속 키는 현재 탭에서만 보관합니다.</small></form>}
      {restoringDraft && <p role="status">작성 중인 분석 요청을 확인하고 있습니다…</p>}
      {clarification && <AnalysisClarification question={clarification.question} sources={clarification.sources} initialDraft={clarification.progress} busy={submitting} error={error} uploadProgress={uploadProgress} onCancel={() => { resetClarification(); setError(''); window.requestAnimationFrame(() => document.getElementById('home-question')?.focus()); }} onConfirm={confirmInvestigation} onCancelUpload={() => uploadController.current?.abort()} />}
      <section hidden={!!clarification || restoringDraft} className={`home-case home-phase-${phase}${phase >= 3 ? ' home-folder-expanded' : ''}${phase >= 4 ? ' home-content-visible' : ''}${phase >= 5 ? ' home-stamp-visible' : ''}`} aria-label="New case">
        {phase < 4 && <div className="home-intro-folder" aria-hidden="true"><div className="home-intro-tab" /><div className="home-intro-paper" /><div className="home-intro-cover"><i /><i /><span /></div></div>}
        <div className="home-case-tab" aria-hidden="true"><span>NEW CASE</span></div><div className="home-case-stamp" aria-hidden="true"><div>OPEN SOURCE</div><span>PUBLIC INFORMATION ONLY</span></div>
        <div className="home-folder-body"><form className="home-paper" onSubmit={event => void startInvestigation(event)}>
          <label htmlFor="home-question" className="home-question-label">What do you want to find out?</label>
          <div className="home-question-field"><textarea id="home-question" className="home-question" rows={3} maxLength={2000} disabled={busy} placeholder="예: 고객·주문·상품의 관계를 정리하고 주문 흐름을 그래프로 보여줘" value={question} onChange={event => { setQuestion(event.target.value); resetClarification(); }} aria-describedby="home-question-hint" />
            {files.length > 0 && <ul className="home-attachments" aria-label="Attached files">{files.map(file => <li className="home-attachment" key={file.id}><Paperclip size={14} /><span className="home-attachment-name" title={file.name}>{file.name}</span><span className="home-attachment-size">{uploadedFiles[file.id] ? `전송됨 · ${uploadedFiles[file.id].chunkCount}구간` : formatSize(file.size)}</span><button type="button" disabled={busy} aria-label={`Remove ${file.name}`} onClick={() => { resetClarification(); delete uploadedFilesRef.current[file.id]; setUploadedFiles({ ...uploadedFilesRef.current }); setFiles(previous => previous.filter(item => item.id !== file.id)); }}>×</button></li>)}</ul>}
            <div className="home-field-actions"><input className="home-file-input" type="file" multiple ref={fileInput} onChange={onFiles} aria-label="Attach files" tabIndex={-1} /><button type="button" className="home-attach-button" disabled={busy} onClick={() => fileInput.current?.click()}><Paperclip /><span>Attach files</span></button><button type="submit" className="home-start-button" disabled={!ready || busy} title={!ready ? 'Type a question or attach a file first' : undefined}><span>{uploadProgress ? 'UPLOADING…' : busy ? job?.stage === 'designing' ? 'DESIGNING ONTOLOGY…' : 'BUILDING GRAPH…' : 'START INVESTIGATION'}</span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg></button></div>
          </div>
          <p className="home-question-hint" id="home-question-hint">확인 질문으로 분석할 대상과 범위를 정리한 뒤 그래프를 만듭니다. 시작 전 정리된 요청을 직접 수정할 수 있습니다.</p>
          <details className="home-source-text"><summary>Paste source text <span>자료 직접 붙여넣기</span></summary><label htmlFor="source-text" className="home-visually-hidden">Source text</label><textarea id="source-text" rows={4} disabled={busy} placeholder="질문의 근거가 되는 문서나 기사 내용을 붙여 넣으세요." value={sourceText} onChange={event => { setSourceText(event.target.value); resetClarification(); }} /><p>JSONL · NDJSON · CSV · TSV · JSON 등 UTF-8 텍스트 · 자료 형식에 맞춰 모든 구간을 처리합니다.</p></details><p className="home-privacy-note">온톨로지 설계용 자료와 문서 분석에 필요한 내용은 연결된 모델로 전송됩니다. 원문·온톨로지·그래프는 이 서버에 저장됩니다.</p>
          <p className="home-full-file-note">설계된 유형과 관계에 맞춰 표 데이터는 코드로 변환하고, 문서는 Codex로 분석합니다. Jev는 적합한 선택형 관계 판정에만 사용합니다. 큰 파일은 모든 구간을 처리해 부분 그래프로 저장하며, 결과의 근거를 함께 확인할 수 있습니다.</p>
          {uploadProgress && <section className="home-upload-progress" aria-label="Source upload progress" role="status"><div><strong>자료 전송 {uploadProgress.index} / {uploadProgress.total}</strong><button type="button" onClick={() => uploadController.current?.abort()}>업로드 취소</button></div><p>{uploadProgress.name}</p><small>서버에 원본을 보내고 분석 구간을 준비하고 있습니다. 전송을 마친 자료는 다시 시작할 때 재사용합니다.</small></section>}
          {error && <p className="home-intake-error" role="alert">{error}</p>}
          {offlineImport && <div className="home-offline-import"><p>서버 연결이 없어 이 기기의 브라우저에만 저장할 수 있습니다. 다른 기기와는 공유되지 않습니다.</p><button type="button" disabled={busy} onClick={() => void openImportedGraph(offlineImport, true)}>이 브라우저에만 불러오기</button></div>}

        </form></div>
      </section>
      {!!status?.resumableJobs?.filter(item => item.id !== job?.id).length && <section className="home-resumable-jobs" aria-label="Unfinished analyses"><span className="home-panel-caption">UNFINISHED ANALYSES</span>{status.resumableJobs.filter(item => item.id !== job?.id).map(item => <article key={item.id}><div><strong>{item.question}</strong><span>{item.completedChunks || 0} / {item.totalChunks || 0} 구간 처리 · {item.graphIds?.length || 0}개 그래프 저장</span></div><button type="button" disabled={busy} onClick={() => void resumeJob(item.id)}>이어서 분석</button><Link to={`/analysis/${encodeURIComponent(item.id)}`}>진행 내용 보기</Link></article>)}</section>}
    </div></main><footer className="home-footer">Public sources only · Every finding links back to its evidence</footer>
    {dragging && <div className="home-drop-indicator" aria-hidden="true"><Paperclip size={26} /><span>Drop files to attach evidence</span></div>}<span className="home-visually-hidden" role="status">{files.length > 0 ? `${files.length} ${files.length === 1 ? 'file' : 'files'} attached` : ''}</span>
  </div>;
}
