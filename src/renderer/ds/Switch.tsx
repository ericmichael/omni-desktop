import { Switch as FluentSwitch } from '@fluentui/react-components';
import { forwardRef } from 'react';

type SwitchProps = {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
};

export const Switch = forwardRef<HTMLInputElement, SwitchProps>(
  ({ checked, onCheckedChange, disabled, className }, ref) => {
    return (
      <FluentSwitch
        ref={ref}
        checked={checked}
        onChange={(_e, data) => onCheckedChange?.(data.checked)}
        disabled={disabled}
        className={className}
      />
    );
  }
);

Switch.displayName = 'Switch';
