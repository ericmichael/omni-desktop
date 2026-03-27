import type { ReadableAtom } from 'nanostores';
import { atom } from 'nanostores';

import { emitter, ipc } from '@/renderer/services/ipc';
import type { ModelsConfig, OperatingSystem, StoreData } from '@/shared/types';

const getDefaults = (): StoreData => ({
  sandboxVariant: 'work',
  optInToLauncherPrereleases: false,
  previewFeatures: false,

  layoutMode: 'chat',
  theme: 'tokyo-night',
  onboardingComplete: false,
  fleetProjects: [],
  fleetTasks: [],
  fleetTickets: [],
  fleetSchemaVersion: 0,
  codeTabs: [],
  activeCodeTabId: null,
  codeLayoutMode: 'deck',
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

  if (import.meta.env.MODE !== 'development' && !store.previewFeatures && store.layoutMode !== 'chat') {
    await persistedStoreApi.setKey('layoutMode', 'chat');
  }

  // Apply default workspace dir if user has never picked one
  if (!store.workspaceDir) {
    const defaultDir = await emitter.invoke('util:get-default-workspace-dir');
    await emitter.invoke('util:ensure-directory', defaultDir);
    await persistedStoreApi.setKey('workspaceDir', defaultDir);
  }

  // Existing-user migration: if onboardingComplete is not set, check if models.json already has providers
  if (!store.onboardingComplete) {
    try {
      const configDir = await emitter.invoke('config:get-omni-config-dir');
      const modelsConfig = (await emitter.invoke(
        'config:read-json-file',
        `${configDir}/models.json`
      )) as ModelsConfig | null;
      if (modelsConfig?.providers && Object.keys(modelsConfig.providers).length > 0) {
        await persistedStoreApi.setKey('onboardingComplete', true);
      }
    } catch {
      // If we can't read the config, just leave onboardingComplete as false
    }
  }

  $initialized.set(true);
};

init();
