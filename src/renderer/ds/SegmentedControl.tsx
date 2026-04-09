import { motion } from 'framer-motion';

import { cn } from '@/renderer/ds/cn';

type SegmentedControlProps<T extends string> = {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  layoutId?: string;
  className?: string;
};

export const SegmentedControl = <T extends string>({
  value,
  options,
  onChange,
  layoutId = 'segmented-control',
  className,
}: SegmentedControlProps<T>) => (
  <div
    className={cn(
      'inline-flex items-center gap-0.5 rounded-xl bg-surface-overlay p-0.5',
      className
    )}
  >
    {options.map((opt) => {
      const isActive = value === opt.value;
      return (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            'relative px-3 py-1.5 sm:px-2.5 sm:py-1 text-sm sm:text-xs font-medium rounded-lg sm:rounded-md transition-colors cursor-pointer select-none',
            isActive ? 'text-fg' : 'text-fg-muted hover:text-fg'
          )}
        >
          {isActive && (
            <motion.div
              layoutId={layoutId}
              className="absolute inset-0 bg-surface rounded-lg sm:rounded-md shadow-sm"
              transition={{ type: 'spring', duration: 0.3, bounce: 0.15 }}
            />
          )}
          <span className="relative z-10">{opt.label}</span>
        </button>
      );
    })}
  </div>
);
