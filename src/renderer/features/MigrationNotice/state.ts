/**
 * Renderer-side hooks for the post-migration notice (Task #18).
 *
 * The state lives on `StoreData.pagesMigration` and is mirrored into the
 * renderer's persisted-store atom. We derive a computed atom that yields
 * the state only when it exists *and* hasn't been acknowledged yet, so
 * the component can simply check truthiness to decide whether to render.
 */
import { computed } from 'nanostores';

import { emitter } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type { PagesMigrationState } from '@/shared/types';

/**
 * The notice state when one is pending; `null` when there's nothing to
 * show (either no migration happened or the user already acted on it).
 */
export const $pendingMigrationNotice = computed(
  persistedStoreApi.$atom,
  (store): PagesMigrationState | null => {
    const state = store.pagesMigration;
    if (!state || state.acknowledged) {
      return null;
    }
    return state;
  }
);

export const migrationApi = {
  acknowledge: (): Promise<void> => emitter.invoke('migration:acknowledge-pages'),
  cleanupLegacy: (): Promise<{ removed: number }> =>
    emitter.invoke('migration:cleanup-legacy-pages'),
};
