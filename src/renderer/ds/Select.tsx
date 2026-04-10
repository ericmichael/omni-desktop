import { Select as FluentSelect } from '@fluentui/react-components';
import { forwardRef } from 'react';

type Size = 'sm' | 'md' | 'lg';

type SelectProps = {
  size?: Size;
  className?: string;
} & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size' | 'onChange'> & {
    onChange?: React.ChangeEventHandler<HTMLSelectElement>;
  };

const sizeMap: Record<Size, 'small' | 'medium' | 'large'> = {
  sm: 'small',
  md: 'medium',
  lg: 'large',
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ size = 'md', className, children, onChange, value, defaultValue, disabled, ...props }, ref) => {
    return (
      <FluentSelect
        ref={ref}
        size={sizeMap[size]}
        appearance="underline"
        className={className}
        onChange={onChange}
        value={value as string | undefined}
        defaultValue={defaultValue as string | undefined}
        disabled={disabled}
        {...props}
      >
        {children}
      </FluentSelect>
    );
  }
);

Select.displayName = 'Select';
