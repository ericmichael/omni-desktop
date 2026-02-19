import { motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { forwardRef } from 'react';

import { cn } from '@/renderer/ds/cn';

type Size = 'sm' | 'md' | 'lg';

type IconButtonProps = {
  'aria-label': string;
  icon: ReactNode;
  size?: Size;
  isDisabled?: boolean;
  onClick?: () => void;
  className?: string;
};

const sizeClasses: Record<Size, string> = {
  sm: 'size-8 text-base',
  md: 'size-10 text-lg',
  lg: 'size-12 text-xl',
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ icon, size = 'md', isDisabled, className, onClick, ...rest }, ref) => {
    return (
      <motion.button
        ref={ref}
        whileHover={isDisabled ? undefined : { scale: 1.1 }}
        whileTap={isDisabled ? undefined : { scale: 0.9 }}
        transition={{ duration: 0.15 }}
        className={cn(
          'inline-flex items-center justify-center rounded-lg text-fg-muted cursor-pointer select-none',
          'hover:bg-white/5 hover:text-fg transition-colors',
          'focus-visible:outline-2 focus-visible:outline-accent-500/50 focus-visible:outline-offset-2',
          'disabled:opacity-40 disabled:pointer-events-none',
          sizeClasses[size],
          className
        )}
        disabled={isDisabled}
        onClick={onClick}
        aria-label={rest['aria-label']}
      >
        {icon}
      </motion.button>
    );
  }
);

IconButton.displayName = 'IconButton';
