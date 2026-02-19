import { motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { forwardRef } from 'react';

import { cn } from '@/renderer/ds/cn';

type Variant = 'primary' | 'ghost' | 'destructive' | 'link';
type Size = 'sm' | 'md' | 'lg';

type ButtonProps = {
  variant?: Variant;
  size?: Size;
  isDisabled?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  onClick?: () => void;
  className?: string;
  type?: 'button' | 'submit' | 'reset';
  children?: ReactNode;
};

const variantClasses: Record<Variant, string> = {
  primary:
    'bg-gradient-to-b from-accent-500 to-accent-600 text-white shadow-md hover:from-accent-400 hover:to-accent-500 active:from-accent-600 active:to-accent-700',
  ghost: 'bg-transparent text-fg hover:bg-white/5 active:bg-white/10',
  destructive: 'bg-transparent text-fg-error hover:bg-red-400/10 active:bg-red-400/15',
  link: 'bg-transparent text-fg-muted hover:text-fg underline-offset-4 hover:underline',
};

const sizeClasses: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5 rounded-md',
  md: 'h-9 px-4 text-sm gap-2 rounded-lg',
  lg: 'h-11 px-6 text-base gap-2.5 rounded-lg',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', isDisabled, leftIcon, rightIcon, className, children, onClick, type }, ref) => {
    return (
      <motion.button
        ref={ref}
        whileHover={isDisabled ? undefined : { scale: 1.02 }}
        whileTap={isDisabled ? undefined : { scale: 0.98 }}
        transition={{ duration: 0.15 }}
        className={cn(
          'inline-flex items-center justify-center font-medium transition-colors cursor-pointer select-none',
          'focus-visible:outline-2 focus-visible:outline-accent-500/50 focus-visible:outline-offset-2',
          'disabled:opacity-40 disabled:pointer-events-none',
          variantClasses[variant],
          sizeClasses[size],
          className
        )}
        disabled={isDisabled}
        onClick={onClick}
        type={type}
      >
        {leftIcon}
        {children}
        {rightIcon}
      </motion.button>
    );
  }
);

Button.displayName = 'Button';
