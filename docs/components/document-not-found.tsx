'use client';

import { usePathname } from 'next/navigation';
import { languageFromPath } from '@/lib/document-language';
import { localizeNode } from '@/lib/localize';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

export default function NotFound() {
  const language = languageFromPath(usePathname());
  return localizeNode(<main className="not-found"><p className="eyebrow">CASE NOT FOUND · 404</p><h1>이 문서는 찾지 못했어요.</h1><p>문서 목록에서 필요한 단서를 다시 찾아보세요.</p><Link className="action-primary" href="/docs"><ArrowLeft size={16} /> 문서로 돌아가기</Link></main>, language);
}
