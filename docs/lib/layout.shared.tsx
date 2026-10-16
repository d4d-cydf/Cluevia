import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { languageHref, type DocumentLanguage } from '@/lib/document-language';
import { translateText } from '@/lib/localize';
import { Brand } from '@/components/brand';
import { appUrl, repositoryUrl } from '@/lib/site';

export function baseOptions(language: DocumentLanguage = 'ko'): BaseLayoutProps {
  return {
    i18n: false,
    nav: { title: <Brand />, url: languageHref('/', language) },
    githubUrl: repositoryUrl,
    links: [{ text: translateText('앱 열기', language), url: appUrl, external: true }],
  };
}
