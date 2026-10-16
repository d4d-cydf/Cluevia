import { source } from '@/lib/source';
import { DocumentPage, documentMetadata } from '@/components/document-page';
export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
  return <DocumentPage slug={(await params).slug} />;
}
export function generateStaticParams() { return source.generateParams().filter(page => page.lang === 'ko'); }
export async function generateMetadata({ params }: { params: Promise<{ slug?: string[] }> }) {
  return documentMetadata((await params).slug, 'ko');
}
