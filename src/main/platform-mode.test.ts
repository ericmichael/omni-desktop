/**
 * Tests for platform-mode — enterprise/open-source mode detection.
 *
 * All exports are pure functions (no I/O, no side effects).
 * `isEnterpriseBuild` and `createPlatformClient` depend on the build-time
 * `__PLATFORM_URL__` global, which is undefined in vitest → open-source path.
 *
 * The legacy `mapPlatformBackend` / `mapSandboxProfiles` / `OPEN_SOURCE_BACKENDS`
 * helpers were removed in the v22 cut (sandbox profiles drive sandbox
 * configuration now, not the legacy backend enum).
 */
import { describe, expect, it } from 'vitest';

import {
  createPlatformClient,
  isEnterpriseBuild,
  isPlatformAuthenticated,
  PLATFORM_URL,
} from '@/main/platform-mode';

// ---------------------------------------------------------------------------
// isPlatformAuthenticated
// ---------------------------------------------------------------------------

describe('isPlatformAuthenticated', () => {
  it('returns true when accessToken is present', () => {
    expect(isPlatformAuthenticated({ accessToken: 'tok', refreshToken: 'ref' })).toBe(true);
  });

  it('returns false when accessToken is empty string', () => {
    expect(isPlatformAuthenticated({ accessToken: '', refreshToken: '' })).toBe(false);
  });

  it('returns false when platform is undefined', () => {
    expect(isPlatformAuthenticated(undefined)).toBe(false);
  });

  it('returns false when platform has no accessToken field', () => {
    expect(isPlatformAuthenticated({} as never)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isEnterpriseBuild / PLATFORM_URL (open-source path — __PLATFORM_URL__ is
// undefined in vitest, so PLATFORM_URL resolves to '')
// ---------------------------------------------------------------------------

describe('isEnterpriseBuild (open-source build)', () => {
  it('returns false when __PLATFORM_URL__ is not defined', () => {
    expect(PLATFORM_URL).toBe('');
    expect(isEnterpriseBuild()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createPlatformClient
// ---------------------------------------------------------------------------

describe('createPlatformClient', () => {
  it('returns null in open-source mode regardless of credentials', () => {
    const result = createPlatformClient({ accessToken: 'tok', refreshToken: 'ref' });
    expect(result).toBeNull();
  });

  it('returns null when platform credentials are undefined', () => {
    expect(createPlatformClient(undefined)).toBeNull();
  });

  it('returns null when accessToken is missing', () => {
    expect(createPlatformClient({ accessToken: '', refreshToken: '' })).toBeNull();
  });
});
