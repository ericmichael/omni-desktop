import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export type E2eState = {
  rootDir: string;
  homeDir: string;
  xdgConfigHome: string;
  cleanup: () => void;
};

export type SeedState =
  | 'blank'
  | 'planning'
  | 'no-workspace'
  | 'lazy-ready'
  | 'lazy-error-pending'
  | 'lazy-error-empty';

const modelsConfig = {
  version: 3,
  default: 'sandbox/gpt-5.2',
  voice_default: null,
  providers: {
    sandbox: {
      type: 'openai-compatible',
      base_url: '$' + '{OPENAI_BASE_URL}',
      api_key: '$' + '{OPENAI_API_KEY}',
      models: { 'gpt-5.2': { model: 'gpt-5.2' } },
    },
  },
};

const seededAt = 1_700_000_000_000;

const planningSeed = {
  projects: [
    {
      id: 'proj_e2e_seed',
      label: 'Seeded Project',
      slug: 'seeded-project',
      sources: [],
      createdAt: seededAt,
    },
  ],
  milestones: [],
  tickets: [],
  pages: [
    {
      id: 'pg_e2e_seed_root',
      projectId: 'proj_e2e_seed',
      parentId: null,
      title: 'Seeded Project',
      sortOrder: 0,
      isRoot: true,
      kind: 'doc',
      createdAt: seededAt,
      updatedAt: seededAt,
    },
    {
      id: 'pg_e2e_seed_spec',
      projectId: 'proj_e2e_seed',
      parentId: 'pg_e2e_seed_root',
      title: 'Seeded Spec',
      sortOrder: 1,
      kind: 'doc',
      createdAt: seededAt,
      updatedAt: seededAt,
    },
  ],
  inboxItems: [
    {
      id: 'inbox_e2e_seed',
      title: 'Seeded inbox item',
      status: 'new',
      createdAt: seededAt,
      updatedAt: seededAt,
    },
  ],
};

function launcherConfig(seedState: SeedState) {
  const errorProfile = 'missing-e2e-profile';
  const lazyState = ['no-workspace', 'lazy-ready', 'lazy-error-pending', 'lazy-error-empty'].includes(seedState);
  const errorWithoutPending = seedState === 'lazy-error-empty';
  return {
    schemaVersion: 28,
    onboardingComplete: true,
    defaultProfileName: seedState.startsWith('lazy-error') ? errorProfile : 'host',
    modelsConfig,
    envVars: '',
    ...(seedState !== 'no-workspace' ? { workspaceDir: '/tmp' } : {}),
    ...(lazyState
      ? {
          codeTabs: [
            {
              id: 'chat-e2e-lazy',
              projectId: null,
              profileName: seedState.startsWith('lazy-error') ? errorProfile : 'host',
              profileNameExplicit: seedState.startsWith('lazy-error'),
              createdAt: seededAt,
              ...(errorWithoutPending ? { sessionId: 'session-e2e-lazy-error', activatedAt: seededAt } : {}),
            },
          ],
          activeCodeTabId: 'chat-e2e-lazy',
        }
      : {}),
    ...(seedState === 'planning' ? planningSeed : {}),
  };
}

export function createE2eState(label: string): E2eState {
  const rootDir = mkdtempSync(path.join(tmpdir(), `omni-desktop-e2e-${label}-`));
  const homeDir = path.join(rootDir, 'home');
  const xdgConfigHome = path.join(rootDir, 'xdg');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(xdgConfigHome, { recursive: true });

  return {
    rootDir,
    homeDir,
    xdgConfigHome,
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
}

export function seedServerState(state: E2eState, seedState: SeedState): void {
  const configDir = path.join(state.homeDir, '.config', 'Omni Code');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    path.join(configDir, 'config.json'),
    `${JSON.stringify(launcherConfig(seedState), null, 2)}\n`,
    'utf-8'
  );
}

export function seedElectronState(state: E2eState, seedState: SeedState): void {
  const configDir = path.join(state.xdgConfigHome, 'Omni Code');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    path.join(configDir, 'config.json'),
    `${JSON.stringify(launcherConfig(seedState), null, 2)}\n`,
    'utf-8'
  );
}
