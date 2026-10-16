export const documentLanguages = [
  { code: 'ko', label: '한국어', subtitle: '한국어 원문', short: 'KO', htmlLang: 'ko' },
  { code: 'en', label: 'English', subtitle: 'English edition', short: 'EN', htmlLang: 'en' },
  { code: 'ja', label: '日本語', subtitle: '日本語版', short: 'JA', htmlLang: 'ja' },
  { code: 'zh', label: '中文', subtitle: '简体中文版', short: 'ZH', htmlLang: 'zh-CN' },
] as const;
export type DocumentLanguage = (typeof documentLanguages)[number]['code'];
export function isDocumentLanguage(value: string): value is DocumentLanguage {
  return documentLanguages.some(language => language.code === value);
}
export function languageFromPath(pathname: string): DocumentLanguage {
  const first = pathname.split('/')[1];
  return isDocumentLanguage(first) ? first : 'ko';
}
/** Keep the document, query, and original heading anchor when changing editions. */
export function languageHref(path: string, language: DocumentLanguage): string {
  const url = new URL(path, 'https://docs.invalid');
  const unprefixed = url.pathname.replace(/^\/(en|ja|zh)(?=\/|$)/, '') || '/';
  const localized = language === 'ko' ? unprefixed : `/${language}${unprefixed}`;
  return `${localized.endsWith('/') ? localized : `${localized}/`}${url.search}${url.hash}`;
}
export function localizeHref(href: string, language: DocumentLanguage): string {
  return /^\/(?:docs(?:\/|$)|(?:en|ja|zh)(?:\/|$)|$)/.test(href) ? languageHref(href, language) : href;
}
