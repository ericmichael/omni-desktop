import type { InputProps as FluentInputProps } from '@fluentui/react-components';
import { Input as FluentInput, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { forwardRef } from 'react';

type Size = 'sm' | 'md' | 'lg';

type InputProps = {
  size?: Size;
  mono?: boolean;
  className?: string;
  type?: FluentInputProps['type'];
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  id?: string;
  name?: string;
  autoFocus?: boolean;
  autoComplete?: string;
  maxLength?: number;
  minLength?: number;
  pattern?: string;
  required?: boolean;
  'aria-label'?: string;
  'aria-describedby'?: string;
  onFocus?: React.FocusEventHandler<HTMLInputElement>;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
};

const sizeMap: Record<Size, 'small' | 'medium' | 'large'> = {
  sm: 'small',
  md: 'medium',
  lg: 'large',
};

const useStyles = makeStyles({
  mono: {
    fontFamily: tokens.fontFamilyMonospace,
  },
});

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      size = 'md',
      mono,
      className,
      onChange,
      value,
      defaultValue,
      placeholder,
      disabled,
      readOnly,
      type,
      id,
      name,
      autoFocus,
      autoComplete,
      maxLength,
      minLength,
      pattern,
      required,
      onFocus,
      onBlur,
      onKeyDown,
      ...rest
    },
    ref
  ) => {
    const styles = useStyles();

    return (
      <FluentInput
        ref={ref}
        size={sizeMap[size]}
        appearance="underline"
        className={mergeClasses(mono && styles.mono, className)}
        onChange={onChange}
        value={value}
        defaultValue={defaultValue}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={readOnly}
        type={type}
        id={id}
        name={name}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        maxLength={maxLength}
        minLength={minLength}
        pattern={pattern}
        required={required}
        aria-label={rest['aria-label']}
        aria-describedby={rest['aria-describedby']}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      />
    );
  }
);

Input.displayName = 'Input';
