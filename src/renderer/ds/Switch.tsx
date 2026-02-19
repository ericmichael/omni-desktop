import * as SwitchPrimitive from '@radix-ui/react-switch';
import { forwardRef } from 'react';

import { cn } from '@/renderer/ds/cn';

type SwitchProps = {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
};

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onCheckedChange, disabled, className }, ref) => {
    return (
      <SwitchPrimitive.Root
        ref={ref}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors',
          'bg-surface-overlay',
          'data-[state=checked]:bg-accent-600',
          'disabled:cursor-not-allowed disabled:opacity-40',
          'focus-visible:outline-2 focus-visible:outline-accent-500/50 focus-visible:outline-offset-2',
          className
        )}
      >
        <SwitchPrimitive.Thumb
          className={cn(
            'block size-4 rounded-full bg-white shadow-sm transition-transform',
            'translate-x-0.5 data-[state=checked]:translate-x-[18px]',
            'mt-0.5'
          )}
        />
      </SwitchPrimitive.Root>
    );
  }
);

Switch.displayName = 'Switch';
