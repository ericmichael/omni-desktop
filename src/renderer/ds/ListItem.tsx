import type { ReactNode } from 'react';
import { PiCaretRightBold } from 'react-icons/pi';

import { cn } from '@/renderer/ds/cn';

type ListItemProps = {
  icon?: ReactNode;
  label: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
  showChevron?: boolean;
  onClick?: () => void;
  className?: string;
};

export const ListItem = ({ icon, label, detail, trailing, showChevron = true, onClick, className }: ListItemProps) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      'flex items-center gap-3.5 w-full px-4 sm:px-5 py-3.5 text-left text-fg',
      'hover:bg-white/5 active:bg-white/10 transition-colors',
      className
    )}
  >
    {icon && (
      <span className="size-9 rounded-xl bg-surface-overlay/60 flex items-center justify-center shrink-0 text-fg-muted">
        {icon}
      </span>
    )}
    <span className="flex-1 min-w-0">
      <span className="text-base sm:text-sm font-medium block truncate">{label}</span>
      {detail && <span className="text-xs text-fg-subtle block mt-0.5 truncate">{detail}</span>}
    </span>
    {trailing}
    {showChevron && <PiCaretRightBold size={14} className="text-fg-muted/40 shrink-0" />}
  </button>
);
