import type { ReactNode } from 'react';

import { Button, cn } from '@/renderer/ds';

type ButtonWithTruncatedLabelProps = {
  variant?: 'primary' | 'ghost' | 'destructive' | 'link';
  size?: 'sm' | 'md' | 'lg';
  isDisabled?: boolean;
  className?: string;
  onClick?: () => void;
  children?: ReactNode;
};

export const ButtonWithTruncatedLabel = ({ children, ...buttonProps }: ButtonWithTruncatedLabelProps) => {
  return (
    <Button {...buttonProps}>
      <span className={cn('overflow-hidden text-ellipsis whitespace-nowrap break-all line-clamp-1')}>{children}</span>
    </Button>
  );
};
