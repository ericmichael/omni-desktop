import type { PropsWithChildren, ReactNode } from 'react';

import { cn } from '@/renderer/ds/cn';

type FormFieldProps = {
  label: ReactNode;
  helperText?: ReactNode;
  className?: string;
};

export const FormField = ({ label, helperText, className, children }: PropsWithChildren<FormFieldProps>) => {
  return (
    <div className={cn('flex items-center justify-between gap-4', className)}>
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-base sm:text-sm text-fg select-none">{label}</span>
        {helperText && <span className="text-sm sm:text-xs text-fg-subtle">{helperText}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
};
