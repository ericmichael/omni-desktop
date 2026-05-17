/**
 * Tests for store init pure logic — layout migration.
 */
import { describe, expect, it } from 'vitest';

import { migrateLayoutMode } from '@/lib/store-init';

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

  it('migrates legacy "code" mode to "spaces"', () => {
    expect(migrateLayoutMode('code')).toBe('spaces');
  });

  it('migrates intermediate "os" mode to "spaces"', () => {
    expect(migrateLayoutMode('os')).toBe('spaces');
  });

  it('returns null for valid "spaces" mode', () => {
    expect(migrateLayoutMode('spaces')).toBeNull();
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
