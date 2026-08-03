import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CodeTab, Project, StoreData } from '@/shared/types';

const invoke = vi.fn(() => Promise.resolve());
const setKey = vi.fn((key: keyof StoreData, value: StoreData[keyof StoreData]) => {
  store = { ...store, [key]: value } as StoreData;
  return Promise.resolve();
});
const getKey = vi.fn((key: keyof StoreData) => store[key]);

vi.mock('@/renderer/services/ipc', () => ({
  emitter: { invoke },
}));

vi.mock('@/renderer/services/store', () => ({
  persistedStoreApi: { getKey, setKey },
}));

vi.mock('@/renderer/services/agent-process', () => ({
  $agentStatuses: { get: () => ({}), set: vi.fn() },
  $agentXTerms: { get: () => ({}), set: vi.fn() },
  agentProcessApi: { start: vi.fn(), stop: vi.fn(), rebuild: vi.fn() },
  clearStatus: vi.fn(),
  pollProcessStatus: vi.fn(),
  teardownTerminal: vi.fn(),
}));

vi.mock('@/renderer/features/Console/state', () => ({
  destroyAllTerminalsForTab: vi.fn(),
}));

vi.mock('@/renderer/constants', () => ({
  STATUS_POLL_INTERVAL_MS: 999999,
}));

let store: StoreData;

const project = (id: string, sandboxProfile?: string | null): Project => ({
  id,
  label: id,
  slug: id,
  sources: [],
  ...(sandboxProfile !== undefined ? { sandboxProfile } : {}),
  createdAt: 1,
});

const tab = (patch: Partial<CodeTab> = {}): CodeTab => ({
  id: 'tab-1',
  projectId: null,
  sessionId: 'session-1',
  snapshotRef: 'snapshot-1',
  profileName: 'host',
  profileNameExplicit: false,
  createdAt: 1,
  ...patch,
});

const resetStore = (patch: Partial<StoreData> = {}) => {
  store = {
    defaultProfileName: 'host',
    projects: [],
    codeTabs: [],
    chatConversations: [],
    activeCodeTabId: null,
    availableSandboxProfiles: undefined,
    ...patch,
  } as StoreData;
  invoke.mockClear();
  setKey.mockClear();
  getKey.mockClear();
};

describe('code tab sandbox profile resolution', () => {
  beforeEach(() => {
    vi.resetModules();
    resetStore();
  });

  it('uses project sandbox over global default when no one-off override exists', async () => {
    resetStore({
      defaultProfileName: 'host',
      projects: [project('project-1', 'devbox')],
      codeTabs: [tab()],
    });
    const { codeApi } = await import('./state');

    await codeApi.setTabProject('tab-1', 'project-1');

    expect(store.codeTabs[0]).toMatchObject({
      projectId: 'project-1',
      profileName: 'devbox',
      profileNameExplicit: false,
    });
  });

  it('preserves an explicit one-off override when selecting a project', async () => {
    resetStore({
      defaultProfileName: 'host',
      availableSandboxProfiles: ['host', 'devbox', 'platform'],
      projects: [project('project-1', 'devbox')],
      codeTabs: [tab({ profileName: 'platform', profileNameExplicit: true })],
    });
    const { codeApi } = await import('./state');

    await codeApi.setTabProject('tab-1', 'project-1');

    expect(store.codeTabs[0]).toMatchObject({
      projectId: 'project-1',
      profileName: 'platform',
      profileNameExplicit: true,
    });
  });

  it('falls back to a safe available profile when inherited choice is unavailable', async () => {
    resetStore({
      defaultProfileName: 'platform',
      availableSandboxProfiles: ['aci'],
      projects: [project('project-1', 'devbox')],
      codeTabs: [tab()],
    });
    const { codeApi } = await import('./state');

    await codeApi.setTabProject('tab-1', 'project-1');

    expect(store.codeTabs[0]).toMatchObject({ projectId: 'project-1', profileName: 'aci' });
  });

  it('falls back to a safe available profile when one-off choice is unavailable', async () => {
    resetStore({
      defaultProfileName: 'host',
      availableSandboxProfiles: ['aci'],
      projects: [project('project-1', 'devbox')],
      codeTabs: [tab({ profileName: 'platform', profileNameExplicit: true })],
    });
    const { codeApi } = await import('./state');

    await codeApi.setTabProject('tab-1', 'project-1');

    expect(store.codeTabs[0]).toMatchObject({ projectId: 'project-1', profileName: 'aci', profileNameExplicit: true });
  });

  it('sets created projects on the setup tab without replacing a one-off sandbox', async () => {
    resetStore({
      defaultProfileName: 'host',
      availableSandboxProfiles: ['host', 'devbox', 'platform'],
      projects: [project('created-project', 'devbox')],
      codeTabs: [tab({ profileName: 'platform', profileNameExplicit: true })],
    });
    const { codeApi } = await import('./state');

    await codeApi.setTabProject('tab-1', 'created-project');

    expect(store.codeTabs[0]).toMatchObject({
      projectId: 'created-project',
      profileName: 'platform',
      profileNameExplicit: true,
    });
  });
});

describe('chat columns and conversation archival', () => {
  beforeEach(() => {
    vi.resetModules();
    resetStore();
  });

  it('addTab creates a fresh tab instead of reusing an existing blank session', async () => {
    resetStore({ codeTabs: [tab({ id: 'blank-tab', projectId: null, sessionId: 'blank-session' })] });
    const { codeApi } = await import('./state');

    const created = await codeApi.addTab();

    expect(created.id).not.toBe('blank-tab');
    expect(store.codeTabs).toHaveLength(2);
    expect(store.activeCodeTabId).toBe(created.id);
  });

  it('addTab creates a fresh tab instead of reusing a routine session', async () => {
    resetStore({
      codeTabs: [
        tab({
          id: 'routine-tab',
          projectId: null,
          sessionId: 'routine-session',
          routineId: 'routine-1',
          routineName: 'Morning review',
          routineSchedule: 'Manual',
        }),
      ],
    });
    const { codeApi } = await import('./state');

    const created = await codeApi.addTab();

    expect(created.id).not.toBe('routine-tab');
    expect(store.codeTabs).toHaveLength(2);
    expect(store.activeCodeTabId).toBe(created.id);
    expect(store.codeTabs.find((item) => item.id === 'routine-tab')).toMatchObject({ routineId: 'routine-1' });
  });

  it('removeTab archives an activated chat column (transcript only) and deletes its snapshot', async () => {
    resetStore({
      codeTabs: [
        tab({ id: 'chat-tab', projectId: null, sessionId: 'sess-1', snapshotRef: 'snapshot-chat', activatedAt: 5 }),
      ],
      chatConversations: [{ sessionId: 'sess-1', title: 'Plan my week', lastActiveAt: 1 }],
    });
    const { codeApi } = await import('./state');

    await codeApi.removeTab('chat-tab');

    expect(store.codeTabs).toHaveLength(0);
    // Close is terminal for the sandbox — chat and code alike. Only the
    // transcript entry survives in Recent.
    expect(invoke).toHaveBeenCalledWith('snapshot:delete', 'snapshot-chat');
    expect(store.chatConversations[0]).toMatchObject({
      sessionId: 'sess-1',
      title: 'Plan my week',
      profileName: 'host',
    });
  });

  it('removeTab deletes the snapshot of an un-activated chat column and of project tabs', async () => {
    resetStore({
      codeTabs: [
        tab({ id: 'fresh-chat', projectId: null, sessionId: 'sess-fresh', snapshotRef: 'snapshot-fresh' }),
        tab({ id: 'proj-tab', projectId: 'p1', sessionId: 'sess-proj', snapshotRef: 'snapshot-proj' }),
      ],
    });
    const { codeApi } = await import('./state');

    await codeApi.removeTab('fresh-chat');
    await codeApi.removeTab('proj-tab');

    expect(invoke).toHaveBeenCalledWith('snapshot:delete', 'snapshot-fresh');
    expect(invoke).toHaveBeenCalledWith('snapshot:delete', 'snapshot-proj');
    expect(store.chatConversations).toHaveLength(0);
  });

  it('setTabActivated stamps once and never re-stamps', async () => {
    resetStore({ codeTabs: [tab({ id: 'chat-tab', projectId: null, activatedAt: 42 })] });
    const { codeApi } = await import('./state');

    await codeApi.setTabActivated('chat-tab');

    expect(store.codeTabs[0]?.activatedAt).toBe(42);
  });

  it('setTabSessionId resets a chat column to the lazy state on a fresh conversation', async () => {
    resetStore({
      codeTabs: [
        tab({ id: 'chat-tab', projectId: null, sessionId: 'old', snapshotRef: 'old-snapshot', activatedAt: 5 }),
      ],
    });
    const { codeApi } = await import('./state');

    await codeApi.setTabSessionId('chat-tab', 'new');

    expect(store.codeTabs[0]).toMatchObject({ sessionId: 'new' });
    expect(store.codeTabs[0]?.snapshotRef).not.toBe('old-snapshot');
    expect(store.codeTabs[0]?.activatedAt).toBeUndefined();
  });

  it('addTabForConversation activates an existing column showing that session', async () => {
    resetStore({ codeTabs: [tab({ id: 'chat-tab', projectId: null, sessionId: 'sess-1' })] });
    const { codeApi } = await import('./state');

    const opened = await codeApi.addTabForConversation({ sessionId: 'sess-1', title: 'x', lastActiveAt: 1 });

    expect(opened.id).toBe('chat-tab');
    expect(store.codeTabs).toHaveLength(1);
    expect(store.activeCodeTabId).toBe('chat-tab');
  });

  it('addTabForConversation rebuilds a column from an archived entry', async () => {
    resetStore();
    const { codeApi } = await import('./state');

    const opened = await codeApi.addTabForConversation({
      sessionId: 'sess-1',
      title: 'x',
      lastActiveAt: 1,
      profileName: 'devbox',
    });

    expect(opened).toMatchObject({
      projectId: null,
      sessionId: 'sess-1',
      profileName: 'devbox',
    });
    expect(opened.activatedAt).toBeTypeOf('number');
  });

  it('deleteConversation removes only the archived conversation entry', async () => {
    resetStore({ chatConversations: [{ sessionId: 'sess-1', title: 'x', lastActiveAt: 1 }] });
    const { codeApi } = await import('./state');

    await codeApi.deleteConversation('sess-1');

    expect(store.chatConversations).toHaveLength(0);
    expect(invoke).not.toHaveBeenCalledWith('snapshot:delete', 'sess-1');
  });

  it('reorderTabs preserves records missing from a filtered input list', async () => {
    const a = tab({ id: 'tab-a' });
    const b = tab({ id: 'tab-b' });
    const app = tab({ id: 'app-tab', customAppId: 'browser' });
    resetStore({ codeTabs: [app, a, b] });
    const { codeApi } = await import('./state');

    await codeApi.reorderTabs([b, a]);

    expect(store.codeTabs.map((t) => t.id)).toEqual(['app-tab', 'tab-b', 'tab-a']);
  });
});
