import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
import { SidebarTrigger } from '@/renderer/ds/ui/sidebar';

type TopAppBarProps = {
  title: ReactNode;
  /** Up one level within the surface. Wins over `onMenu` when both are set —
   *  a screen at depth shows back, not the drawer handle. */
  onBack?: () => void;
  /** Show the shared sidebar trigger at a surface root. */
  showMenu?: boolean;
  actions?: ReactNode;
  className?: string;
};

export const TopAppBar = ({ title, onBack, showMenu, actions, className }: TopAppBarProps) => {
  return (
    <div role="toolbar" className={cn('flex shrink-0 items-center gap-2 border-b px-3 py-1.5', className)}>
      {onBack ? (
        <Button type="button" variant="ghost" size="icon" aria-label="Back" onClick={onBack}>
          <ArrowLeft />
        </Button>
      ) : (
        showMenu && <SidebarTrigger aria-label="Open navigation" />
      )}
      <h2 className="flex-1 truncate font-display text-lg font-semibold tracking-tight">{title}</h2>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </div>
  );
};
