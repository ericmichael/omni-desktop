import { Button as FluentButton, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { ReactElement, ReactNode } from 'react';
import { forwardRef } from 'react';

type Variant = 'primary' | 'ghost' | 'destructive' | 'link';
type Size = 'sm' | 'md' | 'lg';

type ButtonProps = {
  variant?: Variant;
  size?: Size;
  isDisabled?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  onClick?: () => void;
  className?: string;
  type?: 'button' | 'submit' | 'reset';
  children?: ReactNode;
};

const variantToAppearance: Record<Variant, 'primary' | 'subtle' | 'transparent'> = {
  primary: 'primary',
  ghost: 'subtle',
  destructive: 'subtle',
  link: 'transparent',
};

const sizeMap: Record<Size, 'small' | 'medium' | 'large'> = {
  sm: 'small',
  md: 'medium',
  lg: 'large',
};

const useStyles = makeStyles({
  destructive: {
    color: tokens.colorPaletteRedForeground1,
    ':hover': {
      color: tokens.colorPaletteRedForeground1,
    },
  },
  link: {
    textDecorationLine: 'none',
    ':hover': {
      textDecorationLine: 'underline',
    },
  },
});

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', isDisabled, leftIcon, rightIcon, className, children, onClick, type }, ref) => {
    const styles = useStyles();

    return (
      <FluentButton
        ref={ref}
        appearance={variantToAppearance[variant]}
        size={sizeMap[size]}
        disabled={isDisabled}
        onClick={onClick}
        type={type}
        icon={leftIcon ? (leftIcon as ReactElement) : undefined}
        iconPosition="before"
        className={mergeClasses(
          variant === 'destructive' && styles.destructive,
          variant === 'link' && styles.link,
          className
        )}
      >
        {children}
        {rightIcon}
      </FluentButton>
    );
  }
);

Button.displayName = 'Button';
