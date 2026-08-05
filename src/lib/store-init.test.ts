/**
 * Tests for store init pure logic — layout migration.
 */
import { describe, expect, it } from 'vitest';

import { migrateLayoutMode } from '@/lib/store-init';

// ---------------------------------------------------------------------------
// migrateLayoutMode
// ---------------------------------------------------------------------------

describe('migrateLayoutMode', () => {
  it('migrates the split "projects" tab to "work"', () => {
    expect(migrateLayoutMode('projects')).toBe('work');
  });

  it('migrates "desktop" to "chat"', () => {
    expect(migrateLayoutMode('desktop')).toBe('chat');
  });

  it('migrates unknown mode to "chat"', () => {
    expect(migrateLayoutMode('fleet')).toBe('chat');
  });

  it('returns null for valid "chat" mode', () => {
    expect(migrateLayoutMode('chat')).toBeNull();
  });

  it('migrates legacy "code" mode to "chat"', () => {
    expect(migrateLayoutMode('code')).toBe('chat');
  });

  it('migrates intermediate "os" mode to "chat"', () => {
    expect(migrateLayoutMode('os')).toBe('chat');
  });

  it('migrates the retired "more" page to "settings"', () => {
    expect(migrateLayoutMode('more')).toBe('settings');
  });

  it('migrates the merged "spaces" tab to "chat"', () => {
    expect(migrateLayoutMode('spaces')).toBe('chat');
  });

  it('migrates the folded "inbox" tab to "work"', () => {
    expect(migrateLayoutMode('inbox')).toBe('work');
  });

  it('migrates the folded "routines" tab to "agents"', () => {
    expect(migrateLayoutMode('routines')).toBe('agents');
  });

  it('migrates the retired "home" tab to "chat"', () => {
    expect(migrateLayoutMode('home')).toBe('chat');
  });

  it('returns null for valid "work" mode', () => {
    expect(migrateLayoutMode('work')).toBeNull();
  });

  it('returns null for valid "agents" mode', () => {
    expect(migrateLayoutMode('agents')).toBeNull();
  });

  it('returns null for valid "dashboards" mode', () => {
    expect(migrateLayoutMode('dashboards')).toBeNull();
  });

  it('returns null for valid "settings" mode', () => {
    expect(migrateLayoutMode('settings')).toBeNull();
  });

  it('returns null for valid "plugins" mode', () => {
    expect(migrateLayoutMode('plugins')).toBeNull();
  });

  it('returns null for valid "sandboxes" mode', () => {
    expect(migrateLayoutMode('sandboxes')).toBeNull();
  });
});
