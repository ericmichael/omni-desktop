import fs from 'node:fs/promises';
import path from 'node:path';

import { getStoreFile, getUserDataDir } from './paths.mjs';

/** Current schema version — must match the last migration in src/lib/project-migrations.ts. */
export const CURRENT_SCHEMA_VERSION = 17;

/** Defaults for a fresh store. Matches `schema` in src/shared/types.ts. */
function defaultStoreData() {
  return {
    sandboxBackend: 'none',
    sandboxProfiles: null,
    selectedMachineId: null,
    optInToLauncherPrereleases: false,
    previewFeatures: false,
    layoutMode: 'chat',
    theme: 'tokyo-night',
    onboardingComplete: true,
    projects: [],
    milestones: [],
    pages: [],
    inboxItems: [],
    tasks: [],
    tickets: [],
    wipLimit: 3,
    weeklyReviewDay: 5,
    lastWeeklyReviewAt: null,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    chatSessionId: null,
    chatProjectId: null,
    codeTabs: [],
    activeCodeTabId: null,
    codeLayoutMode: 'deck',
    codeDeckBackground: null,
    activeTicketId: null,
    enabledExtensions: {},
    skillSources: {},
    customApps: [],
    browserProfiles: [],
    browserTabsets: {},
    browserHistory: [],
    browserBookmarks: [],
  };
}

export async function readStore() {
  const file = getStoreFile();
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw);
    return { ...defaultStoreData(), ...parsed };
  } catch (err) {
    if (err.code === 'ENOENT') return defaultStoreData();
    throw err;
  }
}

export async function writeStore(data) {
  const file = getStoreFile();
  await fs.mkdir(getUserDataDir(), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, '\t'), 'utf-8');
}
