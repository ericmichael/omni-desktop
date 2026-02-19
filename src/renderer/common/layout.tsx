import type { HTMLAttributes, PropsWithChildren } from 'react';
import { memo } from 'react';

import { cn } from '@/renderer/ds';

type LayoutProps = PropsWithChildren<HTMLAttributes<HTMLDivElement>>;

export const BodyContainer = memo(({ className, ...props }: LayoutProps) => {
  return (
    <div className={cn('relative flex w-full h-full flex-col items-center p-4 gap-4 min-h-0', className)} {...props} />
  );
});
BodyContainer.displayName = 'BodyContainer';

export const BodyHeader = memo(({ className, ...props }: LayoutProps) => {
  return <div className={cn('flex w-full h-12 flex-col items-center gap-4', className)} {...props} />;
});
BodyHeader.displayName = 'BodyHeader';

export const BodyContent = memo(({ className, ...props }: LayoutProps) => {
  return <div className={cn('flex w-full h-full flex-col items-center gap-4 min-h-0', className)} {...props} />;
});
BodyContent.displayName = 'BodyContent';

export const BodyFooter = memo(({ className, ...props }: LayoutProps) => {
  return <div className={cn('flex w-full h-10 items-center justify-end gap-4', className)} {...props} />;
});
BodyFooter.displayName = 'BodyFooter';
