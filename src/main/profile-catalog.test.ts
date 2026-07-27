/**
 * Tests for profile-catalog — sandbox profile discovery for the Sandboxes tab.
 *
 * Uses tmpdir fixtures for the bundled + user dirs; zero vi.mock.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createOverride, listProfiles, type ProfileCatalogDeps, readProfileYaml } from '@/main/profile-catalog';

const DEVBOX_YAML = `
version: 1
run_as: '1000:1000'
client:
  type: docker
  user: 'root'
options:
  image: ghcr.io/example/devbox@sha256:abc
services:
  code_server:
    command: 'code-server'
  vnc:
    command: 'start-vnc'
`;

let root: string;
let deps: ProfileCatalogDeps;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'profile-catalog-'));
  mkdirSync(path.join(root, 'bundled'));
  mkdirSync(path.join(root, 'user'));
  deps = { bundledDir: path.join(root, 'bundled'), userDir: path.join(root, 'user') };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const writeBundled = (name: string, yaml: string): void =>
  writeFileSync(path.join(root, 'bundled', `${name}.yml`), yaml);
const writeUser = (name: string, yaml: string): void => writeFileSync(path.join(root, 'user', `${name}.yml`), yaml);

describe('listProfiles', () => {
  it('always includes the implicit host profile, even with empty dirs', () => {
    const profiles = listProfiles(deps);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      name: 'host',
      clientType: 'host',
      builtin: true,
      path: null,
      origin: 'implicit',
    });
  });

  it('tolerates nonexistent directories', () => {
    const profiles = listProfiles({ bundledDir: path.join(root, 'missing'), userDir: path.join(root, 'gone') });
    expect(profiles.map((p) => p.name)).toEqual(['host']);
  });

  it('lists bundled profiles with parsed details', () => {
    writeBundled('devbox', DEVBOX_YAML);
    const profiles = listProfiles(deps);
    const devbox = profiles.find((p) => p.name === 'devbox');
    expect(devbox).toMatchObject({
      label: 'Devbox (Docker)',
      clientType: 'docker',
      builtin: true,
      path: path.join(root, 'bundled', 'devbox.yml'),
      origin: 'builtin',
      details: {
        image: 'ghcr.io/example/devbox@sha256:abc',
        services: ['code_server', 'vnc'],
        runAs: '1000:1000',
      },
    });
    // confine is absent from the YAML — stays unknown, not defaulted.
    expect(devbox?.details?.confine).toBeUndefined();
  });

  it('shadows a bundled profile with the user override, keeping builtin=true', () => {
    writeBundled('devbox', DEVBOX_YAML);
    writeUser('devbox', 'client:\n  type: docker\nconfine: true\n');
    const profiles = listProfiles(deps);
    const devbox = profiles.filter((p) => p.name === 'devbox');
    expect(devbox).toHaveLength(1);
    expect(devbox[0]).toMatchObject({
      builtin: true,
      origin: 'user-override',
      path: path.join(root, 'user', 'devbox.yml'),
      details: { confine: true },
    });
  });

  it('lists purely user-created profiles as non-builtin overrides', () => {
    writeUser('custom', 'client:\n  type: unix_local\n');
    const custom = listProfiles(deps).find((p) => p.name === 'custom');
    expect(custom).toMatchObject({ builtin: false, origin: 'user-override', clientType: 'unix_local' });
  });

  it('skips malformed YAML with a warning instead of throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeBundled('broken', 'client: [unclosed\n  type: ::::\n');
    writeBundled('devbox', DEVBOX_YAML);
    const profiles = listProfiles(deps);
    expect(profiles.map((p) => p.name)).toEqual(['host', 'devbox']);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('filters to availableSandboxProfiles when set — host only if listed', () => {
    writeBundled('devbox', DEVBOX_YAML);
    writeUser('aci', 'client:\n  type: aci\n');
    const restricted = listProfiles({ ...deps, getAvailableProfileNames: () => ['aci'] });
    expect(restricted.map((p) => p.name)).toEqual(['aci']);
    const withHost = listProfiles({ ...deps, getAvailableProfileNames: () => ['host', 'devbox'] });
    expect(withHost.map((p) => p.name)).toEqual(['host', 'devbox']);
  });

  it('ignores an empty availableSandboxProfiles list', () => {
    writeBundled('devbox', DEVBOX_YAML);
    const profiles = listProfiles({ ...deps, getAvailableProfileNames: () => [] });
    expect(profiles.map((p) => p.name)).toEqual(['host', 'devbox']);
  });
});

describe('readProfileYaml', () => {
  it('returns null for the implicit host profile', () => {
    expect(readProfileYaml(deps, 'host')).toBeNull();
  });

  it('returns null for unknown names', () => {
    expect(readProfileYaml(deps, 'nope')).toBeNull();
  });

  it('prefers the user override over the bundled file', () => {
    writeBundled('devbox', 'bundled: true\n');
    writeUser('devbox', 'user: true\n');
    expect(readProfileYaml(deps, 'devbox')).toEqual({ yaml: 'user: true\n' });
  });

  it('falls back to the bundled file', () => {
    writeBundled('devbox', 'bundled: true\n');
    expect(readProfileYaml(deps, 'devbox')).toEqual({ yaml: 'bundled: true\n' });
  });
});

describe('createOverride', () => {
  it('copies the bundled YAML into the user dir, creating it as needed', () => {
    writeBundled('devbox', DEVBOX_YAML);
    rmSync(path.join(root, 'user'), { recursive: true });
    const result = createOverride(deps, 'devbox');
    expect(result.path).toBe(path.join(root, 'user', 'devbox.yml'));
    expect(readFileSync(result.path, 'utf8')).toBe(DEVBOX_YAML);
  });

  it('refuses when the override already exists', () => {
    writeBundled('devbox', DEVBOX_YAML);
    writeUser('devbox', 'user: true\n');
    expect(() => createOverride(deps, 'devbox')).toThrow(/already exists/);
  });

  it('refuses the implicit host profile', () => {
    expect(() => createOverride(deps, 'host')).toThrow(/built into/);
    expect(existsSync(path.join(root, 'user', 'host.yml'))).toBe(false);
  });

  it('refuses names with no bundled YAML', () => {
    expect(() => createOverride(deps, 'nope')).toThrow(/no bundled YAML/);
  });
});
