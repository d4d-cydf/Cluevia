import { GraphValidationError } from '../src/lib/graph-document.ts';
import type { GraphGenerationInput } from '../src/types/graph.ts';
import type { OntologyDefinition, OntologyExtraction } from '../src/types/ontology.ts';
import { extractionSchema, InsufficientEvidenceError, parseExtraction } from './ontology.ts';

const collections = ['entities', 'relationships', 'events', 'findings'] as const;
type Collection = typeof collections[number];
const limits = extractionSchema.properties as Record<Collection, { maxItems: number }>;

/** Last-resort recovery after the caller has exhausted its bounded model repair.
 * Each retained item still passes the ordinary provenance and ontology validator.
 * This never manufactures missing properties, identities, sources or connections. */
export function recoverExtraction(value: unknown, input: GraphGenerationInput, definition?: OntologyDefinition): OntologyExtraction | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const raw = value as Record<string, unknown>;
  for (const field of collections) {
    const items = raw[field];
    if (!Array.isArray(items) || items.length > limits[field].maxItems) return;
  }

  // Keep the complete envelope so unknown root fields and invalid summaries or
  // limitations cannot disappear merely because individual items are recoverable.
  const envelope = { ...raw, entities: [], relationships: [], events: [], findings: [] };
  try {
    parseExtraction(envelope, input, definition);
    return; // An empty envelope cannot be an ordinary validated extraction.
  } catch (error) {
    if (!(error instanceof InsufficientEvidenceError)) {
      if (error instanceof GraphValidationError) return;
      throw error;
    }
  }

  let recovered = envelope as unknown as OntologyExtraction;
  const omitted: Record<Collection, number> = { entities: 0, relationships: 0, events: 0, findings: 0 };
  // Entities establish references first. Subsequent full validation also checks
  // collisions and cardinality against everything already retained. The schema
  // bounds keep this deliberately conservative O(n²) pass finite.
  for (const field of collections) {
    if (field !== 'entities' && !recovered.entities.length) return;
    for (const item of raw[field] as unknown[]) {
      try {
        recovered = parseExtraction({ ...recovered, [field]: [...recovered[field], item] }, input, definition);
      } catch (error) {
        if (!(error instanceof GraphValidationError)) throw error;
        omitted[field]++;
      }
    }
  }
  if (!recovered.entities.length) return;
  if (Object.values(omitted).some(count => count > 0)) {
    const note = `검증을 통과하지 못한 객체 ${omitted.entities}개·관계 ${omitted.relationships}개·사건 ${omitted.events}개·발견 사항 ${omitted.findings}개를 제외했습니다. 원문은 보존했으며 검증된 항목만 표시합니다. 누락된 연결과 결론은 추가 검토가 필요합니다.`;
    recovered.limitations = [note, ...recovered.limitations.slice(0, 19)];
    recovered.summary = `원자료와 일치하는 객체 ${recovered.entities.length}개·관계 ${recovered.relationships.length}개를 표시합니다. 일부 항목은 검증을 통과하지 못해 제외했으며, 결론과 누락된 연결은 추가 검토가 필요합니다.`;
  }
  return parseExtraction(recovered, input, definition);
}
