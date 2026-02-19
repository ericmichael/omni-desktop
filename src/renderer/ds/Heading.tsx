import type { HTMLAttributes } from 'react';
import { forwardRef } from 'react';

import { cn } from '@/renderer/ds/cn';

type HeadingLevel = 'h1' | 'h2' | 'h3';

type HeadingProps = {
  as?: HeadingLevel;
  size?: 'sm' | 'md' | 'lg';
} & HTMLAttributes<HTMLHeadingElement>;

const sizeClasses = {
  sm: 'text-base font-semibold tracking-tight',
  md: 'text-xl font-bold tracking-tight',
  lg: 'text-2xl font-bold tracking-tight',
};

export const Heading = forwardRef<HTMLHeadingElement, HeadingProps>(
  ({ as: Tag = 'h2', size = 'md', className, ...props }, ref) => {
    return <Tag ref={ref} className={cn('text-fg', sizeClasses[size], className)} {...props} />;
  }
);

Heading.displayName = 'Heading';
