import type { ReactNode } from 'react';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { source } from '@/lib/source';
import { baseOptions } from '@/lib/layout.shared';
import { LanguageSwitcher } from '@/components/language-switcher';
import type { DocumentLanguage } from '@/lib/document-language';

export function DocumentLayout({ children, language = 'ko' }: { children: ReactNode; language?: DocumentLanguage }) {
  return (
    <DocsLayout {...baseOptions(language)} tree={source.getPageTree(language)} tabs={false}
      sidebar={{ defaultOpenLevel: 1, banner: <div className="sidebar-edition"><span className="status-dot" /> ALGORITHM RESEARCH NOTES <span>v0.1</span></div>, footer: <LanguageSwitcher /> }}>
      {children}
    </DocsLayout>
  );
}
