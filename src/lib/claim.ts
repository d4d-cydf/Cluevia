import type { RelationClaim } from '../types/claims.ts';

export const stanceLabels: Record<RelationClaim['stance'], string> = { asserted: '주장', denied: '부인', retracted: '철회', uncertain: '불확실' };
export function readRelationClaim(value: unknown): RelationClaim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('관계 주장 형식이 올바르지 않습니다.');
  const raw = value as Record<string, unknown>;
  if (!Object.hasOwn(stanceLabels, String(raw.stance))) throw new Error('관계의 주장·부인·철회 상태가 필요합니다.');
  const result: RelationClaim = { stance: raw.stance as RelationClaim['stance'], attributedTo: null, validFrom: null, validTo: null, publishedAt: null, derivedFrom: null };
  for (const key of ['attributedTo', 'validFrom', 'validTo', 'publishedAt', 'derivedFrom'] as const) {
    const item = raw[key];
    if (item === null) continue;
    if (typeof item !== 'string' || !item.trim() || item.length > 500) throw new Error(`주장 ${key} 값이 올바르지 않습니다.`);
    if (['validFrom', 'validTo', 'publishedAt'].includes(key) && (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(item) || !Number.isFinite(Date.parse(item)) || new Date(`${item.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== item.slice(0, 10))) throw new Error('주장에는 실제 ISO 날짜가 필요합니다.');
    result[key] = item;
  }
  if (result.validFrom && result.validTo && Date.parse(result.validTo) < Date.parse(result.validFrom)) throw new Error('관계 유효 기간이 역전되었습니다.');
  return result;
}
