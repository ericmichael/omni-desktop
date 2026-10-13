import { atom } from 'nanostores';
import { describe, expect, it, vi } from 'vitest';

import type { ProfileSummary, SandboxSubstrateStatus } from '@/shared/types';

vi.mock('@/renderer/features/Sandboxes/state', () => ({
  $sandboxProfiles: atom<ProfileSummary[]>([]),
  $substrateStatus: atom<SandboxSubstrateStatus | null>(null),
}));
vi.mock('@/renderer/services/machines', () => ({ $machines: atom([]) }));

import { getAvailableProfileNames } from '@/renderer/features/SandboxProfile/profile-list';

const profile = (name: string, clientType: string): ProfileSummary => ({
  name,
  label: name,
  clientType,
  builtin: true,
  path: null,
  origin: 'builtin',
});

const discovered = [
  profile('host', 'host'),
  profile('devbox', 'docker'),
  profile('wasmbox', 'wasm'),
  profile('team-box', 'docker'),
];

describe('getAvailableProfileNames', () => {
  it('never offers the mini computer (wasmbox) yet', () => {
    const names = getAvailableProfileNames({ isEnterprise: false, discovered, substrate: { docker: 'ok' } });
    expect(names).not.toContain('wasmbox');
    expect(names).toEqual(expect.arrayContaining(['host', 'devbox', 'team-box']));
  });

  it('hides it even when a deployment lists it', () => {
    const names = getAvailableProfileNames({
      isEnterprise: false,
      available: ['host', 'wasmbox'],
      discovered,
      substrate: { docker: 'ok' },
    });
    expect(names).toEqual(['host']);
  });

  it('hides every Docker profile when Docker is missing', () => {
    const names = getAvailableProfileNames({ isEnterprise: false, discovered, substrate: { docker: 'missing' } });
    expect(names).toEqual(['host']);
  });

  it('keeps Docker profiles when Docker is installed but not running', () => {
    const names = getAvailableProfileNames({ isEnterprise: false, discovered, substrate: { docker: 'daemon-down' } });
    expect(names).toContain('devbox');
  });

  it('hides nothing before the Docker probe has answered', () => {
    const names = getAvailableProfileNames({ isEnterprise: false, discovered, substrate: null });
    expect(names).toContain('devbox');
  });

  it('applies the Docker requirement to the fallback list before discovery lands', () => {
    const names = getAvailableProfileNames({ isEnterprise: false, discovered: [], substrate: { docker: 'missing' } });
    expect(names).toEqual(['host']);
  });
});
