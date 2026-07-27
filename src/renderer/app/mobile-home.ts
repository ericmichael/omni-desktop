import { atom } from 'nanostores';

import { persistedStoreApi } from '@/renderer/services/store';

/**
 * Mobile-only: whether the Home page (the unified sidebar rendered
 * full-screen) is frontmost. The Slack mobile model — the bottom bar's Home
 * tab shows the nav as a page; opening any surface closes it, and the bar
 * is always there to come back. Desktop ignores this entirely.
 *
 * Defaults open so the app lands on Home on mobile.
 */
export const $mobileHomeOpen = atom(true);

// Any cross-surface jump (toast deep links, palette commands, session
// bridges) changes layoutMode — that's a navigation, so the Home page must
// yield to the destination surface without every call site knowing about it.
let lastMode: string | undefined;
persistedStoreApi.$atom.subscribe((store) => {
  if (store.layoutMode !== lastMode) {
    if (lastMode !== undefined) {
      $mobileHomeOpen.set(false);
    }
    lastMode = store.layoutMode;
  }
});
