import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/page';
import { source } from '@/lib/source';
import { getMDXComponents } from '@/mdx-components';
import { localizeNode } from '@/lib/localize';
import { languageHref, documentLanguages, type DocumentLanguage } from '@/lib/document-language';
import { PrintDocument } from '@/components/print-document';

const sections: Record<string, string> = {
  'main-algorithm': 'ALGORITHM & METHODOLOGY', algorithms: 'IMPLEMENTATION NOTES',
  concepts: 'CONCEPTUAL FRAMEWORK', reference: 'TECHNICAL REFERENCE',
  guide: 'APPLICATION GUIDE', development: 'DEVELOPMENT NOTES',
};

export function DocumentPage({ slug, language = 'ko' }: { slug?: string[]; language?: DocumentLanguage }) {
  const page = source.getPage(slug, language);
  if (!page) notFound();
  const MDX = page.data.body;
  return localizeNode(
    <DocsPage toc={page.data.toc} full={page.data.full} className="research-document" tableOfContent={{ style: 'clerk' }} breadcrumb={{ className: 'paper-breadcrumb' }} footer={{ className: 'paper-page-navigation' }}>
      <div className="paper-running-head"><span>CLUEVIA <i>/</i> TECHNICAL NOTES</span><PrintDocument language={language} /></div>
      <div className="doc-eyebrow">{sections[slug?.[0] || ''] || 'RESEARCH OVERVIEW'}</div>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <div className="paper-document-meta"><span>ALGORITHM SERIES · v0.1</span><span>{slug?.[0] === 'main-algorithm' || !slug?.length ? '설계 명세 · 구현 범위 · 검증 조건' : 'Cluevia 프로젝트 기술 문서'}</span></div>
      <DocsBody><MDX components={getMDXComponents(undefined, language)} /></DocsBody>
    </DocsPage>, language
  );
}

export function documentMetadata(slug: string[] | undefined, language: DocumentLanguage): Metadata {
  const page = source.getPage(slug, language);
  if (!page) notFound();
  const path = '/docs/' + (slug?.join('/') || '');
  return { title: page.data.title, description: page.data.description,
    alternates: { languages: Object.fromEntries(documentLanguages.map(item => [item.htmlLang, languageHref(path, item.code)])) },
  };
}
