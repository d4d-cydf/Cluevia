import { searchForLanguage } from '@/lib/search';
export const { staticGET: GET } = searchForLanguage('ko');
export const dynamic = 'force-static';
