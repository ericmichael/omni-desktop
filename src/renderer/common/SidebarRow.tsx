import './SidebarRow.css';

import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/renderer/ds/cn';
import { SidebarMenuItem } from '@/renderer/ds/ui/sidebar';

export function SidebarRow({ className, ...props }: ComponentProps<typeof SidebarMenuItem>) {
  return (
    <SidebarMenuItem
      className={cn(
        'sidebar-row hover:bg-sidebar-accent has-[>[data-sidebar=menu-button][data-active=true]]:bg-sidebar-accent has-[>[data-sidebar=menu-button]:focus-visible]:bg-sidebar-accent has-[>[data-sidebar-row-actions]:focus-within]:bg-sidebar-accent has-[>[data-sidebar-row-actions][data-state=open]]:bg-sidebar-accent',
        className
      )}
      {...props}
    />
  );
}

export function SidebarRowLayout({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'sidebar-row hover:bg-sidebar-accent has-[>[data-sidebar=menu-button][data-active=true]]:bg-sidebar-accent has-[>[data-sidebar=menu-button]:focus-visible]:bg-sidebar-accent has-[>[data-sidebar-row-actions]:focus-within]:bg-sidebar-accent has-[>[data-sidebar-row-actions][data-state=open]]:bg-sidebar-accent',
        className
      )}
      {...props}
    />
  );
}

export function SidebarRowActions({
  children,
  className,
  open = false,
}: {
  children: ReactNode;
  className?: string;
  open?: boolean;
}) {
  return (
    <div
      data-sidebar-row-actions=""
      data-state={open ? 'open' : 'closed'}
      className={cn('flex items-center', className)}
    >
      {children}
    </div>
  );
}
