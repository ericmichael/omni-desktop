import type { PropsWithChildren } from 'react';

import { cn } from '@/renderer/ds/cn';

type SectionLabelProps = {
  className?: string;
};

export const SectionLabel = ({ className, children }: PropsWithChildren<SectionLabelProps>) => (
  <span className={cn('text-sm sm:text-xs font-medium uppercase tracking-wider text-fg-subtle', className)}>
    {children}
  </span>
);
