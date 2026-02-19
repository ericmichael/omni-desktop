import { cn } from '@/renderer/ds/cn';

type DividerProps = {
  orientation?: 'horizontal' | 'vertical';
  className?: string;
};

export const Divider = ({ orientation = 'horizontal', className }: DividerProps) => {
  return (
    <div
      className={cn(
        'bg-surface-border shrink-0',
        orientation === 'horizontal' ? 'h-px w-full' : 'w-px self-stretch',
        className
      )}
    />
  );
};
