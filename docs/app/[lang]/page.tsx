import { notFound } from 'next/navigation';
import { Home } from '@/components/home';
import { isDocumentLanguage } from '@/lib/document-language';
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isDocumentLanguage(lang) || lang === 'ko') notFound();
  return <Home language={lang} />;
}
export function generateStaticParams() { return ['en', 'ja', 'zh'].map(lang => ({ lang })); }
export const dynamicParams = false;
