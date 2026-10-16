import { exploreGraph } from '../../lib/graph-exploration';
import { stanceLabels } from '../../lib/claim';
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
import type { GraphDecorations, GraphDocument, GraphEdge, GraphEvent, GraphNode, GraphSelection } from '../../types/graph';
import type { GapType } from '../../types/why-not';
import { Icon } from '../Icon';
import './graph-renderer.css';

export interface GraphRendererProps {
  graph: GraphDocument;
  view: 'board' | 'lanes' | 'timeline';
  selection: GraphSelection;
  onSelect: (selection: GraphSelection) => void;
  showPath: boolean;
  query: string;
  decorations?: GraphDecorations;
  persistedPositions?: Record<string, { x: number; y: number }>;
  onPositionsChange?: (positions: Record<string, { x: number; y: number }>) => void;
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
const GOAL_WIDTH = 284;
const GOAL_HEIGHT = 126;
const MIN_ZOOM = 0.02;
const DAY = 86_400_000;
const dateLabel = (date: number | string) => new Date(date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const gapLabels: Record<GapType, string> = {
  EVIDENCE_MISSING: '자료 없음', EVIDENCE_INSUFFICIENT: '근거 부족', EVENT_MISMATCH: '사건 불일치',
  TRUST_WEAK: '지지 수준 부족', PROVENANCE_UNKNOWN: '원출처 미확인', CHAIN_UNKNOWN: '연결 미완성',
};
const nodeSize = (id: string, decorations?: GraphDecorations) => decorations?.nodes[id]?.kind === 'goal'
  ? { width: GOAL_WIDTH, height: GOAL_HEIGHT } : { width: NODE_WIDTH, height: NODE_HEIGHT };

/** A stable layout is computed from the graph itself, without case-specific IDs. */
function boardLayout(graph: GraphDocument): SceneLayout {
  // Case projections can contain thousands of objects. Avoid the per-extraction O(n²)
  // force simulation; retain every object in a deterministic, searchable type grid.
  if (graph.nodes.length > 200) {
    const columns = Math.max(4, Math.ceil(Math.sqrt(graph.nodes.length)));
    const positions = new Map<string, Point>();
    const grouped = new Map<string, GraphNode[]>();
    for (const node of graph.nodes) { const items = grouped.get(node.group) ?? []; items.push(node); grouped.set(node.group, items); }
    let row = 0;
    for (const items of grouped.values()) {
      items.forEach((node, index) => positions.set(node.id, { x: 160 + (index % columns) * 250, y: 120 + (row + Math.floor(index / columns)) * 135 }));
      row += Math.ceil(items.length / columns) + 1;
    }
    return { width: Math.max(900, columns * 250 + 70), height: Math.max(580, row * 135 + 100), positions };
  }
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

/** Explicit review annotations get a central goal without changing graph facts. */
function centeredBoardLayout(graph: GraphDocument, decorations: GraphDecorations): SceneLayout {
  const centerId = decorations.centerNodeId;
  if (!centerId || !graph.nodes.some(node => node.id === centerId)) return boardLayout(graph);
  const positions = new Map<string, Point>([[centerId, { x: 0, y: 0 }]]);
  const gaps = graph.nodes.filter(node => node.id !== centerId && decorations.nodes[node.id]?.kind === 'gap');
  const ordinary = graph.nodes.filter(node => node.id !== centerId && decorations.nodes[node.id]?.kind !== 'gap');
  function rings(nodes: GraphNode[], firstRadiusX: number, firstRadiusY: number) {
    let offset = 0; let ring = 0;
    while (offset < nodes.length) {
      const count = Math.min(nodes.length - offset, 8 + ring * 4);
      for (let index = 0; index < count; index++) {
        const angle = -Math.PI / 2 + index / count * Math.PI * 2 + ring * .17;
        positions.set(nodes[offset + index].id, { x: Math.cos(angle) * (firstRadiusX + ring * 250), y: Math.sin(angle) * (firstRadiusY + ring * 145) });
      }
      offset += count; ring++;
    }
    return { x: firstRadiusX + Math.max(0, ring - 1) * 250, y: firstRadiusY + Math.max(0, ring - 1) * 145 };
  }
  const gapExtent = rings(gaps, 330, 190);
  rings(ordinary, gaps.length ? gapExtent.x + 270 : 340, gaps.length ? gapExtent.y + 175 : 215);
  // Gap and source rings can meet at their diagonals. Resolve full card bounds,
  // keeping the conclusion fixed and retaining a symmetric scene around it.
  const ids = [...positions.keys()];
  for (let pass = 0; pass < 65; pass++) {
    let overlaps = false;
    const cells = new Map<string, string[]>();
    for (const id of ids) {
      const b = positions.get(id)!; const bSize = nodeSize(id, decorations);
      const cellX = Math.floor(b.x / 340); const cellY = Math.floor(b.y / 190);
      for (let x = cellX - 1; x <= cellX + 1; x++) for (let y = cellY - 1; y <= cellY + 1; y++) for (const otherId of cells.get(`${x}:${y}`) ?? []) {
        const a = positions.get(otherId)!; const aSize = nodeSize(otherId, decorations);
        const dx = b.x - a.x; const dy = b.y - a.y;
        const overlapX = (aSize.width + bSize.width) / 2 + 40 - Math.abs(dx);
        const overlapY = (aSize.height + bSize.height) / 2 + 38 - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;
        overlaps = true;
        const af = otherId === centerId ? 0 : id === centerId ? 1 : .5;
        const bf = id === centerId ? 0 : otherId === centerId ? 1 : .5;
        if (overlapX < overlapY) { const move = overlapX * (dx < 0 ? -1 : 1); a.x -= move * af; b.x += move * bf; }
        else { const move = overlapY * (dy < 0 ? -1 : 1); a.y -= move * af; b.y += move * bf; }
      }
      const cell = `${Math.floor(b.x / 340)}:${Math.floor(b.y / 190)}`;
      cells.set(cell, [...(cells.get(cell) ?? []), id]);
    }
    if (!overlaps) break;
  }
  const halfWidth = Math.max(470, ...ids.map(id => Math.abs(positions.get(id)!.x) + nodeSize(id, decorations).width / 2 + 85));
  const halfHeight = Math.max(290, ...ids.map(id => Math.abs(positions.get(id)!.y) + nodeSize(id, decorations).height / 2 + 95));
  positions.forEach(point => { point.x += halfWidth; point.y += halfHeight; });
  return { width: halfWidth * 2, height: halfHeight * 2, positions };
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

function edgeGeometry(edge: GraphEdge, layout: SceneLayout, lanes: boolean, ordinal: number, decorations?: GraphDecorations) {
  const source = layout.positions.get(edge.source);
  const target = layout.positions.get(edge.target);
  if (!source || !target) return null;
  if (edge.source === edge.target) return { path: `M ${source.x - 34} ${source.y - 37} C ${source.x - 65} ${source.y - 105}, ${source.x + 65} ${source.y - 105}, ${source.x + 34} ${source.y - 37}`, label: { x: source.x, y: source.y - 83 } };
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const sourceSize = nodeSize(edge.source, decorations); const targetSize = nodeSize(edge.target, decorations);
  const from = Math.min((sourceSize.width / 2 + 3) / Math.max(1, Math.abs(dx)), (sourceSize.height / 2 + 3) / Math.max(1, Math.abs(dy)));
  const to = Math.min((targetSize.width / 2 + 3) / Math.max(1, Math.abs(dx)), (targetSize.height / 2 + 3) / Math.max(1, Math.abs(dy)));
  const ax = source.x + dx * from;
  const ay = source.y + dy * from;
  const bx = target.x - dx * to;
  const by = target.y - dy * to;
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

function GraphCanvas({ graph, view, selection, onSelect, showPath, query, decorations, persistedPositions, onPositionsChange }: GraphRendererProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
  const nodeById = useMemo(() => new Map(graph.nodes.map(node => [node.id, node])), [graph.nodes]);
  const [zoom, setZoom] = useState(1);
  const [viewport, setViewport] = useState({ width: 900, height: 580 });
  const markerId = useId().replace(/:/g, '');
  const gapTypes = [...new Set(Object.values(decorations?.edges ?? {}).map(edge => edge.gapType))];
  const [manual, setManual] = useState<Record<string, Point>>({});
  const manualRef = useRef(manual); manualRef.current = manual;
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const pan = useRef<{ pointer: number; x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const [panning, setPanning] = useState(false);
  const initialCamera = useRef({ key: '', interacted: false });
  const diagnosticState = decorations?.centerNodeId ? decorations.nodes[decorations.centerNodeId]?.state : undefined;
  const previousDiagnosticState = useRef(diagnosticState);
  if (previousDiagnosticState.current !== diagnosticState && (previousDiagnosticState.current === 'idle' || diagnosticState === 'idle')) initialCamera.current.interacted = true;
  previousDiagnosticState.current = diagnosticState;
  const appliedPositions = useRef({ key: '', signature: '' });
  const touchedPositions = useRef(new Set<string>());
  const priorScene = useRef<{ id: string; view: string; centerNodeId?: string; scene: SceneLayout } | null>(null);
  // Polling may replace descriptions or counts without changing graph topology.
  // Keep layout work out of those updates and place only genuinely new nodes.
  const topologyKey = JSON.stringify([graph.id, graph.nodes.map(node => [node.id, node.group]), graph.edges.map(edge => [edge.source, edge.target]), graph.groups.map(group => group.id), decorations?.centerNodeId]);
  const baseScene = useMemo(() => {
    if (view === 'timeline') return { width: 940, height: 580, positions: new Map<string, Point>() };
    const prior = priorScene.current;
    const nodeIds = new Set(graph.nodes.map(node => node.id));
    let candidate: SceneLayout;
    if (view === 'board' && prior?.id === graph.id && prior.view === view && prior.centerNodeId === decorations?.centerNodeId) {
      candidate = { ...prior.scene, positions: new Map([...prior.scene.positions].filter(([id]) => nodeIds.has(id))) };
      const occupied = [...candidate.positions].map(([id, point]) => ({ id, point: manual[id] ?? point }));
      const vacant = (id: string, next: Point) => !occupied.some(other => {
        const size = nodeSize(id, decorations); const otherSize = nodeSize(other.id, decorations);
        return Math.abs(other.point.x - next.x) < (size.width + otherSize.width) / 2 + 28 && Math.abs(other.point.y - next.y) < (size.height + otherSize.height) / 2 + 28;
      });
      const neighbors = new Map<string, string[]>();
      for (const edge of graph.edges) {
        const from = neighbors.get(edge.source) ?? []; from.push(edge.target); neighbors.set(edge.source, from);
        const to = neighbors.get(edge.target) ?? []; to.push(edge.source); neighbors.set(edge.target, to);
      }
      let freeSlot = 0;
      for (const node of graph.nodes) {
        if (candidate.positions.has(node.id)) continue;
        const anchorId = (neighbors.get(node.id) ?? []).find(id => manual[id] !== undefined || candidate.positions.has(id));
        const anchor = anchorId ? manual[anchorId] ?? candidate.positions.get(anchorId) : undefined;
        let point: Point | undefined;
        // New diagnostics belong near their actual connected condition or
        // evidence. The goal is not a fallback anchor for every warning.
        if (!point && anchor) {
          const currentSize = nodeSize(node.id, decorations); const anchorSize = nodeSize(anchorId!, decorations);
          const across = (currentSize.width + anchorSize.width) / 2 + 48;
          const down = (currentSize.height + anchorSize.height) / 2 + 50;
          for (const [dx, dy] of [[across, 0], [0, down], [-across, 0], [0, -down], [across, down], [-across, down]]) {
            const next = { x: anchor.x + dx, y: anchor.y + dy };
            if (next.x >= 115 && next.y >= 70 && vacant(node.id, next)) { point = next; break; }
          }
        }
        while (!point) {
          const next = { x: 140 + (freeSlot % 5) * 230, y: 100 + Math.floor(freeSlot / 5) * 125 }; freeSlot++;
          if (vacant(node.id, next)) point = next;
        }
        candidate.positions.set(node.id, point); occupied.push({ id: node.id, point });
        candidate.width = Math.max(candidate.width, point.x + 140); candidate.height = Math.max(candidate.height, point.y + 90);
      }
    } else candidate = view === 'lanes' ? lanesLayout(graph) : decorations?.centerNodeId ? centeredBoardLayout(graph, decorations) : boardLayout(graph);
    priorScene.current = { id: graph.id, view, centerNodeId: decorations?.centerNodeId, scene: candidate }; return candidate;
  }, [topologyKey, view]);
  const positionKey = `cluevia.positions.${graph.id}.${view}`;
  const dragging = useRef<{ id: string; pointer: number; x: number; y: number; point: Point; moved: boolean; scrollX: number; scrollY: number } | null>(null);
  const suppressClickUntil = useRef(0);
  useEffect(() => {
    touchedPositions.current.clear();
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(positionKey) ?? '{}');
      const entries = saved && typeof saved === 'object' && !Array.isArray(saved) ? Object.entries(saved).filter((entry): entry is [string, Point] => {
        const value = entry[1]; return value && typeof value === 'object' && Number.isFinite(value.x) && Number.isFinite(value.y) && value.x >= 100 && value.y >= 60 && value.x <= 1e6 && value.y <= 1e6;
      }) : [];
      setManual(Object.fromEntries(entries));
    } catch { setManual({}); }
  }, [positionKey]);
  useEffect(() => {
    if (persistedPositions === undefined) return;
    const entries = Object.entries(persistedPositions).filter(([, point]) => point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.y >= 0 && point.x <= 1e6 && point.y <= 1e6).sort(([a], [b]) => a.localeCompare(b));
    const signature = JSON.stringify(entries);
    if (appliedPositions.current.key === positionKey && appliedPositions.current.signature === signature) return;
    appliedPositions.current = { key: positionKey, signature };
    const next = Object.fromEntries(entries);
    // A late initial GET must not undo a drag completed while it was loading.
    for (const id of touchedPositions.current) if (manualRef.current[id]) next[id] = manualRef.current[id];
    if (dragging.current && manualRef.current[dragging.current.id]) next[dragging.current.id] = manualRef.current[dragging.current.id];
    manualRef.current = next; setManual(next);
  }, [persistedPositions, positionKey]);
  const scene = useMemo(() => {
    const positions = new Map(baseScene.positions); let width = baseScene.width; let height = baseScene.height;
    for (const [id, point] of Object.entries(manual)) if (positions.has(id)) { positions.set(id, point); width = Math.max(width, point.x + 130); height = Math.max(height, point.y + 90); }
    return { width, height, positions };
  }, [baseScene, manual]);
  function startDrag(event: PointerEvent<HTMLButtonElement>, id: string) {
    if (event.button !== 0 || dragging.current) return;
    const point = scene.positions.get(id); if (!point) return;
    initialCamera.current.interacted = true;
    suppressClickUntil.current = 0;
    dragging.current = { id, pointer: event.pointerId, x: event.clientX, y: event.clientY, point, moved: false, scrollX: viewportRef.current?.scrollLeft ?? 0, scrollY: viewportRef.current?.scrollTop ?? 0 };
    setDraggingId(id);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
  }
  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragging.current; if (!drag || drag.pointer !== event.pointerId) return;
    const dx = event.clientX - drag.x; const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    event.preventDefault();
    drag.moved = true; suppressClickUntil.current = performance.now() + 400;
    const point = { x: clamp(drag.point.x + (dx + (viewportRef.current?.scrollLeft ?? 0) - drag.scrollX) / zoom, 100, 1e6), y: clamp(drag.point.y + (dy + (viewportRef.current?.scrollTop ?? 0) - drag.scrollY) / zoom, 60, 1e6) };
    manualRef.current = { ...manualRef.current, [drag.id]: point };
    setManual(manualRef.current);
  }
  function endDrag(event: PointerEvent<HTMLButtonElement>, cancelled = false) {
    const drag = dragging.current;
    if (drag?.pointer !== event.pointerId) return;
    dragging.current = null; setDraggingId(null);
    if (drag.moved || cancelled) suppressClickUntil.current = performance.now() + 400;
    if (cancelled && drag.moved) {
      manualRef.current = { ...manualRef.current, [drag.id]: drag.point };
      setManual(manualRef.current);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (drag.moved && !cancelled) {
      touchedPositions.current.add(drag.id);
      try { localStorage.setItem(positionKey, JSON.stringify(manualRef.current)); } catch { /* Layout remains usable without browser persistence. */ }
      onPositionsChange?.({ ...manualRef.current });
    }
  }
  function startPan(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || pan.current || dragging.current || (event.target as Element).closest('button, a, input, textarea, select, [role="button"]')) return;
    initialCamera.current.interacted = true;
    suppressClickUntil.current = 0;
    pan.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop, moved: false };
    setPanning(true); event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.focus({ preventScroll: true });
  }
  function movePan(event: PointerEvent<HTMLDivElement>) {
    const gesture = pan.current; if (!gesture || gesture.pointer !== event.pointerId) return;
    const dx = event.clientX - gesture.x; const dy = event.clientY - gesture.y;
    if (!gesture.moved && Math.hypot(dx, dy) < 3) return;
    event.preventDefault(); gesture.moved = true; suppressClickUntil.current = performance.now() + 400;
    event.currentTarget.scrollTo({ left: gesture.left - dx, top: gesture.top - dy });
  }
  function endPan(event: PointerEvent<HTMLDivElement>, cancelled = false) {
    const gesture = pan.current; if (!gesture || gesture.pointer !== event.pointerId) return;
    pan.current = null; setPanning(false);
    if (gesture.moved || cancelled) suppressClickUntil.current = performance.now() + 400;
    if (cancelled && gesture.moved) event.currentTarget.scrollTo({ left: gesture.left, top: gesture.top });
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  const timeline = useMemo(() => view === 'timeline' ? timelineLayout(graph) : { width: 1100, height: 580, rows: [], events: [], ticks: [], min: 0, max: 0 } as TimelineLayout, [graph, view]);
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
  const cameraCenter = decorations?.centerNodeId ? scene.positions.get(decorations.centerNodeId) : undefined;

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
    if (!element || !element.clientWidth || !element.clientHeight) return;
    const key = `${graph.id}:${view}:${decorations?.centerNodeId ?? ''}`;
    if (initialCamera.current.key !== key) initialCamera.current = { key, interacted: false };
    if (initialCamera.current.interacted) return;
    const next = clamp((element.clientWidth - 32) / dimensions.width, 0.65, 1);
    setZoom(next);
    const frame = requestAnimationFrame(() => element.scrollTo(cameraCenter
      ? { left: Math.max(0, cameraCenter.x * next - element.clientWidth / 2), top: Math.max(0, cameraCenter.y * next - element.clientHeight / 2) }
      : { top: 0, left: 0 }));
    return () => cancelAnimationFrame(frame);
  }, [graph.id, view, decorations?.centerNodeId, viewport.width, viewport.height, cameraCenter?.x, cameraCenter?.y, dimensions.width, dimensions.height]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const element = viewportRef.current;
      if (!element || !selection || dragging.current) return;
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
  }, [graph.id, view, selection?.kind, selection?.id]);

  function changeZoom(value: number) {
    initialCamera.current.interacted = true;
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
    initialCamera.current.interacted = true;
    const anchor = decorations?.centerNodeId && baseScene.positions.get(decorations.centerNodeId);
    const width = anchor ? Math.max(anchor.x, dimensions.width - anchor.x) * 2 : dimensions.width;
    const height = anchor ? Math.max(anchor.y, dimensions.height - anchor.y) * 2 : dimensions.height;
    setZoom(clamp(Math.min((viewport.width - 28) / width, (viewport.height - 28) / height), MIN_ZOOM, 1));
    viewportRef.current?.scrollTo({ top: 0, left: 0 });
  }

  const baseCenter = decorations?.centerNodeId && baseScene.positions.get(decorations.centerNodeId);
  // Adding a warning to the right must not move cards already placed by the user.
  const sceneLeft = Math.max(0, viewport.width / 2 - (baseCenter ? baseCenter.x : dimensions.width / 2) * zoom);
  const sceneTop = Math.max(0, viewport.height / 2 - (baseCenter ? baseCenter.y : dimensions.height / 2) * zoom);
  const extentWidth = Math.max(viewport.width, dimensions.width * zoom + sceneLeft);
  const extentHeight = Math.max(viewport.height, dimensions.height * zoom + sceneTop);
  const sceneStyle: CSSProperties = { width: dimensions.width, height: dimensions.height, transform: `scale(${zoom})`, left: sceneLeft, top: sceneTop };
  const noTimeline = view === 'timeline' && !timeline.events.length;

  return (
    <section className={`cg-root cg-root--${view}${decorations?.centerNodeId ? ' cg-root--review' : ''}`} aria-label={`${graph.title}: ${view} view`}>
      <div className="cg-toolbar">
        <div className="cg-status" role="status" aria-live="polite">
          <span className="cg-status-dot" />
          {view === 'timeline' ? `${graph.events.length} dated events` : decorations ? `${graph.nodes.filter(node => !decorations.nodes[node.id]).length} items · ${gapTypes.length} gap types` : `${graph.nodes.length} entities · ${graph.edges.length} relations`}
          {normalizedQuery && <span className="cg-match-count">{view === 'timeline' ? graph.events.filter(eventMatches).length : matchingNodes.size} matches</span>}
        </div>
        <div className="cg-zoom" role="group" aria-label="Graph zoom controls">
          <button type="button" onClick={() => changeZoom(zoom - 0.15)} disabled={zoom <= MIN_ZOOM} aria-label="Zoom out">−</button>
          <output aria-label="Zoom level">{Math.round(zoom * 100)}%</output>
          <button type="button" onClick={() => changeZoom(zoom + 0.15)} disabled={zoom >= 1.8} aria-label="Zoom in">+</button>
          <button type="button" className="cg-fit" onClick={fit} aria-label="Fit graph to view"><Icon name="fit" size={15} /><span>Fit</span></button>
        </div>
      </div>
      <div className={`cg-viewport${panning ? ' is-panning' : ''}`} ref={viewportRef} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={event => endPan(event)} onPointerCancel={event => endPan(event, true)} onLostPointerCapture={event => endPan(event, true)} onClick={event => { if (event.detail > 0 && performance.now() < suppressClickUntil.current) { event.preventDefault(); event.stopPropagation(); return; } if (event.target instanceof Element && !event.target.closest('button, [role="button"]')) onSelect(null); }} onScroll={event => setScroll({ left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop })} tabIndex={0} role="region" aria-label="Graph canvas. Scroll or use the arrow keys to pan." data-canvas-scroll>
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
                const node = nodeById.get(event.nodeIds[0]);
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
                  const geometry = edgeGeometry(edge, scene, view === 'lanes', index, decorations);
                  if (!geometry) return null;
                  const selected = selection?.kind === 'edge' && selection.id === edge.id;
                  const connected = selectedNodeIds.has(edge.source) || selectedNodeIds.has(edge.target);
                  const matches = !normalizedQuery || matchingNodes.has(edge.source) && matchingNodes.has(edge.target);
                  const highlighted = showPath && edge.highlighted;
                  const gap = decorations?.edges[edge.id];
                  return <g key={gap ? `${edge.id}:${decorations?.runKey ?? ''}` : edge.id} data-graph-edge={edge.id} data-gap-type={gap?.gapType} className={`cg-edge${gap ? ' cg-edge--gap' : ''}${edge.claim ? ` cg-edge--${edge.claim.stance}` : ''}${edge.status === 'inferred' || (edge.claim && edge.claim.stance !== 'asserted') ? ' cg-edge--inferred' : ''}${highlighted ? ' cg-edge--highlighted' : ''}${connected ? ' cg-edge--connected' : ''}${selected ? ' is-selected' : ''}${matches ? '' : ' is-muted'}`} style={gap ? { '--cg-gap-delay': `${Math.max(0, Math.min(gap.delayMs ?? (gap.revealIndex ?? 0) * 65, 30000))}ms`, '--cg-gap-duration': `${Math.max(1, Math.min(gap.durationMs ?? 750, 30000))}ms` } as CSSProperties : undefined} tabIndex={matches ? 0 : -1} role="button" aria-pressed={selected} aria-label={`${gap ? `근거 공백: ${gapLabels[gap.gapType]}` : `Relation: ${edge.label}`}, ${nodeById.get(edge.source)?.label} to ${nodeById.get(edge.target)?.label}`} onClick={() => onSelect({ kind: 'edge', id: edge.id })} onKeyDown={event => activateEdge(event, () => onSelect({ kind: 'edge', id: edge.id }))}>
                    <title>{edge.label} · {gap ? gapLabels[gap.gapType] : edge.claim ? stanceLabels[edge.claim.stance] : edge.status}</title><path className="cg-edge-hit" d={geometry.path} /><path className="cg-edge-line" d={geometry.path} markerEnd={`url(#${markerId})`} />{gap && <path className="cg-gap-reveal" d={geometry.path} pathLength="1" />}
                    {(graph.edges.length <= 65 || selected || highlighted || gap) && <foreignObject x={geometry.label.x - 77} y={geometry.label.y - 10} width="154" height="22"><div className="cg-edge-label" title={edge.label}>{gap ? gapLabels[gap.gapType] : <>{edge.claim && edge.claim.stance !== "asserted" ? `${stanceLabels[edge.claim.stance]} · ` : ""}{edge.label}</>}</div></foreignObject>}
                  </g>;
                })}
              </svg>
              {graph.nodes.map((node, index) => {
                const point = scene.positions.get(node.id);
                if (!point) return null;
                const pinned = selectedNodeIds.has(node.id) || dragging.current?.id === node.id;
                if (graph.nodes.length > 100 && !pinned && (point.x * zoom < scroll.left - 250 || point.x * zoom > scroll.left + viewport.width + 250 || point.y * zoom < scroll.top - 150 || point.y * zoom > scroll.top + viewport.height + 150)) return null;
                const selected = selection?.kind === 'node' && selection.id === node.id;
                const related = !selected && selectedNodeIds.has(node.id);
                const matches = !normalizedQuery || matchingNodes.has(node.id);
                const group = groups.get(node.group);
                const decoration = decorations?.nodes[node.id];
                return <button type="button" data-graph-node={node.id} data-graph-decoration={decoration?.kind} data-gap-type={decoration?.gapType} data-review-state={decoration?.state} data-evaluation-state={decoration?.kind === 'gap' ? node.properties.evaluationState : undefined} className={`cg-node${decoration ? ` cg-node--${decoration.kind}` : ''}${selected ? ' is-selected' : ''}${related ? ' is-related' : ''}${matches ? '' : ' is-muted'}${draggingId === node.id ? ' is-dragging' : ''}`} key={node.id} style={{ left: point.x, top: point.y, '--cg-color': group?.color ?? '#7a6f5c', '--cg-enter-delay': `${Math.max(0, Math.min(decoration?.delayMs ?? index * 18, decoration?.delayMs === undefined ? 180 : 30000))}ms`, '--cg-enter-duration': `${Math.max(1, Math.min(decoration?.durationMs ?? 380, 30000))}ms` } as CSSProperties} onPointerDown={event => startDrag(event, node.id)} onPointerMove={moveDrag} onPointerUp={event => endDrag(event)} onPointerCancel={event => endDrag(event, true)} onLostPointerCapture={event => endDrag(event, true)} onClick={event => { if (event.detail > 0 && performance.now() < suppressClickUntil.current) { event.preventDefault(); event.stopPropagation(); return; } onSelect({ kind: 'node', id: node.id }); }} aria-pressed={selected} aria-label={`${decoration?.kind === 'gap' ? `근거 공백: ${decoration.gapType ? gapLabels[decoration.gapType] : node.type}` : decoration?.kind === 'goal' ? '분석 목표' : node.type}: ${node.label}`} title={node.description || node.label} tabIndex={matches ? 0 : -1}>
                  <span className="cg-node-type">{decoration?.kind === 'gap' ? <svg className="cg-gap-alert" data-gap-warning width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="m10 2 8 15H2z" strokeLinejoin="round" /><path d="M10 7v4m0 2v1" strokeLinecap="round" /></svg> : <i />}{decoration?.kind === 'goal' ? 'GOAL' : decoration?.kind === 'gap' ? 'GAP' : node.type}{decoration?.kind === 'goal' && decoration.state === 'checking' && <small>Checking…</small>}{decoration?.kind === 'gap' && node.properties.evaluationState === 'PENDING' && <small className="cg-node-check-status">확인 대기</small>}</span><strong>{node.label}</strong><span className="cg-node-meta">{decoration?.kind === 'goal' ? 'Analysis goal' : decoration?.kind === 'gap' ? decoration.gapType ? gapLabels[decoration.gapType] : '근거 확인 필요' : <>{node.sourceIds.length} {node.sourceIds.length === 1 ? 'source' : 'sources'}</>}<span>{decoration?.kind === 'gap' ? 'View reason ↗' : decoration?.kind === 'goal' ? 'Evidence review' : group?.label}</span></span>
                </button>;
              })}
            </>}
          </div>
        </div>}
      </div>
      {!!gapTypes.length && <details className="cg-gap-legend"><summary>Gaps · {gapTypes.length}</summary><ul aria-label="근거 공백 선의 의미">{gapTypes.map(type => <li key={type} data-gap-type={type}><svg width="27" height="7" viewBox="0 0 27 7" aria-hidden="true"><path d="M0 3.5H27" /></svg><span>{gapLabels[type]}</span></li>)}</ul></details>}
    </section>
  );
}


export default function GraphRenderer(props: GraphRendererProps) {
  const [group, setGroup] = useState(''); const [page, setPage] = useState(0); const [depth, setDepth] = useState(1);
  const large = props.graph.nodes.length > 200 || props.graph.edges.length > 1000 || props.graph.events.length > 500;
  useEffect(() => { setPage(0); setGroup(''); }, [props.graph.id, props.selection?.id, props.query]);
  const projection = useMemo(() => large ? exploreGraph(props.graph, { selection: props.selection, group, query: props.query, page, depth }) : null, [large, props.graph, props.selection, group, props.query, page, depth]);
  const displayedGraph = useMemo(() => {
    if (!projection || !props.decorations) return projection?.graph ?? props.graph;
    const ids = new Set(projection.graph.nodes.map(node => node.id));
    // Diagnostic annotations must survive ordinary-object pagination. Preserve
    // their endpoints too, so a retained warning never becomes a dangling edge.
    Object.keys(props.decorations.nodes).forEach(id => ids.add(id));
    if (props.decorations.centerNodeId) ids.add(props.decorations.centerNodeId);
    const diagnosticEdges = props.graph.edges.filter(edge => props.decorations!.edges[edge.id]);
    diagnosticEdges.forEach(edge => { ids.add(edge.source); ids.add(edge.target); });
    const nodes = props.graph.nodes.filter(node => ids.has(node.id));
    const ordinaryEdges = props.graph.edges.filter(edge => !props.decorations!.edges[edge.id] && ids.has(edge.source) && ids.has(edge.target)).slice(0, 1000);
    return { ...projection.graph, nodes, edges: [...ordinaryEdges, ...diagnosticEdges], groups: props.graph.groups.filter(group => nodes.some(node => node.group === group.id)) };
  }, [projection, props.graph, props.decorations]);
  return <div className={`cg-explorer${projection ? '' : ' cg-explorer--compact'}`}>{projection && <div className="cg-explorer-controls" aria-label="대규모 그래프 탐색">
    <span>전체 {props.graph.nodes.length.toLocaleString()}개 · 현재 {displayedGraph.nodes.length}개 표시</span>
    <label>객체 유형 <select value={group} onChange={event => { setGroup(event.target.value); setPage(0); }}><option value="">모든 유형</option>{props.graph.groups.map(group => <option key={group.id} value={group.id}>{group.label}</option>)}</select></label>
    <label>연결 범위 <select value={depth} onChange={event => { setDepth(Number(event.target.value)); setPage(0); }}><option value={0}>전체 목록</option><option value={1}>선택한 객체의 직접 연결</option><option value={2}>두 단계 연결</option></select></label>
    <button type="button" disabled={projection.page === 0} onClick={() => setPage(projection.page - 1)}>이전</button><span>{projection.page + 1} / {projection.pages}</span><button type="button" disabled={projection.page + 1 >= projection.pages} onClick={() => setPage(projection.page + 1)}>다음</button>
    {!!projection.hiddenEdges && <small>현재 객체 사이의 관계 {projection.hiddenEdges}개 추가 보관 · 객체를 선택해 좁혀주세요.</small>}
  </div>}<GraphCanvas {...props} graph={displayedGraph} /></div>;
}
