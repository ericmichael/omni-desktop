import { objectEquals } from '@observ33r/object-equals';
import { Terminal } from '@xterm/xterm';
import { nanoid } from 'nanoid';
import { map } from 'nanostores';

import { DEFAULT_XTERM_OPTIONS, STATUS_POLL_INTERVAL_MS } from '@/renderer/constants';
import type { AutoLaunchPhase } from '@/renderer/features/Code/use-code-auto-launch';
import { emitter, ipc } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type {
  CodeLayoutMode,
  CodeTab,
  CodeTabId,
  ProjectId,
  TicketId,
  SandboxProcessStatus,
  SandboxVariant,
  WithTimestamp,
} from '@/shared/types';

export const $codeTabStatuses = map<Record<CodeTabId, WithTimestamp<SandboxProcessStatus>>>({});
export const $codeTabXTerms = map<Record<CodeTabId, Terminal>>({});
export const $codeTabPhases = map<Record<CodeTabId, AutoLaunchPhase>>({});
export const $codeTabErrors = map<Record<CodeTabId, string | null>>({});

const xtermSubscriptions = new Map<CodeTabId, Set<() => void>>();

const initializeTabTerminal = (tabId: CodeTabId): Terminal => {
  const existing = $codeTabXTerms.get()[tabId];
  if (existing) {
    return existing;
  }

  const xterm = new Terminal({ ...DEFAULT_XTERM_OPTIONS, disableStdin: true });
  const subs = new Set<() => void>();

  subs.add(
    ipc.on('code:sandbox-raw-output', (id, data) => {
      if (id === tabId) {
        xterm.write(data);
      }
    })
  );

  subs.add(
    xterm.onResize(({ cols, rows }) => {
      emitter.invoke('code:resize-sandbox', tabId, cols, rows);
    }).dispose
  );

  xtermSubscriptions.set(tabId, subs);
  $codeTabXTerms.setKey(tabId, xterm);
  return xterm;
};

const teardownTabTerminal = (tabId: CodeTabId) => {
  const subs = xtermSubscriptions.get(tabId);
  if (subs) {
    for (const unsub of subs) {
      unsub();
    }
    subs.clear();
    xtermSubscriptions.delete(tabId);
  }

  const xterm = $codeTabXTerms.get()[tabId];
  if (xterm) {
    xterm.dispose();
    const next = { ...$codeTabXTerms.get() };
    delete next[tabId];
    $codeTabXTerms.set(next);
  }
};

export const codeApi = {
  startSandbox: (tabId: CodeTabId, arg: { workspaceDir: string; sandboxVariant: SandboxVariant; local?: boolean }) => {
    // Clear stale status so watchProcessStatus doesn't see old data from a previous run
    // and immediately send a spurious SANDBOX_EXITED/SANDBOX_ERROR event.
    const statuses = { ...$codeTabStatuses.get() };
    delete statuses[tabId];
    $codeTabStatuses.set(statuses);

    initializeTabTerminal(tabId);
    emitter.invoke('code:start-sandbox', tabId, arg);
  },

  stopSandbox: async (tabId: CodeTabId) => {
    // Teardown terminal first so the push listener's `exited` event
    // doesn't race with us and double-teardown.
    teardownTabTerminal(tabId);
    await emitter.invoke('code:stop-sandbox', tabId);
  },

  rebuildSandbox: (tabId: CodeTabId, fallbackArg: { workspaceDir: string; sandboxVariant: SandboxVariant; local?: boolean }) => {
    // Clear stale status (same rationale as startSandbox).
    const statuses = { ...$codeTabStatuses.get() };
    delete statuses[tabId];
    $codeTabStatuses.set(statuses);

    initializeTabTerminal(tabId);
    emitter.invoke('code:rebuild-sandbox', tabId, fallbackArg);
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
    const statuses = { ...$codeTabStatuses.get() };
    delete statuses[tabId];
    $codeTabStatuses.set(statuses);

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
    // Auto-launch is triggered by the useCodeAutoLaunch effect reacting to workspaceDir becoming non-null.
    // Do NOT write to $codeTabPhases here — it would desync the atom from the XState machine.
  },

  addTabForTicket: async (
    ticketId: TicketId,
    projectId: ProjectId,
    opts?: { sessionId?: string; ticketTitle?: string }
  ): Promise<CodeTab> => {
    // Check if a tab for this ticket already exists
    const existingTabs = persistedStoreApi.getKey('codeTabs') ?? [];
    const existing = existingTabs.find((t) => t.ticketId === ticketId);
    if (existing) {
      await persistedStoreApi.setKey('activeCodeTabId', existing.id);
      return existing;
    }
    const tab: CodeTab = {
      id: nanoid(),
      projectId,
      ticketId,
      sessionId: opts?.sessionId,
      ticketTitle: opts?.ticketTitle,
      createdAt: Date.now(),
    };
    const tabs = [...existingTabs, tab];
    await persistedStoreApi.setKey('codeTabs', tabs);
    await persistedStoreApi.setKey('activeCodeTabId', tab.id);
    return tab;
  },

  setTabSessionId: async (tabId: CodeTabId, sessionId: string | undefined) => {
    const tabs = (persistedStoreApi.getKey('codeTabs') ?? []).map((t) =>
      t.id === tabId ? { ...t, sessionId } : t
    );
    await persistedStoreApi.setKey('codeTabs', tabs);
  },
};

const listen = () => {
  // Push events for real-time updates
  ipc.on('code:sandbox-status', (tabId, status) => {
    // Guard: ignore events for tabs that have been removed. This prevents
    // a late `exited` push from writing to atoms after removeTab() cleaned up.
    const tabs = persistedStoreApi.getKey('codeTabs') ?? [];
    if (!tabs.some((t) => t.id === tabId)) return;

    $codeTabStatuses.setKey(tabId, status);
    if (status.type === 'exited') {
      teardownTabTerminal(tabId);
    }
  });

  // Polling as fallback — catches statuses missed during reconnects / server restarts.
  // Only polls tabs that don't already have a 'running' status to avoid overwriting fresh data.
  const pollStatuses = async () => {
    const tabs = persistedStoreApi.getKey('codeTabs') ?? [];
    for (const tab of tabs) {
      const current = $codeTabStatuses.get()[tab.id];
      // Skip tabs already running — push events keep them up to date
      if (current?.type === 'running') continue;
      try {
        const status = await emitter.invoke('code:get-sandbox-status', tab.id);
        if (!status || status.type === 'uninitialized') continue;
        const old = $codeTabStatuses.get()[tab.id];
        if (!objectEquals(old, status)) {
          $codeTabStatuses.setKey(tab.id, status);
        }
      } catch {
        // ignore — server may not be ready
      }
    }
  };

  setInterval(pollStatuses, STATUS_POLL_INTERVAL_MS);
};

listen();
