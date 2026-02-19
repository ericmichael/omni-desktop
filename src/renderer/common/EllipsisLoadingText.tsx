import type { HTMLAttributes } from 'react';

import { cn } from '@/renderer/ds';

type EllipsisLoadingTextProps = HTMLAttributes<HTMLSpanElement>;

export const EllipsisLoadingText = ({ className, children, ...rest }: EllipsisLoadingTextProps) => {
  return (
    <span className={cn('after:inline-block after:animate-ellipsis after:content-["…"]', className)} {...rest}>
      {children}
    </span>
  );
};
