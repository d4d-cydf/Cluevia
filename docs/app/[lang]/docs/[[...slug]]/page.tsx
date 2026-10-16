import { notFound } from 'next/navigation';
import { source } from '@/lib/source';
import { isDocumentLanguage } from '@/lib/document-language';
import { DocumentPage, documentMetadata } from '@/components/document-page';
type Params = Promise<{ lang: string; slug?: string[] }>;
export default async function Page({ params }: { params: Params }) {
  const { lang, slug } = await params;
  if (!isDocumentLanguage(lang) || lang === 'ko') notFound();
  return <DocumentPage slug={slug} language={lang} />;
}
export function generateStaticParams() { return source.generateParams().filter(page => page.lang !== 'ko'); }
export const dynamicParams = false;
export async function generateMetadata({ params }: { params: Params }) {
  const { lang, slug } = await params;
  if (!isDocumentLanguage(lang)) notFound();
  return documentMetadata(slug, lang);
}
