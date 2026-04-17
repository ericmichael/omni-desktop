import { nanoid } from 'nanoid';
import { map } from 'nanostores';

import { STATUS_POLL_INTERVAL_MS } from '@/renderer/constants';
import type { AutoLaunchPhase } from '@/renderer/features/Code/use-code-auto-launch';
import {
  $agentStatuses,
  $agentXTerms,
  agentProcessApi,
  clearStatus,
  pollProcessStatus,
  teardownTerminal,
} from '@/renderer/services/agent-process';
import { persistedStoreApi } from '@/renderer/services/store';
import type {
  CodeLayoutMode,
  CodeTab,
  CodeTabId,
  ProjectId,
  TicketId,
} from '@/shared/types';

// Re-export agent status/xterm maps so existing imports from Code/state still work.
// Components can read per-tab status via $agentStatuses.get()[tabId].
export { $agentStatuses as $codeTabStatuses, $agentXTerms as $codeTabXTerms };

export const $codeTabPhases = map<Record<CodeTabId, AutoLaunchPhase>>({});
export const $codeTabErrors = map<Record<CodeTabId, string | null>>({});

export const codeApi = {
  startSandbox: (tabId: CodeTabId, arg: { workspaceDir: string }) => {
    clearStatus(tabId);
    agentProcessApi.start(tabId, arg);
  },

  stopSandbox: async (tabId: CodeTabId) => {
    teardownTerminal(tabId);
    await agentProcessApi.stop(tabId);
  },

  rebuildSandbox: (tabId: CodeTabId, fallbackArg: { workspaceDir: string }) => {
    clearStatus(tabId);
    agentProcessApi.rebuild(tabId, fallbackArg);
  },

  addTab: async (): Promise<CodeTab> => {
    const tab: CodeTab = { id: nanoid(), projectId: null, createdAt: Date.now() };
    const tabs = [...(persistedStoreApi.getKey('codeTabs') ?? []), tab];
    await persistedStoreApi.setKey('codeTabs', tabs);
    await persistedStoreApi.setKey('activeCodeTabId', tab.id);
    return tab;
  },

  removeTab: async (tabId: CodeTabId) => {
    await codeApi.stopSandbox(tabId);

    // Clean up per-tab state
    clearStatus(tabId);

    const phases = { ...$codeTabPhases.get() };
    delete phases[tabId];
    $codeTabPhases.set(phases);

    const errors = { ...$codeTabErrors.get() };
    delete errors[tabId];
    $codeTabErrors.set(errors);

    const tabs = (persistedStoreApi.getKey('codeTabs') ?? []).filter((t) => t.id !== tabId);
    const activeId = persistedStoreApi.getKey('activeCodeTabId');

    await persistedStoreApi.setKey('codeTabs', tabs);
    if (activeId === tabId) {
      await persistedStoreApi.setKey('activeCodeTabId', tabs[tabs.length - 1]?.id ?? null);
    }
  },

  setActiveTab: (tabId: CodeTabId) => {
    persistedStoreApi.setKey('activeCodeTabId', tabId);
  },

  setLayoutMode: (mode: CodeLayoutMode) => {
    persistedStoreApi.setKey('codeLayoutMode', mode);
  },

  reorderTabs: async (nextTabs: CodeTab[]) => {
    await persistedStoreApi.setKey('codeTabs', nextTabs);
  },

  setTabProject: async (tabId: CodeTabId, projectId: ProjectId) => {
    const tabs = (persistedStoreApi.getKey('codeTabs') ?? []).map((t) => (t.id === tabId ? { ...t, projectId } : t));
    await persistedStoreApi.setKey('codeTabs', tabs);
  },

  addTabForTicket: async (
    ticketId: TicketId,
    projectId: ProjectId,
    opts?: { sessionId?: string; ticketTitle?: string; workspaceDir?: string }
  ): Promise<CodeTab> => {
    const existingTabs = persistedStoreApi.getKey('codeTabs') ?? [];
    const existing = existingTabs.find((t) => t.ticketId === ticketId);
    if (existing) {
      if (opts?.workspaceDir && existing.workspaceDir !== opts.workspaceDir) {
        const updated = existingTabs.map((t) => (t.id === existing.id ? { ...t, workspaceDir: opts.workspaceDir } : t));
        await persistedStoreApi.setKey('codeTabs', updated);
      }
      await persistedStoreApi.setKey('activeCodeTabId', existing.id);
      return { ...existing, ...(opts?.workspaceDir ? { workspaceDir: opts.workspaceDir } : {}) };
    }
    const tab: CodeTab = {
      id: nanoid(),
      projectId,
      ticketId,
      sessionId: opts?.sessionId,
      ticketTitle: opts?.ticketTitle,
      workspaceDir: opts?.workspaceDir,
      createdAt: Date.now(),
    };
    const tabs = [...existingTabs, tab];
    await persistedStoreApi.setKey('codeTabs', tabs);
    await persistedStoreApi.setKey('activeCodeTabId', tab.id);
    return tab;
  },

  addAppTab: async (customAppId: string): Promise<CodeTab> => {
    const tab: CodeTab = { id: nanoid(), projectId: null, customAppId, createdAt: Date.now() };
    const tabs = [...(persistedStoreApi.getKey('codeTabs') ?? []), tab];
    await persistedStoreApi.setKey('codeTabs', tabs);
    return tab;
  },

  setTabAppId: async (tabId: CodeTabId, customAppId: string) => {
    const tabs = (persistedStoreApi.getKey('codeTabs') ?? []).map((t) =>
      t.id === tabId ? { ...t, customAppId } : t
    );
    await persistedStoreApi.setKey('codeTabs', tabs);
  },

  setTabSessionId: async (tabId: CodeTabId, sessionId: string | undefined) => {
    const tabs = (persistedStoreApi.getKey('codeTabs') ?? []).map((t) =>
      t.id === tabId ? { ...t, sessionId } : t
    );
    await persistedStoreApi.setKey('codeTabs', tabs);
  },
};

const listen = () => {
  // Poll code tab statuses (chat polling is handled by agent-process service)
  const pollStatuses = async () => {
    const tabs = persistedStoreApi.getKey('codeTabs') ?? [];
    for (const tab of tabs) {
      // Skip polling for custom app tabs — they have no sandbox
      if (tab.customAppId) {
        continue;
      }
      await pollProcessStatus(tab.id);
    }
  };

  setInterval(pollStatuses, STATUS_POLL_INTERVAL_MS);
};

listen();
