/**
 * Tests for store init pure logic — sandbox enforcement and layout migration.
 *
 * These guard production-critical invariants:
 * - GA users must never run with a sandbox backend
 * - Legacy layout modes must be migrated to valid current modes
 */
import { describe, expect, it } from 'vitest';

import { enforceSandboxPolicy, migrateLayoutMode } from '@/lib/store-init';

// ---------------------------------------------------------------------------
// enforceSandboxPolicy
// ---------------------------------------------------------------------------

describe('enforceSandboxPolicy', () => {
  it('resets backend to none for GA user with docker backend', () => {
    expect(
      enforceSandboxPolicy({ previewFeatures: false, sandboxProfiles: null, sandboxBackend: 'docker' })
    ).toBe('none');
  });

  it('resets backend to none for GA user with podman backend', () => {
    expect(
      enforceSandboxPolicy({ previewFeatures: false, sandboxProfiles: null, sandboxBackend: 'podman' })
    ).toBe('none');
  });

  it('resets backend to none for GA user with local backend', () => {
    expect(
      enforceSandboxPolicy({ previewFeatures: false, sandboxProfiles: null, sandboxBackend: 'local' })
    ).toBe('none');
  });

  it('allows none backend for GA user', () => {
    expect(
      enforceSandboxPolicy({ previewFeatures: false, sandboxProfiles: null, sandboxBackend: 'none' })
    ).toBeNull();
  });

  it('allows any backend when preview features are enabled', () => {
    expect(
      enforceSandboxPolicy({ previewFeatures: true, sandboxProfiles: null, sandboxBackend: 'docker' })
    ).toBeNull();
  });

  it('allows any backend when enterprise sandbox profiles are present', () => {
    expect(
      enforceSandboxPolicy({
        previewFeatures: false,
        sandboxProfiles: [{ resource_id: 1, name: 'Standard', backend: 'docker' }] as never[],
        sandboxBackend: 'docker',
      })
    ).toBeNull();
  });

  it('allows none backend when both preview and enterprise are absent', () => {
    expect(
      enforceSandboxPolicy({ previewFeatures: false, sandboxProfiles: null, sandboxBackend: 'none' })
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// migrateLayoutMode
// ---------------------------------------------------------------------------

describe('migrateLayoutMode', () => {
  it('migrates "work" to "chat"', () => {
    expect(migrateLayoutMode('work')).toBe('chat');
  });

  it('migrates "desktop" to "chat"', () => {
    expect(migrateLayoutMode('desktop')).toBe('chat');
  });

  it('migrates "home" to "chat"', () => {
    expect(migrateLayoutMode('home')).toBe('chat');
  });

  it('migrates unknown mode to "chat"', () => {
    expect(migrateLayoutMode('fleet')).toBe('chat');
  });

  it('returns null for valid "chat" mode', () => {
    expect(migrateLayoutMode('chat')).toBeNull();
  });

  it('returns null for valid "code" mode', () => {
    expect(migrateLayoutMode('code')).toBeNull();
  });

  it('returns null for valid "projects" mode', () => {
    expect(migrateLayoutMode('projects')).toBeNull();
  });

  it('returns null for valid "dashboards" mode', () => {
    expect(migrateLayoutMode('dashboards')).toBeNull();
  });

  it('returns null for valid "settings" mode', () => {
    expect(migrateLayoutMode('settings')).toBeNull();
  });
});
