/**
 * Platform-shell plumbing for top-level navigation (UI/UX gameplan Phase 8).
 *
 * Mirrors the app's navigation state — the active layout mode plus the
 * Projects view — into the browser history, so system back/forward navigate
 * the app instead of exiting it (PWA/browser mode; harmless under Electron).
 * Also keeps `document.title` describing where the user is, for the browser
 * tab, the task switcher, and the Electron window title.
 *
 * Loop guard: applying a popstate writes `lastKey` *before* mutating the
 * stores, so the (async, IPC round-trip) store echo arrives with a key we
 * already recorded and is not pushed again.
 */
import { $mobileNavOpen, restoreMobileNav, setNavEntryWasPushed } from '@/renderer/app/mobile-nav';
import { $ticketsView, pushTicketsHistory, type TicketsView } from '@/renderer/features/Tickets/state';
import { $initialized, persistedStoreApi } from '@/renderer/services/store';
import type { LayoutMode } from '@/shared/types';

type AppHistoryState = {
  omni: true;
  layoutMode: LayoutMode;
  ticketsView: TicketsView;
  /** Mobile: whether the nav drawer was open. The open drawer is a real
   *  history entry, so system back / edge-swipe closes it. */
  navOpen: boolean;
};

const TAB_TITLES: Record<LayoutMode, string> = {
  work: 'Work',
  chat: 'Chat',
  dashboards: 'Dashboards',
  agents: 'Agents',
  plugins: 'Plugins',
  sandboxes: 'Sandboxes',
  settings: 'Settings',
  gallery: 'Gallery',
};

const currentState = (): AppHistoryState => ({
  omni: true,
  layoutMode: persistedStoreApi.get().layoutMode,
  ticketsView: $ticketsView.get(),
  navOpen: $mobileNavOpen.get(),
});

const keyOf = (state: AppHistoryState): string => JSON.stringify([state.layoutMode, state.ticketsView, state.navOpen]);

/** History entries persist across reloads — an old entry may carry a retired mode. */
const isValidMode = (mode: unknown): mode is LayoutMode => typeof mode === 'string' && mode in TAB_TITLES;

/**
 * History entries also persist across app versions — migrate retired view
 * shapes (pre-shell `board` views, `project` views without a tab) instead of
 * letting them land in `$ticketsView` malformed.
 */
const normalizeTicketsView = (view: TicketsView): TicketsView => {
  const legacy = view as unknown as { type: string; projectId?: string; tab?: unknown };
  if (legacy.type === 'board' && legacy.projectId) {
    return { type: 'project', projectId: legacy.projectId, tab: 'board' };
  }
  // 'dashboard' moved to its own rail tab; an old Work-view entry carrying
  // it lands on the all-work list. ('inbox' is a valid Work view again.)
  if (legacy.type === 'dashboard') {
    return { type: 'all' };
  }
  if (view.type === 'project' && !legacy.tab) {
    return { type: 'project', projectId: view.projectId, tab: 'home' };
  }
  return view;
};

let lastKey = '';
/** The state the current history entry holds — tells us whether a change is
 *  being made from an open drawer, whose entry it then supersedes. */
let lastState: AppHistoryState | null = null;
/** Mirrors what the drawer module was told, so a replace can inherit it. */
let navEntryPushed = false;
const markNavEntry = (value: boolean): void => {
  navEntryPushed = value;
  setNavEntryWasPushed(value);
};
let lastPushAt = 0;

/**
 * One user gesture can land as several store updates milliseconds apart
 * (e.g. a tab click sets layoutMode over IPC *and* resets the Projects view
 * synchronously). Updates inside this window replace the entry instead of
 * stacking, so one gesture costs one Back press.
 */
const COALESCE_MS = 300;

const syncTitle = (mode: LayoutMode): void => {
  document.title = `${TAB_TITLES[mode]} — Omni`;
};

const applyHistoryState = (state: AppHistoryState): void => {
  lastKey = keyOf(state);
  lastState = state;
  // We landed here by popping, so this entry isn't one we pushed —
  // dismissing the drawer must not pop again.
  markNavEntry(false);
  // The next navigation after a back/forward must push, never coalesce —
  // replacing here would overwrite the entry the user just landed on.
  lastPushAt = 0;
  // Drawer first: the flag is set before layoutMode so the store echo arrives
  // already marked as a restore and doesn't fight the restored value.
  restoreMobileNav(state.navOpen, state.layoutMode);
  if (persistedStoreApi.get().layoutMode !== state.layoutMode) {
    void persistedStoreApi.setKey('layoutMode', state.layoutMode);
  }
  // Keep the in-app contextual Back buttons coherent: the view being left
  // becomes "previous" for them too.
  pushTicketsHistory($ticketsView.get());
  $ticketsView.set(normalizeTicketsView(state.ticketsView));
  syncTitle(state.layoutMode);
};

const onNavChange = (): void => {
  const state = currentState();
  const key = keyOf(state);
  if (key === lastKey) {
    return;
  }
  const leaving = lastState;
  lastKey = key;
  lastState = state;
  syncTitle(state.layoutMode);
  const now = Date.now();
  // An open drawer is an overlay, not a destination: ANY change made from
  // one supersedes its entry rather than stacking on it. Order-independent
  // on purpose — picking a nav row lands as two updates (the view, then the
  // drawer closing) and neither must leave the drawer in the back stack.
  const supersedesDrawer = leaving?.navOpen === true;
  try {
    if (supersedesDrawer || now - lastPushAt < COALESCE_MS) {
      window.history.replaceState(state, '');
      // A replace inherits the entry's identity — it stops being a poppable
      // drawer entry only once the drawer itself has closed.
      markNavEntry(navEntryPushed && state.navOpen);
    } else {
      window.history.pushState(state, '');
      markNavEntry(state.navOpen);
    }
    lastPushAt = now;
  } catch {
    // History can throw under rapid-fire updates (Safari rate limit) — the
    // app keeps working, this entry just isn't navigable.
  }
};

let started = false;

/** Idempotent; subscribed from the App shell once the store atom is live. */
export const initAppHistory = (): void => {
  if (started) {
    return;
  }
  started = true;

  const start = (): void => {
    const state = currentState();
    lastKey = keyOf(state);
    lastState = state;
    syncTitle(state.layoutMode);
    window.history.replaceState(state, '');

    persistedStoreApi.$atom.listen(onNavChange);
    $ticketsView.listen(onNavChange);
    $mobileNavOpen.listen(onNavChange);

    window.addEventListener('popstate', (event: PopStateEvent) => {
      const state = event.state as Partial<AppHistoryState> | null;
      if (!state?.omni || !isValidMode(state.layoutMode) || !state.ticketsView) {
        return;
      }
      // Entries written before the drawer joined the stack carry no flag.
      applyHistoryState({ ...(state as AppHistoryState), navOpen: state.navOpen === true });
    });
  };

  if ($initialized.get()) {
    start();
  } else {
    const unsubscribe = $initialized.listen((ready) => {
      if (ready) {
        unsubscribe();
        start();
      }
    });
  }
};
