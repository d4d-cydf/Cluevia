import { documentLanguages, type DocumentLanguage } from '@/lib/document-language';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import { LanguageSwitcher } from '@/components/language-switcher';
import 'katex/dist/katex.min.css';
import '@/app/global.css';

export const metadata: Metadata = {
  title: { default: 'Cluevia — Algorithm Research Notes', template: '%s · Cluevia Docs' },
  description: 'Why-not Tree로 자료와 논리를 연결하고 Gap Find·Gap Fill을 수행하는 Cluevia의 메인 알고리즘 지침서. 출처 계보, 신뢰도 계산과 공백별 보완 액션을 설명합니다.',
  icons: { icon: '/brand/favicon-64.png' },
};

export function SiteLayout({ children, language = 'ko' }: { children: ReactNode; language?: DocumentLanguage }) {
  return <html lang={documentLanguages.find(item => item.code === language)!.htmlLang} suppressHydrationWarning>
    <body><Providers>{children}<LanguageSwitcher placement="floating" /></Providers></body>
  </html>;
}
