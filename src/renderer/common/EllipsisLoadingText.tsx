import type { HTMLAttributes } from 'react';

import { cn } from '@/renderer/ds/cn';

type EllipsisLoadingTextProps = HTMLAttributes<HTMLSpanElement>;

export const EllipsisLoadingText = ({ className, children, ...rest }: EllipsisLoadingTextProps) => {
  return (
    <span className={cn('ellipsis-loading', className)} {...rest}>
      {children}
    </span>
  );
};
