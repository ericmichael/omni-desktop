import type { ReactNode } from 'react';

import { cn } from '@/renderer/ds/cn';
import { SidebarTrigger } from '@/renderer/ds/ui/sidebar';

type PageHeaderProps = {
  title: string;
  /** Show the shared sidebar trigger. */
  showMenu?: boolean;
  /** Icon buttons / controls rendered at the right edge. */
  actions?: ReactNode;
};

/**
 * The standard header for a rail-level tab (or its list pane). Geometry
 * matches the Work sidebar header so every tab opens with the same
 * top-left title placement.
 */
export const PageHeader = ({ title, showMenu, actions }: PageHeaderProps) => {
  return (
    <div className={cn('flex shrink-0 items-center gap-2 pt-8 pr-1 pb-5 pl-5', showMenu && 'pl-1')}>
      {showMenu && <SidebarTrigger size="icon-sm" aria-label="Open navigation" />}
      <h2 className="min-w-0 flex-1 truncate font-display text-lg font-semibold tracking-tight">{title}</h2>
      {actions}
    </div>
  );
};
