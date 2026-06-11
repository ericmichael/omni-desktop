import { nanoid } from 'nanoid';
import { map } from 'nanostores';

import { uuidv4 } from '@/lib/uuid';
import { STATUS_POLL_INTERVAL_MS } from '@/renderer/constants';
import type { AutoLaunchPhase } from '@/renderer/features/Code/use-code-auto-launch';
import { destroyAllTerminalsForTab } from '@/renderer/features/Console/state';
import {
  $agentStatuses,
  $agentXTerms,
  agentProcessApi,
  clearStatus,
  pollProcessStatus,
  teardownTerminal,
} from '@/renderer/services/agent-process';
import { emitter } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type { CodeLayoutMode, CodeTab, CodeTabId, ProjectId, TicketId } from '@/shared/types';
import { CHAT_TAB_ID, isChatTab } from '@/shared/types';

/**
 * Resolve the profile a fresh tab should be bound to. Mirrors the chain in
 * ``ProcessManager.resolveProfileName`` so the value the renderer persists
 * matches what main would have picked at this moment — after that the tab's
 * ``profileName`` is sticky regardless of changes to defaults.
 */
const seedProfileName = (projectId: ProjectId | null | undefined): string => {
  const projects = persistedStoreApi.getKey('projects') ?? [];
  const project = projectId ? projects.find((p) => p.id === projectId) : undefined;
  const inherited = project?.sandboxProfile;
  if (typeof inherited === 'string' && inherited.length > 0) {
    return inherited;
  }
  return persistedStoreApi.getKey('defaultProfileName') ?? 'host';
};

const resolveAvailableProfileName = (name: string): string => {
  const available = persistedStoreApi.getKey('availableSandboxProfiles');
  if (!available || available.length === 0 || available.includes(name)) {
    return name;
  }
  return available[0] ?? 'host';
};

export const resolveCodeTabProfileName = (projectId: ProjectId | null | undefined): string =>
  resolveAvailableProfileName(seedProfileName(projectId));

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
    // Reuse an existing unconfigured tab instead of stacking up orphan
    // "New Session" columns: a tab created here but abandoned before a
    // project was picked is indistinguishable from a fresh one.
    const existingTabs = persistedStoreApi.getKey('codeTabs') ?? [];
    // The reserved chat record is also projectless — never hand it out as a
    // blank "New Session" tab.
    const blank = existingTabs.find((t) => !isChatTab(t) && !t.projectId && !t.customAppId && !t.ticketId);
    if (blank) {
      await persistedStoreApi.setKey('activeCodeTabId', blank.id);
      return blank;
    }
    const tab: CodeTab = {
      id: nanoid(),
      projectId: null,
      sessionId: uuidv4(),
      profileName: resolveCodeTabProfileName(null),
      profileNameExplicit: false,
      createdAt: Date.now(),
    };
    const tabs = [...existingTabs, tab];
    await persistedStoreApi.setKey('codeTabs', tabs);
    await persistedStoreApi.setKey('activeCodeTabId', tab.id);
    return tab;
  },

  removeTab: async (tabId: CodeTabId) => {
    // The reserved chat record is permanent — no UI offers closing it; guard
    // against programmatic removal too.
    if (tabId === CHAT_TAB_ID) {
      return;
    }
    const tab = (persistedStoreApi.getKey('codeTabs') ?? []).find((t) => t.id === tabId);
    await codeApi.stopSandbox(tabId);
    await destroyAllTerminalsForTab(tabId);

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

    // Cascade: delete the tab's workspace snapshot. Tab is gone for
    // good (no resume UI for deleted tabs), so the tar is dead weight.
    if (tab?.sessionId) {
      void emitter.invoke('snapshot:delete', tab.sessionId);
    }
  },

  setActiveTab: (tabId: CodeTabId) => {
    persistedStoreApi.setKey('activeCodeTabId', tabId);
  },

  setLayoutMode: (mode: CodeLayoutMode) => {
    persistedStoreApi.setKey('codeLayoutMode', mode);
  },

  reorderTabs: async (nextTabs: CodeTab[]) => {
    // Callers (the deck) pass their FILTERED tab list — the reserved chat
    // record is not rendered there and must not be dropped by a wholesale
    // overwrite. Preserve any stored tab missing from the input, at the front.
    const stored = persistedStoreApi.getKey('codeTabs') ?? [];
    const incoming = new Set(nextTabs.map((t) => t.id));
    const preserved = stored.filter((t) => !incoming.has(t.id));
    await persistedStoreApi.setKey('codeTabs', [...preserved, ...nextTabs]);
  },

  setTabProject: async (tabId: CodeTabId, projectId: ProjectId) => {
    const tabs = (persistedStoreApi.getKey('codeTabs') ?? []).map((t) => {
      if (t.id !== tabId) {
        return t;
      }
      const profileName = t.profileNameExplicit
        ? resolveAvailableProfileName(t.profileName ?? seedProfileName(projectId))
        : resolveCodeTabProfileName(projectId);
      if (profileName === t.profileName) {
        return { ...t, projectId, profileName };
      }
      const { containerId: _drop, ...rest } = t;
      void _drop;
      return { ...rest, projectId, profileName };
    });
    await persistedStoreApi.setKey('codeTabs', tabs);
  },

  addTabForTicket: async (
    ticketId: TicketId,
    projectId: ProjectId,
    opts?: { ticketTitle?: string; workspaceDir?: string; profileName?: string }
  ): Promise<CodeTab> => {
    const existingTabs = persistedStoreApi.getKey('codeTabs') ?? [];
    const existing = existingTabs.find((t) => t.ticketId === ticketId);
    if (existing) {
      const { containerId: _drop, ...existingWithoutContainer } = existing;
      void _drop;
      const baseExisting = opts?.profileName ? existingWithoutContainer : existing;
      const nextExisting = {
        ...baseExisting,
        ...(opts?.workspaceDir ? { workspaceDir: opts.workspaceDir } : {}),
        ...(opts?.profileName ? { profileName: opts.profileName } : {}),
      };
      if (nextExisting.workspaceDir !== existing.workspaceDir || nextExisting.profileName !== existing.profileName) {
        const updated = existingTabs.map((t) => (t.id === existing.id ? nextExisting : t));
        await persistedStoreApi.setKey('codeTabs', updated);
      }
      await persistedStoreApi.setKey('activeCodeTabId', existing.id);
      return nextExisting;
    }
    const tab: CodeTab = {
      id: nanoid(),
      projectId,
      ticketId,
      sessionId: uuidv4(),
      ticketTitle: opts?.ticketTitle,
      workspaceDir: opts?.workspaceDir,
      profileName: opts?.profileName ?? resolveCodeTabProfileName(projectId),
      profileNameExplicit: Boolean(opts?.profileName),
      createdAt: Date.now(),
    };
    const tabs = [...existingTabs, tab];
    await persistedStoreApi.setKey('codeTabs', tabs);
    await persistedStoreApi.setKey('activeCodeTabId', tab.id);
    return tab;
  },

  addAppTab: async (customAppId: string): Promise<CodeTab> => {
    const tab: CodeTab = {
      id: nanoid(),
      projectId: null,
      sessionId: uuidv4(),
      customAppId,
      profileName: resolveCodeTabProfileName(null),
      profileNameExplicit: false,
      createdAt: Date.now(),
    };
    const tabs = [...(persistedStoreApi.getKey('codeTabs') ?? []), tab];
    await persistedStoreApi.setKey('codeTabs', tabs);
    return tab;
  },

  setTabAppId: async (tabId: CodeTabId, customAppId: string) => {
    const tabs = (persistedStoreApi.getKey('codeTabs') ?? []).map((t) => (t.id === tabId ? { ...t, customAppId } : t));
    await persistedStoreApi.setKey('codeTabs', tabs);
  },

  setTabSessionId: async (tabId: CodeTabId, sessionId: string | undefined) => {
    const tabs = (persistedStoreApi.getKey('codeTabs') ?? []).map((t) => {
      if (t.id !== tabId) {
        return t;
      }
      if ((t.sessionId ?? undefined) === sessionId) {
        return { ...t, sessionId };
      }
      const { containerId: _drop, ...rest } = t;
      void _drop;
      return { ...rest, sessionId };
    });
    await persistedStoreApi.setKey('codeTabs', tabs);
  },

  setTabProfile: async (tabId: CodeTabId, profileName: string) => {
    // Profile change = different image. The persisted containerId is
    // profile-specific so we drop it here — the SDK would silently fall back
    // anyway, but not sending a definitely-stale id is cleaner.
    const tabs = (persistedStoreApi.getKey('codeTabs') ?? []).map((t) => {
      if (t.id !== tabId) {
        return t;
      }
      const { containerId: _drop, ...rest } = t;
      void _drop;
      return { ...rest, profileName, profileNameExplicit: true };
    });
    await persistedStoreApi.setKey('codeTabs', tabs);
  },

  setTabContainerId: async (tabId: CodeTabId, containerId: string | undefined) => {
    const tabs = (persistedStoreApi.getKey('codeTabs') ?? []).map((t) => {
      if (t.id !== tabId) {
        return t;
      }
      if (containerId === undefined) {
        const { containerId: _drop, ...rest } = t;
        void _drop;
        return rest;
      }
      return { ...t, containerId };
    });
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
