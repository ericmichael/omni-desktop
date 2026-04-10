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

export const APPETITE_COLORS: Record<Appetite, string> = {
  small: 'text-green-400 bg-green-400/10',
  medium: 'text-blue-400 bg-blue-400/10',
  large: 'text-purple-400 bg-purple-400/10',
};
