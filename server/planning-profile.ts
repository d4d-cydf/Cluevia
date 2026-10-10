import type { EvidenceDocument } from '../src/types/graph.ts';

/** Design previews only. Full originals are read again for extraction.
 * Retain column names, observed kinds and lengths even when examples are shortened. */
export function compactPlanningDocument(document: EvidenceDocument, targetChars: number): EvidenceDocument {
  const profile = JSON.parse(document.text) as Record<string, unknown>;
  if (Array.isArray(profile.columns)) {
    const columns = profile.columns.map(column => ({ ...(column as Record<string, unknown>) }));
    const result: Record<string, unknown> = { ...profile, columns, note: 'Schema design preview only; every column and observed type is retained. Examples are abbreviated, not factual evidence. Extraction reads complete originals.' };
    delete result.samples;
    let text = JSON.stringify(result);
    for (const length of [80, 40, 16, 0]) {
      if (text.length <= targetChars) break;
      for (const column of columns) {
        if (Array.isArray(column.examples)) column.examples = length ? column.examples.slice(0, length >= 80 ? 2 : 1).map(value => String(value).slice(0, length)) : [];
      }
      text = JSON.stringify(result);
    }
    // A wide schema may exceed the soft target. Never silently remove its columns.
    return { ...document, text };
  }
  const result: Record<string, unknown> = { ...profile, note: 'Schema design samples only; shortened previews are not factual evidence. Extraction reads complete originals.' };
  let text = JSON.stringify(result);
  for (let attempt = 0; text.length > targetChars && attempt < 10; attempt++) {
    for (const field of ['first', 'last']) if (typeof result[field] === 'string') result[field] = result[field].slice(0, Math.floor(result[field].length * 0.65));
    if (Array.isArray(result.samples)) result.samples = result.samples.map(sample => typeof sample === 'string' ? sample.slice(0, Math.floor(sample.length * 0.65)) : sample);
    text = JSON.stringify(result);
  }
  return { ...document, text };
}
