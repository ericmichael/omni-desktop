import type { SandboxBackend, SandboxConfig } from '@/shared/types';

const BACKEND_LABELS: Record<SandboxBackend, string> = {
  platform: 'Cloud',
  docker: 'Docker',
  podman: 'Podman',
  vm: 'VM',
  local: 'Local',
  none: 'None',
};

/**
 * Build the sandbox label shown in the Input component.
 * Examples: "Docker", "Cloud (dev)", "Docker (custom)"
 */
export const buildSandboxLabel = (
  backend: SandboxBackend,
  options?: { custom?: boolean }
): string => {
  const base = BACKEND_LABELS[backend] ?? backend;
  const tags: string[] = [];
  if (import.meta.env.MODE === 'development') {
tags.push('dev');
}
  if (options?.custom) {
tags.push('custom');
}
  return tags.length > 0 ? `${base} (${tags.join(', ')})` : base;
};

/** Returns true when the project uses a custom Dockerfile or image. */
export const isCustomSandbox = (config: SandboxConfig | null | undefined): boolean =>
  !!(config?.dockerfile || config?.image);
