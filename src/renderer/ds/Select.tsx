import { forwardRef } from 'react';

import { cn } from '@/renderer/ds/cn';

type Size = 'sm' | 'md' | 'lg';

type SelectProps = {
  size?: Size;
  className?: string;
} & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'>;

const sizeClasses: Record<Size, string> = {
  sm: 'h-9 px-3 text-sm sm:h-8 sm:px-2 sm:text-xs',
  md: 'h-10 px-3 text-base sm:h-9 sm:px-2.5 sm:text-sm',
  lg: 'h-12 px-4 text-base sm:h-10 sm:px-3 sm:text-sm',
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ size = 'md', className, children, ...props }, ref) => {
    return (
      <select
        ref={ref}
        className={cn(
          'rounded-lg border border-surface-border/50 bg-surface text-fg cursor-pointer outline-none transition-colors',
          'focus:border-accent-500/50',
          'disabled:opacity-40 disabled:cursor-not-allowed',
          sizeClasses[size],
          className
        )}
        {...props}
      >
        {children}
      </select>
    );
  }
);
Select.displayName = 'Select';
