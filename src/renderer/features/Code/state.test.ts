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

  it('clears stale container id when selecting a project changes the profile', async () => {
    resetStore({
      defaultProfileName: 'host',
      projects: [project('project-1', 'devbox')],
      codeTabs: [tab({ containerId: 'old-container' })],
    });
    const { codeApi } = await import('./state');

    await codeApi.setTabProject('tab-1', 'project-1');

    expect(store.codeTabs[0]?.containerId).toBeUndefined();
  });

  it('clears stale container id when session id changes', async () => {
    resetStore({ codeTabs: [tab({ sessionId: 'session-1', containerId: 'old-container' })] });
    const { codeApi } = await import('./state');

    await codeApi.setTabSessionId('tab-1', 'session-2');

    expect(store.codeTabs[0]).toMatchObject({ sessionId: 'session-2' });
    expect(store.codeTabs[0]?.containerId).toBeUndefined();
  });

  it('preserves container id when session id is unchanged', async () => {
    resetStore({ codeTabs: [tab({ sessionId: 'session-1', containerId: 'container-1' })] });
    const { codeApi } = await import('./state');

    await codeApi.setTabSessionId('tab-1', 'session-1');

    expect(store.codeTabs[0]).toMatchObject({ sessionId: 'session-1', containerId: 'container-1' });
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

describe('reserved chat record guards', () => {
  beforeEach(() => {
    vi.resetModules();
    resetStore();
  });

  const chatTab = (): CodeTab => tab({ id: 'chat', projectId: null, sessionId: 'chat-sess' });

  it('addTab does not reuse the chat record as a blank tab', async () => {
    resetStore({ codeTabs: [chatTab()] });
    const { codeApi } = await import('./state');

    const created = await codeApi.addTab();

    expect(created.id).not.toBe('chat');
    expect(store.codeTabs).toHaveLength(2);
    expect(store.codeTabs.some((t) => t.id === 'chat')).toBe(true);
  });

  it('removeTab is a no-op for the chat record', async () => {
    resetStore({ codeTabs: [chatTab(), tab({ id: 'tab-1' })] });
    const { codeApi } = await import('./state');

    await codeApi.removeTab('chat');

    expect(store.codeTabs.map((t) => t.id)).toEqual(['chat', 'tab-1']);
  });

  it('reorderTabs preserves the chat record when given the deck-filtered list', async () => {
    const a = tab({ id: 'tab-a' });
    const b = tab({ id: 'tab-b' });
    resetStore({ codeTabs: [chatTab(), a, b] });
    const { codeApi } = await import('./state');

    // The deck reorders its filtered view (no chat record).
    await codeApi.reorderTabs([b, a]);

    expect(store.codeTabs.map((t) => t.id)).toEqual(['chat', 'tab-b', 'tab-a']);
  });
});
