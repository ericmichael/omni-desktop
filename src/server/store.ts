import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

import { emptyMcpConfig, emptyModelsConfig, emptyNetworkConfig } from '@/lib/agent-config';
import type { StoreData } from '@/shared/types';

const STORE_PATH = join(homedir(), '.config', 'Omni Code', 'config.json');

export const DEFAULTS: StoreData = {
  defaultProfileName: 'host',
  optInToLauncherPrereleases: false,
  previewFeatures: false,
  notifyOnAgentAttention: false,
  textScale: 100,
  voicePersonas: [],
  activeVoicePersonaId: 'default',
  voiceToggleHotkey: null,
  globalVoiceToggleHotkey: null,
  localVoiceEnabled: false,
  audioSettings: {
    inputDeviceId: null,
    outputDeviceId: null,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
  layoutMode: 'chat',
  theme: 'omni',
  onboardingComplete: false,
  cliCardDismissed: false,
  cloudMode: null,
  projects: [],
  milestones: [],
  pages: [],
  inboxItems: [],
  tasks: [],
  tickets: [],
  schemaVersion: 0,
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
  gitCredentials: [],
  pullRequestLinks: [],
  modelsConfig: emptyModelsConfig(),
  mcpConfig: emptyMcpConfig(),
  networkConfig: emptyNetworkConfig(),
  envVars: '',
  browserProfiles: [],
  browserTabsets: {},
  browserHistory: [],
  browserBookmarks: [],
};

type ChangeCallback = (data: StoreData | undefined) => void;

/**
 * JSON-file-based store that replaces electron-store for server mode.
 * Provides the same API surface used by MainProcessManager and managers.
 */
export class ServerStore {
  private data: StoreData;
  private changeCallbacks = new Set<ChangeCallback>();

  constructor() {
    this.data = this.load();
  }

  private load(): StoreData {
    if (!existsSync(STORE_PATH)) {
      return { ...DEFAULTS };
    }
    try {
      const raw = readFileSync(STORE_PATH, 'utf-8');
      return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<StoreData>) };
    } catch (err) {
      // Don't silently discard a corrupted store — back it up under a
      // timestamped name so the operator can recover by hand and we leave
      // a loud breadcrumb instead of pretending all user state vanished.
      const backupPath = `${STORE_PATH}.corrupt-${Date.now()}`;
      try {
        renameSync(STORE_PATH, backupPath);
        console.error(`[store] corrupted config.json backed up to ${backupPath}:`, err);
      } catch (backupErr) {
        console.error('[store] failed to back up corrupted config.json:', backupErr);
      }
      return { ...DEFAULTS };
    }
  }

  private persist(): void {
    // Atomic write: serialize to a temp file, then rename. A crash mid-write
    // leaves the original config.json intact instead of leaving the user with
    // a half-written file that load() would treat as corrupted.
    mkdirSync(dirname(STORE_PATH), { recursive: true });
    const tmpPath = `${STORE_PATH}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), 'utf-8');
    renameSync(tmpPath, STORE_PATH);
  }

  private notify(): void {
    for (const cb of this.changeCallbacks) {
      cb(this.data);
    }
  }

  get store(): StoreData {
    return this.data;
  }

  set store(data: StoreData) {
    this.data = data;
    this.persist();
    this.notify();
  }

  get<K extends keyof StoreData>(key: K, defaultValue?: StoreData[K]): StoreData[K] {
    const val = this.data[key];
    return val !== undefined ? val : (defaultValue as StoreData[K]);
  }

  set<K extends keyof StoreData>(key: K, value: StoreData[K]): void;
  set(data: Partial<StoreData>): void;
  set<K extends keyof StoreData>(keyOrData: K | Partial<StoreData>, value?: StoreData[K]): void {
    if (typeof keyOrData === 'string') {
      (this.data as Record<string, unknown>)[keyOrData] = value;
    } else {
      Object.assign(this.data, keyOrData);
    }
    this.persist();
    this.notify();
  }

  delete<K extends keyof StoreData>(key: K): void {
    delete (this.data as Record<string, unknown>)[key];
    this.persist();
    this.notify();
  }

  clear(): void {
    this.data = { ...DEFAULTS };
    this.persist();
    this.notify();
  }

  onDidAnyChange(callback: ChangeCallback): () => void {
    this.changeCallbacks.add(callback);
    return () => {
      this.changeCallbacks.delete(callback);
    };
  }
}
