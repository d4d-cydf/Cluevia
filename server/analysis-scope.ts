import type { AnalysisBrief } from '../src/types/clarification.ts';

export function scopeExclusion(sourceName: string, text: string, brief?: AnalysisBrief, row?: unknown): string | undefined {
  const filters = brief?.filters;
  if (!filters) return;
  if (filters.sourceNames.length && !filters.sourceNames.includes(sourceName)) return '사용자가 선택한 자료 범위 밖입니다. 원문은 보존했습니다.';
  if (!filters.dateField || (!filters.dateFrom && !filters.dateTo) || !row || typeof row !== 'object' || Array.isArray(row)) return;
  // A date outside the period can still report a correction about the requested period.
  if (/deny|denie|refut|retract|correct|previous|former|not\b|부인|반박|정정|철회|이전|앞서|않|아니/u.test(text.toLowerCase())) return;
  const value = (row as Record<string, unknown>)[filters.dateField];
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) || !Number.isFinite(Date.parse(value))) return;
  const day = value.slice(0, 10);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return;
  if ((filters.dateFrom && day < filters.dateFrom) || (filters.dateTo && day > filters.dateTo)) return `${filters.dateField}=${day}: 확정한 기간 밖입니다. 원문은 보존했고 날짜 불명·정정·반증 자료는 계속 분석합니다.`;
}
