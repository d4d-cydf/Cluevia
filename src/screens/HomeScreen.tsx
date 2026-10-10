import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import BrandLogo from '../components/BrandLogo';
import { generateGraph, importGraphFile, recentGraphs } from '../services/graph-repository';
import { GRAPH_LIMITS } from '../lib/graph-document';
import type { EvidenceDocument } from '../types/graph';
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
  return <div className="home-graph-backdrop" aria-hidden="true"><svg width="100%" height="100%" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" fill="none" aria-hidden="true"><path d="M612 58L645 44M612 58L642 101M612 58L580 76M612 58L587 13M905 118L950 148M905 118L882 159M905 118L844 128M905 118L890 83M905 118L943 108M1250 92L1285 136M1250 92L1209 121M1250 92L1214 59M1250 92L1256 50M1250 92L1286 96M1180 300L1215 275M1180 300L1221 323M1180 300L1154 343M1180 300L1144 254M1365 455L1343 500M1365 455L1329 445M1365 455L1388 428M1365 455L1413 477M1270 690L1262 745M1270 690L1231 683M1270 690L1265 632M1270 690L1316 692M1010 812L1034 848M1010 812L958 815M1010 812L1052 776M700 862L731 889M700 862L647 868M700 862L704 815M420 826L410 887M420 826L364 813M420 826L424 762M420 826L462 805M420 826L455 857M160 740L118 772M160 740L170 690M160 740L186 765M250 520L283 551M250 520L212 568M250 520L220 481M250 520L277 484M70 330L120 371M70 330L48 376M70 330L10 304M70 330L79 289M70 330L122 303M210 170L192 227M210 170L156 145M210 170L212 129M210 170L240 152M210 170L243 196M430 110L364 112M430 110L413 73M430 110L465 89M430 110L433 171M580 76L950 148M645 44L1256 50M882 159L1256 50M882 159L1144 254M1214 59L1215 275M1144 254L1413 477M1316 692L1343 500M1052 776L1231 683M731 889L1034 848M731 889L212 568M277 484L186 765M118 772L455 857M277 484L212 129M156 145L413 73M120 371L192 227M120 371L212 568M1144 254L1034 848M413 73L645 44" stroke="#D2C4A3" strokeWidth="0.8"></path><path d="M612 58L905 118M612 58L1250 92M905 118L1250 92M905 118L1180 300M1250 92L1180 300M1180 300L1365 455M1270 690L1365 455M1010 812L1270 690M700 862L1010 812M700 862L250 520M250 520L160 740M160 740L420 826M250 520L210 170M210 170L430 110M70 330L210 170M70 330L250 520M1180 300L1010 812M430 110L612 58" stroke="#C4B48D" strokeWidth="1"></path><path className="home-graph-flow" d="M210 170L430 110M250 520L160 740M1010 812L1270 690M1250 92L1180 300" stroke="#B8321A" strokeOpacity="0.6" strokeWidth="1.3"></path><path d="M580 76h0M587 13h0M844 128h0M890 83h0M1209 121h0M1256 50h0M1286 96h0M1154 343h0M1329 445h0M1262 745h0M1231 683h0M1265 632h0M1034 848h0M1052 776h0M731 889h0M647 868h0M704 815h0M364 813h0M462 805h0M455 857h0M118 772h0M186 765h0M283 551h0M220 481h0M277 484h0M120 371h0M48 376h0M79 289h0M122 303h0M212 129h0M240 152h0M413 73h0M433 171h0" stroke="#BBA982" strokeWidth="4" strokeLinecap="round"></path><path d="M645 44h0M642 101h0M950 148h0M882 159h0M943 108h0M1285 136h0M1214 59h0M1215 275h0M1221 323h0M1144 254h0M1343 500h0M1388 428h0M1413 477h0M1316 692h0M958 815h0M410 887h0M424 762h0M170 690h0M212 568h0M10 304h0M192 227h0M156 145h0M243 196h0M364 112h0M465 89h0" stroke="#AE9C75" strokeWidth="5.5" strokeLinecap="round"></path><path d="M606.5 58a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0M899.5 118a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0M1244.5 92a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0M1174.5 300a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0M1359.5 455a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0M1264.5 690a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0M1004.5 812a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0M694.5 862a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0M414.5 826a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0M154.5 740a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0M244.5 520a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0M64.5 330a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0M204.5 170a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0M424.5 110a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0" fill="#E6DCC6" stroke="#9F8D67" strokeWidth="1.2"></path><path d="M612 58h0M905 118h0M1250 92h0M1180 300h0M1365 455h0M1270 690h0M1010 812h0M700 862h0M420 826h0M160 740h0M250 520h0M70 330h0M210 170h0M430 110h0" stroke="#8A7953" strokeWidth="4" strokeLinecap="round"></path><g fill="#998863" fontFamily="Courier Prime, monospace" fontSize="10" letterSpacing="1.5"><text x="624" y="62">SOURCE</text><text x="917" y="122">CLAIM</text><text x="1262" y="96">MEDIA</text><text x="1192" y="304">EVENT</text><text x="1353" y="459" textAnchor="end">LOCATION</text><text x="1282" y="694">PORT</text><text x="1022" y="816">VESSEL</text><text x="712" y="866">DOCUMENT</text><text x="432" y="830">TRANSACTION</text><text x="172" y="744">WALLET</text><text x="262" y="524">ORGANIZATION</text><text x="82" y="334">CERTIFICATE</text><text x="222" y="174">DOMAIN</text><text x="442" y="114">IP ADDRESS</text></g><g fill="#AD9C77" fontFamily="Courier Prime, monospace" fontSize="9" letterSpacing="0.5"><text x="320" y="134" textAnchor="middle" transform="rotate(-15 320 140)">resolves_to</text><text x="140" y="244" textAnchor="middle" transform="rotate(-49 140 250)">issued_for</text><text x="205" y="624" textAnchor="middle" transform="rotate(-68 205 630)">controls</text><text x="1140" y="745" textAnchor="middle" transform="rotate(-25 1140 751)">docked_at</text><text x="1215" y="190" textAnchor="middle" transform="rotate(-71 1215 196)">depicts</text><text x="1077" y="99" textAnchor="middle" transform="rotate(-4 1077 105)">cites</text><text x="855" y="831" textAnchor="middle" transform="rotate(-9 855 837)">mentions</text><text x="758" y="82" textAnchor="middle" transform="rotate(12 758 88)">published</text></g></svg></div>;
}

export default function HomeScreen() {
  const navigate = useNavigate();
  const [question, setQuestion] = useState('');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [phase, setPhase] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 5 : 0);
  const [menu, setMenu] = useState<'cases' | 'account' | null>(null);
  const [dragging, setDragging] = useState(false);
  const [sourceText, setSourceText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [aipReady, setAipReady] = useState(false);
  const graphFileInput = useRef<HTMLInputElement>(null);
  const generationController = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const headerActions = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);
  const fileSequence = useRef(0);
  const ready = question.trim().length > 0 || files.length > 0;

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/aip/status', { signal: controller.signal }).then(response => response.ok ? response.json() : null).then(result => setAipReady(result?.configured === true)).catch(() => {});
    return () => { controller.abort(); generationController.current?.abort(); };
  }, []);

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (preference.matches) return;
    const timers = [[1, 120], [2, 640], [3, 900], [4, 1440], [5, 1700]].map(([next, delay]) => window.setTimeout(() => setPhase(next), delay));
    const skipAnimation = () => {
      if (preference.matches) {
        timers.forEach(window.clearTimeout);
        setPhase(5);
      }
    };
    preference.addEventListener('change', skipAnimation);
    return () => {
      timers.forEach(window.clearTimeout);
      preference.removeEventListener('change', skipAnimation);
    };
  }, []);

  useEffect(() => {
    if (!menu) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!headerActions.current?.contains(event.target as Node)) setMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        headerActions.current?.querySelector<HTMLButtonElement>(`[aria-controls="home-${menu}-panel"]`)?.focus();
        setMenu(null);
      }
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menu]);

  const addFiles = (incoming: FileList | File[]) => {
    setError('');
    const candidates = Array.from(incoming);
    if (files.length + candidates.length > GRAPH_LIMITS.documents) { setError('자료는 최대 10개까지 첨부할 수 있습니다.'); return; }
    if (candidates.some(file => !/\.(txt|md|csv|json)$/i.test(file.name))) { setError('현재는 TXT, MD, CSV, JSON 자료를 지원합니다. PDF·사진은 텍스트로 변환한 뒤 첨부해주세요.'); return; }
    if (candidates.some(file => file.size > GRAPH_LIMITS.jsonBytes)) { setError('파일은 각각 2MB 이하여야 합니다.'); return; }
    const added = candidates.map(file => ({ id: `doc-${++fileSequence.current}`, name: file.name, size: file.size, file }));
    setFiles(previous => [...previous, ...added]);
  };
  const onFiles = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) addFiles(event.target.files);
    event.target.value = '';
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
  };
  const openImportedGraph = async (file: File) => {
    setBusy(true); setError('');
    try { const graph = await importGraphFile(file); navigate(`/case/${graph.id}/board`); }
    catch (error) { setError(error instanceof Error ? error.message : '그래프를 불러오지 못했습니다.'); }
    finally { setBusy(false); }
  };

  const startInvestigation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true); setError('');
    try {
      if (files.length === 1 && /\.json$/i.test(files[0].name)) {
        const content = await files[0].file.text();
        let candidate: unknown;
        try { candidate = JSON.parse(content); } catch { /* Let AIP read non-graph evidence if configured. */ }
        if (candidate && typeof candidate === 'object' && 'schemaVersion' in candidate) {
          const graph = await importGraphFile(files[0].file); navigate(`/case/${graph.id}/board`); return;
        }
      }
      if (!question.trim()) throw new Error('자료에서 확인하고 싶은 질문을 입력해주세요.');
      const documents: EvidenceDocument[] = [];
      if (sourceText.trim()) documents.push({ id: 'pasted-source', name: 'Pasted source text', text: sourceText.trim() });
      for (const attachment of files) documents.push({ id: attachment.id, name: attachment.name, text: await attachment.file.text() });
      if (!documents.length) throw new Error('분석할 자료를 첨부하거나 Source text에 붙여 넣어주세요. GFW 예제는 아래 버튼으로 바로 열 수 있습니다.');
      if (documents.length > GRAPH_LIMITS.documents || documents.some(document => document.text.length > GRAPH_LIMITS.documentChars) || documents.reduce((total, document) => total + document.text.length, 0) > GRAPH_LIMITS.totalDocumentChars) throw new Error('자료는 최대 10개, 각 5만 자, 전체 15만 자 이내로 입력해주세요.');
      if (!aipReady) throw new Error('AIP가 아직 연결되지 않았습니다. 환경변수를 설정하고 서버를 다시 실행하거나, 완성된 그래프 JSON / GFW 예제를 열어주세요.');
      generationController.current = new AbortController();
      const graph = await generateGraph({ question: question.trim(), documents }, generationController.current.signal);
      navigate(`/case/${graph.id}/board`);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setError(error instanceof Error ? error.message : '그래프를 생성하지 못했습니다.');
    } finally { setBusy(false); generationController.current = null; }
  };

  return (
    <div className={`home-screen${dragging ? ' home-is-dragging' : ''}`} onDragOver={event => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }} onDragEnter={event => {
      if (event.dataTransfer.types.includes('Files')) {
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }
    }} onDragLeave={() => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    }} onDrop={onDrop}>
      <GraphBackdrop />
      <header className="home-header">
        <Link to="/" className="home-brand" aria-label="Cluevia home">
          <BrandLogo />
        </Link>
        <div className="home-header-actions" ref={headerActions}>
          <button type="button" className="home-cases-button" aria-expanded={menu === 'cases'} aria-controls="home-cases-panel" onClick={() => setMenu(menu === 'cases' ? null : 'cases')}>MY CASES</button>
          <button type="button" className="home-account-button" aria-label="Account" aria-expanded={menu === 'account'} aria-controls="home-account-panel" onClick={() => setMenu(menu === 'account' ? null : 'account')}><span>JH</span></button>
          {menu === 'cases' && <div className="home-header-panel" id="home-cases-panel"><span className="home-panel-caption">RECENT CASES</span><Link to="/case/gfw-galapagos/board" className="home-recent-case"><strong>GFW · Galápagos 2017</strong><span>공개 자료로 완성한 그래프 ↗</span></Link>{recentGraphs().map(graph => <Link key={graph.id} to={`/case/${graph.id}/board`} className="home-recent-case"><strong>{graph.title}</strong></Link>)}<Link to="/case/0143/board" className="home-recent-case"><span>Original design demo ↗</span></Link></div>}
          {menu === 'account' && <div className="home-header-panel home-account-panel" id="home-account-panel"><span className="home-panel-caption">YOUR WORKSPACE</span><strong>JH</strong><span>Personal workspace</span><button type="button" onClick={() => setMenu(null)}>Close account menu</button></div>}
        </div>
      </header>

      <main className="home-main">
        <div className="home-case-container">
          <section className={`home-case home-phase-${phase}${phase >= 3 ? ' home-folder-expanded' : ''}${phase >= 4 ? ' home-content-visible' : ''}${phase >= 5 ? ' home-stamp-visible' : ''}`} aria-label="New case">
            {phase < 4 && <div className="home-intro-folder" aria-hidden="true"><div className="home-intro-tab" /><div className="home-intro-paper" /><div className="home-intro-cover"><i /><i /><span /></div></div>}
            <div className="home-case-tab" aria-hidden="true"><span>NEW CASE</span></div>
            <div className="home-case-stamp" aria-hidden="true"><div>OPEN SOURCE</div><span>PUBLIC INFORMATION ONLY</span></div>
            <div className="home-folder-body">
              <form className="home-paper" onSubmit={event => void startInvestigation(event)}>
                <label htmlFor="home-question" className="home-question-label">What do you want to find out?</label>
                <div className="home-question-field">
                  <textarea id="home-question" className="home-question" rows={3} maxLength={2000} placeholder="e.g. Which vessels were connected, and what supports each connection?" value={question} onChange={event => setQuestion(event.target.value)} aria-describedby="home-question-hint" />
                  {files.length > 0 && <ul className="home-attachments" aria-label="Attached files">{files.map(file => <li className="home-attachment" key={file.id}><Paperclip size={14} /><span className="home-attachment-name" title={file.name}>{file.name}</span><span className="home-attachment-size">{formatSize(file.size)}</span><button type="button" aria-label={`Remove ${file.name}`} onClick={() => setFiles(previous => previous.filter(item => item.id !== file.id))}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" /></svg></button></li>)}</ul>}
                  <div className="home-field-actions">
                    <input className="home-file-input" type="file" accept=".txt,.md,.csv,.json" multiple ref={fileInput} onChange={onFiles} aria-label="Attach files" tabIndex={-1} />
                    <button type="button" className="home-attach-button" onClick={() => fileInput.current?.click()}><Paperclip /><span>Attach files</span></button>
                    <button type="submit" className="home-start-button" disabled={!ready || busy} title={!ready ? 'Type a question or attach a file first' : undefined}><span>{busy ? 'BUILDING GRAPH…' : 'START INVESTIGATION'}</span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg></button>
                  </div>
                </div>
                <p className="home-question-hint" id="home-question-hint">Ask in plain words. Add TXT, MD, CSV or JSON evidence.</p>
                <details className="home-source-text"><summary>Paste source text <span>자료 직접 붙여넣기</span></summary><label htmlFor="source-text" className="home-visually-hidden">Source text</label><textarea id="source-text" rows={4} maxLength={GRAPH_LIMITS.documentChars} placeholder="질문의 근거가 되는 문서나 기사 내용을 붙여 넣으세요." value={sourceText} onChange={event => setSourceText(event.target.value)} /><p>입력한 자료는 그래프 생성 시 연결된 AIP로 전송됩니다.</p></details>
                {error && <p className="home-intake-error" role="alert">{error}</p>}
                {busy && <p className="home-intake-status" role="status">자료에서 객체와 관계를 추출하고 있습니다… <button type="button" onClick={() => generationController.current?.abort()}>취소</button></p>}
              </form>
            </div>
          </section>
          <section className="home-graph-entry" aria-label="Open a completed graph"><div><span className="home-panel-caption">FROM EVIDENCE TO CONNECTIONS</span><p>완성된 그래프를 먼저 살펴보세요.</p></div><div className="home-graph-entry-actions"><Link to="/case/gfw-galapagos/board" aria-label="Open GFW example">GFW 공개 사례 <span aria-hidden="true">↗</span></Link><button type="button" disabled={busy} onClick={() => graphFileInput.current?.click()} aria-label="Import graph JSON">그래프 JSON 불러오기</button><input className="home-file-input" ref={graphFileInput} type="file" accept=".json,application/json" aria-label="Graph JSON file" onChange={event => { const file = event.target.files?.[0]; if (file) void openImportedGraph(file); event.target.value = ''; }} /></div><small>{aipReady ? '● AIP 설정됨 · 자료로 새 그래프 생성 요청 가능' : 'GFW 예제와 JSON 불러오기는 AIP 연결 없이 사용할 수 있습니다.'}</small></section>
        </div>
      </main>
      <footer className="home-footer">Public sources only · Every finding links back to its evidence</footer>
      {dragging && <div className="home-drop-indicator" aria-hidden="true"><Paperclip size={26} /><span>Drop files to attach evidence</span></div>}
      <span className="home-visually-hidden" role="status">{files.length > 0 ? `${files.length} ${files.length === 1 ? 'file' : 'files'} attached` : ''}</span>
    </div>
  );
}
