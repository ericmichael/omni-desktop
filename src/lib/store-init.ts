/**
 * Pure logic extracted from the renderer store init sequence.
 *
 * These functions determine what store corrections are needed at startup
 * without performing any I/O — the caller applies the patches.
 */

import type { LayoutMode, SandboxBackend } from '@/shared/types';

const VALID_LAYOUT_MODES: LayoutMode[] = ['chat', 'code', 'projects', 'dashboards', 'settings', 'more'];

/**
 * GA users (no preview features, no enterprise policy) must not run with any
 * sandbox backend. Returns 'none' if the backend should be reset, null if ok.
 */
export function enforceSandboxPolicy(store: {
  previewFeatures: boolean;
  sandboxProfiles: unknown[] | null;
  sandboxBackend: SandboxBackend;
}): 'none' | null {
  if (!store.previewFeatures && !store.sandboxProfiles && store.sandboxBackend && store.sandboxBackend !== 'none') {
    return 'none';
  }
  return null;
}

/**
 * Migrate legacy layout modes to current valid modes.
 * Returns the corrected mode, or null if the current mode is already valid.
 */
export function migrateLayoutMode(mode: string): LayoutMode | null {
  if (mode === 'work' || mode === 'desktop' || mode === 'home') {
    return 'chat';
  }
  if (!VALID_LAYOUT_MODES.includes(mode as LayoutMode)) {
    return 'chat';
  }
  return null;
}
