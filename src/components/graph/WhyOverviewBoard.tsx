import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { buildWhyOverview } from '../../lib/why-overview';
import type { WhyOverviewEdge, WhyOverviewModel, WhyOverviewNode, WhyOverviewStatus } from '../../lib/why-overview';
import type { EvidenceVerdict, LogicOperator, WhyRun } from '../../types/why-not';
import { Icon } from '../Icon';
import './why-overview-board.css';

interface Props {
  run: WhyRun;
  query?: string;
  onRecord?: (number: number) => void;
  onReview?: () => void;
  onInspectChange?: (open: boolean) => void;
}

interface PlacedNode { node: WhyOverviewNode; x: number; y: number; width: number; height: number }
interface Layout { nodes: PlacedNode[]; width: number; height: number }
interface Camera { x: number; y: number; scale: number }
type Selection = { kind: 'node' | 'edge'; id: string } | null;

const statusLabels: Record<WhyOverviewStatus, string> = {
  supported: '자료 지지', refuted: '반증 자료', insufficient: '근거 불충분', unreviewed: '미검토', pending: '검토 중', gap: '추가 확인 필요',
};
const verdictLabels: Record<EvidenceVerdict, string> = { SUPPORTED: '지지', REFUTED: '반증', INSUFFICIENT: '불충분', IRRELEVANT: '무관', UNREVIEWED: '미검토' };
const operatorLabels: Record<LogicOperator, string> = { AND: '모든 조건이 필요합니다.', OR: '하나 이상의 경로가 필요합니다.', NOT_SUPPORT: '부정 주장을 입증하는 근거를 모두 확인합니다.' };
const kindLabels = { conclusion: 'CONCLUSION', claim: 'CLAIM', requirement: 'CHECK', evidence: 'EVIDENCE' };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** A spatial board: the conclusion stays in the centre, while shared material
 * keeps one position. The layout never invents or flattens a logical connection. */
function placeBoard(model: WhyOverviewModel): Layout {
  const logical = model.nodes.filter(node => node.kind !== 'conclusion' && node.kind !== 'evidence');
  const materials = model.nodes.filter(node => node.kind === 'evidence');
  const radiusX = 335 + Math.max(0, logical.length - 5) * 23;
  const radiusY = 235 + Math.max(0, logical.length - 4) * 32;
  const nodes: PlacedNode[] = model.nodes.filter(node => node.kind === 'conclusion').map(node => ({ node, x: 0, y: 0, width: 352, height: 224 }));
  logical.forEach((node, index) => {
    const angle = logical.length === 1 ? 0 : (index / logical.length) * Math.PI * 2;
    nodes.push({ node, x: Math.cos(angle) * radiusX, y: Math.sin(angle) * radiusY, width: 246, height: 148 });
  });
  const byId = new Map(nodes.map(node => [node.node.id, node]));
  const materialGroups = new Map<string, string[]>();
  for (const material of materials) {
    const targets = model.edges.filter(edge => edge.source === material.id).map(edge => edge.target).sort();
    const group = targets[0] ?? model.rootId;
    materialGroups.set(group, [...(materialGroups.get(group) ?? []), material.id]);
  }
  materials.forEach((node, index) => {
    const targets = model.edges.filter(edge => edge.source === node.id).map(edge => edge.target).sort();
    const target = byId.get(targets[0] ?? model.rootId);
    const group = materialGroups.get(targets[0] ?? model.rootId) ?? [node.id];
    const offset = (group.indexOf(node.id) - (group.length - 1) / 2) * .32;
    const connected = [...new Set(targets)].flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
    const centre = connected.reduce((point, item) => ({ x: point.x + item.x / connected.length, y: point.y + item.y / connected.length }), { x: 0, y: 0 });
    const angle = connected.length > 1
      ? (Math.hypot(centre.x, centre.y) < 40 ? -Math.PI / 2 : Math.atan2(centre.y / radiusY, centre.x / radiusX)) + offset
      : target && target.node.kind !== 'conclusion' ? Math.atan2(target.y / radiusY, target.x / radiusX) + offset : (index / Math.max(1, materials.length)) * Math.PI * 2;
    nodes.push({ node, x: Math.cos(angle) * (logical.length ? radiusX + 270 : 380), y: Math.sin(angle) * (logical.length ? radiusY + 165 : 250), width: 224, height: 92 });
  });
  // Separate document clusters and long claim cards without moving the hero.
  const anchors = nodes.map(node => ({ x: node.x, y: node.y }));
  for (let iteration = 0; iteration < 110; iteration++) {
    let overlaps = 0;
    for (let left = 0; left < nodes.length; left++) for (let right = left + 1; right < nodes.length; right++) {
      const a = nodes[left]; const b = nodes[right];
      const dx = b.x - a.x; const dy = b.y - a.y;
      const overlapX = (a.width + b.width) / 2 + 46 - Math.abs(dx);
      const overlapY = (a.height + b.height) / 2 + 40 - Math.abs(dy);
      if (overlapX <= 0 || overlapY <= 0) continue;
      overlaps++;
      const af = a.node.kind === 'conclusion' ? 0 : b.node.kind === 'conclusion' ? 1 : .5;
      const bf = b.node.kind === 'conclusion' ? 0 : a.node.kind === 'conclusion' ? 1 : .5;
      if (overlapX < overlapY) { const push = overlapX * (dx < 0 ? -1 : 1); a.x -= push * af; b.x += push * bf; }
      else { const push = overlapY * (dy < 0 ? -1 : 1); a.y -= push * af; b.y += push * bf; }
    }
    if (!overlaps) break;
    if (iteration < 65) nodes.forEach((node, index) => { if (node.node.kind !== 'conclusion') { node.x += (anchors[index].x - node.x) * .018; node.y += (anchors[index].y - node.y) * .018; } });
  }
  const minX = Math.min(0, ...nodes.map(node => node.x - node.width / 2)) - 70;
  const minY = Math.min(0, ...nodes.map(node => node.y - node.height / 2)) - 90;
  const maxX = Math.max(0, ...nodes.map(node => node.x + node.width / 2)) + 70;
  const maxY = Math.max(0, ...nodes.map(node => node.y + node.height / 2)) + 90;
  nodes.forEach(node => { node.x -= minX; node.y -= minY; });
  return { nodes, width: maxX - minX, height: maxY - minY };
}

type Point = { x: number; y: number };

function routeAroundConclusion(start: Point, end: Point, conclusion: PlacedNode): Point[] | null {
  const box = { left: conclusion.x - conclusion.width / 2 - 17, right: conclusion.x + conclusion.width / 2 + 17, top: conclusion.y - conclusion.height / 2 - 17, bottom: conclusion.y + conclusion.height / 2 + 17 };
  function crosses(a: Point, b: Point) {
    let from = 0; let to = 1;
    for (const [position, delta, min, max] of [[a.x, b.x - a.x, box.left, box.right], [a.y, b.y - a.y, box.top, box.bottom]]) {
      if (Math.abs(delta) < .01) { if (position <= min || position >= max) return false; continue; }
      const entry = (min - position) / delta; const exit = (max - position) / delta;
      from = Math.max(from, Math.min(entry, exit)); to = Math.min(to, Math.max(entry, exit));
      if (from >= to) return false;
    }
    return from < to;
  }
  if (!crosses(start, end)) return null;
  const points = [start, end, { x: box.left - 22, y: box.top - 22 }, { x: box.right + 22, y: box.top - 22 }, { x: box.right + 22, y: box.bottom + 22 }, { x: box.left - 22, y: box.bottom + 22 }];
  const distance = points.map((_, index) => index === 0 ? 0 : Infinity);
  const previous = points.map(() => -1); const seen = new Set<number>();
  for (let step = 0; step < points.length; step++) {
    let current = -1;
    for (let index = 0; index < points.length; index++) if (!seen.has(index) && (current < 0 || distance[index] < distance[current])) current = index;
    if (current < 0 || !Number.isFinite(distance[current]) || current === 1) break;
    seen.add(current);
    for (let next = 0; next < points.length; next++) {
      if (seen.has(next) || crosses(points[current], points[next])) continue;
      const value = distance[current] + Math.hypot(points[next].x - points[current].x, points[next].y - points[current].y);
      if (value < distance[next]) { distance[next] = value; previous[next] = current; }
    }
  }
  if (!Number.isFinite(distance[1])) return null;
  const route = [end]; let index = previous[1];
  while (index >= 0) { route.unshift(points[index]); index = previous[index]; }
  return route;
}

function roundedPath(points: Point[]) {
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length - 1; index++) {
    const before = points[index - 1]; const point = points[index]; const after = points[index + 1];
    const inLength = Math.hypot(point.x - before.x, point.y - before.y); const outLength = Math.hypot(after.x - point.x, after.y - point.y);
    const radius = Math.min(20, inLength / 3, outLength / 3);
    path += ` L ${point.x - (point.x - before.x) / inLength * radius} ${point.y - (point.y - before.y) / inLength * radius} Q ${point.x} ${point.y} ${point.x + (after.x - point.x) / outLength * radius} ${point.y + (after.y - point.y) / outLength * radius}`;
  }
  const last = points[points.length - 1]; return `${path} L ${last.x} ${last.y}`;
}

function edgePath(source: PlacedNode, target: PlacedNode, conclusion?: PlacedNode) {
  const dx = target.x - source.x; const dy = target.y - source.y;
  if (!dx && !dy) return '';
  const fromFactor = Math.min(source.width / 2 / Math.max(.01, Math.abs(dx)), source.height / 2 / Math.max(.01, Math.abs(dy)));
  const toFactor = Math.min(target.width / 2 / Math.max(.01, Math.abs(dx)), target.height / 2 / Math.max(.01, Math.abs(dy)));
  const start = { x: source.x + dx * fromFactor, y: source.y + dy * fromFactor };
  const end = { x: target.x - dx * toFactor, y: target.y - dy * toFactor };
  if (conclusion && source !== conclusion && target !== conclusion) {
    const route = routeAroundConclusion(start, end, conclusion);
    if (route) return roundedPath(route);
  }
  const horizontal = Math.abs(dx) > Math.abs(dy);
  const bend = clamp(Math.hypot(end.x - start.x, end.y - start.y) * .4, 35, 150);
  const xBend = horizontal ? Math.sign(dx) * bend : 0;
  const yBend = horizontal ? 0 : Math.sign(dy) * bend;
  return `M ${start.x} ${start.y} C ${start.x + xBend} ${start.y + yBend}, ${end.x - xBend} ${end.y - yBend}, ${end.x} ${end.y}`;
}

function DocumentMark() {
  return <svg width="16" height="18" viewBox="0 0 18 20" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 1.5h6l4 4V18H4zM10 1.5V6h4M6.5 10h5M6.5 13h4" /></svg>;
}

function sourceUrl(value?: string | null) {
  if (!value) return null;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null; } catch { return null; }
}

export default function WhyOverviewBoard({ run, query = '', onRecord, onReview, onInspectChange }: Props) {
  const [expanded, setExpanded] = useState(false);
  const model = useMemo(() => run.snapshot ? buildWhyOverview(run.snapshot, run.result, { query, maxNodes: expanded ? Infinity : 18 }) : null, [run.snapshot, run.result, query, expanded]);
  const layout = useMemo(() => model ? placeBoard(model) : { nodes: [], width: 1, height: 1 }, [model]);
  const positions = useMemo(() => new Map(layout.nodes.map(node => [node.node.id, node])), [layout]);
  const viewport = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 900, height: 650 });
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 });
  const cameraRef = useRef(camera); cameraRef.current = camera;
  const [selection, setSelection] = useState<Selection>(null);
  const trigger = useRef<HTMLElement | SVGElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; camera: Camera; moved: boolean; item: boolean } | null>(null);
  const suppressClickUntil = useRef(0);
  const [dragging, setDragging] = useState(false);
  const markerId = useId().replace(/:/g, '');
  const selectedNode = selection?.kind === 'node' ? model?.nodes.find(node => node.id === selection.id) : undefined;
  const selectedEdge = selection?.kind === 'edge' ? model?.edges.find(edge => edge.id === selection.id) : undefined;
  const nodeDetail = run.snapshot?.nodes.find(node => node.id === selectedNode?.originalNodeId);
  const evidenceDetail = run.snapshot?.evidence.find(evidence => evidence.id === selectedNode?.evidenceId);
  const relatedBindings = run.snapshot?.bindings.filter(binding => evidenceDetail ? binding.evidenceId === evidenceDetail.id && model?.edges.some(edge => edge.bindingId === binding.id) : selectedEdge?.bindingId === binding.id) ?? [];
  const gapIds = selectedNode?.gapIds ?? selectedEdge?.gapIds ?? [];
  const selectedGaps = run.result?.gaps.filter(gap => gapIds.includes(gap.id)) ?? [];
  const externalUrl = sourceUrl(evidenceDetail?.url);

  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const update = () => setSize({ width: element.clientWidth || 900, height: element.clientHeight || 650 });
    update(); const observer = new ResizeObserver(update); observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => { setExpanded(false); setSelection(null); }, [run.id, query]);
  useEffect(() => {
    if (selection && !(selection.kind === 'node' ? model?.nodes : model?.edges)?.some(item => item.id === selection.id)) setSelection(null);
  }, [model, selection]);
  useEffect(() => {
    const fitScale = clamp(Math.min((size.width - 48) / layout.width, (size.height - 74) / layout.height), .18, 1);
    const mobile = size.width < 600;
    const scale = mobile ? Math.max(.78, fitScale) : fitScale;
    const root = layout.nodes.find(node => node.node.kind === 'conclusion');
    setCamera({ scale, x: size.width / 2 - (mobile ? root?.x ?? layout.width / 2 : layout.width / 2) * scale, y: size.height / 2 + 20 - (mobile ? root?.y ?? layout.height / 2 : layout.height / 2) * scale });
  }, [layout, size]);
  useEffect(() => { onInspectChange?.(Boolean(selection)); }, [selection, onInspectChange]);
  useEffect(() => () => onInspectChange?.(false), [onInspectChange]);
  useEffect(() => {
    if (!selection) return;
    closeButton.current?.focus({ preventScroll: true });
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopImmediatePropagation(); setSelection(null); trigger.current?.focus({ preventScroll: true });
    };
    window.addEventListener('keydown', keydown, true); return () => window.removeEventListener('keydown', keydown, true);
  }, [selection]);
  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const wheel = (event: WheelEvent) => {
      if ((event.target as Element).closest('.wob-inspector, .wob-toolbar, .wob-caption')) return;
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const rect = element.getBoundingClientRect();
        const at = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        setCamera(old => { const scale = clamp(old.scale * Math.exp(-event.deltaY * .003), .18, 1.8); const factor = scale / old.scale; return { scale, x: at.x - (at.x - old.x) * factor, y: at.y - (at.y - old.y) * factor }; });
      } else setCamera(old => ({ ...old, x: old.x - event.deltaX, y: old.y - event.deltaY }));
    };
    element.addEventListener('wheel', wheel, { passive: false }); return () => element.removeEventListener('wheel', wheel);
  }, []);

  function closeDetail() { setSelection(null); trigger.current?.focus({ preventScroll: true }); }
  function select(value: Selection) { trigger.current = document.activeElement instanceof HTMLElement || document.activeElement instanceof SVGElement ? document.activeElement : null; setSelection(value); }
  function fit() {
    const scale = clamp(Math.min((size.width - 38) / layout.width, (size.height - 80) / layout.height), .18, 1);
    setCamera({ scale, x: (size.width - layout.width * scale) / 2, y: (size.height - layout.height * scale) / 2 + 22 });
  }
  function zoom(factor: number) {
    setCamera(old => { const scale = clamp(old.scale * factor, .18, 1.8); const ratio = scale / old.scale; return { scale, x: size.width / 2 - (size.width / 2 - old.x) * ratio, y: size.height / 2 - (size.height / 2 - old.y) * ratio }; });
  }
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    suppressClickUntil.current = 0;
    if (event.button !== 0 || (event.target as Element).closest('.wob-toolbar, .wob-caption, .wob-inspector, a')) return;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, camera: cameraRef.current, moved: false, item: Boolean((event.target as Element).closest('.wob-node, [data-why-edge]')) };
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const state = drag.current; if (!state || state.id !== event.pointerId) return;
    const dx = event.clientX - state.x; const dy = event.clientY - state.y;
    if (Math.hypot(dx, dy) > 4) { state.moved = true; setDragging(true); event.currentTarget.setPointerCapture(event.pointerId); }
    if (state.moved) setCamera({ ...state.camera, x: state.camera.x + dx, y: state.camera.y + dy });
  }
  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current || drag.current.id !== event.pointerId) return;
    if (drag.current.moved) suppressClickUntil.current = performance.now() + 150;
    else if (!drag.current.item && event.type !== 'pointercancel') setSelection(null);
    drag.current = null; setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function canvasKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.2); }
    else if (event.key === '-') { event.preventDefault(); zoom(1 / 1.2); }
    else if (event.key === '0') { event.preventDefault(); fit(); }
    else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault(); setCamera(old => ({ ...old, x: old.x + (event.key === 'ArrowLeft' ? 60 : event.key === 'ArrowRight' ? -60 : 0), y: old.y + (event.key === 'ArrowUp' ? 60 : event.key === 'ArrowDown' ? -60 : 0) }));
    }
  }
  function edgeLabel(edge: WhyOverviewEdge) { return `연결 보기: ${positions.get(edge.source)?.node.title ?? ''} → ${positions.get(edge.target)?.node.title ?? ''}`; }

  return <section className="why-overview-board" aria-label="결론과 근거 그래프">
    <div ref={viewport} className={`wob-viewport${dragging ? ' is-dragging' : ''}`} tabIndex={0} aria-label="그래프 이동 영역" onKeyDown={canvasKey} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onClickCapture={event => { if (performance.now() < suppressClickUntil.current) { event.preventDefault(); event.stopPropagation(); suppressClickUntil.current = 0; } }}>
      <div className="wob-caption"><span className="wob-caption-label">CONCLUSION MAP</span>{model && <span className="wob-caption-meta">{model.nodes.filter(node => node.kind === 'evidence').length} sources · {model.edges.length} links{model.coverage.hiddenNodes > 0 && <button type="button" onClick={() => setExpanded(true)} aria-label="전체 연결 보기">Show all <span>+{model.coverage.hiddenNodes}</span></button>}{expanded && <button type="button" onClick={() => setExpanded(false)}>Less</button>}</span>}</div>
      <div className="wob-toolbar" aria-label="그래프 도구">
        {onReview && <button type="button" className="wob-review" onClick={() => { setSelection(null); onReview(); }}>Review <span aria-hidden="true">↗</span></button>}
        <div className="wob-zoom"><button type="button" aria-label="그래프 축소" onClick={() => zoom(1 / 1.2)}>−</button><button type="button" className="wob-fit" aria-label="그래프 화면에 맞추기" onClick={fit}><Icon name="fit" size={14} /><span>Fit</span></button><button type="button" aria-label="그래프 확대" onClick={() => zoom(1.2)}>+</button></div>
      </div>
      {!model?.nodes.length || !model.queryMatched ? <div className="wob-empty" role="status"><p>{query.trim() ? '검색어와 일치하는 주장이나 자료가 없습니다.' : '아직 연결할 수 있는 논리가 없습니다.'}</p>{onReview && <button type="button" onClick={onReview}>Open review <span aria-hidden="true">↗</span></button>}</div> : <div className="wob-world" style={{ width: layout.width, height: layout.height, transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})` }}>
        <svg className="wob-connections" width={layout.width} height={layout.height} aria-label="주장과 자료의 연결">
          <defs><marker id={`${markerId}-arrow`} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M1 1L5 3.5L1 6" fill="none" stroke="context-stroke" strokeWidth="1.2" /></marker></defs>
          {model.edges.map(edge => {
            const source = positions.get(edge.source); const target = positions.get(edge.target); if (!source || !target) return null;
            const path = edgePath(source, target, positions.get(model.rootId)); const active = selectedEdge?.id === edge.id || selectedNode && [edge.source, edge.target].includes(selectedNode.id);
            const gap = edge.gapIds.length > 0 || edge.kind === 'binding' && edge.verdict !== 'SUPPORTED';
            return <g className={`wob-edge${edge.kind === 'binding' ? ' is-binding' : ''}${gap ? ' has-gap' : ''}${active ? ' is-active' : ''}`} key={edge.id}>
              <path className="wob-edge-line" d={path} markerEnd={`url(#${markerId}-arrow)`} />
              <path className="wob-edge-hit" d={path} role="button" tabIndex={0} data-why-edge={edge.id} aria-label={edgeLabel(edge)} aria-pressed={selectedEdge?.id === edge.id} onClick={() => select({ kind: 'edge', id: edge.id })} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select({ kind: 'edge', id: edge.id }); } }} />
            </g>;
          })}
        </svg>
        {layout.nodes.map(({ node, x, y, width, height }) => {
          const isRoot = node.kind === 'conclusion'; const isEvidence = node.kind === 'evidence';
          const status = isRoot && node.status === 'supported' ? '기준 충족' : statusLabels[node.status];
          const url = isEvidence ? sourceUrl(run.snapshot?.evidence.find(evidence => evidence.id === node.evidenceId)?.url) : null;
          const connections = model.edges.filter(edge => edge.source === node.id).length;
          return <button type="button" key={node.id} data-why-node={node.id} className={`wob-node is-${node.kind} status-${node.status}${selectedNode?.id === node.id ? ' is-selected' : ''}${node.searchMatch ? ' is-match' : ''}`} style={{ left: x - width / 2, top: y - height / 2, width, height }} aria-label={`${isEvidence ? '자료' : '주장'} 보기: ${node.title}`} aria-pressed={selectedNode?.id === node.id} onClick={() => select({ kind: 'node', id: node.id })}>
            <span className="wob-node-top">{isEvidence ? <DocumentMark /> : <span className="wob-node-dot" aria-hidden="true" />}<span>{kindLabels[node.kind]}</span>{!isEvidence && node.operator && <span className="wob-operator">{node.operator === 'NOT_SUPPORT' ? 'NOT · AND' : node.operator}</span>}{isEvidence && connections > 1 && <span className="wob-shared">{connections} links</span>}</span>
            <strong>{node.title}</strong>
            <span className="wob-node-bottom">{isEvidence ? <span className="wob-source-host">{url?.hostname.replace(/^www\./, '') ?? (node.record != null ? `Record ${node.record}` : 'Source material')}</span> : <span className="wob-status"><i aria-hidden="true" />{status}</span>}{node.gapIds.length > 0 && <span className="wob-gap-count">{node.gapIds.length} gaps</span>}{isRoot && <span className="wob-node-open" aria-hidden="true">↗</span>}</span>
          </button>;
        })}
      </div>}
      {selection && (selectedNode || selectedEdge) && <aside className="wob-inspector" role="dialog" aria-modal="false" aria-label="연결된 자료와 논리" data-overview-detail>
        <div className="wob-inspector-heading"><span>{selectedEdge ? 'CONNECTION' : kindLabels[selectedNode!.kind]}</span><button ref={closeButton} type="button" aria-label="상세 닫기" onClick={closeDetail}><Icon name="close" size={17} /></button></div>
        <div className="wob-inspector-body">
          <h2>{selectedNode?.title ?? positions.get(selectedEdge!.target)?.node.title}</h2>
          {selectedEdge && <p className="wob-connection-from">{positions.get(selectedEdge.source)?.node.title}<span aria-hidden="true"> ↗</span></p>}
          {selectedNode && <p className={`wob-detail-status status-${selectedNode.status}`}>{selectedNode.kind === 'conclusion' && selectedNode.status === 'supported' ? '설정한 근거 기준을 충족했습니다.' : statusLabels[selectedNode.status]}</p>}
          {(nodeDetail?.inferenceRule || selectedEdge?.reason) && <p>{nodeDetail?.inferenceRule || selectedEdge?.reason}</p>}
          {(nodeDetail?.operator || selectedEdge?.operator) && <p className="wob-detail-note">{operatorLabels[(nodeDetail?.operator ?? selectedEdge?.operator)!]}</p>}
          {selectedNode?.kind === 'conclusion' && run.result && <div className="wob-confidence"><span>자료 지지 점수</span><strong>{run.result.confidence.supportScore != null ? `${Math.round(run.result.confidence.supportScore * 100)}%` : run.result.confidence.range ? `${Math.round(run.result.confidence.range[0] * 100)}–${Math.round(run.result.confidence.range[1] * 100)}%` : '평가 보류'}</strong><p>{run.result.confidence.reason}</p><small>자료와 설정한 기준에 따른 지지 수준이며, 진실 확률을 뜻하지 않습니다.</small></div>}
          {relatedBindings.map(binding => <div className="wob-binding-detail" key={binding.id}><div className="wob-detail-label"><span>{verdictLabels[binding.verdict]}</span>{evidenceDetail && <span>{run.snapshot?.nodes.find(node => node.id === binding.requirementId)?.statement}</span>}</div>{binding.quote && <blockquote>{binding.quote}</blockquote>}{binding.reason && <p>{binding.reason}</p>}{binding.missingRequirements.length > 0 && <p className="wob-detail-note">필요한 근거: {binding.missingRequirements.join(' · ')}</p>}</div>)}
          {evidenceDetail && !relatedBindings.length && <p>{evidenceDetail.text}</p>}
          {evidenceDetail?.sourceReason && <p className="wob-detail-note">{evidenceDetail.sourceReason}</p>}
          {nodeDetail?.need && <div className="wob-need">{nodeDetail.need.criteria.length > 0 && <p>{nodeDetail.need.criteria.join(' · ')}</p>}{nodeDetail.need.fields.length > 0 && <p className="wob-detail-note">확인할 항목: {nodeDetail.need.fields.join(' · ')}</p>}</div>}
          {selectedGaps.length > 0 && <div className="wob-detail-gaps"><h3>확인이 필요한 부분</h3>{selectedGaps.map(gap => <p key={gap.id}>{gap.explanation}</p>)}</div>}
          {selectedNode?.kind === 'conclusion' && model && model.warnings.length > 0 && <div className="wob-detail-note">{model.warnings.map(warning => <p key={warning}>{warning}</p>)}</div>}
          {(externalUrl || evidenceDetail?.record != null && onRecord || onReview && selectedGaps.length > 0) && <div className="wob-detail-actions">
            {evidenceDetail?.record != null && onRecord && <button type="button" aria-label={`기록 ${evidenceDetail.record} 열기`} onClick={() => { setSelection(null); onRecord(evidenceDetail.record!); }}>Record {evidenceDetail.record} <span aria-hidden="true">↗</span></button>}
            {externalUrl && <a href={externalUrl.href} target="_blank" rel="noopener noreferrer">Open source <span aria-hidden="true">↗</span></a>}
            {onReview && selectedGaps.length > 0 && <button type="button" onClick={() => { setSelection(null); onReview(); }}>Review gaps <span aria-hidden="true">↗</span></button>}
          </div>}
        </div>
      </aside>}
    </div>
  </section>;
}
