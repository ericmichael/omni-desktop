import { forwardRef } from 'react';

import { cn } from '@/renderer/ds/cn';

type Size = 'sm' | 'md' | 'lg';

type InputProps = {
  size?: Size;
  mono?: boolean;
  className?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'>;

const sizeClasses: Record<Size, string> = {
  sm: 'h-9 px-3 text-sm sm:h-8 sm:px-2 sm:text-xs',
  md: 'h-10 px-3 text-base sm:h-9 sm:px-2.5 sm:text-sm',
  lg: 'h-12 px-4 text-base sm:h-10 sm:px-3 sm:text-sm',
};

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ size = 'md', mono, className, ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={cn(
          'rounded-lg border border-surface-border/50 bg-transparent text-fg outline-none transition-colors',
          'placeholder:text-fg-muted/50',
          'focus:border-accent-500/50',
          'disabled:opacity-40 disabled:cursor-not-allowed',
          sizeClasses[size],
          mono && 'font-mono',
          className
        )}
        {...props}
      />
    );
  }
);
Input.displayName = 'Input';
