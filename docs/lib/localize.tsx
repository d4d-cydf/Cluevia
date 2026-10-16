import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import en from './locales/en.json';
import ja from './locales/ja.json';
import zh from './locales/zh.json';
import { localizeHref, type DocumentLanguage } from './document-language';
const decodeEntities = (text: string) => text.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
const dictionaries: Record<string, Record<string, string>> = Object.fromEntries(
  Object.entries({ en, ja, zh }).map(([language, entries]) => [language,
    Object.fromEntries(Object.entries(entries).map(([key, value]) => [decodeEntities(key), decodeEntities(value)])),
  ]),
);
export function translateText(text: string, language: DocumentLanguage): string {
  if (language === 'ko' || !/[가-힣]/.test(text)) return text;
  const key = text.replace(/\s+/g, ' ').trim();
  const translated = dictionaries[language]?.[key];
  if (translated === undefined) return text;
  return `${text.match(/^\s*/)?.[0] ?? ''}${translated}${text.match(/\s*$/)?.[0] ?? ''}`;
}
/** Translate authored figure/UI labels; leave code, math, IDs, and handlers intact. */
export function localizeNode(node: ReactNode, language: DocumentLanguage): ReactNode {
  if (language === 'ko') return node;
  if (typeof node === 'string') return translateText(node, language);
  if (Array.isArray(node)) return Children.toArray(node).map(child => localizeNode(child, language));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<Record<string, unknown>>;
  const { props } = element;
  if (props.translate === 'no' || element.type === 'code' || element.type === 'pre') return element;
  const next: Record<string, unknown> = {};
  for (const key of ['title', 'aria-label', 'alt', 'placeholder']) {
    if (typeof props[key] === 'string') next[key] = translateText(props[key], language);
  }
  if (typeof props.href === 'string') next.href = localizeHref(props.href, language);
  if ('children' in props) next.children = localizeNode(props.children as ReactNode, language);
  return cloneElement(element, next);
}
