import type { OverviewConfidenceSummary } from '../../types/why-not';
import { confidenceGrade } from '../../lib/confidence-grade';
import './overview-confidence.css';

export interface OverviewConfidenceProps extends Partial<Omit<OverviewConfidenceSummary, 'state'>> {
  state: OverviewConfidenceSummary['state'];
  hidden?: boolean;
  baselineScore?: number | null;
  preparedScore?: number | null;
  previousScore?: number | null;
  computing?: boolean;
  showResult?: boolean;
  onReview?: () => void;
  onOpenChange?: (open: boolean) => void;
}
const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const format = (value: number) => value > 0 && value < .1 ? '<0.1' : value > 99.9 && value < 100 ? '>99.9' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);
const spokenScore = (value: number) => value > 0 && value < .1 ? '0점 초과, 0.1점 미만' : value > 99.9 && value < 100 ? '99.9점 초과, 100점 미만' : `${format(value)}점`;

/** The canvas shows only the stored numeric estimate and its A–F grade. */
export default function OverviewConfidence({ confidence, state, hidden = false, baselineScore, preparedScore, previousScore, computing = state === 'pending', showResult = true }: OverviewConfidenceProps) {
  if (hidden) return null;
  const before = valid(baselineScore) ? baselineScore : null;
  const posterior = ['ready', 'incomplete'].includes(state) && confidence?.bayesian?.status !== 'UNASSESSED' ? confidence?.bayesian?.score : null;
  const measured = valid(preparedScore) ? preparedScore : typeof posterior === 'number' && !computing ? posterior * 100 : null;
  const current = showResult && valid(measured) ? measured : before;
  const after = computing && valid(previousScore) ? previousScore : current;
  const changed = !computing && showResult && valid(after) && valid(before) && Math.abs(after - before) > .00001;
  const label = valid(after) ? `${computing ? '이전 ' : ''}신뢰도 ${spokenScore(after)} ${confidenceGrade(after / 100)}등급${computing ? ', 다시 계산 중' : ''}` : computing ? '신뢰도 계산 중' : '신뢰도 미평가';
  return <div className={`overview-confidence oc-compact${changed ? ' has-change' : ''}${computing ? ' is-computing' : ''}`} data-overview-confidence data-confidence-computing={computing || undefined} role="status" aria-live="polite" aria-atomic="true" aria-busy={computing} aria-label={label}>
    {changed && <><span className="oc-before">{format(before)} <b>{confidenceGrade(before / 100)}</b></span><span className="oc-arrow" aria-hidden="true">→</span></>}
    {valid(after) && <><span className="oc-number" key={after}>{format(after)}</span><span className="oc-grade" data-confidence-grade={confidenceGrade(after / 100)}>{confidenceGrade(after / 100)}</span></>}
    {computing ? <span className="oc-computing" aria-hidden="true">Calculating<span className="oc-dots"><i>.</i><i>.</i><i>.</i></span></span> : !valid(after) && <span className="oc-unassessed">Not rated</span>}
  </div>;
}
