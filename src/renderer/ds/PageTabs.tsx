import type { ComponentProps } from 'react';

import { cn } from '@/renderer/ds/cn';
import { TabsList, TabsTrigger } from '@/renderer/ds/ui/tabs';

/**
 * Section navigation within one destination or object. Page tabs are always
 * left-aligned and use an underline; pill controls are reserved for changing
 * a view or filter.
 */
export function PageTabsList({ className, ...props }: ComponentProps<typeof TabsList>) {
  return (
    <TabsList
      variant="line"
      className={cn(
        'scrollbar-none h-9 w-full justify-start gap-4 overflow-x-auto overflow-y-hidden rounded-none bg-transparent p-0',
        className
      )}
      {...props}
    />
  );
}

export function PageTabsTrigger({ className, ...props }: ComponentProps<typeof TabsTrigger>) {
  return <TabsTrigger className={cn('h-9 flex-none rounded-none px-1', className)} {...props} />;
}
