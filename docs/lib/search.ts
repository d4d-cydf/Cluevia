import { createFromSource } from 'fumadocs-core/search/server';
import { source } from '@/lib/source';
import type { DocumentLanguage } from '@/lib/document-language';

/** Each edition downloads only its own searchable text. */
export function searchForLanguage(language: DocumentLanguage) {
  return createFromSource({ ...source, getPages: () => source.getPages(language) });
}
