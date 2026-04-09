import type { PropsWithChildren, ReactNode } from 'react';

import { cn } from '@/renderer/ds/cn';

type EmptyStateProps = {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
};

export const EmptyState = ({ title, description, action, className }: EmptyStateProps) => (
  <div className={cn('flex flex-col items-center justify-center gap-3 h-full px-6', className)}>
    <p className="text-fg-muted text-base sm:text-sm font-medium">{title}</p>
    {description && <p className="text-fg-subtle text-sm sm:text-xs text-center">{description}</p>}
    {action}
  </div>
);
