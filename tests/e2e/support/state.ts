import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export type E2eState = {
  rootDir: string;
  homeDir: string;
  xdgConfigHome: string;
  workspaceDir: string;
  cleanup: () => void;
};

export type SeedState =
  | 'blank'
  | 'planning'
  | 'no-workspace'
  | 'workspace-files'
  | 'workspace-git'
  | 'pooled-workspaces'
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

const workspaceFilesSeed = (workspaceDir: string) => ({
  projects: [
    {
      id: 'proj_e2e_workspace_files',
      label: 'Workspace Files',
      slug: 'workspace-files',
      sources: [
        {
          id: 'src_e2e_workspace_files',
          mountName: 'workspace-files',
          kind: 'local',
          workspaceDir,
          gitDetected: false,
        },
      ],
      createdAt: seededAt,
    },
  ],
  codeTabs: [
    {
      id: 'code-e2e-workspace-files',
      projectId: 'proj_e2e_workspace_files',
      sessionId: 'session-e2e-workspace-files',
      workspaceDir,
      profileName: 'host',
      profileNameExplicit: true,
      createdAt: seededAt,
      activatedAt: seededAt,
    },
  ],
  activeCodeTabId: 'code-e2e-workspace-files',
  codeLayoutMode: 'focus',
});

const workspaceGitSeed = (workspaceDir: string) => ({
  projects: [
    {
      id: 'proj_e2e_workspace_git',
      label: 'Workspace Git',
      slug: 'workspace-git',
      sources: [
        {
          id: 'src_e2e_workspace_git',
          mountName: 'workspace-git',
          kind: 'local',
          workspaceDir,
          gitDetected: true,
        },
      ],
      createdAt: seededAt,
    },
  ],
  codeTabs: [
    {
      id: 'code-e2e-workspace-git',
      projectId: 'proj_e2e_workspace_git',
      sessionId: 'session-e2e-workspace-git',
      workspaceDir,
      profileName: 'host',
      profileNameExplicit: true,
      createdAt: seededAt,
      activatedAt: seededAt,
    },
  ],
  activeCodeTabId: 'code-e2e-workspace-git',
  codeLayoutMode: 'focus',
});

const pooledWorkspacesSeed = (workspaceDir: string) => {
  const alphaDir = path.join(workspaceDir, 'alpha');
  const betaDir = path.join(workspaceDir, 'beta');
  return {
    projects: [
      {
        id: 'proj_e2e_pool_alpha',
        label: 'Pool Alpha',
        slug: 'pool-alpha',
        sources: [
          {
            id: 'src_e2e_pool_alpha',
            mountName: 'pool-alpha',
            kind: 'local',
            workspaceDir: alphaDir,
            gitDetected: false,
          },
        ],
        createdAt: seededAt,
      },
      {
        id: 'proj_e2e_pool_beta',
        label: 'Pool Beta',
        slug: 'pool-beta',
        sources: [
          {
            id: 'src_e2e_pool_beta',
            mountName: 'pool-beta',
            kind: 'local',
            workspaceDir: betaDir,
            gitDetected: false,
          },
        ],
        createdAt: seededAt + 1,
      },
    ],
    codeTabs: [
      {
        id: 'code-e2e-pool-alpha',
        projectId: 'proj_e2e_pool_alpha',
        sessionId: 'session-e2e-pool-alpha',
        workspaceDir: alphaDir,
        profileName: 'host',
        profileNameExplicit: true,
        createdAt: seededAt,
        activatedAt: seededAt,
      },
      {
        id: 'code-e2e-pool-beta',
        projectId: 'proj_e2e_pool_beta',
        sessionId: 'session-e2e-pool-beta',
        workspaceDir: betaDir,
        profileName: 'host',
        profileNameExplicit: true,
        createdAt: seededAt + 1,
        activatedAt: seededAt + 1,
      },
    ],
    activeCodeTabId: 'code-e2e-pool-alpha',
    codeLayoutMode: 'focus',
  };
};

function seedWorkspaceFiles(workspaceDir: string): void {
  const sourceDir = path.join(workspaceDir, 'src');
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(path.join(workspaceDir, 'README.md'), '# Workspace files fixture\n', 'utf-8');
  writeFileSync(
    path.join(sourceDir, 'index.ts'),
    "export const greeting = 'hello';\r\nconsole.log(greeting);\r\n",
    'utf-8'
  );
  writeFileSync(path.join(sourceDir, 'utility.ts'), 'export const answer = 42;\n', 'utf-8');
}

function seedWorkspaceGit(workspaceDir: string): void {
  const sourceDir = path.join(workspaceDir, 'src');
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(path.join(workspaceDir, 'README.md'), '# Workspace git fixture\n', 'utf-8');
  writeFileSync(
    path.join(sourceDir, 'index.ts'),
    "export const greeting = 'hello';\nexport const target = 'before';\nconsole.log(greeting);\n",
    'utf-8'
  );
  writeFileSync(path.join(sourceDir, 'utility.ts'), 'export const answer = 42;\n', 'utf-8');
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: workspaceDir, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: workspaceDir, stdio: 'ignore' });
  execFileSync(
    'git',
    ['-c', 'user.name=Omni E2E', '-c', 'user.email=omni-e2e@example.invalid', 'commit', '-m', 'fixture baseline'],
    { cwd: workspaceDir, stdio: 'ignore' }
  );
  writeFileSync(
    path.join(sourceDir, 'index.ts'),
    "export const greeting = 'hello';\nexport const target = 'after';\nconsole.log(greeting);\n",
    'utf-8'
  );
}

function seedPooledWorkspaces(workspaceDir: string): void {
  const alphaDir = path.join(workspaceDir, 'alpha');
  const betaDir = path.join(workspaceDir, 'beta');
  mkdirSync(alphaDir, { recursive: true });
  mkdirSync(betaDir, { recursive: true });
  writeFileSync(path.join(alphaDir, 'identity.txt'), 'alpha workspace\n', 'utf-8');
  writeFileSync(path.join(betaDir, 'identity.txt'), 'beta workspace\n', 'utf-8');
}

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

function launcherConfig(seedState: SeedState, workspaceDir: string) {
  const errorProfile = 'missing-e2e-profile';
  const lazyState = ['no-workspace', 'lazy-ready', 'lazy-error-pending', 'lazy-error-empty'].includes(seedState);
  const errorWithoutPending = seedState === 'lazy-error-empty';
  return {
    schemaVersion: 28,
    onboardingComplete: true,
    defaultProfileName: seedState.startsWith('lazy-error') ? errorProfile : 'host',
    modelsConfig,
    envVars: '',
    ...(seedState !== 'no-workspace'
      ? { workspaceDir: seedState === 'workspace-files' || seedState === 'workspace-git' ? workspaceDir : '/tmp' }
      : {}),
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
    ...(seedState === 'workspace-files' ? workspaceFilesSeed(workspaceDir) : {}),
    ...(seedState === 'workspace-git' ? workspaceGitSeed(workspaceDir) : {}),
    ...(seedState === 'pooled-workspaces' ? pooledWorkspacesSeed(workspaceDir) : {}),
  };
}

export function createE2eState(label: string): E2eState {
  const rootDir = mkdtempSync(path.join(tmpdir(), `omni-desktop-e2e-${label}-`));
  const homeDir = path.join(rootDir, 'home');
  const xdgConfigHome = path.join(rootDir, 'xdg');
  const workspaceDir = path.join(rootDir, 'workspace');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(xdgConfigHome, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });

  return {
    rootDir,
    homeDir,
    xdgConfigHome,
    workspaceDir,
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
}

export function seedServerState(state: E2eState, seedState: SeedState): void {
  if (seedState === 'workspace-files') {
    seedWorkspaceFiles(state.workspaceDir);
  }
  if (seedState === 'workspace-git') {
    seedWorkspaceGit(state.workspaceDir);
  }
  if (seedState === 'pooled-workspaces') {
    seedPooledWorkspaces(state.workspaceDir);
  }
  const configDir = path.join(state.homeDir, '.config', 'Omni Code');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    path.join(configDir, 'config.json'),
    `${JSON.stringify(launcherConfig(seedState, state.workspaceDir), null, 2)}\n`,
    'utf-8'
  );
}

export function seedElectronState(state: E2eState, seedState: SeedState): void {
  if (seedState === 'workspace-files') {
    seedWorkspaceFiles(state.workspaceDir);
  }
  if (seedState === 'workspace-git') {
    seedWorkspaceGit(state.workspaceDir);
  }
  if (seedState === 'pooled-workspaces') {
    seedPooledWorkspaces(state.workspaceDir);
  }
  const configDir = path.join(state.xdgConfigHome, 'Omni Code');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    path.join(configDir, 'config.json'),
    `${JSON.stringify(launcherConfig(seedState, state.workspaceDir), null, 2)}\n`,
    'utf-8'
  );
}
