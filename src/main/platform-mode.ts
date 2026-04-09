/**
 * Determines whether the launcher is running in enterprise (platform) mode
 * or open-source (local) mode.
 *
 * Enterprise mode is available when `OMNI_PLATFORM_URL` was set at build time.
 * The user still needs to sign in — but they never configure the URL.
 *
 * Open-source mode: no platform URL baked in → local Docker sandboxes.
 */

import type { AgentProcessMode } from '@/main/agent-process';
import { PlatformClient } from '@/main/platform-client';
import type { PlatformCredentials } from '@/shared/types';

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
 * Returns the agent process mode based on build type, auth state, and compute setting.
 *
 * Enterprise builds authenticate to the platform for governance (policy, dashboards,
 * audit) but run agents locally unless explicitly configured for cloud compute.
 *
 * - `'platform'` only when OMNI_COMPUTE_MODE=platform (cloud container management)
 * - `'sandbox'` when sandboxEnabled (local Docker/Podman)
 * - `'local'` when running without sandbox
 */
export function resolveAgentMode(opts: {
  platform?: PlatformCredentials;
  sandboxEnabled: boolean;
}): AgentProcessMode {
  // Platform compute only when explicitly opted in — not just because auth is configured
  if (
    isEnterpriseBuild() &&
    isPlatformAuthenticated(opts.platform) &&
    process.env.OMNI_COMPUTE_MODE === 'platform'
  ) {
    return 'platform';
  }
  return opts.sandboxEnabled ? 'sandbox' : 'local';
}

/**
 * Creates a PlatformClient from stored credentials, or returns null
 * if not in enterprise mode or not signed in.
 */
export function createPlatformClient(
  platform?: PlatformCredentials,
  fetchFn?: typeof globalThis.fetch
): PlatformClient | null {
  if (!isEnterpriseBuild() || !platform?.accessToken) return null;

  return new PlatformClient(
    {
      url: PLATFORM_URL,
      accessToken: platform.accessToken,
      refreshToken: platform.refreshToken,
    },
    fetchFn
  );
}
