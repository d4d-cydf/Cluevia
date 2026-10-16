export type ConfidenceGrade = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
export const sourceGradeCoefficients: Record<ConfidenceGrade, number> = { A: 1, B: .8, C: .6, D: .4, E: .2, F: 0 };
export function sourceGradeCoefficient(grade: ConfidenceGrade | null): number { return grade === null ? 0 : sourceGradeCoefficients[grade]; }
/** Unrounded 0–1 score; exact boundaries stay in the lower band. */
export function confidenceGrade(score: number): ConfidenceGrade {
  if (!Number.isFinite(score) || score < 0 || score > 1) throw new RangeError('Confidence score must be between 0 and 1.');
  return score === 0 ? 'F' : score <= .2 ? 'E' : score <= .4 ? 'D' : score <= .6 ? 'C' : score <= .8 ? 'B' : 'A';
}
