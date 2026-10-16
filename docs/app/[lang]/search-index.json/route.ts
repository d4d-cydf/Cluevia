import { searchForLanguage } from '@/lib/search';
import { isDocumentLanguage } from '@/lib/document-language';
export async function GET(_request: Request, { params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isDocumentLanguage(lang) || lang === 'ko') return new Response(null, { status: 404 });
  return searchForLanguage(lang).staticGET();
}
export function generateStaticParams() { return ['en', 'ja', 'zh'].map(lang => ({ lang })); }
export const dynamic = 'force-static';
