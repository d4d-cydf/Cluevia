'use client';

import { localizeNode, translateText } from '@/lib/localize';
import type { DocumentLanguage } from '@/lib/document-language';


import { Printer } from 'lucide-react';

export function PrintDocument({ language = 'ko' }: { language?: DocumentLanguage }) {
  return localizeNode(<button className="paper-print" type="button" onClick={() => window.print()} title="현재 문서를 인쇄하거나 PDF로 저장">
    <Printer size={14} aria-hidden="true" /><span>인쇄 / PDF</span>
  </button>, language);
}
