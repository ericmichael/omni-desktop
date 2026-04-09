import type { PropsWithChildren, ReactNode } from 'react';
import { PiArrowLeftBold } from 'react-icons/pi';

import { cn } from '@/renderer/ds/cn';
import { IconButton } from '@/renderer/ds/IconButton';

type TopAppBarProps = {
  title: ReactNode;
  onBack?: () => void;
  actions?: ReactNode;
  className?: string;
};

export const TopAppBar = ({ title, onBack, actions, className }: TopAppBarProps) => (
  <div className={cn('flex items-center gap-2 px-3 sm:px-4 py-1.5 sm:py-2 border-b border-surface-border shrink-0', className)}>
    {onBack && (
      <IconButton
        aria-label="Back"
        icon={<PiArrowLeftBold />}
        size="md"
        onClick={onBack}
        className="sm:size-9"
      />
    )}
    <span className="text-base sm:text-sm font-semibold text-fg truncate flex-1">{title}</span>
    {actions && <div className="flex items-center gap-1 shrink-0">{actions}</div>}
  </div>
);
