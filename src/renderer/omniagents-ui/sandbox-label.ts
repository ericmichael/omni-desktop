import type { SandboxConfig, SandboxVariant } from '@/shared/types';

/**
 * Build the sandbox label shown in the Input component.
 * Examples: "Work", "Work (dev)", "Work (custom)", "Work (dev, custom)"
 */
export const buildSandboxLabel = (
  variant: SandboxVariant,
  options?: { custom?: boolean }
): string => {
  const base = variant === 'standard' ? 'Standard' : 'Work';
  const tags: string[] = [];
  if (import.meta.env.MODE === 'development') tags.push('dev');
  if (options?.custom) tags.push('custom');
  return tags.length > 0 ? `${base} (${tags.join(', ')})` : base;
};

/** Returns true when the project uses a custom Dockerfile or image. */
export const isCustomSandbox = (config: SandboxConfig | null | undefined): boolean =>
  !!(config?.dockerfile || config?.image);
