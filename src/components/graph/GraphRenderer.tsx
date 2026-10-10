import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import type { GraphDocument, GraphEdge, GraphEvent, GraphNode, GraphSelection } from '../../types/graph';
import { Icon } from '../Icon';
import './graph-renderer.css';

export interface GraphRendererProps {
  graph: GraphDocument;
  view: 'board' | 'lanes' | 'timeline';
  selection: GraphSelection;
  onSelect: (selection: GraphSelection) => void;
  showPath: boolean;
  query: string;
}

interface Point { x: number; y: number }
interface SceneLayout { width: number; height: number; positions: Map<string, Point> }
interface PlacedEvent { event: GraphEvent; x: number; y: number; endX?: number }
interface TimelineLayout {
  width: number;
  height: number;
  rows: { id: string; label: string; color: string; top: number; height: number }[];
  events: PlacedEvent[];
  ticks: { x: number; date: number }[];
  min: number;
  max: number;
}

const NODE_WIDTH = 182;
const NODE_HEIGHT = 74;
const MIN_ZOOM = 0.02;
const DAY = 86_400_000;
const dateLabel = (date: number | string) => new Date(date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** A stable layout is computed from the graph itself, without case-specific IDs. */
function boardLayout(graph: GraphDocument): SceneLayout {
  const columns = Math.max(3, Math.ceil(Math.sqrt(graph.nodes.length * 1.4)));
  const width = Math.max(940, columns * 240 + 80);
  const height = Math.max(580, Math.ceil(graph.nodes.length / columns) * 160 + 100);
  const degree = new Map<string, number>(graph.nodes.map(node => [node.id, 0]));
  graph.edges.forEach(edge => {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  });
  const ordered = [...graph.nodes].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.id.localeCompare(b.id));
  const positions = new Map<string, Point>();
  ordered.forEach((node, index) => {
    const angle = index * 2.399963229728653;
    const radius = Math.sqrt((index + 0.6) / Math.max(1, ordered.length));
    positions.set(node.id, { x: width / 2 + Math.cos(angle) * radius * (width / 2 - 120), y: height / 2 + Math.sin(angle) * radius * (height / 2 - 70) });
  });
  const edges = graph.edges.filter(edge => positions.has(edge.source) && positions.has(edge.target) && edge.source !== edge.target);
  for (let iteration = 0; iteration < 150; iteration++) {
    const forces = new Map(ordered.map(node => [node.id, { x: 0, y: 0 }]));
    for (let a = 0; a < ordered.length; a++) {
      const first = positions.get(ordered[a].id)!;
      for (let b = a + 1; b < ordered.length; b++) {
        const second = positions.get(ordered[b].id)!;
        const dx = first.x - second.x || 0.01;
        const dy = first.y - second.y || 0.01;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const push = Math.min(24, 11_000 / (distance * distance));
        const fx = dx / distance * push;
        const fy = dy / distance * push;
        forces.get(ordered[a].id)!.x += fx;
        forces.get(ordered[a].id)!.y += fy;
        forces.get(ordered[b].id)!.x -= fx;
        forces.get(ordered[b].id)!.y -= fy;
      }
    }
    edges.forEach(edge => {
      const a = positions.get(edge.source)!;
      const b = positions.get(edge.target)!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const pull = (distance - 255) * 0.012;
      forces.get(edge.source)!.x += dx / distance * pull;
      forces.get(edge.source)!.y += dy / distance * pull;
      forces.get(edge.target)!.x -= dx / distance * pull;
      forces.get(edge.target)!.y -= dy / distance * pull;
    });
    ordered.forEach(node => {
      const point = positions.get(node.id)!;
      const force = forces.get(node.id)!;
      point.x = clamp(point.x + clamp(force.x + (width / 2 - point.x) * 0.004, -16, 16), 115, width - 115);
      point.y = clamp(point.y + clamp(force.y + (height / 2 - point.y) * 0.004, -16, 16), 70, height - 70);
    });
    // Resolve rectangular card collisions as well as point repulsion.
    for (let a = 0; a < ordered.length; a++) {
      const first = positions.get(ordered[a].id)!;
      for (let b = a + 1; b < ordered.length; b++) {
        const second = positions.get(ordered[b].id)!;
        const overlapX = NODE_WIDTH + 28 - Math.abs(first.x - second.x);
        const overlapY = NODE_HEIGHT + 28 - Math.abs(first.y - second.y);
        if (overlapX <= 0 || overlapY <= 0) continue;
        if (overlapX < overlapY) {
          const delta = overlapX * 0.51 * (first.x >= second.x ? 1 : -1);
          first.x = clamp(first.x + delta, 115, width - 115);
          second.x = clamp(second.x - delta, 115, width - 115);
        } else {
          const delta = overlapY * 0.51 * (first.y >= second.y ? 1 : -1);
          first.y = clamp(first.y + delta, 70, height - 70);
          second.y = clamp(second.y - delta, 70, height - 70);
        }
      }
    }
  }
  return { width, height, positions };
}

function lanesLayout(graph: GraphDocument): SceneLayout {
  const columns = graph.groups.map(group => graph.nodes.filter(node => node.group === group.id));
  const width = Math.max(900, graph.groups.length * 254 + 40);
  const height = Math.max(580, Math.max(0, ...columns.map(nodes => nodes.length)) * 124 + 150);
  const laneWidth = (width - 40) / Math.max(1, graph.groups.length);
  const positions = new Map<string, Point>();
  columns.forEach((nodes, column) => nodes.forEach((node, row) => positions.set(node.id, { x: 20 + laneWidth * (column + 0.5), y: 140 + row * 124 })));
  return { width, height, positions };
}

function timelineLayout(graph: GraphDocument): TimelineLayout {
  const valid = graph.events.filter(event => Number.isFinite(Date.parse(event.date))).sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.id.localeCompare(b.id));
  const dates = valid.flatMap(event => [Date.parse(event.date), Date.parse(event.endDate || event.date)]).filter(Number.isFinite);
  const min = dates.length ? Math.min(...dates) : 0;
  const max = dates.length ? Math.max(...dates) : 0;
  const span = Math.max(DAY, max - min);
  const width = Math.max(1100, Math.min(6000, valid.length * 125 + 500));
  const xAt = (date: number) => 240 + (date - min) / span * (width - 490);
  const grouped = new Map<string, GraphEvent[]>();
  valid.forEach(event => {
    const rowId = event.nodeIds.find(id => graph.nodes.some(node => node.id === id)) ?? '__graph_events';
    grouped.set(rowId, [...(grouped.get(rowId) ?? []), event]);
  });
  const rows: TimelineLayout['rows'] = [];
  const events: PlacedEvent[] = [];
  let top = 96;
  grouped.forEach((rowEvents, id) => {
    const node = graph.nodes.find(item => item.id === id);
    const group = graph.groups.find(item => item.id === node?.group);
    const trackEnds: number[] = [];
    rowEvents.forEach(event => {
      const x = xAt(Date.parse(event.date));
      let track = trackEnds.findIndex(end => end + 20 < x);
      if (track < 0) track = trackEnds.length;
      const endX = event.endDate ? xAt(Date.parse(event.endDate)) : undefined;
      trackEnds[track] = Math.max(x + 194, endX ?? x);
      events.push({ event, x, y: top + 24 + track * 92, endX });
    });
    const height = Math.max(110, trackEnds.length * 92 + 34);
    rows.push({ id, label: node?.label ?? 'Graph events', color: group?.color ?? '#7a6f5c', top, height });
    top += height;
  });
  const tickCount = max === min ? 1 : Math.min(7, Math.max(2, Math.ceil((max - min) / DAY) + 1));
  const ticks = Array.from({ length: tickCount }, (_, index) => {
    const date = min + (max - min) * index / Math.max(1, tickCount - 1);
    return { x: xAt(date), date };
  });
  return { width, height: Math.max(580, top + 30), rows, events, ticks, min, max };
}

function edgeGeometry(edge: GraphEdge, layout: SceneLayout, lanes: boolean, ordinal: number) {
  const source = layout.positions.get(edge.source);
  const target = layout.positions.get(edge.target);
  if (!source || !target) return null;
  if (edge.source === edge.target) return { path: `M ${source.x - 34} ${source.y - 37} C ${source.x - 65} ${source.y - 105}, ${source.x + 65} ${source.y - 105}, ${source.x + 34} ${source.y - 37}`, label: { x: source.x, y: source.y - 83 } };
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const factor = Math.min((NODE_WIDTH / 2 + 3) / Math.max(1, Math.abs(dx)), (NODE_HEIGHT / 2 + 3) / Math.max(1, Math.abs(dy)));
  const ax = source.x + dx * factor;
  const ay = source.y + dy * factor;
  const bx = target.x - dx * factor;
  const by = target.y - dy * factor;
  if (lanes && Math.abs(dx) < 1) {
    const side = ordinal % 2 ? -1 : 1;
    const controlX = source.x + side * 125;
    return { path: `M ${source.x + side * NODE_WIDTH / 2} ${source.y} C ${controlX} ${source.y}, ${controlX} ${target.y}, ${target.x + side * NODE_WIDTH / 2} ${target.y}`, label: { x: controlX, y: (source.y + target.y) / 2 } };
  }
  const bend = ordinal % 3 === 0 ? 16 : -16;
  const length = Math.max(1, Math.hypot(dx, dy));
  const cx = (ax + bx) / 2 - dy / length * bend;
  const cy = (ay + by) / 2 + dx / length * bend;
  return { path: `M ${ax} ${ay} Q ${cx} ${cy}, ${bx} ${by}`, label: { x: (ax + 2 * cx + bx) / 4, y: (ay + 2 * cy + by) / 4 } };
}

function activateEdge(event: KeyboardEvent<SVGGElement>, callback: () => void) {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); callback(); }
}

function nodeText(node: GraphNode) { return `${node.label} ${node.type} ${node.description} ${Object.values(node.properties).join(' ')}`.toLocaleLowerCase(); }

export default function GraphRenderer({ graph, view, selection, onSelect, showPath, query }: GraphRendererProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [viewport, setViewport] = useState({ width: 900, height: 580 });
  const markerId = useId().replace(/:/g, '');
  const scene = useMemo(() => view === 'lanes' ? lanesLayout(graph) : boardLayout(graph), [graph, view]);
  const timeline = useMemo(() => timelineLayout(graph), [graph]);
  const dimensions = view === 'timeline' ? timeline : scene;
  const groups = useMemo(() => new Map(graph.groups.map(group => [group.id, group])), [graph.groups]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchingNodes = useMemo(() => {
    const matches = new Set(graph.nodes.filter(node => nodeText(node).includes(normalizedQuery)).map(node => node.id));
    if (normalizedQuery) {
      graph.edges.filter(edge => `${edge.label} ${edge.description}`.toLocaleLowerCase().includes(normalizedQuery)).forEach(edge => { matches.add(edge.source); matches.add(edge.target); });
      graph.events.filter(event => `${event.label} ${event.description} ${event.date}`.toLocaleLowerCase().includes(normalizedQuery)).forEach(event => event.nodeIds.forEach(id => matches.add(id)));
    }
    return matches;
  }, [graph, normalizedQuery]);
  const eventMatches = (event: GraphEvent) => !normalizedQuery || `${event.label} ${event.description} ${event.date}`.toLocaleLowerCase().includes(normalizedQuery) || event.nodeIds.some(id => matchingNodes.has(id));
  const selectedNodeIds = useMemo(() => {
    if (selection?.kind === 'node') return new Set([selection.id]);
    if (selection?.kind === 'edge') { const edge = graph.edges.find(item => item.id === selection.id); return new Set(edge ? [edge.source, edge.target] : []); }
    if (selection?.kind === 'event') return new Set(graph.events.find(item => item.id === selection.id)?.nodeIds ?? []);
    return new Set<string>();
  }, [graph, selection]);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    setViewport({ width: element.clientWidth, height: element.clientHeight });
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setViewport({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    setZoom(clamp((element.clientWidth - 32) / dimensions.width, 0.65, 1));
    element.scrollTo({ top: 0, left: 0 });
  }, [graph, view, dimensions.width]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const element = viewportRef.current;
      if (!element || !selection) return;
      const selectedEvent = selection.kind === 'event' ? selection.id : graph.events.find(event => event.nodeIds.some(id => selectedNodeIds.has(id)))?.id;
      const target = Array.from(element.querySelectorAll<HTMLElement>('[data-graph-node], [data-graph-event]')).find(item => view === 'timeline'
        ? item.dataset.graphEvent === selectedEvent
        : selectedNodeIds.has(item.dataset.graphNode ?? ''));
      if (!target) return;
      const bounds = element.getBoundingClientRect();
      const card = target.getBoundingClientRect();
      const outsideX = card.left < bounds.left + 20 || card.right > bounds.right - 20;
      const outsideY = card.top < bounds.top + 20 || card.bottom > bounds.bottom - 20;
      if (outsideX || outsideY) element.scrollBy({
        left: outsideX ? card.left + card.width / 2 - bounds.left - bounds.width / 2 : 0,
        top: outsideY ? card.top + card.height / 2 - bounds.top - bounds.height / 2 : 0,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [graph, view, selection, selectedNodeIds]);

  function changeZoom(value: number) {
    const element = viewportRef.current;
    const next = clamp(value, MIN_ZOOM, 1.8);
    if (element) {
      const x = (element.scrollLeft + element.clientWidth / 2) / zoom;
      const y = (element.scrollTop + element.clientHeight / 2) / zoom;
      setZoom(next);
      requestAnimationFrame(() => element.scrollTo({ left: Math.max(0, x * next - element.clientWidth / 2), top: Math.max(0, y * next - element.clientHeight / 2) }));
    } else setZoom(next);
  }

  function fit() {
    setZoom(clamp(Math.min((viewport.width - 28) / dimensions.width, (viewport.height - 28) / dimensions.height), MIN_ZOOM, 1));
    viewportRef.current?.scrollTo({ top: 0, left: 0 });
  }

  const extentWidth = Math.max(viewport.width, dimensions.width * zoom);
  const extentHeight = Math.max(viewport.height, dimensions.height * zoom);
  const sceneStyle: CSSProperties = { width: dimensions.width, height: dimensions.height, transform: `scale(${zoom})`, left: Math.max(0, (extentWidth - dimensions.width * zoom) / 2), top: Math.max(0, (extentHeight - dimensions.height * zoom) / 2) };
  const displayedGroups = graph.groups.filter(group => graph.nodes.some(node => node.group === group.id));
  const hasInferred = graph.edges.some(edge => edge.status === 'inferred');
  const hasHighlight = graph.edges.some(edge => edge.highlighted);
  const noTimeline = view === 'timeline' && !timeline.events.length;

  return (
    <section className={`cg-root cg-root--${view}`} aria-label={`${graph.title}: ${view} view`}>
      <div className="cg-toolbar">
        <div className="cg-status" role="status" aria-live="polite">
          <span className="cg-status-dot" />
          {view === 'timeline' ? `${graph.events.length} dated events` : `${graph.nodes.length} entities · ${graph.edges.length} relations`}
          {normalizedQuery && <span className="cg-match-count">{view === 'timeline' ? graph.events.filter(eventMatches).length : matchingNodes.size} matches</span>}
        </div>
        <div className="cg-zoom" role="group" aria-label="Graph zoom controls">
          <button type="button" onClick={() => changeZoom(zoom - 0.15)} disabled={zoom <= MIN_ZOOM} aria-label="Zoom out">−</button>
          <output aria-label="Zoom level">{Math.round(zoom * 100)}%</output>
          <button type="button" onClick={() => changeZoom(zoom + 0.15)} disabled={zoom >= 1.8} aria-label="Zoom in">+</button>
          <button type="button" className="cg-fit" onClick={fit} aria-label="Fit graph to view"><Icon name="fit" size={15} /><span>Fit</span></button>
        </div>
      </div>
      <div className="cg-viewport" ref={viewportRef} tabIndex={0} role="region" aria-label="Graph canvas. Scroll or use the arrow keys to pan." data-canvas-scroll>
        {noTimeline ? <div className="cg-empty"><span>NO DATED EVENTS</span><h3>This graph has no timeline yet.</h3><p>Add events with dates to the graph document to view them here.</p></div> : <div className="cg-extent" style={{ width: extentWidth, height: extentHeight }}>
          <div className="cg-scene" style={sceneStyle}>
            {view === 'timeline' ? <>
              <div className="cg-timeline-heading">EVENTS FROM SOURCES<span>{dateLabel(timeline.min)}{timeline.min !== timeline.max ? ` — ${dateLabel(timeline.max)}` : ''}</span></div>
              {timeline.rows.map((row, index) => <Fragment key={row.id}>
                <div className={`cg-time-row${index % 2 ? ' cg-time-row--alternate' : ''}`} style={{ top: row.top, height: row.height }} />
                <div className="cg-time-row-name" style={{ top: row.top + 30 }}><i style={{ background: row.color }} /><span title={row.label}>{row.label}</span></div>
              </Fragment>)}
              {timeline.ticks.map((tick, index) => <Fragment key={index}><div className="cg-time-grid" style={{ left: tick.x, height: timeline.height - 90 }} /><span className="cg-time-tick" style={{ left: tick.x }}>{dateLabel(tick.date)}</span></Fragment>)}
              {timeline.events.map(({ event, x, y, endX }) => {
                const selected = selection?.kind === 'event' && selection.id === event.id;
                const node = graph.nodes.find(item => item.id === event.nodeIds[0]);
                const color = groups.get(node?.group ?? '')?.color ?? '#7a6f5c';
                const matches = eventMatches(event);
                return <Fragment key={event.id}>
                  {endX !== undefined && endX > x && <div className={`cg-duration${matches ? '' : ' is-muted'}`} style={{ left: x, top: y + 12, width: endX - x, background: color }} title={`${dateLabel(event.date)} — ${dateLabel(event.endDate!)}`} />}
                  <button type="button" data-graph-event={event.id} className={`cg-event${selected ? ' is-selected' : ''}${matches ? '' : ' is-muted'}`} style={{ left: x, top: y, '--cg-color': color } as CSSProperties} onClick={() => onSelect({ kind: 'event', id: event.id })} aria-pressed={selected} aria-label={`${event.label}, ${dateLabel(event.date)}`} tabIndex={matches ? 0 : -1}>
                    <i className="cg-event-marker" /><span className="cg-event-date">{dateLabel(event.date)}{event.endDate ? ` → ${dateLabel(event.endDate)}` : ''}</span><strong>{event.label}</strong><span className="cg-event-sources">{event.sourceIds.length} {event.sourceIds.length === 1 ? 'source' : 'sources'}</span>
                  </button>
                </Fragment>;
              })}
            </> : <>
              {view === 'lanes' && graph.groups.map((group, index) => {
                const laneWidth = (scene.width - 40) / Math.max(1, graph.groups.length);
                return <div className={`cg-lane${index % 2 ? ' cg-lane--alternate' : ''}`} key={group.id} style={{ left: 20 + index * laneWidth, width: laneWidth }}><div className="cg-lane-title"><i style={{ background: group.color }} /><strong>{group.label}</strong><span>{graph.nodes.filter(node => node.group === group.id).length}</span></div></div>;
              })}
              <svg className="cg-connections" width={scene.width} height={scene.height} viewBox={`0 0 ${scene.width} ${scene.height}`} fill="none" aria-label="Graph relations">
                <defs><marker id={markerId} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0 0 L6 3 L0 6" fill="none" stroke="context-stroke" strokeWidth="1" /></marker></defs>
                {graph.edges.map((edge, index) => {
                  const geometry = edgeGeometry(edge, scene, view === 'lanes', index);
                  if (!geometry) return null;
                  const selected = selection?.kind === 'edge' && selection.id === edge.id;
                  const connected = selectedNodeIds.has(edge.source) || selectedNodeIds.has(edge.target);
                  const matches = !normalizedQuery || matchingNodes.has(edge.source) && matchingNodes.has(edge.target);
                  const highlighted = showPath && edge.highlighted;
                  return <g key={edge.id} className={`cg-edge${edge.status === 'inferred' ? ' cg-edge--inferred' : ''}${highlighted ? ' cg-edge--highlighted' : ''}${connected ? ' cg-edge--connected' : ''}${selected ? ' is-selected' : ''}${matches ? '' : ' is-muted'}`} tabIndex={matches ? 0 : -1} role="button" aria-pressed={selected} aria-label={`Relation: ${edge.label}, ${graph.nodes.find(node => node.id === edge.source)?.label} to ${graph.nodes.find(node => node.id === edge.target)?.label}`} onClick={() => onSelect({ kind: 'edge', id: edge.id })} onKeyDown={event => activateEdge(event, () => onSelect({ kind: 'edge', id: edge.id }))}>
                    <title>{edge.label} · {edge.status}</title><path className="cg-edge-hit" d={geometry.path} /><path className="cg-edge-line" d={geometry.path} markerEnd={`url(#${markerId})`} />
                    {(graph.edges.length <= 65 || selected || highlighted) && <foreignObject x={geometry.label.x - 77} y={geometry.label.y - 10} width="154" height="22"><div className="cg-edge-label" title={edge.label}>{edge.label}</div></foreignObject>}
                  </g>;
                })}
              </svg>
              {graph.nodes.map(node => {
                const point = scene.positions.get(node.id);
                if (!point) return null;
                const selected = selection?.kind === 'node' && selection.id === node.id;
                const related = !selected && selectedNodeIds.has(node.id);
                const matches = !normalizedQuery || matchingNodes.has(node.id);
                const group = groups.get(node.group);
                return <button type="button" data-graph-node={node.id} className={`cg-node${selected ? ' is-selected' : ''}${related ? ' is-related' : ''}${matches ? '' : ' is-muted'}`} key={node.id} style={{ left: point.x, top: point.y, '--cg-color': group?.color ?? '#7a6f5c' } as CSSProperties} onClick={() => onSelect({ kind: 'node', id: node.id })} aria-pressed={selected} aria-label={`${node.type}: ${node.label}`} title={node.description || node.label} tabIndex={matches ? 0 : -1}>
                  <span className="cg-node-type"><i />{node.type}</span><strong>{node.label}</strong><span className="cg-node-meta">{node.sourceIds.length} {node.sourceIds.length === 1 ? 'source' : 'sources'}<span>{group?.label}</span></span>
                </button>;
              })}
            </>}
          </div>
        </div>}
      </div>
      <div className="cg-footer"><div className="cg-legend" aria-label="Graph legend">{displayedGroups.map(group => <span key={group.id}><i style={{ background: group.color }} />{group.label}</span>)}{view !== 'timeline' && <span><i className="cg-line-swatch" />Reported</span>}{view !== 'timeline' && hasInferred && <span><i className="cg-line-swatch cg-line-swatch--inferred" />Inferred</span>}{view !== 'timeline' && hasHighlight && <span><i className="cg-line-swatch cg-line-swatch--highlight" />Evidence path</span>}</div><span className="cg-pan-hint">Scroll to pan · Select to inspect</span></div>
    </section>
  );
}
