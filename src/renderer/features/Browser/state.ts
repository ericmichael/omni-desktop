/**
 * Renderer-side bridge to the main-process BrowserManager. Exposes:
 *
 *  - `$browserState`  — nanostores atom kept in sync with `browser:state-changed`
 *  - `browserApi`     — thin IPC invokers covering every browser:* channel
 *
 * Every mutation goes through the manager, never directly at the persisted
 * store, so history/tabs/bookmarks stay consistent across surfaces.
 */
import { atom } from 'nanostores';

import { emitter, ipc } from '@/renderer/services/ipc';
import type {
  BrowserBookmark,
  BrowserHistoryEntry,
  BrowserProfile,
  BrowserProfileId,
  BrowserSuggestion,
  BrowserTab,
  BrowserTabId,
  BrowserTabset,
  BrowserTabsetId,
} from '@/shared/types';

export type BrowserSnapshot = {
  profiles: BrowserProfile[];
  tabsets: Record<BrowserTabsetId, BrowserTabset>;
  bookmarks: BrowserBookmark[];
};

const EMPTY: BrowserSnapshot = { profiles: [], tabsets: {}, bookmarks: [] };

export const $browserState = atom<BrowserSnapshot>(EMPTY);

ipc.on('browser:state-changed', (snapshot) => {
  $browserState.set(snapshot ?? EMPTY);
});

/** Fire-and-forget snapshot fetch; resolves the atom on startup. */
void emitter
  .invoke('browser:get-state')
  .then((snap) => $browserState.set(snap))
  .catch(() => {
    /* ignore — we already have the default snapshot */
  });

export const browserApi = {
  ensureTabset: (id: BrowserTabsetId, opts?: { profileId?: BrowserProfileId; initialUrl?: string }) =>
    emitter.invoke('browser:tabset-ensure', id, opts),
  removeTabset: (id: BrowserTabsetId) => emitter.invoke('browser:tabset-remove', id),
  setTabsetProfile: (id: BrowserTabsetId, profileId: BrowserProfileId) =>
    emitter.invoke('browser:tabset-set-profile', id, profileId),

  addProfile: (input: { label: string; incognito?: boolean }) =>
    emitter.invoke('browser:profile-add', input),
  removeProfile: (id: BrowserProfileId) => emitter.invoke('browser:profile-remove', id),

  createTab: (tabsetId: BrowserTabsetId, opts?: { url?: string; activate?: boolean; profileId?: BrowserProfileId }) =>
    emitter.invoke('browser:tab-create', tabsetId, opts),
  closeTab: (tabsetId: BrowserTabsetId, tabId: BrowserTabId) =>
    emitter.invoke('browser:tab-close', tabsetId, tabId),
  activateTab: (tabsetId: BrowserTabsetId, tabId: BrowserTabId) =>
    emitter.invoke('browser:tab-activate', tabsetId, tabId),
  navigateTab: (tabsetId: BrowserTabsetId, tabId: BrowserTabId, url: string) =>
    emitter.invoke('browser:tab-navigate', tabsetId, tabId, url),
  updateTabMeta: (
    tabsetId: BrowserTabsetId,
    tabId: BrowserTabId,
    patch: { title?: string; favicon?: string; url?: string }
  ) => emitter.invoke('browser:tab-update-meta', tabsetId, tabId, patch),
  reorderTabs: (tabsetId: BrowserTabsetId, tabIds: BrowserTabId[]) =>
    emitter.invoke('browser:tab-reorder', tabsetId, tabIds),
  pinTab: (tabsetId: BrowserTabsetId, tabId: BrowserTabId, pinned: boolean) =>
    emitter.invoke('browser:tab-pin', tabsetId, tabId, pinned),
  duplicateTab: (tabsetId: BrowserTabsetId, tabId: BrowserTabId): Promise<BrowserTab> =>
    emitter.invoke('browser:tab-duplicate', tabsetId, tabId),
  reopenTab: (tabsetId: BrowserTabsetId): Promise<BrowserTab | null> =>
    emitter.invoke('browser:tab-reopen', tabsetId),

  recordHistory: (entry: { url: string; title?: string; profileId: BrowserProfileId }) =>
    emitter.invoke('browser:history-record', entry),
  listHistory: (opts?: { query?: string; limit?: number; profileId?: BrowserProfileId }): Promise<BrowserHistoryEntry[]> =>
    emitter.invoke('browser:history-list', opts),
  clearHistory: (opts?: { profileId?: BrowserProfileId }) => emitter.invoke('browser:history-clear', opts),

  addBookmark: (input: { url: string; title: string; folder?: string }) =>
    emitter.invoke('browser:bookmark-add', input),
  removeBookmark: (id: string) => emitter.invoke('browser:bookmark-remove', id),

  suggest: (query: string, opts?: { limit?: number; profileId?: BrowserProfileId }): Promise<BrowserSuggestion[]> =>
    emitter.invoke('browser:suggest', query, opts),
};

/**
 * Pick a tab from a tabset. Returns the active tab if the tabset has one,
 * otherwise the first tab, otherwise null.
 */
export function getActiveTab(ts: BrowserTabset | undefined): BrowserTab | null {
  if (!ts) {
return null;
}
  if (ts.activeTabId) {
    const t = ts.tabs.find((x) => x.id === ts.activeTabId);
    if (t) {
return t;
}
  }
  return ts.tabs[0] ?? null;
}
