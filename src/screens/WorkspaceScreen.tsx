import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, NavLink, useParams } from 'react-router-dom';
import { BrandMark, Icon } from '../components/Icon';
import { investigationSteps, objectColors } from '../mock/case-0143';
import { caseRepository, readCaseDraft, readSession, writeSession } from '../services/case-repository';
import type { Attachment, CaseAction, CaseMessage, InvestigationCase, WorkspaceView } from '../types/case';
import BoardView from './BoardView';
import LanesView from './LanesView';
import TimelineView from './TimelineView';
import './workspace.css';

const dateOf = (day: number) => `${day <= 10 ? 20 + day : day - 10} ${day <= 10 ? 'SEP' : 'OCT'} 2026`;
const views: WorkspaceView[] = ['board', 'lanes', 'timeline'];
const citationObjects: Record<string, string> = { E1: 'ip', E2: 'cert', E4: 'kit', E6: 'exch' };
const citationEvents: Record<string, string> = { E1: 'ev6', E2: 'ev8', E4: 'ev12', E6: 'ev14' };

export default function WorkspaceScreen() {
  const { id = '', view = 'board' } = useParams();
  const [caseData, setCaseData] = useState<InvestigationCase | null | undefined>();
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let active = true;
    setCaseData(undefined);
    setLoadError('');
    caseRepository.getCase(id).then(data => { if (active) setCaseData(data); }).catch(() => { if (active) setLoadError('The case could not be opened. Please try again.'); });
    return () => { active = false; };
  }, [id]);

  if (!views.includes(view as WorkspaceView)) return <Navigate to={`/case/${id}/board`} replace />;
  if (loadError || caseData === null) return <main className="empty-state"><p className="eyebrow">CASE NOT FOUND</p><h1>{loadError || 'This case is not in the file.'}</h1><p>The preview includes case 0143.</p><Link to="/case/0143/board">Open the demo case →</Link><Link to="/">Return home</Link></main>;
  if (!caseData) return <main className="empty-state" role="status"><BrandMark size={36} /><p>Opening the case file…</p></main>;
  return <CaseWorkspace key={caseData.id} data={caseData} view={view as WorkspaceView} />;
}

function CaseWorkspace({ data, view }: { data: InvestigationCase; view: WorkspaceView }) {
  const [initialDraft] = useState(readCaseDraft);
  const question = initialDraft?.question.trim() || (initialDraft?.files.length ? 'Investigate the attached evidence.' : data.question);
  const [selectedObject, setSelectedObject] = useState('wallet');
  const [selectedEvent, setSelectedEvent] = useState('ev14');
  const [showPath, setShowPath] = useState(true);
  const [phase, setPhase] = useState(0);
  const [replayKey, setReplayKey] = useState(0);
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [messages, setMessages] = useState<CaseMessage[]>(() => {
    const saved = readSession<CaseMessage[]>(`cluevia.${data.id}.messages`, []);
    return Array.isArray(saved) ? saved.filter(message => message && typeof message.text === 'string' && ['user', 'assistant'].includes(message.role)) : [];
  });
  const [actions, setActions] = useState<CaseAction[]>(() => {
    const saved = readSession<CaseAction[]>(`cluevia.${data.id}.actions`, []);
    return Array.isArray(saved) ? saved.filter(action => action && typeof action.objectId === 'string' && typeof action.label === 'string') : [];
  });
  const [sending, setSending] = useState(false);
  const [pendingAction, setPendingAction] = useState('');
  const [notice, setNotice] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const done = phase >= 6;
  const isTimeline = view === 'timeline';
  const object = data.objects[selectedObject];
  const event = data.timeline.events.find(item => item.id === selectedEvent)!;
  const eventRow = data.timeline.rows.find(row => row.id === event.row)!;
  const activeObject = isTimeline ? data.objects[event.row] : object;

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setPhase(6); return; }
    setPhase(0);
    const timers = [1, 2, 3, 4, 5, 6].map(step => window.setTimeout(() => setPhase(step), 150 + (step - 1) * 520));
    return () => timers.forEach(window.clearTimeout);
  }, [replayKey]);

  useEffect(() => { writeSession(`cluevia.${data.id}.messages`, messages); }, [data.id, messages]);
  useEffect(() => { writeSession(`cluevia.${data.id}.actions`, actions); }, [data.id, actions]);
  useEffect(() => { if (messages.length) threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight }); }, [messages]);
  useEffect(() => { if (notice) { const timer = window.setTimeout(() => setNotice(''), 4500); return () => window.clearTimeout(timer); } }, [notice]);

  function selectCitation(label: string) {
    setSelectedObject(citationObjects[label]);
    setSelectedEvent(citationEvents[label]);
  }

  function citation(label: string) {
    const selected = isTimeline ? selectedEvent === citationEvents[label] : selectedObject === citationObjects[label];
    return <button type="button" className={`ws-citation${selected ? ' is-active' : ''}`} aria-label={`Show evidence ${label}`} aria-pressed={selected} onClick={() => selectCitation(label)}>{label}</button>;
  }

  async function queueAction(label: string) {
    if (pendingAction || actions.some(action => action.objectId === activeObject.id && action.label === label)) return;
    setPendingAction(label);
    try {
      const action = await caseRepository.runAction(data.id, activeObject.id, label);
      setActions(previous => [...previous, action]);
      setNotice(`${label} queued in this demo. No external action was performed.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not queue this action.'); }
    finally { setPendingAction(''); }
  }

  function askAbout() {
    setDraft(isTimeline ? `What happened on ${dateOf(event.d)} with ${eventRow.name}? ` : `Tell me more about ${object.value}. `);
    inputRef.current?.focus();
    inputRef.current?.scrollIntoView({ block: 'nearest' });
  }

  async function send() {
    if (sending || (!draft.trim() && !files.length)) return;
    const userMessage: CaseMessage = { id: crypto.randomUUID(), role: 'user', text: draft.trim(), files };
    setSending(true);
    setMessages(previous => [...previous, userMessage]);
    setDraft('');
    setFiles([]);
    try {
      const response = await caseRepository.sendMessage(data.id, userMessage.text, userMessage.files ?? []);
      setMessages(previous => [...previous, response]);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Your question could not be sent.'); }
    finally { setSending(false); inputRef.current?.focus(); }
  }

  function exportCase() {
    const content = JSON.stringify({ ...data, mode: 'demo', initialQuestion: question, attachments: initialDraft?.files ?? [], messages, actions }, null, 2);
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `cluevia-case-${data.id}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice('Case file exported.');
  }

  function actionButtons() {
    return <div className="ws-action-buttons">{activeObject.actions.map(label => {
      const queued = actions.some(action => action.objectId === activeObject.id && action.label === label);
      return <button key={label} type="button" className={queued ? 'is-queued' : ''} disabled={queued || !!pendingAction} onClick={() => void queueAction(label)}>{queued ? `Queued: ${label}` : label}</button>;
    })}<button type="button" className="ws-secondary" onClick={askAbout}>Ask about this</button>{isTimeline && <Link to={`/case/${data.id}/board`} onClick={() => setSelectedObject(event.row)}>Open on board</Link>}</div>;
  }

  const graphProps = { objects: data.objects, links: data.links, selectedId: selectedObject, onSelect: setSelectedObject, showPath, phase };
  const visibleAt = [0, 1, 3, 4, 5];
  const visibleObjects = Object.values(data.objects).filter(item => (view !== 'lanes' || item.id !== 'block') && phase >= visibleAt[item.stage]);
  const visibleLinks = data.links.filter(link => visibleObjects.some(item => item.id === link.source) && visibleObjects.some(item => item.id === link.target));
  const count = isTimeline ? `${data.timeline.events.length} events · ${data.timeline.rows.length} objects` : `${done ? 'Ontology' : 'Building'} · ${visibleObjects.length} objects · ${visibleLinks.length} links`;

  return <div className="workspace">
    <header className="ws-header">
      <div className="ws-header-left"><Link to="/" className="ws-brand" aria-label="OSINT Copilot home"><BrandMark /><span>OSINT COPILOT</span></Link><span className="ws-header-rule" /><div className="ws-case-title"><span>CASE {data.id}</span><strong title={question}>{initialDraft ? question : data.title}</strong></div></div>
      <div className="ws-header-actions"><span className="ws-demo-label">DEMO</span><Link to="/"><Icon name="plus" size={14} />NEW CASE</Link><details className="ws-menu"><summary>MY CASES</summary><div><span className="eyebrow">RECENT CASE</span><Link to={`/case/${data.id}/board`}>0143 · secure-login.example</Link><small>Local preview · fictional evidence</small></div></details><button type="button" onClick={exportCase}>EXPORT</button><details className="ws-menu ws-account"><summary aria-label="Account"><span>JH</span></summary><div><strong>Local workspace</strong><small>Demo session</small><Link to="/">Start a new case →</Link></div></details></div>
    </header>
    <div className="ws-body">
      <aside className="ws-conversation" aria-label="Conversation">
        <div className="ws-thread" ref={threadRef}>
          <div className="ws-user-message">{question}{initialDraft?.files.map(file => <span className="ws-message-file" key={file.id}><Icon name="attach" size={12} />{file.name}</span>)}</div>
          <div className="ws-assistant"><div className="ws-assistant-label"><BrandMark size={16} /><span>COPILOT</span></div>
            {!done ? <div className="ws-building" role="status"><span className="eyebrow">BUILDING THE CASE</span>{investigationSteps.map((step, index) => <div key={step} className={`ws-build-step ${phase === index + 1 ? 'is-active' : ''} ${phase > index + 1 ? 'is-done' : ''}`}><span>{phase > index + 1 ? <Icon name="check" size={14} /> : <i />}</span>{step}</div>)}</div> : <div className="ws-answer">
              {initialDraft && <p className="ws-preview-note">Showing the sample case below. Your question and attachment names are saved for this preview.</p>}
              <p><strong>secure-login.example is one of four look-alike sites running the same wallet-draining kit.</strong> Three of them share a server and a certificate, and the money from all four ends up in one wallet.</p>
              <ol><li><span>1</span><div>Shares 203.0.113.42 and a certificate with two sibling domains. {citation('E1')} {citation('E2')}</div></li><li><span>2</span><div>The kit’s config file pays out to wallet 0x5aAe…eAed. {citation('E4')}</div></li><li><span>3</span><div>That wallet cashes out to a labelled exchange deposit. {citation('E6')}</div></li></ol>
              <p className="ws-attribution">The registrant is privacy-protected, so attribution stops at the exchange. Naming the operator needs a legal request, not more searching.</p>
              <div className="ws-answer-meta"><span>9 sources checked · Confidence: high</span><span>◇ 12 objects and 12 links in the demo ontology</span></div>
            </div>}
          </div>
          {messages.map(message => <div key={message.id} className={message.role === 'user' ? 'ws-user-message' : 'ws-reply'}>{message.role === 'assistant' && <div className="ws-assistant-label"><BrandMark size={16} />COPILOT</div>}<p>{message.text}</p>{message.files?.map(file => <span key={file.id} className="ws-message-file"><Icon name="attach" size={12} />{file.name}</span>)}</div>)}
        </div>
        <form className="ws-compose" onSubmit={event => { event.preventDefault(); void send(); }}>
          <div className="ws-compose-field"><label htmlFor="follow-up" className="sr-only">Follow-up question</label><textarea ref={inputRef} id="follow-up" rows={2} placeholder="Ask a follow-up…" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
            {!!files.length && <div className="ws-files">{files.map(file => <span key={file.id} title={file.name}><span>{file.name}</span><button type="button" aria-label={`Remove ${file.name}`} onClick={() => setFiles(previous => previous.filter(item => item.id !== file.id))}><Icon name="close" size={11} /></button></span>)}</div>}
            <div className="ws-compose-actions"><input className="sr-only" ref={fileRef} type="file" multiple tabIndex={-1} aria-label="Attach files" onChange={event => { setFiles(previous => [...previous, ...Array.from(event.target.files ?? []).map(file => ({ id: crypto.randomUUID(), name: file.name, size: file.size }))]); event.target.value = ''; }} /><button type="button" aria-label="Attach files" title="Attach files" onClick={() => fileRef.current?.click()}><Icon name="attach" size={18} /></button><button type="submit" aria-label="Send" className="ws-send" disabled={sending || (!draft.trim() && !files.length)}><Icon name="send" size={18} /></button></div>
          </div>
        </form>
      </aside>
      <section ref={stageRef} className={`ws-stage ws-stage--${view}`} aria-label={isTimeline ? 'Investigation timeline' : 'Investigation graph'}>
        <div className="ws-toolbar"><nav aria-label="Graph views">{views.map(item => <NavLink key={item} to={`/case/${data.id}/${item}`} aria-label={item.charAt(0).toUpperCase() + item.slice(1)}>{item.toUpperCase()}</NavLink>)}</nav><div className="ws-graph-tools"><span className="ws-count" aria-live="polite">{count}</span><span className="ws-tool-rule" /><button type="button" role="switch" aria-checked={showPath} onClick={() => setShowPath(previous => !previous)}><span className={`ws-path-swatch${showPath ? '' : ' is-off'}`} />Answer path</button><span className="ws-tool-rule" /><button type="button" onClick={() => setReplayKey(previous => previous + 1)}><Icon name="replay" size={14} />Replay</button><button type="button" aria-label="Fit to screen" title="Fit to screen" onClick={() => stageRef.current?.querySelector('[data-canvas-scroll]')?.scrollTo({ left: 0, top: 0, behavior: 'smooth' })}><Icon name="fit" /></button></div></div>
        {view === 'board' && <BoardView {...graphProps} />}{view === 'lanes' && <LanesView {...graphProps} />}{isTimeline && <TimelineView {...data.timeline} selectedId={selectedEvent} onSelect={setSelectedEvent} showPath={showPath} phase={phase} />}
        {done && (isTimeline ? <section className="ws-event-inspector" aria-label="Selected event"><div><div className="ws-inspector-meta"><i style={{ background: objectColors[eventRow.group] }} />{dateOf(event.d)} · {eventRow.type} · {eventRow.name}</div><h2>{event.label}</h2><p>{event.note}</p><div className="ws-event-facts">Evidence {event.ev} · {event.inf ? 'Inferred' : 'Confirmed'} · {eventRow.name}</div></div><div className="ws-event-actions"><h3>ACTIONS ON {eventRow.type}</h3>{actionButtons()}<div className="ws-action-note">Actions are queued locally in this demo.</div></div></section> : <section className="ws-object-inspector" aria-label="Selected object"><div className="ws-inspector-top"><span className="ws-inspector-meta"><i style={{ background: objectColors[object.group] }} />{object.type}</span><span className={`ws-confidence ${object.conf === 'INFERRED' ? 'is-inferred' : ''}`}>{object.conf}</span></div><h2>{object.value}</h2><p>{object.note}</p><h3>PROPERTIES</h3><dl>{object.props.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl><h3>ACTIONS</h3>{actionButtons()}<div className="ws-action-note">Evidence {object.src} · Actions are queued locally.</div></section>)}
      </section>
    </div>
    <div className={`ws-toast${notice ? ' is-visible' : ''}`} role="status" aria-live="polite">{notice}</div>
  </div>;
}
