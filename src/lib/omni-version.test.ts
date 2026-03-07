import { describe, expect, it } from 'vitest';

import { checkOmniVersion, OMNI_CODE_VERSION } from '@/lib/omni-version';

describe('checkOmniVersion', () => {
  it('returns not outdated when version matches', () => {
    const result = checkOmniVersion(OMNI_CODE_VERSION);
    expect(result.isOutdated).toBe(false);
    expect(result.installedVersion).toBe(OMNI_CODE_VERSION);
    expect(result.expectedVersion).toBe(OMNI_CODE_VERSION);
  });

  it('returns outdated when installed version is older', () => {
    const result = checkOmniVersion('0.4.20');
    expect(result.isOutdated).toBe(true);
    expect(result.installedVersion).toBe('0.4.20');
    expect(result.expectedVersion).toBe(OMNI_CODE_VERSION);
  });

  it('returns outdated when installed version is newer', () => {
    const result = checkOmniVersion('0.5.0');
    expect(result.isOutdated).toBe(true);
    expect(result.installedVersion).toBe('0.5.0');
    expect(result.expectedVersion).toBe(OMNI_CODE_VERSION);
  });

  it('returns outdated for completely different version', () => {
    const result = checkOmniVersion('1.0.0');
    expect(result.isOutdated).toBe(true);
  });

  it('handles pre-release versions as outdated', () => {
    const result = checkOmniVersion(`${OMNI_CODE_VERSION}.dev1`);
    expect(result.isOutdated).toBe(true);
  });
});
