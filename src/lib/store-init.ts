/**
 * Pure logic extracted from the renderer store init sequence.
 *
 * These functions determine what store corrections are needed at startup
 * without performing any I/O — the caller applies the patches.
 */

import type { LayoutMode } from '@/shared/types';

const VALID_LAYOUT_MODES: LayoutMode[] = ['chat', 'spaces', 'projects', 'dashboards', 'settings', 'more'];

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
  if (!VALID_LAYOUT_MODES.includes(mode as LayoutMode)) {
    return 'chat';
  }
  return null;
}
