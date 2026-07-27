import { Button as FluentButton, Tooltip } from '@fluentui/react-components';
import type { ReactElement, ReactNode } from 'react';
import { forwardRef } from 'react';

type Size = 'sm' | 'md' | 'lg';

type IconButtonProps = {
  'aria-label': string;
  icon: ReactNode;
  size?: Size;
  tooltip?: string;
  isDisabled?: boolean;
  onClick?: () => void;
  className?: string;
};

const sizeMap: Record<Size, 'small' | 'medium' | 'large'> = {
  sm: 'small',
  md: 'medium',
  lg: 'large',
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ icon, size = 'md', tooltip, isDisabled, className, onClick, ...rest }, ref) => {
    // Disabled + tooltip = the disabled-with-reason pattern: use Fluent's
    // disabledFocusable so the button stays hoverable/focusable and the
    // tooltip explaining WHY it's disabled actually shows (a plain disabled
    // button swallows pointer + focus events and the reason is unreachable).
    const disabledFocusable = Boolean(isDisabled && tooltip);
    const button = (
      <FluentButton
        ref={ref}
        appearance="subtle"
        shape="circular"
        size={sizeMap[size]}
        disabled={isDisabled && !disabledFocusable}
        disabledFocusable={disabledFocusable}
        onClick={onClick}
        icon={icon as ReactElement}
        aria-label={rest['aria-label']}
        className={className}
      />
    );

    if (tooltip) {
      return (
        <Tooltip content={tooltip} relationship="label">
          {button}
        </Tooltip>
      );
    }

    return button;
  }
);

IconButton.displayName = 'IconButton';
