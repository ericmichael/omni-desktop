import { beforeEach, describe, expect, it } from 'vitest';

import { BrowserManager, type BrowserStoreSurface, DEFAULT_PROFILE_ID } from '@/main/browser-manager';
import type { BrowserBookmark, BrowserHistoryEntry, BrowserProfile, BrowserTabset, BrowserTabsetId } from '@/shared/types';

function makeStore(): BrowserStoreSurface {
  let profiles: BrowserProfile[] = [];
  let tabsets: Record<BrowserTabsetId, BrowserTabset> = {};
  let history: BrowserHistoryEntry[] = [];
  let bookmarks: BrowserBookmark[] = [];
  return {
    getProfiles: () => profiles,
    setProfiles: (p) => {
      profiles = p;
    },
    getTabsets: () => tabsets,
    setTabsets: (t) => {
      tabsets = t;
    },
    getHistory: () => history,
    setHistory: (h) => {
      history = h;
    },
    getBookmarks: () => bookmarks,
    setBookmarks: (b) => {
      bookmarks = b;
    },
  };
}

let idCounter = 0;
let clock = 1_000;

function makeManager() {
  idCounter = 0;
  clock = 1_000;
  return new BrowserManager({
    store: makeStore(),
    newId: () => `id-${++idCounter}`,
    now: () => ++clock,
  });
}

describe('BrowserManager', () => {
  let mgr: BrowserManager;
  beforeEach(() => {
    mgr = makeManager();
  });

  it('seeds a default profile on construction', () => {
    const { profiles } = mgr.getSnapshot();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.id).toBe(DEFAULT_PROFILE_ID);
    expect(profiles[0]!.partition).toContain('persist:');
  });

  it('ensureTabset is idempotent and creates a blank tab on first call', () => {
    const ts1 = mgr.ensureTabset('col:abc');
    expect(ts1.tabs).toHaveLength(1);
    const ts2 = mgr.ensureTabset('col:abc');
    expect(ts2.id).toBe(ts1.id);
    expect(ts2.tabs).toHaveLength(1);
  });

  it('closes the active tab and picks a sensible successor', () => {
    mgr.ensureTabset('ts');
    const a = mgr.createTab('ts', { url: 'https://a.example', activate: false });
    const b = mgr.createTab('ts', { url: 'https://b.example', activate: true });
    const before = mgr.getSnapshot().tabsets.ts!;
    expect(before.activeTabId).toBe(b.id);
    mgr.closeTab('ts', b.id);
    const after = mgr.getSnapshot().tabsets.ts!;
    expect(after.tabs.map((t) => t.id)).not.toContain(b.id);
    expect(after.activeTabId).toBe(a.id);
  });

  it('replaces the last closed tab with a blank one', () => {
    const ts = mgr.ensureTabset('solo');
    const only = ts.tabs[0]!;
    mgr.closeTab('solo', only.id);
    const after = mgr.getSnapshot().tabsets.solo!;
    expect(after.tabs).toHaveLength(1);
    expect(after.tabs[0]!.id).not.toBe(only.id);
  });

  it('records history and dedupes consecutive duplicates', () => {
    mgr.recordHistory({ url: 'https://a.example', profileId: DEFAULT_PROFILE_ID });
    mgr.recordHistory({ url: 'https://a.example', profileId: DEFAULT_PROFILE_ID });
    mgr.recordHistory({ url: 'https://b.example', profileId: DEFAULT_PROFILE_ID });
    expect(mgr.listHistory()).toHaveLength(2);
  });

  it('suggest returns bookmark first, then history, then search', () => {
    mgr.addBookmark({ url: 'https://github.com/x/y', title: 'github x/y' });
    mgr.recordHistory({
      url: 'https://github.com/something-else',
      title: 'Something Else',
      profileId: DEFAULT_PROFILE_ID,
    });
    const out = mgr.suggest('github');
    expect(out[0]!.kind).toBe('bookmark');
    expect(out.some((s) => s.kind === 'history')).toBe(true);
    expect(out[out.length - 1]!.kind).toBe('search');
  });

  it('normalizeAddress runs on navigate so typed localhost works', () => {
    mgr.ensureTabset('nav');
    const { activeTabId } = mgr.getSnapshot().tabsets.nav!;
    mgr.navigateTab('nav', activeTabId!, 'localhost:3000');
    const ts = mgr.getSnapshot().tabsets.nav!;
    expect(ts.tabs[0]!.url).toBe('http://localhost:3000');
  });

  it('removeTabset drops the entry', () => {
    mgr.ensureTabset('t1');
    mgr.removeTabset('t1');
    expect(mgr.getSnapshot().tabsets.t1).toBeUndefined();
  });

  it('duplicateTab inserts beside the source and activates the clone', () => {
    mgr.ensureTabset('dup');
    const src = mgr.getSnapshot().tabsets.dup!.tabs[0]!;
    mgr.updateTabMeta('dup', src.id, { url: 'https://x.example', title: 'X' });
    const clone = mgr.duplicateTab('dup', src.id);
    const after = mgr.getSnapshot().tabsets.dup!;
    expect(after.tabs).toHaveLength(2);
    expect(after.tabs[1]!.id).toBe(clone.id);
    expect(after.activeTabId).toBe(clone.id);
  });

  it('removeProfile reassigns tabsets to default', () => {
    const p = mgr.addProfile({ label: 'Work' });
    mgr.ensureTabset('x', { profileId: p.id });
    mgr.removeProfile(p.id);
    expect(mgr.getSnapshot().tabsets.x!.profileId).toBe(DEFAULT_PROFILE_ID);
  });

  it('refuses to remove the default profile', () => {
    expect(() => mgr.removeProfile(DEFAULT_PROFILE_ID)).toThrow();
  });
});
