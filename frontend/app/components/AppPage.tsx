import { PageFrame } from '@gaulatti/bleecker';
import type { ReactNode } from 'react';

interface AppPageProps {
  children: ReactNode;
  className?: string;
  width?: 'content' | 'wide' | 'full';
}

export function AppPage({ children, className = '', width = 'content' }: AppPageProps) {
  return (
    <PageFrame as='main' width={width} gutter='comfortable' verticalSpacing='comfortable' className={`alcantara-page ${className}`}>
      {children}
    </PageFrame>
  );
}
