import type { PropsWithChildren } from 'react';

import { cn } from '@/renderer/ds/cn';

export const Strong = ({ children, className }: PropsWithChildren<{ className?: string }>) => {
  return <span className={cn('font-semibold', className)}>{children}</span>;
};
