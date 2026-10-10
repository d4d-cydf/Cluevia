import { Fragment, useState } from 'react';
import type { TimelineConnector, TimelineEvent, TimelineRow } from '../types/case';
import './timeline.css';

interface TimelineViewProps {
  rows: TimelineRow[];
  events: TimelineEvent[];
  payments: [number, number][];
  connectors: TimelineConnector[];
  selectedId: string;
  onSelect: (id: string) => void;
  showPath: boolean;
  phase: number;
}

const colors = {
  domain: '#2a78d6',
  infra: '#e87ba4',
  artifact: '#eda100',
  money: '#1baf7a',
};

const positionX = (day: number) => `${(24 + day * 3.4).toFixed(2)}%`;
const revealAt = (day: number) => (day <= 6 ? 2 : day <= 13 ? 3 : 4);
const stripeColor = (index: number) => (index % 2 === 1 ? '#F6F0E3' : '#FBF8F1');
const dateOf = (day: number, withYear = false) =>
  `${day <= 10 ? 20 + day : day - 10} ${day <= 10 ? 'SEP' : 'OCT'}${withYear ? ' 2026' : ''}`;

/** Presentation-only timeline. Its data and selected event are owned by the case. */
export default function TimelineView({
  rows,
  events,
  payments,
  connectors,
  selectedId,
  onSelect,
  showPath,
  phase,
}: TimelineViewProps) {
  const [hoverBar, setHoverBar] = useState<number | null>(null);
  const complete = phase >= 6;
  const barsVisible = phase >= 5;
  const rowIndex = new Map(rows.map((row, index) => [row.id, index]));
  const rowY = (id: string) => 262 + (rowIndex.get(id) ?? 0) * 42;
  const eventByPosition = new Map(events.map((event) => [`${event.row}@${event.d}`, event]));
  const stageOrder = new Map<number, number>();
  const peak = payments.reduce<[number, number] | undefined>(
    (highest, payment) => (!highest || payment[1] > highest[1] ? payment : highest),
    undefined,
  );
  const hoveredPayment = barsVisible && hoverBar !== null ? payments[hoverBar] : undefined;
  const paymentTotal = payments.reduce((total, [, count]) => total + count, 0);

  return (
    <div className="timeline-frame">
    <div className="timeline-scroll" data-canvas-scroll role="region" aria-label="Investigation timeline. Scroll horizontally to explore dates.">
      <div className="timeline-canvas">
        {rows.map((row, index) => (
          <div
            key={row.id}
            className="timeline-stripe"
            aria-hidden="true"
            style={{ top: 241 + index * 42, background: stripeColor(index) }}
          />
        ))}

        <div className="timeline-campaign" aria-hidden="true" style={{ opacity: complete ? 1 : 0 }} />
        <div className="timeline-campaign-label" style={{ opacity: complete ? 1 : 0 }}>
          CAMPAIGN ACTIVE · 23 SEP → TODAY
        </div>

        {Array.from({ length: 11 }, (_, index) => index * 2).map((day) => (
          <Fragment key={day}>
            <div className="timeline-tick-line" aria-hidden="true" style={{ left: positionX(day) }} />
            <div className="timeline-tick-label" style={{ left: positionX(day) }}>
              {day === 0 ? '20 SEP' : day === 12 ? '2 OCT' : day <= 10 ? 20 + day : day - 10}
            </div>
          </Fragment>
        ))}

        <div className="timeline-today-line" aria-hidden="true" />
        <div className="timeline-today-label">TODAY</div>

        <div className="timeline-payments-heading">
          <strong>PAYMENTS PER DAY</strong>
          <span>into 0x5aAe…eAed</span>
          <span>{paymentTotal} since 29 Sep</span>
        </div>
        <div className="timeline-payments-baseline" aria-hidden="true" />
        {payments.map(([day, count], index) => (
          <div
            key={day}
            className="timeline-payment"
            role="img"
            aria-label={`${dateOf(day, true)}: ${count} ${count === 1 ? 'payment' : 'payments'}`}
            aria-hidden={!barsVisible}
            tabIndex={barsVisible ? 0 : -1}
            onMouseEnter={() => setHoverBar(index)}
            onMouseLeave={() => setHoverBar(null)}
            onFocus={() => setHoverBar(index)}
            onBlur={() => setHoverBar(null)}
            style={{ left: positionX(day) }}
          >
            <span style={{ height: barsVisible ? Math.round(count * 12.5) : 0, transitionDelay: `${index * 50}ms` }} />
          </div>
        ))}
        {peak && (
          <span
            className="timeline-payment-peak"
            aria-hidden="true"
            style={{
              left: positionX(peak[0]),
              top: 196 - Math.round(peak[1] * 12.5) - 18,
              opacity: barsVisible ? 1 : 0,
            }}
          >
            {peak[1]}
          </span>
        )}
        {hoveredPayment && (
          <div
            className="timeline-payment-tooltip"
            role="status"
            style={{
              left: positionX(hoveredPayment[0]),
              top: 196 - Math.round(hoveredPayment[1] * 12.5) - 44,
            }}
          >
            {dateOf(hoveredPayment[0])} · {hoveredPayment[1]} {hoveredPayment[1] === 1 ? 'payment' : 'payments'}
          </div>
        )}

        {rows.map((row, index) => (
          <div key={row.id} className="timeline-row-label" style={{ top: 241 + index * 42 }}>
            <span className="timeline-row-dot" aria-hidden="true" style={{ background: colors[row.group] }} />
            <span className="timeline-row-name" title={row.name}>{row.name}</span>
            {row.id === 'lead' && <span className="timeline-lead-badge">LEAD</span>}
          </div>
        ))}

        {connectors.map((connector) => {
          const from = eventByPosition.get(`${connector.a}@${connector.d}`);
          const to = eventByPosition.get(`${connector.b}@${connector.d}`);
          if (!from || !to || phase < revealAt(from.d) || phase < revealAt(to.d)) return null;
          const firstY = Math.min(rowY(connector.a), rowY(connector.b));
          const lastY = Math.max(rowY(connector.a), rowY(connector.b));
          const onPath = connector.ans && showPath && complete;
          return (
            <div
              key={`${connector.d}-${connector.a}-${connector.b}`}
              className={`timeline-connector${onPath ? ' is-answer-path' : ''}`}
              aria-hidden="true"
              style={{ left: positionX(connector.d), top: firstY, height: lastY - firstY }}
            />
          );
        })}

        {events.map((event) => {
          const index = rowIndex.get(event.row);
          if (index === undefined) return null;
          const row = rows[index];
          const visible = phase >= revealAt(event.d);
          const selected = complete && selectedId === event.id;
          const answerPath = event.ans && showPath && complete;
          const stage = revealAt(event.d);
          const order = stageOrder.get(stage) ?? 0;
          stageOrder.set(stage, order + 1);
          const color = colors[row.group];
          const markerShadow = selected
            ? '0 0 0 2px #FBF8F1, 0 0 0 4px #1E1B16'
            : `0 0 0 2px #FBF8F1${answerPath ? ', 0 0 0 4px #B8321A' : ''}`;

          return (
            <button
              key={event.id}
              type="button"
              className={`timeline-event${selected ? ' is-selected' : ''}`}
              aria-label={`${event.label}, ${dateOf(event.d, true)}, ${row.name}`}
              aria-pressed={selected}
              aria-hidden={!visible}
              tabIndex={visible ? 0 : -1}
              onClick={() => onSelect(event.id)}
              style={{
                left: positionX(event.d),
                top: rowY(event.row),
                opacity: visible ? 1 : 0,
                pointerEvents: visible ? 'auto' : 'none',
                transitionDelay: `${order * 70}ms`,
              }}
            >
              <span
                className="timeline-marker-position"
                aria-hidden="true"
                style={{ transform: `scale(${visible ? 1 : 0.4})`, transitionDelay: `${order * 70}ms` }}
              >
                <span
                  className="timeline-marker"
                  style={{
                    width: selected ? 16 : 12,
                    height: selected ? 16 : 12,
                    background: event.inf ? '#FBF8F1' : color,
                    border: event.inf ? `2px dashed ${color}` : '0',
                    boxShadow: markerShadow,
                  }}
                />
              </span>
              <span
                className="timeline-event-label"
                aria-hidden="true"
                style={{ background: stripeColor(index), opacity: visible ? 1 : 0, transitionDelay: `${order * 70 + 120}ms` }}
              >
                {event.label}
              </span>
            </button>
          );
        })}

      </div>
    </div>
    <div className="timeline-legend" role="group" aria-label="Timeline legend">
          <span><i style={{ background: colors.domain }} aria-hidden="true" />Domain</span>
          <span><i className="timeline-legend-inferred" aria-hidden="true" />Inferred</span>
          <span><i style={{ background: colors.infra }} aria-hidden="true" />Infrastructure</span>
          <span><i className="timeline-legend-answer" aria-hidden="true" />Answer path</span>
          <span><i style={{ background: colors.artifact }} aria-hidden="true" />Artifact</span>
          <span><i className="timeline-legend-connector" aria-hidden="true" />Same day</span>
          <span><i style={{ background: colors.money }} aria-hidden="true" />Money</span>
    </div>
    </div>
  );
}
