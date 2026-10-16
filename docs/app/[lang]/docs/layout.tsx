import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { DocumentLayout } from '@/components/document-layout';
import { isDocumentLanguage } from '@/lib/document-language';
export default async function Layout({ children, params }: { children: ReactNode; params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isDocumentLanguage(lang)) notFound();
  return <DocumentLayout language={lang}>{children}</DocumentLayout>;
}
