import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { SiteLayout } from '@/components/site-layout';
import { isDocumentLanguage } from '@/lib/document-language';
import { metadata as baseMetadata } from '@/components/site-layout';
export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const descriptions: Record<string, string> = {
    en: 'Cluevia algorithm research notes: Why-not Tree, Gap Find, Gap Fill, source provenance, and confidence evaluation.',
    ja: 'Clueviaのアルゴリズム研究ノート。Why-not Tree、Gap Find、Gap Fill、出典の系譜と信頼度評価を記述する。',
    zh: 'Cluevia 算法研究文档：Why-not Tree、Gap Find、Gap Fill、来源谱系及可信度评估。',
  };
  return { ...baseMetadata, description: descriptions[lang] };
}
export default async function Layout({ children, params }: { children: ReactNode; params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isDocumentLanguage(lang) || lang === 'ko') notFound();
  return <SiteLayout language={lang}>{children}</SiteLayout>;
}
