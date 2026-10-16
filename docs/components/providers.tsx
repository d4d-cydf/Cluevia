'use client';

import { RootProvider } from 'fumadocs-ui/provider/next';
import { defineI18nUI } from 'fumadocs-ui/i18n';
import { useEffect, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { i18n } from '@/lib/i18n';
import { documentLanguages, languageFromPath } from '@/lib/document-language';

const ui = defineI18nUI(i18n, {
  ko: {
    displayName: '한국어',
    'Search(search trigger)': '문서 검색', 'Search(search dialog)': '검색어를 입력하세요',
    'No results found(search dialog)': '검색 결과가 없습니다',
    'On this page(table of contents)': '이 페이지에서', 'Table of Contents(inline table of contents)': '목차',
    'Previous Page(pagination)': '이전 문서', 'Next Page(pagination)': '다음 문서',
    'Open Sidebar(sidebar)(aria-label)': '목차 열기', 'Close Sidebar(sidebar)(aria-label)': '목차 닫기',
    'Open Search(search trigger)(aria-label)': '문서 검색', 'Close Search(search dialog)(aria-label)': '검색 닫기',
  },
  en: { displayName: 'English' },
  ja: {
    displayName: '日本語',
    'Search(search trigger)': '文書を検索', 'Search(search dialog)': '検索語を入力',
    'No results found(search dialog)': '検索結果がありません',
    'On this page(table of contents)': 'このページの内容', 'Table of Contents(inline table of contents)': '目次',
    'Previous Page(pagination)': '前の文書', 'Next Page(pagination)': '次の文書',
    'Open Sidebar(sidebar)(aria-label)': '目次を開く', 'Close Sidebar(sidebar)(aria-label)': '目次を閉じる',
    'Open Search(search trigger)(aria-label)': '文書を検索', 'Close Search(search dialog)(aria-label)': '検索を閉じる',
  },
  zh: {
    displayName: '中文',
    'Search(search trigger)': '搜索文档', 'Search(search dialog)': '输入搜索词',
    'No results found(search dialog)': '没有搜索结果',
    'On this page(table of contents)': '本页内容', 'Table of Contents(inline table of contents)': '目录',
    'Previous Page(pagination)': '上一篇', 'Next Page(pagination)': '下一篇',
    'Open Sidebar(sidebar)(aria-label)': '打开目录', 'Close Sidebar(sidebar)(aria-label)': '关闭目录',
    'Open Search(search trigger)(aria-label)': '搜索文档', 'Close Search(search dialog)(aria-label)': '关闭搜索',
  },
});

export function Providers({ children }: { children: ReactNode }) {
  const language = languageFromPath(usePathname());
  useEffect(() => {
    document.documentElement.lang = documentLanguages.find(item => item.code === language)!.htmlLang;
  }, [language]);
  return <RootProvider i18n={ui.provider(language)} theme={{ defaultTheme: 'light', enableSystem: true }}
    search={{ options: { type: 'static', api: language === 'ko' ? '/search-index.json' : `/${language}/search-index.json` } }}>
    {children}
  </RootProvider>;
}
