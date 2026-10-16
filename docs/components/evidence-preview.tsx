'use client';

import { localizeNode, translateText } from '@/lib/localize';
import type { DocumentLanguage } from '@/lib/document-language';


import { useId, useState } from 'react';
import { ArrowUpRight, Clock3, Columns3, Network, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import graph from '@/public/examples/gfw-galapagos.json';

const displayedIds = ['longliner-7866', 'encounters', 'carrier', 'interception', 'galapagos'];
const nodes = displayedIds.map((id) => graph.nodes.find((node) => node.id === id)!);
const edges = graph.edges.filter((edge) => displayedIds.includes(edge.source) && displayedIds.includes(edge.target));
const positions = [[115, 87], [322, 61], [214, 203], [435, 190], [391, 318]];
const types: Record<string, string> = { vessels: 'VESSEL', events: 'EVENT', places: 'LOCATION' };
const titles: Record<string, string> = { 'longliner-7866': 'Fu Yuan Yu 7866', encounters: '4척과 AIS 조우', carrier: 'Fu Yuan Yu Leng 999', interception: '운반선 나포', galapagos: '갈라파고스 보호구역' };
const views = [{ id: 'board', label: 'Board', icon: Network }, { id: 'lanes', label: 'Lanes', icon: Columns3 }, { id: 'timeline', label: 'Timeline', icon: Clock3 }] as const;
type View = typeof views[number]['id'];

export function EvidencePreview({ language = 'ko' }: { language?: DocumentLanguage }) {
  const [view, setView] = useState<View>('board');
  const [selected, setSelected] = useState('carrier');
  const instanceId = useId();
  const node = nodes.find((item) => item.id === selected)!;
  const sources = graph.sources.filter((source) => node.sourceIds.includes(source.id));

  return localizeNode(
    <div className="evidence-preview">
      <div className="preview-file"><span><span className="status-dot" /> PUBLIC SOURCE / CASE 001</span><span>GALÁPAGOS, 2017</span></div>
      <div className="preview-toolbar">
        <div className="preview-tabs" role="tablist" aria-label="예제 보기 방식">
          {views.map(({ id, label, icon: Icon }, index) => <button key={id} type="button" role="tab" id={`${instanceId}-${id}-tab`} aria-controls={`${instanceId}-panel`} aria-selected={view === id} tabIndex={view === id ? 0 : -1} onClick={() => setView(id)} onKeyDown={(event) => {
            const next = event.key === 'ArrowRight' ? (index + 1) % views.length : event.key === 'ArrowLeft' ? (index + views.length - 1) % views.length : event.key === 'Home' ? 0 : event.key === 'End' ? views.length - 1 : -1;
            if (next < 0) return;
            event.preventDefault();
            setView(views[next].id);
            event.currentTarget.parentElement?.querySelectorAll('button')[next].focus();
          }}><Icon size={13} aria-hidden="true" />{label}</button>)}
        </div>
        <button type="button" className="preview-reset" aria-label="예제 보기 초기화" onClick={() => { setView('board'); setSelected('carrier'); }}><RotateCcw size={14} /></button>
      </div>
      <div className={`preview-canvas preview-mode-${view}`} id={`${instanceId}-panel`} role="tabpanel" aria-labelledby={`${instanceId}-${view}-tab`}>
        {view === 'board' && <>
          <svg className="preview-connections" viewBox="0 0 560 380" aria-hidden="true">
            {edges.map((edge) => {
              const [x1, y1] = positions[displayedIds.indexOf(edge.source)];
              const [x2, y2] = positions[displayedIds.indexOf(edge.target)];
              const active = edge.source === selected || edge.target === selected;
              return <g key={edge.id} className={active ? 'connection-active' : ''}><line x1={x1} y1={y1} x2={x2} y2={y2} strokeDasharray={edge.status === 'inferred' ? '5 5' : undefined} /><text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 9}>{edge.label}</text></g>;
            })}
          </svg>
          {nodes.map((item, index) => <button key={item.id} type="button" className={`graph-node node-${item.group}${selected === item.id ? ' selected' : ''}`} style={{ left: `${positions[index][0] / 5.6}%`, top: `${positions[index][1] / 3.8}%` }} aria-pressed={selected === item.id} onClick={() => setSelected(item.id)}><span><i />{types[item.group]}</span><strong>{titles[item.id]}</strong></button>)}
          <div className="graph-legend"><span><i />보고된 관계</span><span><i className="dashed" />추론 관계</span></div>
        </>}
        {view === 'lanes' && <div className="preview-lane-list">{graph.groups.filter((group) => nodes.some((item) => item.group === group.id)).map((group) => <div className="preview-lane" key={group.id}><span>{group.label}</span><div>{nodes.filter((item) => item.group === group.id).map((item) => <button type="button" key={item.id} aria-pressed={selected === item.id} className={selected === item.id ? 'selected' : ''} onClick={() => setSelected(item.id)}>{titles[item.id]}</button>)}</div></div>)}</div>}
        {view === 'timeline' && <div className="preview-timeline"><span className="eyebrow">AUGUST 2017 / 자료에 명시된 날짜</span>{graph.events.map((event) => <button type="button" key={event.id} className={selected === event.nodeIds[1] ? 'selected' : ''} onClick={() => setSelected(event.nodeIds[1])}><time dateTime={event.date}>{event.date.slice(5).replace('-', '.')}<span>{event.endDate ? `— ${event.endDate.slice(5).replace('-', '.')}` : '2017'}</span></time><span><strong>{event.label}</strong><small>{event.description}</small></span><ArrowUpRight size={16} /></button>)}<p>조우는 화물 이전을 입증하지 않습니다.</p></div>}
      </div>
      <div className="preview-inspector" aria-live="polite" aria-atomic="true"><div><span className="eyebrow">SELECTED EVIDENCE</span><strong>{node.label}</strong><p>{node.description}</p></div><a className="source-chip" href={sources[0]?.url} target="_blank" rel="noreferrer" aria-label={`${translateText(node.label, language)} ${translateText('출처 원문 열기', language)}`}>[{sources.length}] 출처 원문 ↗</a></div>
      <div className="preview-caption"><span>예제의 5개 객체로 구성한 미리보기</span><Link href="/docs/guide/example">전체 사례 읽기 <ArrowUpRight size={13} /></Link></div>
    </div>, language
  );
}
