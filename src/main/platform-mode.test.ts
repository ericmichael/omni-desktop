/**
 * Tests for platform-mode — enterprise/open-source mode detection,
 * backend vocabulary mapping, and sandbox profile conversion.
 *
 * All exports are pure functions (no I/O, no side effects).
 * `isEnterpriseBuild` and `createPlatformClient` depend on the build-time
 * `__PLATFORM_URL__` global, which is undefined in vitest → open-source path.
 */
import { describe, expect, it } from 'vitest';

import {
  createPlatformClient,
  isEnterpriseBuild,
  isPlatformAuthenticated,
  mapPlatformBackend,
  mapSandboxProfiles,
  OPEN_SOURCE_BACKENDS,
  PLATFORM_URL,
} from '@/main/platform-mode';

// ---------------------------------------------------------------------------
// mapPlatformBackend
// ---------------------------------------------------------------------------

describe('mapPlatformBackend', () => {
  it('maps bwrap to local', () => {
    expect(mapPlatformBackend('bwrap')).toBe('local');
  });

  it('maps qemu to vm', () => {
    expect(mapPlatformBackend('qemu')).toBe('vm');
  });

  it.each(['docker', 'podman', 'local', 'vm', 'none', 'platform'] as const)(
    'passes through %s unchanged',
    (backend) => {
      expect(mapPlatformBackend(backend)).toBe(backend);
    }
  );

  it('passes through unknown strings as-is', () => {
    expect(mapPlatformBackend('future-backend')).toBe('future-backend');
  });
});

// ---------------------------------------------------------------------------
// mapSandboxProfiles
// ---------------------------------------------------------------------------

describe('mapSandboxProfiles', () => {
  it('maps a profile with resource_limits', () => {
    const profiles = [
      {
        resource_id: 1,
        name: 'Standard',
        backend: 'bwrap',
        variant: 'work',
        image: 'ubuntu:24.04',
        network_mode: 'bridge',
        resource_limits: { cpu: 8, memory: '16Gi', max_duration_minutes: 120 },
      },
    ];
    const result = mapSandboxProfiles(profiles);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      resource_id: 1,
      name: 'Standard',
      backend: 'local', // bwrap → local
      variant: 'work',
      image: 'ubuntu:24.04',
      network_mode: 'bridge',
      resource_limits: {
        cpu: '8', // String() coerced
        memory: '16Gi',
        max_duration_minutes: 120,
      },
    });
  });

  it('applies defaults when resource_limits fields are missing', () => {
    const profiles = [
      { resource_id: 2, name: 'Minimal', backend: 'qemu', resource_limits: {} },
    ];
    const result = mapSandboxProfiles(profiles);
    expect(result[0]!.resource_limits).toEqual({
      cpu: '4',
      memory: '8Gi',
      max_duration_minutes: 360,
    });
  });

  it('omits resource_limits when not provided', () => {
    const profiles = [{ resource_id: 3, name: 'Bare', backend: 'docker' }];
    const result = mapSandboxProfiles(profiles);
    expect(result[0]!.resource_limits).toBeUndefined();
  });

  it('preserves optional fields (variant, image, network_mode) as undefined when absent', () => {
    const profiles = [{ resource_id: 4, name: 'Plain', backend: 'podman' }];
    const result = mapSandboxProfiles(profiles);
    expect(result[0]!.variant).toBeUndefined();
    expect(result[0]!.image).toBeUndefined();
    expect(result[0]!.network_mode).toBeUndefined();
  });

  it('returns empty array for empty input', () => {
    expect(mapSandboxProfiles([])).toEqual([]);
  });
});

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

// ---------------------------------------------------------------------------
// OPEN_SOURCE_BACKENDS
// ---------------------------------------------------------------------------

describe('OPEN_SOURCE_BACKENDS', () => {
  it('includes all expected backends', () => {
    expect(OPEN_SOURCE_BACKENDS).toEqual(['docker', 'podman', 'vm', 'local', 'none']);
  });
});
