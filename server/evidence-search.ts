/** Search terms are hints, never evidence or entity equivalences. */
const families = [
  ['자금', '거래', '입금', '송금', '지급', 'payment', 'paid', 'transfer', 'transaction'],
  ['고용', '직원', '근무', '소속', 'employment', 'employed', 'employee', 'works'],
  ['소유', '지분', '주주', 'ownership', 'owns', 'owned', 'shareholder'],
  ['부인', '반박', '철회', '정정', 'denied', 'denies', 'refuted', 'retracted', 'correction'],
];
const wordsIn = (text: string) => (text.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._:-]*/gu) ?? []).map(word => word.replace(/[._:-]+$/u, '')).filter(Boolean);
export function searchTerms(query: string): string[] {
  const words = wordsIn(query);
  const terms = new Set(words.filter(word => word.length > 1));
  for (const word of words) {
    const stem = word.replace(/(에서는|으로부터|에게서|에서|에게|으로|이랑|까지|부터|처럼|와의|과의|은|는|이|가|을|를|의|에|와|과)$/u, '');
    if (stem.length > 1) terms.add(stem);
  }
  for (const family of families) if (family.some(term => [...terms].some(word => word.includes(term)))) family.forEach(term => terms.add(term));
  return [...terms].slice(0, 80);
}
export function searchScore(text: string, terms: string[]): number {
  const normalized = text.normalize('NFKC').toLocaleLowerCase();
  return terms.reduce((score, term) => score + (normalized.includes(term) ? Math.min(8, 1 + term.length / 3) : 0), 0);
}
/** Exact substrings, with offsets. Never splice text into a fabricated quotation. */
export function relevantPassages(text: string, terms: string[], budget = 8000): { text: string; start: number; end: number }[] {
  if (text.length <= budget) return [{ text, start: 0, end: text.length }];
  const windows: { start: number; end: number; score: number }[] = [];
  for (let start = 0; start < text.length; start += 1000) {
    const end = Math.min(text.length, start + 1600);
    windows.push({ start, end, score: searchScore(text.slice(start, end), terms) });
  }
  windows.sort((a, b) => b.score - a.score || a.start - b.start);
  const selected: typeof windows = []; let remaining = budget;
  for (const window of windows) {
    if (remaining < 300) break;
    if (selected.some(other => window.start < other.end && window.end > other.start)) continue;
    const end = Math.min(window.end, window.start + remaining);
    selected.push({ ...window, end }); remaining -= end - window.start;
  }
  return selected.sort((a, b) => a.start - b.start).map(({ start, end }) => ({ start, end, text: text.slice(start, end) }));
}

/** Portable inverted index; Node SQLite builds do not all include FTS5. */
export function indexTerms(text: string): string[] {
  const words = wordsIn(text);
  const result = new Set<string>();
  for (const word of words) {
    if (word.length <= 150) result.add(word);
    for (const korean of word.match(/[가-힣]+/gu) ?? []) {
      for (let index = 0; index < korean.length - 1; index++) result.add(korean.slice(index, index + 2));
    }
  }
  return [...result];
}
