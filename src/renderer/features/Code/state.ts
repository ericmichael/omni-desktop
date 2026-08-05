import { nanoid } from 'nanoid';
import { map } from 'nanostores';

import { pruneConversations, upsertConversation } from '@/lib/chat-conversations';
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
import type {
  AgentProcessStopOptions,
  ChatConversation,
  CodeLayoutMode,
  CodeTab,
  CodeTabId,
  ProjectId,
  TicketId,
} from '@/shared/types';
import { isChatColumn } from '@/shared/types';

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

/** The synthetic app-launcher column id ("Apps" grid). */
export const APP_LAUNCHER_ID = '__launcher__';

export const codeApi = {
  startSandbox: (tabId: CodeTabId, arg: { workspaceDir: string }) => {
    clearStatus(tabId);
    agentProcessApi.start(tabId, arg);
  },

  stopSandbox: async (tabId: CodeTabId, opts?: AgentProcessStopOptions) => {
    teardownTerminal(tabId);
    await agentProcessApi.stop(tabId, opts);
  },

  rebuildSandbox: (tabId: CodeTabId, fallbackArg: { workspaceDir: string }) => {
    clearStatus(tabId);
    agentProcessApi.rebuild(tabId, fallbackArg);
  },

  /**
   * Land in a fresh chat: reuse a pristine chat column (one whose session
   * never produced a conversation) or create one — idempotent, so boot
   * landings and repeated "New chat" clicks never stack empty columns.
   */
  openFreshChat: async (): Promise<void> => {
    const tabs = persistedStoreApi.getKey('codeTabs') ?? [];
    const known = new Set((persistedStoreApi.getKey('chatConversations') ?? []).map((c) => c.sessionId));
    const pristine = tabs.find(
      (t) => !t.projectId && !t.customAppId && !t.ticketId && !t.routineId && (!t.sessionId || !known.has(t.sessionId))
    );
    if (pristine) {
      await persistedStoreApi.setKey('activeCodeTabId', pristine.id);
      return;
    }
    await codeApi.addTab();
  },

  addTab: async (): Promise<CodeTab> => {
    const existingTabs = persistedStoreApi.getKey('codeTabs') ?? [];
    const tab: CodeTab = {
      id: nanoid(),
      projectId: null,
      sessionId: uuidv4(),
      snapshotRef: uuidv4(),
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
    const all = persistedStoreApi.getKey('codeTabs') ?? [];
    const tab = all.find((t) => t.id === tabId);

    // Remove the tab from the store FIRST so the column unmounts immediately
    // and its chat WebSocket drops — omni serve's graceful SIGTERM drain
    // waits on open connections, so keeping the column mounted through the
    // stop would block serve's exit on our own socket.
    const tabs = all.filter((t) => t.id !== tabId);
    const activeId = persistedStoreApi.getKey('activeCodeTabId');
    await persistedStoreApi.setKey('codeTabs', tabs);
    if (activeId === tabId) {
      await persistedStoreApi.setKey('activeCodeTabId', tabs[tabs.length - 1]?.id ?? null);
    }

    try {
      // Terminal sockets are also connections into omni serve — close them
      // BEFORE the stop so the drain doesn't wait on them either.
      await destroyAllTerminalsForTab(tabId);
      // Removing the column is terminal for its sandbox — the
      // snapshot is deleted below, so tell serve to skip persisting one.
      await codeApi.stopSandbox(tabId, { discardSnapshot: true });
    } finally {
      // Clean up per-tab state
      clearStatus(tabId);

      const phases = { ...$codeTabPhases.get() };
      delete phases[tabId];
      $codeTabPhases.set(phases);

      const errors = { ...$codeTabErrors.get() };
      delete errors[tabId];
      $codeTabErrors.set(errors);

      // Cascade: delete the tab's Workspace snapshot. Archived sessions
      // resume into fresh columns instead of rehydrating the old tab, so the
      // tar is dead weight.
      if (tab?.snapshotRef) {
        void emitter.invoke('snapshot:delete', tab.snapshotRef);
      }
    }
  },

  setActiveTab: (tabId: CodeTabId) => {
    persistedStoreApi.setKey('activeCodeTabId', tabId);
  },

  setLayoutMode: (mode: CodeLayoutMode) => {
    persistedStoreApi.setKey('codeLayoutMode', mode);
  },

  setSpacesColumnLayouts: async (
    layouts: Record<string, { width?: number | null; expanded?: boolean }>
  ): Promise<void> => {
    const tabs = (persistedStoreApi.getKey('codeTabs') ?? []).map((tab) => {
      const column = layouts[tab.id];
      const sidecar = layouts[`sidecar:${tab.id}`];
      if (!column && !sidecar) {
        return tab;
      }

      const next = { ...tab };
      if (column) {
        if (column.width === null) {
          delete next.spacesWidth;
        } else if (column.width !== undefined) {
          next.spacesWidth = column.width;
        }
        if (column.expanded !== undefined) {
          next.spacesExpanded = column.expanded;
        }
      }
      if (sidecar) {
        if (sidecar.width === null) {
          delete next.spacesSidecarWidth;
        } else if (sidecar.width !== undefined) {
          next.spacesSidecarWidth = sidecar.width;
        }
        if (sidecar.expanded !== undefined) {
          next.spacesSidecarExpanded = sidecar.expanded;
        }
      }
      return next;
    });
    await persistedStoreApi.setKey('codeTabs', tabs);
  },

  reorderTabs: async (nextTabs: CodeTab[]) => {
    // Defensive: preserve any stored tab missing from the input (at the
    // front) so a caller rendering a filtered view can't drop records with a
    // wholesale overwrite.
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
      // Attaching a project is intent — it activates a lazy chat column.
      const activated = { activatedAt: t.activatedAt ?? Date.now() };
      const workspaceIdentity = { snapshotRef: uuidv4() };
      if (profileName === t.profileName) {
        return { ...t, projectId, profileName, ...activated, ...workspaceIdentity };
      }
      return { ...t, projectId, profileName, ...activated, ...workspaceIdentity };
    });
    await persistedStoreApi.setKey('codeTabs', tabs);
    const attached = tabs.find((tab) => tab.id === tabId);
    if (
      attached?.sessionId &&
      (persistedStoreApi.getKey('chatConversations') ?? []).some(
        (conversation) => conversation.sessionId === attached.sessionId
      )
    ) {
      await codeApi.recordConversation(attached.sessionId, { projectId });
    }
  },

  /**
   * Stamp first-intent on a chat column (first message sent). Chat columns
   * don't boot their sandbox until this is set.
   */
  setTabActivated: async (tabId: CodeTabId) => {
    const tabs = (persistedStoreApi.getKey('codeTabs') ?? []).map((t) =>
      t.id === tabId && !t.activatedAt ? { ...t, activatedAt: Date.now() } : t
    );
    await persistedStoreApi.setKey('codeTabs', tabs);
  },

  /**
   * Reopen a retained conversation as a column. If a column already shows
   * this sessionId, it is activated instead of duplicated. The sessionId
   * deterministically keys the scratch dir and agent session, so the
   * transcript and scratch-dir files resume; the sandbox itself launches
   * fresh (closing the column was terminal for it).
   */
  addTabForConversation: async (conversation: ChatConversation): Promise<CodeTab> => {
    const existingTabs = persistedStoreApi.getKey('codeTabs') ?? [];
    const existing = existingTabs.find((t) => t.sessionId === conversation.sessionId);
    if (existing) {
      await persistedStoreApi.setKey('activeCodeTabId', existing.id);
      return existing;
    }
    const tab: CodeTab = {
      id: nanoid(),
      projectId: conversation.projectId ?? null,
      ...(conversation.ticketId ? { ticketId: conversation.ticketId } : {}),
      ...(conversation.ticketTitle ? { ticketTitle: conversation.ticketTitle } : {}),
      sessionId: conversation.sessionId,
      snapshotRef: uuidv4(),
      profileName: conversation.profileName ?? resolveCodeTabProfileName(conversation.projectId),
      profileNameExplicit: Boolean(conversation.profileName),
      createdAt: Date.now(),
      activatedAt: Date.now(),
    };
    await persistedStoreApi.setKey('codeTabs', [...existingTabs, tab]);
    await persistedStoreApi.setKey('activeCodeTabId', tab.id);
    // Persist the entry (notably the title) in the launcher index: a
    // conversation surfaced only by the live session listing would otherwise
    // lose its title whenever no chat column is running to list it.
    await codeApi.recordConversation(conversation.sessionId, { title: conversation.title });
    return tab;
  },

  /** Upsert a conversation-history entry (newest-first, capped). */
  recordConversation: async (sessionId: string, patch?: Partial<ChatConversation>) => {
    const list = persistedStoreApi.getKey('chatConversations') ?? [];
    const tab = (persistedStoreApi.getKey('codeTabs') ?? []).find((candidate) => candidate.sessionId === sessionId);
    const inferredContext: Partial<ChatConversation> = tab
      ? {
          ...(tab.profileName ? { profileName: tab.profileName } : {}),
          ...(tab.projectId ? { projectId: tab.projectId } : {}),
          ...(tab.ticketId ? { ticketId: tab.ticketId } : {}),
          ...(tab.ticketTitle ? { ticketTitle: tab.ticketTitle } : {}),
        }
      : {};
    const { kept } = pruneConversations(
      upsertConversation(list, { sessionId, lastActiveAt: Date.now(), ...inferredContext, ...patch })
    );
    await persistedStoreApi.setKey('chatConversations', kept);
  },

  /** Hide a retained conversation from Projects/Recents until restored. */
  archiveConversation: async (conversation: ChatConversation) => {
    const list = persistedStoreApi.getKey('chatConversations') ?? [];
    const { kept } = pruneConversations(
      upsertConversation(list, {
        ...conversation,
        archivedAt: Date.now(),
      })
    );
    await persistedStoreApi.setKey('chatConversations', kept);
  },

  /** Archive an active session, then remove its column from the deck. */
  archiveTab: async (tabId: CodeTabId, title?: string) => {
    const tab = (persistedStoreApi.getKey('codeTabs') ?? []).find((candidate) => candidate.id === tabId);
    if (tab?.sessionId && !tab.customAppId) {
      const indexed = (persistedStoreApi.getKey('chatConversations') ?? []).find(
        (candidate) => candidate.sessionId === tab.sessionId
      );
      await codeApi.recordConversation(tab.sessionId, {
        title: title ?? indexed?.title ?? tab.ticketTitle ?? tab.routineName ?? 'New chat',
        ...(tab.profileName ? { profileName: tab.profileName } : {}),
        ...(tab.projectId ? { projectId: tab.projectId } : {}),
        ...(tab.ticketId ? { ticketId: tab.ticketId } : {}),
        ...(tab.ticketTitle ? { ticketTitle: tab.ticketTitle } : {}),
      });
      const conversation = (persistedStoreApi.getKey('chatConversations') ?? []).find(
        (candidate) => candidate.sessionId === tab.sessionId
      );
      if (conversation) {
        await codeApi.archiveConversation(conversation);
      }
    }
    await codeApi.removeTab(tabId);
  },

  /** Return an archived conversation to its project or Recents. */
  restoreConversation: async (sessionId: string) => {
    const list = persistedStoreApi.getKey('chatConversations') ?? [];
    await persistedStoreApi.setKey(
      'chatConversations',
      list.map((conversation) =>
        conversation.sessionId === sessionId ? { ...conversation, archivedAt: undefined } : conversation
      )
    );
  },

  addTabForTicket: async (
    ticketId: TicketId,
    projectId: ProjectId,
    opts?: { ticketTitle?: string; workspaceDir?: string; profileName?: string }
  ): Promise<CodeTab> => {
    const existingTabs = persistedStoreApi.getKey('codeTabs') ?? [];
    const existing = existingTabs.find((t) => t.ticketId === ticketId);
    if (existing) {
      const nextExisting = {
        ...existing,
        ...(opts?.workspaceDir ? { workspaceDir: opts.workspaceDir } : {}),
        ...(opts?.profileName ? { profileName: opts.profileName } : {}),
        ...(opts?.workspaceDir && opts.workspaceDir !== existing.workspaceDir ? { snapshotRef: uuidv4() } : {}),
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
      snapshotRef: uuidv4(),
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
      snapshotRef: uuidv4(),
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

  openSidecarApp: async (tabId: CodeTabId, appId: string) => {
    if (appId === 'chat') {
      return;
    }
    const tabs = (persistedStoreApi.getKey('codeTabs') ?? []).map((tab) => {
      if (tab.id !== tabId) {
        return tab;
      }
      const sidecarAppIds = tab.sidecarAppIds?.includes(appId)
        ? tab.sidecarAppIds
        : [...(tab.sidecarAppIds ?? []), appId];
      return { ...tab, sidecarOpen: true, sidecarAppIds, activeSidecarAppId: appId };
    });
    await persistedStoreApi.setKey('codeTabs', tabs);
  },

  setSidecarOpen: async (tabId: CodeTabId, sidecarOpen: boolean) => {
    const tabs = (persistedStoreApi.getKey('codeTabs') ?? []).map((tab) =>
      tab.id === tabId ? { ...tab, sidecarOpen } : tab
    );
    await persistedStoreApi.setKey('codeTabs', tabs);
  },

  setActiveSidecarApp: async (tabId: CodeTabId, appId: string) => {
    const tabs = (persistedStoreApi.getKey('codeTabs') ?? []).map((tab) =>
      tab.id === tabId && tab.sidecarAppIds?.includes(appId) ? { ...tab, activeSidecarAppId: appId } : tab
    );
    await persistedStoreApi.setKey('codeTabs', tabs);
  },

  closeSidecarApp: async (tabId: CodeTabId, appId: string) => {
    const tabs = (persistedStoreApi.getKey('codeTabs') ?? []).map((tab) => {
      if (tab.id !== tabId || !tab.sidecarAppIds?.includes(appId)) {
        return tab;
      }
      const closedIndex = tab.sidecarAppIds.indexOf(appId);
      const sidecarAppIds = tab.sidecarAppIds.filter((id) => id !== appId);
      if (sidecarAppIds.length === 0) {
        const { sidecarAppIds: _open, activeSidecarAppId: _active, ...withoutSidecar } = tab;
        void _open;
        void _active;
        return { ...withoutSidecar, sidecarOpen: tab.sidecarOpen ?? true };
      }
      const activeSidecarAppId =
        tab.activeSidecarAppId !== appId && sidecarAppIds.includes(tab.activeSidecarAppId ?? '')
          ? tab.activeSidecarAppId
          : sidecarAppIds[Math.min(closedIndex, sidecarAppIds.length - 1)];
      return { ...tab, sidecarAppIds, activeSidecarAppId };
    });
    await persistedStoreApi.setKey('codeTabs', tabs);
  },

  setTabSessionId: async (tabId: CodeTabId, sessionId: string | undefined) => {
    const current = (persistedStoreApi.getKey('codeTabs') ?? []).find((tab) => tab.id === tabId);
    if (
      current?.projectId &&
      current.sessionId &&
      current.sessionId !== sessionId &&
      !current.customAppId &&
      !current.routineId
    ) {
      await codeApi.recordConversation(current.sessionId);
    }
    const tabs = (persistedStoreApi.getKey('codeTabs') ?? []).map((t) => {
      if (t.id !== tabId) {
        return t;
      }
      if ((t.sessionId ?? undefined) === sessionId) {
        return { ...t, sessionId };
      }
      if (isChatColumn(t)) {
        // A fresh conversation returns the chat column to the lazy state —
        // greeting up, no sandbox until the first message.
        const { activatedAt: _reset, ...lazy } = t;
        void _reset;
        return { ...lazy, sessionId, snapshotRef: uuidv4() };
      }
      return { ...t, sessionId };
    });
    await persistedStoreApi.setKey('codeTabs', tabs);
  },

  setTabSnapshotRef: async (tabId: CodeTabId, snapshotRef: string) => {
    const tabs = (persistedStoreApi.getKey('codeTabs') ?? []).map((t) => (t.id === tabId ? { ...t, snapshotRef } : t));
    await persistedStoreApi.setKey('codeTabs', tabs);
  },

  setTabProfile: async (tabId: CodeTabId, profileName: string) => {
    const tabs = (persistedStoreApi.getKey('codeTabs') ?? []).map((t) => {
      if (t.id !== tabId) {
        return t;
      }
      return { ...t, profileName, profileNameExplicit: true };
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
