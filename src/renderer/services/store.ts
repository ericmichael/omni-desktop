import type { ReadableAtom } from 'nanostores';
import { atom } from 'nanostores';

import { emptyMcpConfig, emptyModelsConfig, emptyNetworkConfig } from '@/lib/agent-config';
import { migrateLayoutMode } from '@/lib/store-init';
import { loadTeams, loadWhoami } from '@/renderer/features/Teams/state';
import { initComputeBridge } from '@/renderer/services/compute';
import { emitter, ipc } from '@/renderer/services/ipc';
import { initMachines } from '@/renderer/services/machines';
import { initTunnelBridge } from '@/renderer/services/tunnel-bridge';
import type { OperatingSystem, StoreData } from '@/shared/types';

const getDefaults = (): StoreData => ({
  defaultProfileName: 'host',
  optInToLauncherPrereleases: false,
  previewFeatures: false,
  voicePersonas: [],
  activeVoicePersonaId: 'default',

  layoutMode: 'chat',
  theme: 'teams-light',
  onboardingComplete: false,
  cloudMode: null,
  projects: [],
  milestones: [],
  pages: [],
  inboxItems: [],
  tasks: [],
  tickets: [],
  schemaVersion: 0,
  chatSessionId: null,
  chatProfileName: null,
  chatContainerId: null,
  codeTabs: [],
  activeCodeTabId: null,
  codeLayoutMode: 'tile',
  codeDeckBackground: null,
  glassTone: 'dark',
  activeTicketId: null,
  wipLimit: 3,
  weeklyReviewDay: 5,
  lastWeeklyReviewAt: null,
  enabledExtensions: {},
  skillSources: {},
  installedBundles: {},
  customApps: [],
  modelsConfig: emptyModelsConfig(),
  mcpConfig: emptyMcpConfig(),
  networkConfig: emptyNetworkConfig(),
  envVars: '',
  browserProfiles: [],
  browserTabsets: {},
  browserHistory: [],
  browserBookmarks: [],
});

/**
 * Private atom that holds the store data. Use `persistedStoreApi` to interact with the store.
 */
const _$store = atom<StoreData>(getDefaults());

ipc.on('store:changed', (data) => {
  _$store.set(data ?? getDefaults());
});

/**
 * An API to interact with the persisted store.
 */
export const persistedStoreApi = {
  /**
   * The public atom that holds the store data. Use this atom to subscribe to store changes or consume the store data
   * in React.
   *
   * Changes to the store made from both main and renderer processes will be reflected in this atom.
   */
  $atom: _$store as ReadableAtom<StoreData>,
  /**
   * Set a key in the store. This will update the store and persist the change.
   */
  setKey: <K extends keyof StoreData>(key: K, value: StoreData[K]): Promise<void> => {
    return emitter.invoke('store:set-key', key, value);
  },
  /**
   * Get a key from the store. This is read from the in-memory store and does not make a round-trip to the main process.
   */
  getKey: <K extends keyof StoreData>(key: K): StoreData[K] => {
    return _$store.get()[key];
  },
  /**
   * Set the entire store. This will update the store and persist the change.
   */
  set: (data: StoreData): Promise<void> => {
    return emitter.invoke('store:set', data);
  },
  /**
   * Get the entire store. This is read from the in-memory store and does not make a round-trip to the main process.
   */
  get: (): StoreData => {
    return _$store.get();
  },
  /**
   * Reset the entire store to its default values. This will update the store and persist the change.
   */
  reset: (): Promise<void> => {
    return emitter.invoke('store:reset');
  },
  /**
   * Force a sync of the store with the main process. This will update the in-memory store with the persisted store data.
   */
  sync: async () => {
    const data = await emitter.invoke('store:get');
    _$store.set(data);
  },
};

export const selectWorkspaceDir = async () => {
  const workspaceDir = persistedStoreApi.getKey('workspaceDir');
  const newWorkspaceDir = await emitter.invoke('util:select-directory', workspaceDir);
  if (newWorkspaceDir) {
    persistedStoreApi.setKey('workspaceDir', newWorkspaceDir);
  }
};

/**
 * An atom that holds the initialization state of the store. This is used to determine when the store is ready to be
 * consumed. The app should wait for this atom to be `true` before allowing user interaction.
 */
export const $initialized = atom(false);

/**
 * An atom that holds the operating system of the user. This is fetched from the main process when the app starts.
 */
export const $operatingSystem = atom<OperatingSystem | undefined>(undefined);

// Fetch the operating system from the main process and set it in the store when the app starts
emitter.invoke('util:get-os').then($operatingSystem.set);

/**
 * Initialize the store: sync with main process, apply convention defaults for any unset values, then mark as ready.
 */
const init = async () => {
  await persistedStoreApi.sync();
  const store = persistedStoreApi.get();

  // Migrate legacy layoutMode values to current valid modes
  const layoutReset = migrateLayoutMode(store.layoutMode as string);
  if (layoutReset) {
    await persistedStoreApi.setKey('layoutMode', layoutReset);
  }

  // Apply default workspace dir if user has never picked one
  if (!store.workspaceDir) {
    const defaultDir = await emitter.invoke('util:get-default-workspace-dir');
    await emitter.invoke('util:ensure-directory', defaultDir);
    await persistedStoreApi.setKey('workspaceDir', defaultDir);
  }

  // Existing-user migration: if onboardingComplete is not set, mark it done when
  // model providers are already configured (now sourced from the store, not a file).
  if (!store.onboardingComplete) {
    try {
      const modelsConfig = await emitter.invoke('settings:get-models-config');
      if (Object.keys(modelsConfig.providers).length > 0) {
        await persistedStoreApi.setKey('onboardingComplete', true);
      }
    } catch {
      // If we can't read the config, just leave onboardingComplete as false
    }
  }

  // Teams/cloud: learn our principal + memberships so "my work" filters and the
  // team switcher work. No-op (null/empty) in single-user/local mode.
  void loadWhoami();
  void loadTeams();

  // Computer-as-sandbox: read this Electron's stable identity and (when
  // cloud-linked) register it with the cloud so it appears in the picker.
  // No-op in browser/server mode.
  void initMachines();

  // Bridge the cloud's compute reverse-RPCs through to local Electron main.
  // No-op outside cloud-linked Electron.
  initComputeBridge();

  // Pipe local omni-serve tunnel frames from main back up to the cloud.
  // No-op outside cloud-linked Electron.
  initTunnelBridge();

  $initialized.set(true);
};

init();
