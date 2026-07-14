import { atom } from 'nanostores';

import { persistedStoreApi } from '@/renderer/services/store';

/**
 * Which routine is open in the rail-level Routines tab (null = the list).
 * Same shape as the Inbox tab's `$inboxView`, and for the same reason: one
 * source of truth for "which routine is open" that cross-tab jumps can set
 * before raising the tab.
 */
export const $routinesView = atom<{ selectedTaskId: string | null }>({ selectedTaskId: null });

/** Raise the Routines rail tab, optionally landing on a specific routine. */
export function goToRoutine(selectedTaskId?: string): void {
  $routinesView.set({ selectedTaskId: selectedTaskId ?? null });
  if (persistedStoreApi.$atom.get().layoutMode !== 'routines') {
    persistedStoreApi.setKey('layoutMode', 'routines');
  }
}
