import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

import type { StoreData } from '@/shared/types';

const STORE_PATH = join(homedir(), '.config', 'Omni Code', 'config.json');

const DEFAULTS: StoreData = {
  sandboxBackend: 'none',
  sandboxProfiles: null,
  selectedMachineId: null,
  optInToLauncherPrereleases: false,
  previewFeatures: false,
  layoutMode: 'chat',
  theme: 'tokyo-night',
  onboardingComplete: false,
  projects: [],
  milestones: [],
  pages: [],
  inboxItems: [],
  tasks: [],
  tickets: [],
  schemaVersion: 0,
  chatSessionId: null,
  chatProjectId: null,
  codeTabs: [],
  activeCodeTabId: null,
  codeLayoutMode: 'deck',
  codeDeckBackground: null,
  activeTicketId: null,
  wipLimit: 3,
  weeklyReviewDay: 5,
  lastWeeklyReviewAt: null,
  enabledExtensions: {},
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
    try {
      if (existsSync(STORE_PATH)) {
        const raw = readFileSync(STORE_PATH, 'utf-8');
        return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<StoreData>) };
      }
    } catch {
      // Corrupted file — use defaults
    }
    return { ...DEFAULTS };
  }

  private persist(): void {
    mkdirSync(dirname(STORE_PATH), { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify(this.data, null, 2), 'utf-8');
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
