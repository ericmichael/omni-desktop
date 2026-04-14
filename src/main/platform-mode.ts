/**
 * Determines whether the launcher is running in enterprise (platform) mode
 * or open-source (local) mode.
 *
 * Enterprise mode is available when `OMNI_PLATFORM_URL` was set at build time.
 * The user still needs to sign in — but they never configure the URL.
 *
 * Open-source mode: no platform URL baked in → local sandboxes with all backends.
 */

import { PlatformClient } from '@/main/platform-client';
import type { PlatformCredentials, SandboxBackend, SandboxProfile } from '@/shared/types';

declare const __PLATFORM_URL__: string;

/**
 * The platform URL baked in at build time, or empty string for open-source builds.
 */
export const PLATFORM_URL: string = typeof __PLATFORM_URL__ === 'string' ? __PLATFORM_URL__ : '';

/**
 * Whether this is an enterprise build (platform URL was set at compile time).
 */
export const isEnterpriseBuild = (): boolean => PLATFORM_URL.length > 0;

/**
 * Whether the user is signed in to the platform.
 */
export const isPlatformAuthenticated = (platform?: PlatformCredentials): boolean => {
  return Boolean(platform?.accessToken);
};

/**
 * The default sandbox backends available in open-source mode (no platform policy).
 */
export const OPEN_SOURCE_BACKENDS: SandboxBackend[] = ['docker', 'podman', 'vm', 'local', 'none'];

/**
 * Map platform backend vocabulary to launcher backend vocabulary.
 * The platform uses 'bwrap'/'qemu'; the launcher uses 'local'/'vm'.
 */
export function mapPlatformBackend(backend: string): SandboxBackend {
  switch (backend) {
    case 'bwrap':
      return 'local';
    case 'qemu':
      return 'vm';
    default:
      return backend as SandboxBackend;
  }
}

/**
 * Convert platform sandbox_profiles to launcher SandboxProfile format.
 */
export function mapSandboxProfiles(
  profiles: Array<{ resource_id: number; name: string; backend: string; variant?: string; image?: string; network_mode?: string; resource_limits?: Record<string, string | number> }>
): SandboxProfile[] {
  return profiles.map((p) => ({
    resource_id: p.resource_id,
    name: p.name,
    backend: mapPlatformBackend(p.backend),
    variant: p.variant,
    image: p.image,
    network_mode: p.network_mode,
    resource_limits: p.resource_limits
      ? {
          cpu: String(p.resource_limits.cpu ?? '4'),
          memory: String(p.resource_limits.memory ?? '8Gi'),
          max_duration_minutes: Number(p.resource_limits.max_duration_minutes ?? 360),
        }
      : undefined,
  }));
}

/**
 * Creates a PlatformClient from stored credentials, or returns null
 * if not in enterprise mode or not signed in.
 */
export function createPlatformClient(
  platform?: PlatformCredentials,
  fetchFn?: typeof globalThis.fetch
): PlatformClient | null {
  if (!isEnterpriseBuild() || !platform?.accessToken) {
return null;
}

  return new PlatformClient(
    {
      url: PLATFORM_URL,
      accessToken: platform.accessToken,
      refreshToken: platform.refreshToken,
    },
    fetchFn
  );
}
