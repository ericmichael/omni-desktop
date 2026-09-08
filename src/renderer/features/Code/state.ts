import { map } from 'nanostores';

import { STATUS_POLL_INTERVAL_MS } from '@/renderer/constants';
import type { AutoLaunchPhase } from '@/renderer/features/Code/use-code-auto-launch';
import { forgetTerminalsForTab } from '@/renderer/features/Console/state';
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
import type { ChatCommand, ChatOperations } from '@/shared/chat-commands';
import type { AgentProcessStopOptions, CodeTab, CodeTabId, ProjectId } from '@/shared/types';

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

export function finishRemoval(tabId: string) {
  try {
    forgetTerminalsForTab(tabId);
    teardownTerminal(tabId);
  } finally {
    clearStatus(tabId);
    const phases = { ...$codeTabPhases.get() };
    delete phases[tabId];
    $codeTabPhases.set(phases);
    const errors = { ...$codeTabErrors.get() };
    delete errors[tabId];
    $codeTabErrors.set(errors);
  }
}
function run<K extends keyof ChatOperations>(
  method: K,
  ...args: Parameters<ChatOperations[K]>
): Promise<ReturnType<ChatOperations[K]>> {
  return emitter.invoke('store:chat-command', { method, args } as ChatCommand) as Promise<
    ReturnType<ChatOperations[K]>
  >;
}
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
  openFreshChat: (...args: Parameters<ChatOperations['openFreshChat']>) => run('openFreshChat', ...args),
  addTab: (...args: Parameters<ChatOperations['addTab']>) => run('addTab', ...args),
  removeTab: async (...args: Parameters<ChatOperations['removeTab']>): Promise<void> => {
    await run('removeTab', ...args);
    finishRemoval(args[0]);
  },
  setActiveTab: (...args: Parameters<ChatOperations['setActiveTab']>) => run('setActiveTab', ...args),
  setLayoutMode: (...args: Parameters<ChatOperations['setLayoutMode']>) => run('setLayoutMode', ...args),
  setSpacesColumnLayouts: (...args: Parameters<ChatOperations['setSpacesColumnLayouts']>) =>
    run('setSpacesColumnLayouts', ...args),
  reorderTabs: (tabs: CodeTab[]) =>
    run(
      'reorderTabs',
      tabs.map((tab) => tab.id)
    ),
  setTabProject: (...args: Parameters<ChatOperations['setTabProject']>) => run('setTabProject', ...args),
  setTabActivated: (...args: Parameters<ChatOperations['setTabActivated']>) => run('setTabActivated', ...args),
  addTabForConversation: (...args: Parameters<ChatOperations['addTabForConversation']>) =>
    run('addTabForConversation', ...args),
  recordConversation: (...args: Parameters<ChatOperations['recordConversation']>) => run('recordConversation', ...args),
  archiveConversation: (...args: Parameters<ChatOperations['archiveConversation']>) =>
    run('archiveConversation', ...args),
  archiveTab: async (...args: Parameters<ChatOperations['archiveTab']>): Promise<void> => {
    await run('archiveTab', ...args);
    finishRemoval(args[0]);
  },
  restoreConversation: (...args: Parameters<ChatOperations['restoreConversation']>) =>
    run('restoreConversation', ...args),
  addTabForTicket: (...args: Parameters<ChatOperations['addTabForTicket']>) => run('addTabForTicket', ...args),
  addAppTab: (...args: Parameters<ChatOperations['addAppTab']>) => run('addAppTab', ...args),
  setTabAppId: (...args: Parameters<ChatOperations['setTabAppId']>) => run('setTabAppId', ...args),
  openSidecarApp: (...args: Parameters<ChatOperations['openSidecarApp']>) => run('openSidecarApp', ...args),
  setSidecarOpen: (...args: Parameters<ChatOperations['setSidecarOpen']>) => run('setSidecarOpen', ...args),
  setActiveSidecarApp: (...args: Parameters<ChatOperations['setActiveSidecarApp']>) =>
    run('setActiveSidecarApp', ...args),
  reorderSidecarApps: (...args: Parameters<ChatOperations['reorderSidecarApps']>) => run('reorderSidecarApps', ...args),
  closeSidecarApp: (...args: Parameters<ChatOperations['closeSidecarApp']>) => run('closeSidecarApp', ...args),
  setTabSessionId: (...args: Parameters<ChatOperations['setTabSessionId']>) => run('setTabSessionId', ...args),
  setTabSnapshotRef: (...args: Parameters<ChatOperations['setTabSnapshotRef']>) => run('setTabSnapshotRef', ...args),
  setTabProfile: (...args: Parameters<ChatOperations['setTabProfile']>) => run('setTabProfile', ...args),
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
