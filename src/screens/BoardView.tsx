import type { CaseLink, CaseObject } from '../types/case';
import './graph.css';

export interface GraphViewProps {
  objects: Record<string, CaseObject>;
  links: CaseLink[];
  selectedId: string;
  onSelect: (id: string) => void;
  showPath: boolean;
  phase: number;
}

export type GraphLayout = Record<string, readonly [number, number]>;

const BOARD_LAYOUT: GraphLayout = {
  cert: [14, 18],
  sib2: [32, 12],
  ip: [46, 26],
  asn: [64, 14],
  sib1: [62, 36],
  lead: [20, 42],
  block: [9, 62],
  kit: [40, 56],
  wallet: [62, 56],
  exch: [84, 46],
  sib3: [26, 74],
  post: [46, 80],
};

const COLORS: Record<CaseObject['group'], string> = {
  domain: '#2a78d6',
  infra: '#e87ba4',
  artifact: '#eda100',
  money: '#1baf7a',
};

const VISIBLE_AT = [0, 1, 3, 4, 5];

function linkPath(link: CaseLink, layout: GraphLayout, lanes: boolean) {
  const [ax, ay] = layout[link.source];
  const [bx, by] = layout[link.target];
  const start = `M${ax} ${ay}`;
  if (!lanes || (link.source === 'post' && link.target === 'kit') || (link.source === 'wallet' && link.target === 'exch')) {
    return `${start}L${bx} ${by}`;
  }
  const withinInfrastructure = ax === bx;
  const controlX = withinInfrastructure ? ax + (link.source === 'sib1' ? 17 : 14) : (ax + bx) / 2;
  return `${start}C${controlX} ${ay} ${controlX} ${by} ${bx} ${by}`;
}

export function GraphCanvas({
  objects,
  links,
  selectedId,
  onSelect,
  showPath,
  phase,
  layout,
  lanes = false,
}: GraphViewProps & { layout: GraphLayout; lanes?: boolean }) {
  const done = phase >= 6;
  const shown = (id: string) => Boolean(objects[id]) && phase >= (VISIBLE_AT[objects[id].stage] ?? 0);
  const visibleLinks = links.filter((link) => layout[link.source] && layout[link.target] && shown(link.source) && shown(link.target));
  const stageCount: Record<number, number> = {};
  const nodes = Object.entries(layout).filter(([id]) => objects[id]).map(([id, position]) => {
    const object = objects[id];
    const order = stageCount[object.stage] ?? 0;
    stageCount[object.stage] = order + 1;
    return { id, object, position, order };
  });
  const selectedLinks = visibleLinks.filter((link) => done && (link.source === selectedId || link.target === selectedId));
  const answerLinks = visibleLinks.filter((link) => done && showPath && link.kind === 'ans');

  return (
    <div className={`graph-scroll${lanes ? ' graph-scroll--lanes' : ' graph-scroll--board'}`} data-canvas-scroll>
      <section className="graph-canvas" aria-label={lanes ? 'Investigation graph, lanes view' : 'Investigation graph, board view'}>
        <div className="graph-scene">
        {lanes && (
          <>
            <div className="graph-lane-background" style={{ left: '1%' }} aria-hidden="true" />
            <div className="graph-lane-background" style={{ left: '45%' }} aria-hidden="true" />
            {[
              { x: 11, title: 'LEAD', count: 1 },
              { x: 33, title: 'INFRASTRUCTURE', count: 6 },
              { x: 55, title: 'CONTENT', count: 2 },
              { x: 77, title: 'MONEY TRAIL', count: 2 },
            ].map((lane) => (
              <div className="graph-lane-title" style={{ left: `${lane.x}%` }} key={lane.title}>
                {lane.title} <span>· {lane.count}</span>
              </div>
            ))}
          </>
        )}

        <svg className="graph-connections" viewBox="0 0 100 100" preserveAspectRatio="none" fill="none" aria-hidden="true">
          {visibleLinks.map((link) => (
            <path
              key={link.id}
              d={linkPath(link, layout, lanes)}
              className={`graph-edge${link.kind === 'inf' ? ' graph-edge--inferred' : ''}`}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {selectedLinks.map((link) => (
            <path
              key={`selected-${link.id}`}
              d={linkPath(link, layout, lanes)}
              className={`graph-edge graph-edge--selected${link.kind === 'inf' ? ' graph-edge--inferred' : ''}`}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {answerLinks.map((link) => (
            <path key={`answer-${link.id}`} d={linkPath(link, layout, lanes)} className="graph-edge graph-edge--answer" vectorEffect="non-scaling-stroke" />
          ))}
        </svg>

        {visibleLinks.filter((link) => link.label && (!lanes || (link.kind === 'ans' && done))).map((link) => {
          const [ax, ay] = layout[link.source];
          const [bx, by] = layout[link.target];
          const offset = !lanes && link.label === 'pays_out_to' ? -5.5 : 0;
          return (
            <span
              className={`graph-edge-label${link.kind === 'ans' && showPath && done ? ' graph-edge-label--answer' : ''}`}
              key={`label-${link.id}`}
              style={{ left: `${(ax + bx) / 2}%`, top: `${(ay + by) / 2 + offset}%` }}
              aria-hidden="true"
            >
              {link.label}
            </span>
          );
        })}

        {nodes.map(({ id, object, position, order }) => {
          const selected = done && selectedId === id;
          const visible = shown(id);
          return (
            <button
              type="button"
              key={id}
              className={`graph-node${selected ? ' graph-node--selected' : ''}${object.conf === 'INFERRED' ? ' graph-node--inferred' : ''}${visible ? '' : ' graph-node--hidden'}`}
              style={{ left: `${position[0]}%`, top: `${position[1]}%`, transitionDelay: `${order * 90}ms` }}
              onClick={() => onSelect(id)}
              aria-pressed={selected}
              aria-label={`${object.type}: ${object.value}`}
              aria-hidden={!visible}
              tabIndex={visible ? 0 : -1}
              title={object.value}
            >
              <span className="graph-node-type"><i className="graph-group-dot" style={{ background: COLORS[object.group] }} aria-hidden="true" />{object.type}</span>
              <span className="graph-node-value">{object.value}</span>
              {lanes && id === 'lead' && (
                <span className="graph-node-flag">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 21V4M5 4h11l-2 4 2 4H5" /></svg>
                  BLOCKLISTED 3 OCT
                </span>
              )}
              {id === 'lead' && <span className="graph-lead-badge">LEAD</span>}
            </button>
          );
        })}
        </div>
      </section>
    </div>
  );
}

export default function BoardView(props: GraphViewProps) {
  return <GraphCanvas {...props} layout={BOARD_LAYOUT} />;
}
