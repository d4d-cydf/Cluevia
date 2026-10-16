'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Check, ChevronUp, Languages } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from 'fumadocs-ui/components/ui/popover';
import { documentLanguages, languageFromPath, languageHref } from '@/lib/document-language';

const labels = {
  ko: { choose: '문서 언어 선택', language: '문서 언어', note: '현재 문서의 번역본으로 이동합니다.' },
  en: { choose: 'Choose document language', language: 'Document language', note: 'Read this document in your preferred language.' },
  ja: { choose: '文書の言語を選択', language: '文書の言語', note: '同じ文書の翻訳版に切り替えます。' },
  zh: { choose: '选择文档语言', language: '文档语言', note: '切换至当前文档的对应译本。' },
};

export function LanguageSwitcher({ placement = 'sidebar' }: { placement?: 'sidebar' | 'floating' }) {
  const pathname = usePathname();
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const current = languageFromPath(pathname);
  const selected = documentLanguages.find(language => language.code === current)!;
  const copy = labels[current];
  const [open, setOpen] = useState(false);
  const [suffix, setSuffix] = useState('');
  const items = useRef<(HTMLAnchorElement | null)[]>([]);

  function changeOpen(next: boolean) {
    if (next) setSuffix(window.location.search + window.location.hash);
    setOpen(next);
  }

  function navigateOptions(event: KeyboardEvent) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const enabled = items.current.filter((item): item is HTMLAnchorElement => !!item);
    if (!enabled.length) return;
    event.preventDefault();
    const index = enabled.findIndex(item => item === document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
    enabled[next].focus();
  }

  return <div className={`document-language language-${placement}${/^\/(?:en\/|ja\/|zh\/)?docs(?:\/|$)/.test(pathname) ? ' is-docs' : ''} notranslate`} translate="no">
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger disabled={!ready} className="language-trigger" aria-label={`${copy.choose} · ${selected.label}`} title={copy.choose}>
        <Languages size={17} strokeWidth={1.6} aria-hidden="true" />
        <span>{selected.label}</span><span className="language-code">{selected.short}</span>
        <ChevronUp size={13} className="language-chevron" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={9} collisionPadding={12} className="language-popover notranslate" translate="no" aria-label={copy.choose}>
        <div className="language-popover-heading"><span>LANGUAGE</span><span>{copy.language}</span></div>
        <div role="menu" aria-label={copy.choose} onKeyDown={navigateOptions}>
          {documentLanguages.map((language, index) => <Link key={language.code} ref={element => { items.current[index] = element; }}
            href={languageHref(pathname + suffix, language.code)} hrefLang={language.htmlLang} prefetch={false}
            role="menuitemradio" aria-checked={current === language.code} className="language-option" data-current={current === language.code}
            onClick={event => { if (current === language.code) event.preventDefault(); setOpen(false); }}>
            <span className="language-option-code">{language.short}</span>
            <span className="language-option-name"><span lang={language.htmlLang}>{language.label}</span><small lang={language.htmlLang}>{language.subtitle}</small></span>
            {current === language.code && <Check size={15} aria-hidden="true" />}
          </Link>)}
        </div>
        <p className="language-popover-note">{copy.note}</p>
      </PopoverContent>
    </Popover>
  </div>;
}
