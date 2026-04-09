import type { PropsWithChildren } from 'react';

import { cn } from '@/renderer/ds/cn';

type CardProps = {
  divided?: boolean;
  className?: string;
};

export const Card = ({ divided, className, children }: PropsWithChildren<CardProps>) => (
  <div
    className={cn(
      'bg-surface-raised/50 rounded-lg border border-surface-border/50',
      divided ? 'divide-y divide-surface-border/50' : 'p-4 flex flex-col gap-3',
      className
    )}
  >
    {children}
  </div>
);
