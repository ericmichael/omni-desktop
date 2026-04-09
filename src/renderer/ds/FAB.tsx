import type { ReactNode } from 'react';

import { cn } from '@/renderer/ds/cn';

type FABProps = {
  icon: ReactNode;
  onClick: () => void;
  'aria-label': string;
  className?: string;
};

export const FAB = ({ icon, onClick, className, ...rest }: FABProps) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      'fixed right-4 bottom-20 z-30',
      'size-14 rounded-2xl bg-accent-600 text-white',
      'shadow-lg shadow-accent-600/25',
      'flex items-center justify-center',
      'active:scale-95 transition-transform cursor-pointer',
      className
    )}
    aria-label={rest['aria-label']}
  >
    {icon}
  </button>
);
