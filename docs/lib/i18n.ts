import { defineI18n } from 'fumadocs-core/i18n';
export const i18n = defineI18n({
  languages: ['ko', 'en', 'ja', 'zh'],
  defaultLanguage: 'ko',
  hideLocale: 'default-locale',
  parser: 'dot',
  fallbackLanguage: null,
});
