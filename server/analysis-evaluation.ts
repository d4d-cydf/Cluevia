import type { OntologyExtraction } from '../src/types/ontology.ts';

export interface GoldCase {
  id: string; text: string; entities: string[];
  relations: { source: string; target: string; type: string; stance: string }[];
}
/** Synthetic, hand-labelled regression corpus. It contains no real-person allegations. */
export const goldCases: GoldCase[] = [
  { id: 'ownership', text: 'Synthetic registry: company Aster (ORG-101) owns generator Nova (ASSET-101).', entities: ['ORG-101', 'ASSET-101'], relations: [{ source: 'ORG-101', target: 'ASSET-101', type: 'owns', stance: 'asserted' }] },
  { id: 'employment', text: 'Synthetic personnel register: researcher Mina (PERSON-201) is part of laboratory Boreal (ORG-201).', entities: ['PERSON-201', 'ORG-201'], relations: [{ source: 'PERSON-201', target: 'ORG-201', type: 'part_of', stance: 'asserted' }] },
  { id: 'logistics', text: 'Synthetic inventory: pump Delta (ASSET-301) is located in warehouse Elm (PLACE-301).', entities: ['ASSET-301', 'PLACE-301'], relations: [{ source: 'ASSET-301', target: 'PLACE-301', type: 'located_in', stance: 'asserted' }] },
  { id: 'denial', text: 'Synthetic statement: company Aster (ORG-101) denied that it owns generator Nova (ASSET-101). Ownership is unverified.', entities: ['ORG-101', 'ASSET-101'], relations: [{ source: 'ORG-101', target: 'ASSET-101', type: 'owns', stance: 'denied' }] },
  { id: 'retraction', text: 'Synthetic correction: company Aster (ORG-101) retracted its earlier claim that it owns generator Nova (ASSET-101). No ownership is established.', entities: ['ORG-101', 'ASSET-101'], relations: [{ source: 'ORG-101', target: 'ASSET-101', type: 'owns', stance: 'retracted' }] },
  { id: 'homonyms', text: 'Synthetic registry: Alex (PERSON-401) is part of company Alder (ORG-401). A different Alex (PERSON-402) is part of company Birch (ORG-402). These are different people.', entities: ['PERSON-401', 'PERSON-402', 'ORG-401', 'ORG-402'], relations: [{ source: 'PERSON-401', target: 'ORG-401', type: 'part_of', stance: 'asserted' }, { source: 'PERSON-402', target: 'ORG-402', type: 'part_of', stance: 'asserted' }] },
];

export function scoreExtraction(gold: GoldCase, extraction: OntologyExtraction) {
  const identities = new Map(extraction.entities.map(entity => [entity.id, gold.entities.filter(value => entity.identifiers.some(identifier => identifier.value === value) || entity.label.includes(value) || entity.properties.some(property => property.value === value))]));
  const found = new Set([...identities.values()].filter(ids => ids.length === 1).flat());
  const actual = new Set(extraction.relationships.map(relation => JSON.stringify([identities.get(relation.source)?.[0], identities.get(relation.target)?.[0], relation.type, relation.claim?.stance ?? 'unspecified'])));
  const expected = new Set(gold.relations.map(relation => JSON.stringify([relation.source, relation.target, relation.type, relation.stance])));
  const truePositives = [...actual].filter(item => expected.has(item)).length;
  return { entityPrecision: extraction.entities.length ? found.size / extraction.entities.length : 0, entityRecall: gold.entities.filter(id => found.has(id)).length / gold.entities.length,
    relationPrecision: actual.size ? truePositives / actual.size : expected.size ? 0 : 1,
    relationRecall: expected.size ? truePositives / expected.size : 1,
    wrongMerges: [...identities.values()].filter(ids => ids.length > 1).length,
    stanceErrors: extraction.relationships.filter(relation => gold.relations.some(expected => identities.get(relation.source)?.includes(expected.source) && identities.get(relation.target)?.includes(expected.target) && relation.type === expected.type && relation.claim?.stance !== expected.stance)).length };
}
