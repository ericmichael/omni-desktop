import { atom } from 'nanostores';

import { $residentsView } from '@/renderer/features/Residents/state';
import { persistedStoreApi } from '@/renderer/services/store';

/**
 * Which routine is open in the Agents tab's Routines surface (null = the
 * list). Same shape as the inbox's `$inboxView`, and for the same reason:
 * one source of truth for "which routine is open" that cross-tab jumps can
 * set before raising the surface.
 */
export const $routinesView = atom<{ selectedTaskId: string | null }>({ selectedTaskId: null });

/** Open the Agents tab's Routines surface, optionally on a specific routine. */
export function goToRoutine(selectedTaskId?: string): void {
  $routinesView.set({ selectedTaskId: selectedTaskId ?? null });
  $residentsView.set({ selectedAgentId: null, selectedChannel: null, showRoutines: true });
  if (persistedStoreApi.$atom.get().layoutMode !== 'agents') {
    persistedStoreApi.setKey('layoutMode', 'agents');
  }
}
