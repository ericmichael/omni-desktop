import { Checkbox as FluentCheckbox } from '@fluentui/react-components';
import { forwardRef } from 'react';

type CheckboxProps = {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
  className?: string;
};

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ checked, onCheckedChange, label, disabled, className }, ref) => {
    return (
      <FluentCheckbox
        ref={ref}
        checked={checked}
        onChange={(_e, data) => onCheckedChange?.(!!data.checked)}
        label={label}
        disabled={disabled}
        className={className}
      />
    );
  }
);

Checkbox.displayName = 'Checkbox';
