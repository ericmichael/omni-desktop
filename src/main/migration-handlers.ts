/**
 * IPC handlers for the post-migration notice (Task #18, pages relocation).
 *
 * Identical between Electron and server mode — both pass an `IIpcListener`
 * and a thin store adapter that knows how to read/write the
 * `pagesMigration` slice of `StoreData`. Shape mirrors
 * `src/shared/ipc-handlers.ts` so the wire-in is symmetric.
 */
import { rmSync } from 'node:fs';

import type { IIpcListener } from '@/shared/ipc-listener';
import type { PagesMigrationState } from '@/shared/types';

export interface MigrationStoreAdapter {
  /** Read the current notice state (null when there is nothing to show). */
  get(): PagesMigrationState | null;
  /** Write the slice. Pass `null` to clear it entirely. */
  set(value: PagesMigrationState | null): void;
}

/**
 * Wire `migration:*` handlers onto the supplied listener.
 *
 * Cleanup removes only the paths recorded in the notice; we never widen the
 * blast radius based on user input. Errors per-path are swallowed because
 * the migration is best-effort — a path that disappears between record
 * and cleanup is just one fewer thing to delete.
 */
export function registerMigrationHandlers(
  ipc: IIpcListener,
  resolve: (event: unknown) => MigrationStoreAdapter
): void {
  ipc.handle('migration:get-pages-state', (e: unknown) => resolve(e).get());

  ipc.handle('migration:acknowledge-pages', (e: unknown) => {
    const store = resolve(e);
    const state = store.get();
    if (!state) {
      return;
    }
    store.set({ ...state, acknowledged: true });
  });

  ipc.handle('migration:cleanup-legacy-pages', (e: unknown) => {
    const store = resolve(e);
    const state = store.get();
    if (!state) {
      return { removed: 0 };
    }
    let removed = 0;
    for (const p of state.legacyPaths) {
      try {
        rmSync(p, { recursive: true, force: true });
        removed++;
      } catch (err) {
        console.warn(`[migration] failed to remove ${p}:`, err);
      }
    }
    store.set({ ...state, acknowledged: true });
    return { removed };
  });
}
