import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { forwardRef } from 'react';

import { cn } from '@/renderer/ds/cn';

type CheckboxProps = {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
};

export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(
  ({ checked, onCheckedChange, disabled, className }, ref) => {
    return (
      <CheckboxPrimitive.Root
        ref={ref}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded border transition-colors cursor-pointer',
          'border-surface-border bg-transparent',
          'data-[state=checked]:border-accent-600 data-[state=checked]:bg-accent-600',
          'disabled:cursor-not-allowed disabled:opacity-40',
          'focus-visible:outline-2 focus-visible:outline-accent-500/50 focus-visible:outline-offset-2',
          className
        )}
      >
        <CheckboxPrimitive.Indicator>
          <svg width="10" height="10" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M11.4669 3.72684C11.7558 3.91574 11.8369 4.30308 11.648 4.59198L7.39799 11.092C7.29783 11.2452 7.13556 11.3467 6.95402 11.3699C6.77247 11.3931 6.58989 11.3354 6.45446 11.2124L3.70446 8.71241C3.44905 8.48022 3.43023 8.08494 3.66242 7.82953C3.89461 7.57412 4.28989 7.55529 4.5453 7.78749L6.75292 9.79441L10.6018 3.90792C10.7907 3.61902 11.178 3.53795 11.4669 3.72684Z"
              fill="white"
              fillRule="evenodd"
              clipRule="evenodd"
            />
          </svg>
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
    );
  }
);

Checkbox.displayName = 'Checkbox';
