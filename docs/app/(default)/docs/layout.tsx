import type { ReactNode } from 'react';
import { DocumentLayout } from '@/components/document-layout';
export default function Layout({ children }: { children: ReactNode }) { return <DocumentLayout>{children}</DocumentLayout>; }
