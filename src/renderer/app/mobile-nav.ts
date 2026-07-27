import { atom } from 'nanostores';

import { persistedStoreApi } from '@/renderer/services/store';
import type { LayoutMode } from '@/shared/types';

/**
 * Mobile-only: whether the nav drawer (the unified sidebar, overlaid) is
 * open. The ChatGPT/Gmail model — the app lands on the working surface, not
 * on navigation, and the sidebar slides over it from a leading affordance in
 * the surface's header. There is no bottom bar and no Home screen.
 *
 * `app-history` mirrors this into `window.history`, so the system back
 * button and the edge-swipe gesture close the drawer. Desktop, where the
 * sidebar is always present, ignores this entirely.
 */
export const $mobileNavOpen = atom(false);

/** Whether the current history entry is one we pushed for the open drawer —
 *  maintained by `app-history`, the only module that knows the stack. */
let navEntryWasPushed = false;

export function setNavEntryWasPushed(value: boolean): void {
  navEntryWasPushed = value;
}

export function openMobileNav(): void {
  $mobileNavOpen.set(true);
}

/**
 * Close the drawer (scrim tap, Escape, the drawer's own dismiss).
 *
 * When the open drawer is its own history entry this POPS, so the dismiss
 * gesture and the system back button do the same thing and the stack doesn't
 * accumulate a dead entry per peek. Selecting a nav row does NOT come through
 * here — that's a navigation, and `app-history` replaces the drawer's entry
 * with the destination so back skips straight past it.
 */
export function closeMobileNav(): void {
  if (navEntryWasPushed) {
    window.history.back();
    return;
  }
  $mobileNavOpen.set(false);
}

// Any cross-surface jump (toast deep links, palette commands, session
// bridges) changes layoutMode — that's a navigation, so the drawer must
// yield without every call site knowing about it.
let lastMode: string | undefined;
// ...except when the mode change IS a history restore: popping to an entry
// sets both, and the (async) store echo must not fight the restored value.
let restoredMode: LayoutMode | undefined;

/** Apply a history entry's drawer state. Call before mutating `layoutMode`. */
export function restoreMobileNav(open: boolean, mode: LayoutMode): void {
  restoredMode = mode;
  $mobileNavOpen.set(open);
}

persistedStoreApi.$atom.subscribe((store) => {
  if (store.layoutMode !== lastMode) {
    const restored = store.layoutMode === restoredMode;
    restoredMode = undefined;
    if (lastMode !== undefined && !restored) {
      $mobileNavOpen.set(false);
    }
    lastMode = store.layoutMode;
  }
});
