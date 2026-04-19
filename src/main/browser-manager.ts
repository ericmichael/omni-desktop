/**
 * BrowserManager — source of truth for the browser surface.
 *
 * Owns profiles, tabsets, per-tab navigation state, history, and bookmarks.
 * Every mutation updates the persisted store and broadcasts a full
 * `browser:state-changed` snapshot so every renderer sees the same data.
 *
 * The manager is deliberately pure w.r.t. Electron — it depends only on a
 * narrow store interface so it can be exercised in tests without a live
 * electron-store instance.
 */
import { BROWSER_START_URL, normalizeAddress } from '@/lib/url';
import type { IIpcListener } from '@/shared/ipc-listener';
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
  IpcRendererEvents,
} from '@/shared/types';

/** Upper bound on persisted history. Older entries are pruned on insert. */
export const HISTORY_CAP = 2000;

/** Built-in default profile id. Always present; cannot be removed. */
export const DEFAULT_PROFILE_ID = 'default';

export interface BrowserStoreSurface {
  getProfiles(): BrowserProfile[];
  setProfiles(p: BrowserProfile[]): void;
  getTabsets(): Record<BrowserTabsetId, BrowserTabset>;
  setTabsets(t: Record<BrowserTabsetId, BrowserTabset>): void;
  getHistory(): BrowserHistoryEntry[];
  setHistory(h: BrowserHistoryEntry[]): void;
  getBookmarks(): BrowserBookmark[];
  setBookmarks(b: BrowserBookmark[]): void;
}

export interface BrowserManagerDeps {
  store: BrowserStoreSurface;
  newId: () => string;
  now: () => number;
}

export class BrowserTabsetNotFoundError extends Error {
  constructor(id: string) {
    super(`Browser tabset ${id} not found`);
  }
}

export class BrowserTabNotFoundError extends Error {
  constructor(tabsetId: string, tabId: string) {
    super(`Browser tab ${tabId} not found in tabset ${tabsetId}`);
  }
}

export class BrowserManager {
  constructor(private readonly deps: BrowserManagerDeps) {
    this.ensureDefaultProfile();
  }

  // ---------------------------------------------------------------------------
  // Snapshot
  // ---------------------------------------------------------------------------

  getSnapshot(): {
    profiles: BrowserProfile[];
    tabsets: Record<BrowserTabsetId, BrowserTabset>;
    bookmarks: BrowserBookmark[];
  } {
    return {
      profiles: this.deps.store.getProfiles(),
      tabsets: this.deps.store.getTabsets(),
      bookmarks: this.deps.store.getBookmarks(),
    };
  }

  // ---------------------------------------------------------------------------
  // Profiles
  // ---------------------------------------------------------------------------

  private ensureDefaultProfile(): BrowserProfile {
    const profiles = this.deps.store.getProfiles();
    const existing = profiles.find((p) => p.id === DEFAULT_PROFILE_ID);
    if (existing) {
return existing;
}
    const profile: BrowserProfile = {
      id: DEFAULT_PROFILE_ID,
      label: 'Default',
      partition: `persist:browser-${DEFAULT_PROFILE_ID}`,
      builtin: true,
      createdAt: this.deps.now(),
    };
    this.deps.store.setProfiles([profile, ...profiles]);
    return profile;
  }

  addProfile(input: { label: string; incognito?: boolean }): BrowserProfile {
    const profiles = this.deps.store.getProfiles();
    const id = this.deps.newId();
    const profile: BrowserProfile = {
      id,
      label: input.label.trim() || 'Profile',
      // Incognito profiles use a non-persistent partition (no `persist:` prefix).
      partition: input.incognito ? `browser-${id}` : `persist:browser-${id}`,
      createdAt: this.deps.now(),
      ...(input.incognito ? { incognito: true } : {}),
    };
    this.deps.store.setProfiles([...profiles, profile]);
    return profile;
  }

  removeProfile(id: BrowserProfileId): void {
    if (id === DEFAULT_PROFILE_ID) {
      throw new Error('Cannot remove the default profile');
    }
    const profiles = this.deps.store.getProfiles();
    this.deps.store.setProfiles(profiles.filter((p) => p.id !== id));
    // Reassign any tabset using the removed profile back to default.
    const tabsets = this.deps.store.getTabsets();
    let mutated = false;
    const next: Record<BrowserTabsetId, BrowserTabset> = {};
    for (const [tsId, ts] of Object.entries(tabsets)) {
      if (ts.profileId === id) {
        next[tsId] = { ...ts, profileId: DEFAULT_PROFILE_ID, updatedAt: this.deps.now() };
        mutated = true;
      } else {
        next[tsId] = ts;
      }
    }
    if (mutated) {
this.deps.store.setTabsets(next);
}
  }

  // ---------------------------------------------------------------------------
  // Tabsets
  // ---------------------------------------------------------------------------

  ensureTabset(
    id: BrowserTabsetId,
    opts?: { profileId?: BrowserProfileId; initialUrl?: string }
  ): BrowserTabset {
    const tabsets = this.deps.store.getTabsets();
    const existing = tabsets[id];
    if (existing) {
return existing;
}
    const now = this.deps.now();
    const initialUrl = opts?.initialUrl ?? BROWSER_START_URL;
    const firstTab: BrowserTab = {
      id: this.deps.newId(),
      url: initialUrl,
      createdAt: now,
      lastActiveAt: now,
    };
    const tabset: BrowserTabset = {
      id,
      profileId: opts?.profileId ?? DEFAULT_PROFILE_ID,
      tabs: [firstTab],
      activeTabId: firstTab.id,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.store.setTabsets({ ...tabsets, [id]: tabset });
    return tabset;
  }

  removeTabset(id: BrowserTabsetId): void {
    const tabsets = this.deps.store.getTabsets();
    if (!tabsets[id]) {
return;
}
    const { [id]: _removed, ...rest } = tabsets;
    this.deps.store.setTabsets(rest);
  }

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------

  createTab(
    tabsetId: BrowserTabsetId,
    opts?: { url?: string; activate?: boolean; profileId?: BrowserProfileId }
  ): BrowserTab {
    return this.mutateTabset(tabsetId, (ts) => {
      const now = this.deps.now();
      const tab: BrowserTab = {
        id: this.deps.newId(),
        url: opts?.url ?? BROWSER_START_URL,
        createdAt: now,
        lastActiveAt: now,
        ...(opts?.profileId ? { profileId: opts.profileId } : {}),
      };
      const tabs = [...ts.tabs, tab];
      return {
        next: {
          ...ts,
          tabs,
          activeTabId: opts?.activate === false ? ts.activeTabId : tab.id,
        },
        result: tab,
      };
    });
  }

  closeTab(tabsetId: BrowserTabsetId, tabId: BrowserTabId): void {
    this.mutateTabset(tabsetId, (ts) => {
      const idx = ts.tabs.findIndex((t) => t.id === tabId);
      if (idx < 0) {
throw new BrowserTabNotFoundError(tabsetId, tabId);
}
      const tabs = ts.tabs.filter((t) => t.id !== tabId);
      let activeTabId = ts.activeTabId;
      if (activeTabId === tabId) {
        // Prefer the tab immediately to the right, then left, then none.
        activeTabId = tabs[idx]?.id ?? tabs[idx - 1]?.id ?? null;
      }
      // If the tabset is now empty, keep one blank tab so surfaces always have
      // something to render. Cheaper than a bunch of empty-state branching.
      if (tabs.length === 0) {
        const now = this.deps.now();
        const fresh: BrowserTab = {
          id: this.deps.newId(),
          url: BROWSER_START_URL,
          createdAt: now,
          lastActiveAt: now,
        };
        return { next: { ...ts, tabs: [fresh], activeTabId: fresh.id } };
      }
      return { next: { ...ts, tabs, activeTabId } };
    });
  }

  activateTab(tabsetId: BrowserTabsetId, tabId: BrowserTabId): void {
    this.mutateTabset(tabsetId, (ts) => {
      if (!ts.tabs.some((t) => t.id === tabId)) {
        throw new BrowserTabNotFoundError(tabsetId, tabId);
      }
      const now = this.deps.now();
      const tabs = ts.tabs.map((t) => (t.id === tabId ? { ...t, lastActiveAt: now } : t));
      return { next: { ...ts, tabs, activeTabId: tabId } };
    });
  }

  navigateTab(tabsetId: BrowserTabsetId, tabId: BrowserTabId, rawUrl: string): void {
    const url = normalizeAddress(rawUrl);
    this.mutateTabset(tabsetId, (ts) => {
      const tab = ts.tabs.find((t) => t.id === tabId);
      if (!tab) {
throw new BrowserTabNotFoundError(tabsetId, tabId);
}
      const now = this.deps.now();
      const tabs = ts.tabs.map((t) =>
        t.id === tabId ? { ...t, url, lastActiveAt: now, title: undefined, favicon: undefined } : t
      );
      return { next: { ...ts, tabs, activeTabId: tabId } };
    });
  }

  updateTabMeta(
    tabsetId: BrowserTabsetId,
    tabId: BrowserTabId,
    patch: { title?: string; favicon?: string; url?: string }
  ): void {
    this.mutateTabset(tabsetId, (ts) => {
      const tab = ts.tabs.find((t) => t.id === tabId);
      if (!tab) {
throw new BrowserTabNotFoundError(tabsetId, tabId);
}
      const tabs = ts.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t));
      return { next: { ...ts, tabs } };
    });
  }

  reorderTabs(tabsetId: BrowserTabsetId, tabIds: BrowserTabId[]): void {
    this.mutateTabset(tabsetId, (ts) => {
      const byId = new Map(ts.tabs.map((t) => [t.id, t]));
      const ordered: BrowserTab[] = [];
      for (const id of tabIds) {
        const t = byId.get(id);
        if (t) {
          ordered.push(t);
          byId.delete(id);
        }
      }
      // Anything the caller omitted goes to the end (defensive).
      for (const t of byId.values()) {
ordered.push(t);
}
      return { next: { ...ts, tabs: ordered } };
    });
  }

  pinTab(tabsetId: BrowserTabsetId, tabId: BrowserTabId, pinned: boolean): void {
    this.mutateTabset(tabsetId, (ts) => {
      const tab = ts.tabs.find((t) => t.id === tabId);
      if (!tab) {
throw new BrowserTabNotFoundError(tabsetId, tabId);
}
      const tabs = ts.tabs.map((t) => (t.id === tabId ? { ...t, pinned } : t));
      return { next: { ...ts, tabs } };
    });
  }

  duplicateTab(tabsetId: BrowserTabsetId, tabId: BrowserTabId): BrowserTab {
    return this.mutateTabset(tabsetId, (ts) => {
      const src = ts.tabs.find((t) => t.id === tabId);
      if (!src) {
throw new BrowserTabNotFoundError(tabsetId, tabId);
}
      const now = this.deps.now();
      const clone: BrowserTab = {
        ...src,
        id: this.deps.newId(),
        createdAt: now,
        lastActiveAt: now,
      };
      const idx = ts.tabs.findIndex((t) => t.id === tabId);
      const tabs = [...ts.tabs.slice(0, idx + 1), clone, ...ts.tabs.slice(idx + 1)];
      return { next: { ...ts, tabs, activeTabId: clone.id }, result: clone };
    });
  }

  // ---------------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------------

  recordHistory(entry: { url: string; title?: string; profileId: BrowserProfileId }): void {
    if (!entry.url || entry.url === 'about:blank') {
return;
}
    const history = this.deps.store.getHistory();
    const last = history[0];
    // Dedupe consecutive visits to the same URL within the same profile.
    if (last && last.url === entry.url && last.profileId === entry.profileId) {
      if (entry.title && entry.title !== last.title) {
        const updated: BrowserHistoryEntry = { ...last, title: entry.title, visitedAt: this.deps.now() };
        this.deps.store.setHistory([updated, ...history.slice(1)]);
      }
      return;
    }
    const fresh: BrowserHistoryEntry = {
      id: this.deps.newId(),
      url: entry.url,
      profileId: entry.profileId,
      visitedAt: this.deps.now(),
      ...(entry.title ? { title: entry.title } : {}),
    };
    const next = [fresh, ...history].slice(0, HISTORY_CAP);
    this.deps.store.setHistory(next);
  }

  listHistory(opts?: {
    query?: string;
    limit?: number;
    profileId?: BrowserProfileId;
  }): BrowserHistoryEntry[] {
    const q = (opts?.query ?? '').trim().toLowerCase();
    const limit = opts?.limit ?? 100;
    let entries = this.deps.store.getHistory();
    if (opts?.profileId) {
entries = entries.filter((e) => e.profileId === opts.profileId);
}
    if (q) {
      entries = entries.filter(
        (e) => e.url.toLowerCase().includes(q) || (e.title?.toLowerCase().includes(q) ?? false)
      );
    }
    return entries.slice(0, limit);
  }

  clearHistory(opts?: { profileId?: BrowserProfileId }): void {
    if (!opts?.profileId) {
      this.deps.store.setHistory([]);
      return;
    }
    const kept = this.deps.store.getHistory().filter((e) => e.profileId !== opts.profileId);
    this.deps.store.setHistory(kept);
  }

  // ---------------------------------------------------------------------------
  // Bookmarks
  // ---------------------------------------------------------------------------

  addBookmark(input: { url: string; title: string; folder?: string }): BrowserBookmark {
    const bookmark: BrowserBookmark = {
      id: this.deps.newId(),
      url: input.url,
      title: input.title.trim() || input.url,
      createdAt: this.deps.now(),
      ...(input.folder ? { folder: input.folder } : {}),
    };
    this.deps.store.setBookmarks([bookmark, ...this.deps.store.getBookmarks()]);
    return bookmark;
  }

  removeBookmark(id: string): void {
    this.deps.store.setBookmarks(this.deps.store.getBookmarks().filter((b) => b.id !== id));
  }

  // ---------------------------------------------------------------------------
  // Suggestions
  // ---------------------------------------------------------------------------

  suggest(
    query: string,
    opts?: { limit?: number; profileId?: BrowserProfileId }
  ): BrowserSuggestion[] {
    const q = query.trim();
    const limit = opts?.limit ?? 8;
    if (!q) {
return [];
}

    const qLower = q.toLowerCase();
    const now = this.deps.now();
    const out: BrowserSuggestion[] = [];

    // Bookmarks first — strong boost so exact bookmarks dominate.
    for (const b of this.deps.store.getBookmarks()) {
      const hay = `${b.title} ${b.url}`.toLowerCase();
      if (!hay.includes(qLower)) {
continue;
}
      out.push({ kind: 'bookmark', url: b.url, title: b.title, score: 100 + hay.indexOf(qLower) * -1 });
    }

    // History — recency-weighted.
    const history = this.deps.store.getHistory();
    const seen = new Set<string>(out.map((o) => o.url));
    for (const h of history) {
      if (opts?.profileId && h.profileId !== opts.profileId) {
continue;
}
      if (seen.has(h.url)) {
continue;
}
      const hay = `${h.title ?? ''} ${h.url}`.toLowerCase();
      if (!hay.includes(qLower)) {
continue;
}
      // Decay: last 24h ≈ +30, last week ≈ +15, older ≈ +5
      const ageHours = Math.max(0, (now - h.visitedAt) / 3_600_000);
      const recency = ageHours < 24 ? 30 : ageHours < 24 * 7 ? 15 : 5;
      out.push({ kind: 'history', url: h.url, title: h.title, score: 50 + recency - hay.indexOf(qLower) * 0.1 });
      seen.add(h.url);
    }

    out.sort((a, b) => b.score - a.score);
    const trimmed = out.slice(0, Math.max(0, limit - 1));

    // Always append a synthetic search suggestion last.
    trimmed.push({
      kind: 'search',
      url: `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
      title: `Search “${q}”`,
      score: 0,
    });
    return trimmed;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private mutateTabset<R = void>(
    tabsetId: BrowserTabsetId,
    mutator: (ts: BrowserTabset) => { next: BrowserTabset; result?: R }
  ): R {
    const tabsets = this.deps.store.getTabsets();
    const ts = tabsets[tabsetId];
    if (!ts) {
throw new BrowserTabsetNotFoundError(tabsetId);
}
    const { next, result } = mutator(ts);
    const stamped: BrowserTabset = { ...next, updatedAt: this.deps.now() };
    this.deps.store.setTabsets({ ...tabsets, [tabsetId]: stamped });
    return result as R;
  }
}

// ---------------------------------------------------------------------------
// Factory + IPC wiring
// ---------------------------------------------------------------------------

type ElectronStoreLike = {
  get<K extends 'browserProfiles' | 'browserTabsets' | 'browserHistory' | 'browserBookmarks'>(
    key: K
  ): unknown;
  set(key: string, value: unknown): void;
};

type SendToWindow = <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;

export interface CreateBrowserManagerOptions {
  ipc: IIpcListener;
  sendToWindow: SendToWindow;
  store: ElectronStoreLike;
  newId?: () => string;
  now?: () => number;
}

/**
 * Registers browser:* IPC handlers and returns the manager + cleanup.
 *
 * Every mutating handler broadcasts a full `browser:state-changed` snapshot
 * so every renderer re-renders from the same source of truth — simpler than
 * per-channel diffs and plenty fast for the tiny payload sizes at play.
 */
export function createBrowserManager(options: CreateBrowserManagerOptions): [BrowserManager, () => void] {
  const { ipc, sendToWindow, store } = options;

  const storeAdapter: BrowserStoreSurface = {
    getProfiles: () => (store.get('browserProfiles') as BrowserProfile[]) ?? [],
    setProfiles: (p) => store.set('browserProfiles', p),
    getTabsets: () => (store.get('browserTabsets') as Record<BrowserTabsetId, BrowserTabset>) ?? {},
    setTabsets: (t) => store.set('browserTabsets', t),
    getHistory: () => (store.get('browserHistory') as BrowserHistoryEntry[]) ?? [],
    setHistory: (h) => store.set('browserHistory', h),
    getBookmarks: () => (store.get('browserBookmarks') as BrowserBookmark[]) ?? [],
    setBookmarks: (b) => store.set('browserBookmarks', b),
  };

  const manager = new BrowserManager({
    store: storeAdapter,
    newId: options.newId ?? (() => `b-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`),
    now: options.now ?? (() => Date.now()),
  });

  const broadcast = () => sendToWindow('browser:state-changed', manager.getSnapshot());

  // Read-only
  ipc.handle('browser:get-state', () => manager.getSnapshot());
  ipc.handle('browser:history-list', (_: unknown, opts?: Parameters<BrowserManager['listHistory']>[0]) =>
    manager.listHistory(opts)
  );
  ipc.handle('browser:suggest', (_: unknown, q: string, opts?: Parameters<BrowserManager['suggest']>[1]) =>
    manager.suggest(q, opts)
  );

  // Profiles
  ipc.handle('browser:profile-add', (_: unknown, input: { label: string; incognito?: boolean }) => {
    const p = manager.addProfile(input);
    broadcast();
    return p;
  });
  ipc.handle('browser:profile-remove', (_: unknown, id: BrowserProfileId) => {
    manager.removeProfile(id);
    broadcast();
  });

  // Tabsets
  ipc.handle('browser:tabset-ensure', (_: unknown, id: BrowserTabsetId, opts?: Parameters<BrowserManager['ensureTabset']>[1]) => {
    const ts = manager.ensureTabset(id, opts);
    broadcast();
    return ts;
  });
  ipc.handle('browser:tabset-remove', (_: unknown, id: BrowserTabsetId) => {
    manager.removeTabset(id);
    broadcast();
  });

  // Tabs
  ipc.handle(
    'browser:tab-create',
    (_: unknown, tabsetId: BrowserTabsetId, opts?: Parameters<BrowserManager['createTab']>[1]) => {
      const t = manager.createTab(tabsetId, opts);
      broadcast();
      return t;
    }
  );
  ipc.handle('browser:tab-close', (_: unknown, tabsetId: BrowserTabsetId, tabId: BrowserTabId) => {
    manager.closeTab(tabsetId, tabId);
    broadcast();
  });
  ipc.handle('browser:tab-activate', (_: unknown, tabsetId: BrowserTabsetId, tabId: BrowserTabId) => {
    manager.activateTab(tabsetId, tabId);
    broadcast();
  });
  ipc.handle(
    'browser:tab-navigate',
    (_: unknown, tabsetId: BrowserTabsetId, tabId: BrowserTabId, url: string) => {
      manager.navigateTab(tabsetId, tabId, url);
      broadcast();
    }
  );
  ipc.handle(
    'browser:tab-update-meta',
    (
      _: unknown,
      tabsetId: BrowserTabsetId,
      tabId: BrowserTabId,
      patch: { title?: string; favicon?: string; url?: string }
    ) => {
      manager.updateTabMeta(tabsetId, tabId, patch);
      broadcast();
    }
  );
  ipc.handle(
    'browser:tab-reorder',
    (_: unknown, tabsetId: BrowserTabsetId, tabIds: BrowserTabId[]) => {
      manager.reorderTabs(tabsetId, tabIds);
      broadcast();
    }
  );
  ipc.handle(
    'browser:tab-pin',
    (_: unknown, tabsetId: BrowserTabsetId, tabId: BrowserTabId, pinned: boolean) => {
      manager.pinTab(tabsetId, tabId, pinned);
      broadcast();
    }
  );
  ipc.handle(
    'browser:tab-duplicate',
    (_: unknown, tabsetId: BrowserTabsetId, tabId: BrowserTabId) => {
      const t = manager.duplicateTab(tabsetId, tabId);
      broadcast();
      return t;
    }
  );

  // History
  ipc.handle(
    'browser:history-record',
    (_: unknown, entry: { url: string; title?: string; profileId: BrowserProfileId }) => {
      manager.recordHistory(entry);
      // History changes don't affect tabsets/profiles/bookmarks, so don't
      // broadcast a full snapshot — renderers read history on demand.
    }
  );
  ipc.handle('browser:history-clear', (_: unknown, opts?: { profileId?: BrowserProfileId }) => {
    manager.clearHistory(opts);
  });

  // Bookmarks
  ipc.handle(
    'browser:bookmark-add',
    (_: unknown, input: { url: string; title: string; folder?: string }) => {
      const b = manager.addBookmark(input);
      broadcast();
      return b;
    }
  );
  ipc.handle('browser:bookmark-remove', (_: unknown, id: string) => {
    manager.removeBookmark(id);
    broadcast();
  });

  // Seed broadcast so renderers get current state on startup even before any mutation.
  // Fire on next tick to avoid broadcasting before the window exists.
  queueMicrotask(broadcast);

  const cleanup = () => {
    // No resources to release — all state is in the store. Kept for parity
    // with other manager factories so wiring sites can await it.
  };
  return [manager, cleanup];
}
