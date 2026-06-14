/**
 * Pure logic extracted from the renderer store init sequence.
 *
 * These functions determine what store corrections are needed at startup
 * without performing any I/O — the caller applies the patches.
 */

import type { LayoutMode, OmniTheme } from '@/shared/types';

const VALID_LAYOUT_MODES: LayoutMode[] = ['chat', 'spaces', 'projects', 'dashboards', 'routines', 'settings'];

/**
 * Migrate legacy layout modes to current valid modes.
 * Returns the corrected mode, or null if the current mode is already valid.
 */
export function migrateLayoutMode(mode: string): LayoutMode | null {
  if (mode === 'work' || mode === 'desktop' || mode === 'home') {
    return 'chat';
  }
  if (mode === 'code' || mode === 'os') {
    return 'spaces';
  }
  // The mobile "More" page was retired — its only destination was Settings.
  if (mode === 'more') {
    return 'settings';
  }
  if (!VALID_LAYOUT_MODES.includes(mode as LayoutMode)) {
    return 'chat';
  }
  return null;
}

/**
 * Themes whose material is glass. Mirrors `material: 'glass'` in
 * `renderer/theme/fluent-themes.ts` — kept literal here so this module stays
 * free of renderer/Fluent imports.
 */
const GLASS_THEMES: ReadonlySet<string> = new Set(['omni']);

/**
 * Phase 10 one-knob migration: glass used to be activated by uploading a
 * wallpaper on ANY theme. Material now follows the theme, so a user with a
 * wallpaper on a flat theme moves to the glass theme (their wallpaper and
 * detected tone are kept — appearance is preserved; only the accent changes).
 * Returns the corrected theme, or null when no change is needed.
 */
export function migrateThemeForGlass(theme: string, hasBackground: boolean): OmniTheme | null {
  if (!hasBackground || GLASS_THEMES.has(theme)) {
    return null;
  }
  return 'omni';
}
