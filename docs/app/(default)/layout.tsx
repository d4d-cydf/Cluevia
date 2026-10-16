import type { ReactNode } from 'react';
import { SiteLayout } from '@/components/site-layout';
export { metadata } from '@/components/site-layout';
export default function Layout({ children }: { children: ReactNode }) {
  return <SiteLayout>{children}</SiteLayout>;
}
