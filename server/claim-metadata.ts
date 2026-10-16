import { GRAPH_LIMITS } from '../src/lib/graph-document.ts';
import type { GraphGenerationInput } from '../src/types/graph.ts';
import { containsIdentifier } from './ontology.ts';

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const fields = ['attributedTo', 'derivedFrom'] as const;

/** Optional attribution cannot invalidate an otherwise grounded relationship.
 * Remove only unsupported attribution strings, never repair the relationship,
 * alter its stance, widen its quotation, or assign an author from document metadata. */
export function normalizeClaimMetadata(value: unknown, input: GraphGenerationInput): { value: unknown; changed: boolean } {
  const unchanged = { value, changed: false };
  if (!record(value) || !Array.isArray(value.relationships) || value.relationships.length > GRAPH_LIMITS.edges || !Array.isArray(value.limitations) || value.limitations.length > 20 || value.limitations.some(note => typeof note !== 'string' || !note.trim() || note.length > 1000)) return unchanged;
  const sources = new Map(input.documents.map(document => [document.id, document.text]));
  // Ambiguous source IDs remain a validation failure, not an attribution repair.
  if (sources.size !== input.documents.length) return unchanged;
  let removed = 0;
  const relationships = value.relationships.map(relation => {
    if (!record(relation) || !record(relation.claim) || !Array.isArray(relation.evidence)) return relation;
    const quotes = relation.evidence.flatMap(item => {
      if (!record(item) || typeof item.documentId !== 'string' || typeof item.quote !== 'string' || item.quote.length < 8 || item.quote.length > 1600 || !item.quote.trim() || !sources.get(item.documentId)?.includes(item.quote)) return [];
      return [item.quote];
    });
    let claim: Record<string, unknown> | undefined;
    for (const field of fields) {
      const supplied = relation.claim[field];
      // Malformed values still go to the ordinary validator unchanged.
      if (typeof supplied !== 'string' || !supplied.trim() || supplied.length > 500 || quotes.some(quote => containsIdentifier(quote, supplied))) continue;
      claim ??= { ...relation.claim };
      claim[field] = null;
      removed++;
    }
    return claim ? { ...relation, claim } : relation;
  });
  if (!removed) return unchanged;
  const notice = `인용문에서 확인되지 않은 선택적 주장 주체·재인용 출처 ${removed}개를 비워 두었습니다. 관계와 인용문은 유지했으며 해당 출처 정보는 추가 확인이 필요합니다.`;
  return { value: { ...value, relationships, limitations: [notice, ...value.limitations.slice(0, 19)] }, changed: true };
}
