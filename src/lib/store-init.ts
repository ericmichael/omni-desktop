/**
 * Pure logic extracted from the renderer store init sequence.
 *
 * These functions determine what store corrections are needed at startup
 * without performing any I/O — the caller applies the patches.
 */

import type { LayoutMode, OmniTheme } from '@/shared/types';

const VALID_LAYOUT_MODES: LayoutMode[] = ['work', 'chat', 'dashboards', 'agents', 'plugins', 'settings'];

/**
 * Migrate legacy layout modes to current valid modes.
 * Returns the corrected mode, or null if the current mode is already valid.
 *
 * Note: 'home' and 'work' existed as layout modes twice — once in the
 * pre-deck era (retired to 'chat') and again since the attention-centric IA
 * split (Home / Inbox / Work rail tabs). The old values were reset by boots
 * of intermediate versions, so treating them as valid today cannot resurrect
 * a pre-deck value.
 */
export function migrateLayoutMode(mode: string): LayoutMode | null {
  // The container-centric Projects tab split into Home / Inbox / Work; the
  // project-and-task surface itself lives under Work.
  if (mode === 'projects') {
    return 'work';
  }
  // The Inbox rail tab folded into Work (an "Inbox" sidebar row / view).
  if (mode === 'inbox') {
    return 'work';
  }
  // The Routines rail tab folded into Agents (a "Routines" nav-row surface).
  if (mode === 'routines') {
    return 'agents';
  }
  // Home retired with the unified sidebar — the sidebar's badges are the
  // attention surface; the Deck is the landing.
  if (mode === 'home') {
    return 'chat';
  }
  // 'spaces' merged into 'chat' (the deck now lives behind the Chat tab);
  // 'code' and 'os' were its earlier names.
  if (mode === 'code' || mode === 'os' || mode === 'spaces' || mode === 'desktop') {
    return 'chat';
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
