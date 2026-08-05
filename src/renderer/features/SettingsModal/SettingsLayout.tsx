import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/renderer/ds/cn';

export function SettingsPane({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-8', className)} {...props} />;
}

type SettingsSectionProps = ComponentProps<'section'> & {
  title: ReactNode;
  description?: ReactNode;
};

export function SettingsSection({ title, description, className, children, ...props }: SettingsSectionProps) {
  return (
    <section className={cn('flex flex-col gap-3', className)} {...props}>
      <div className="flex flex-col gap-1">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

export const settingsCardContentClassName = 'flex flex-col gap-5';
