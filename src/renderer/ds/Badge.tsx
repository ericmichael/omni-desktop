import type { PropsWithChildren } from 'react';

import { cn } from '@/renderer/ds/cn';

type ColorScheme = 'default' | 'blue' | 'green' | 'purple' | 'red' | 'yellow' | 'sky' | 'orange';

type BadgeProps = {
  color?: ColorScheme;
  className?: string;
};

const colorClasses: Record<ColorScheme, string> = {
  default: 'text-fg-muted bg-fg-muted/10',
  blue: 'text-blue-400 bg-blue-400/10',
  green: 'text-green-400 bg-green-400/10',
  purple: 'text-purple-400 bg-purple-400/10',
  red: 'text-red-400 bg-red-400/10',
  yellow: 'text-yellow-400 bg-yellow-400/10',
  sky: 'text-sky-400 bg-sky-400/10',
  orange: 'text-orange-400 bg-orange-400/10',
};

export const Badge = ({ color = 'default', className, children }: PropsWithChildren<BadgeProps>) => (
  <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium', colorClasses[color], className)}>
    {children}
  </span>
);
