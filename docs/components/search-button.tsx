'use client';

import { localizeNode, translateText } from '@/lib/localize';
import type { DocumentLanguage } from '@/lib/document-language';


import { useEffect, useState } from 'react';
import { useSearchContext } from 'fumadocs-ui/contexts/search';
import { Search } from 'lucide-react';

export function SearchButton({ large = false, language = 'ko' }: { large?: boolean; language?: DocumentLanguage }) {
  const { setOpenSearch } = useSearchContext();
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return localizeNode(
    <button type="button" disabled={!ready} aria-label="문서 검색" onClick={() => setOpenSearch(true)} className={`search-trigger${large ? ' search-trigger-large' : ''}`}>
      <Search size={16} aria-hidden="true" />
      <span>문서 검색<span className="search-hint"> — 궁금한 것부터 찾아보세요</span></span>
      <kbd>⌘ / Ctrl K</kbd>
    </button>, language
  );
}
