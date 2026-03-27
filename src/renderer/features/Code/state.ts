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
  FleetProjectId,
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
  startSandbox: (tabId: CodeTabId, arg: { workspaceDir: string; sandboxVariant: SandboxVariant }) => {
    initializeTabTerminal(tabId);
    emitter.invoke('code:start-sandbox', tabId, arg);
  },

  stopSandbox: async (tabId: CodeTabId) => {
    await emitter.invoke('code:stop-sandbox', tabId);
    teardownTabTerminal(tabId);
  },

  rebuildSandbox: (tabId: CodeTabId, fallbackArg: { workspaceDir: string; sandboxVariant: SandboxVariant }) => {
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

  setTabProject: async (tabId: CodeTabId, projectId: FleetProjectId) => {
    const tabs = (persistedStoreApi.getKey('codeTabs') ?? []).map((t) => (t.id === tabId ? { ...t, projectId } : t));
    await persistedStoreApi.setKey('codeTabs', tabs);
    // Trigger auto-launch by setting phase to checking
    $codeTabPhases.setKey(tabId, 'checking');
  },
};

const listen = () => {
  ipc.on('code:sandbox-status', (tabId, status) => {
    $codeTabStatuses.setKey(tabId, status);
    if (status.type === 'exited') {
      teardownTabTerminal(tabId);
    }
  });

  // Poll sandbox statuses for all tabs that have a project
  setInterval(async () => {
    const tabs = persistedStoreApi.getKey('codeTabs') ?? [];
    for (const tab of tabs) {
      if (!tab.projectId) {
        continue;
      }
      try {
        const oldStatus = $codeTabStatuses.get()[tab.id];
        const newStatus = await emitter.invoke('code:get-sandbox-status', tab.id);
        if (!objectEquals(oldStatus, newStatus)) {
          $codeTabStatuses.setKey(tab.id, newStatus);
        }
      } catch {
        // ignore polling errors
      }
    }
  }, STATUS_POLL_INTERVAL_MS);
};

listen();
