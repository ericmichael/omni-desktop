import { describe, expect, it } from 'vitest';

import { workspaceScopeFromMounts } from './workspace-mounts';

const mount = (path: string) => ({ name: path === '.' ? 'scratch' : path, path, writable: true });

describe('workspaceScopeFromMounts', () => {
  it('scopes a single mount that landed under the root', () => {
    expect(workspaceScopeFromMounts([mount('f74a9eba')])).toBe('f74a9eba');
  });

  it('needs no scope when the mount IS the root (host layout)', () => {
    expect(workspaceScopeFromMounts([mount('.')])).toBeUndefined();
  });

  it('keeps the composite root for multi-mount environments', () => {
    expect(workspaceScopeFromMounts([mount('web'), mount('api')])).toBeUndefined();
  });

  it('does nothing without a mount table (older runtimes, platform path)', () => {
    expect(workspaceScopeFromMounts(undefined)).toBeUndefined();
    expect(workspaceScopeFromMounts([])).toBeUndefined();
  });
});
