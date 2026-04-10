import type { Appetite } from '@/shared/types';

export const APPETITE_LABELS: Record<Appetite, string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
};

export const APPETITE_DESCRIPTIONS: Record<Appetite, string> = {
  small: 'A day or less',
  medium: 'A few days',
  large: 'A week+',
};

import type { BadgeColor } from '@/renderer/features/Tickets/ticket-constants';

export const APPETITE_COLORS: Record<Appetite, BadgeColor> = {
  small: 'green',
  medium: 'blue',
  large: 'purple',
};
