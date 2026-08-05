import type { ReactNode } from 'react';
import { memo } from 'react';

import { cn } from '@/renderer/ds/cn';

type ProjectPageHeaderProps = {
  /** The page's real title. Strings render at the standard page-title scale;
   *  pass a node for editable titles (tickets). */
  title: ReactNode;
  /** Right-aligned controls on the title row (filters, actions, menus). */
  actions?: ReactNode;
  /** Caption line under the title (e.g. milestone metadata). */
  meta?: ReactNode;
  className?: string;
};

export const ProjectPageHeader = memo(({ title, actions, meta, className }: ProjectPageHeaderProps) => {
  return (
    <div
      className={cn('flex flex-col gap-0.5 w-full max-w-full min-w-0 pl-5 pr-5 pt-5 pb-2 shrink-0', className)}
      data-slot="project-page-header"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 w-full min-w-0">
        <div className="flex-auto basis-80 min-w-0 overflow-hidden">
          {typeof title === 'string' ? (
            <h3
              className={cn(
                'font-display text-lg font-semibold tracking-tight',
                'overflow-hidden text-ellipsis whitespace-nowrap'
              )}
            >
              {title}
            </h3>
          ) : (
            title
          )}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-1 ml-auto shrink-0">{actions}</div>}
      </div>
      {meta && <div className="min-w-0 overflow-hidden text-muted-foreground">{meta}</div>}
    </div>
  );
});
ProjectPageHeader.displayName = 'ProjectPageHeader';
