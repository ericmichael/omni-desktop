import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
  | 'codex-account'
  | 'mcp-migration'
  | 'planning'
  | 'no-workspace'
  | 'workspace-files'
  | 'workspace-git'
  | 'pooled-workspaces'
  | 'pooled-devboxes'
  | 'lazy-ready'
  | 'lazy-host-first-message'
  | 'lazy-devbox-first-message'
  | 'lazy-error-pending'
  | 'lazy-error-empty';

export type E2eCodexCredentialState = {
  exists: boolean;
  mode: number | null;
};

export type E2eMcpConfigState = {
  exists: boolean;
  mode: number | null;
  ownedByOmniagents: boolean;
  migratedServerPresent: boolean;
  migratedServerUpdated: boolean;
  migratedSecretPreserved: boolean;
  createdServerPresent: boolean;
  createdServerUpdated: boolean;
  managedServerPresent: boolean;
};

export const E2E_MCP_SECRET = 'e2e-mcp-secret-never-render';
export const E2E_MCP_SERVER_NAME = 'legacy-safe';
export const E2E_MCP_CREATED_SERVER_NAME = 'e2e-created';
export const E2E_MCP_FIXTURE_FILE = 'e2e-mcp-server.mjs';

const modelsConfig = {
  version: 3,
  default: 'sandbox/gpt-5.2',
  voice_default: null,
  providers: {
    sandbox: {
      type: 'openai-compatible',
      base_url: '$' + '{OPENAI_BASE_URL}',
      api_key: '$' + '{OPENAI_API_KEY}',
      models: {
        'gpt-5.2': {
          model: 'gpt-5.2',
          label: 'GPT 5.2 E2E',
          reasoning: 'medium',
        },
        'gpt-5.2-mini': {
          model: 'gpt-5.2-mini',
          label: 'GPT 5.2 Mini E2E',
          reasoning: 'low',
        },
      },
    },
  },
};

function e2eModelsConfig() {
  const externalPath = process.env.E2E_REAL_MODELS_FILE;
  if (!externalPath) {
    return modelsConfig;
  }
  return JSON.parse(readFileSync(externalPath, 'utf-8')) as typeof modelsConfig;
}

const seededAt = 1_700_000_000_000;

const syntheticCodexTokens = {
  refresh: 'e2e-refresh-placeholder',
  access: 'e2e-access-placeholder',
  expires: 4_102_444_800_000,
  account_id: 'acct_e2e_durable_logout',
};

const mcpFixtureScript = `import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin, terminal: false });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');

input.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined) {
    return;
  }
  if (request.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'omni-e2e-mcp', version: '1.0.0' },
      },
    });
    return;
  }
  if (request.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: [
          {
            name: 'fixture_ping',
            description: 'Returns a deterministic local response.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
      },
    });
    return;
  }
  if (request.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'pong' }] } });
    return;
  }
  send({ jsonrpc: '2.0', id: request.id, result: {} });
});
`;

const electronCodexCredentialPath = (state: E2eState): string =>
  path.join(state.xdgConfigHome, 'omni_code', 'codex.json');

export function inspectElectronCodexCredential(state: E2eState): E2eCodexCredentialState {
  const credentialPath = electronCodexCredentialPath(state);
  if (!existsSync(credentialPath)) {
    return { exists: false, mode: null };
  }
  return { exists: true, mode: statSync(credentialPath).mode & 0o777 };
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function nestedRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function inspectElectronMcpConfig(state: E2eState): E2eMcpConfigState {
  const mcpPath = path.join(state.xdgConfigHome, 'omni_code', 'mcp.json');
  const launcherPath = path.join(state.xdgConfigHome, 'Omni Code', 'config.json');
  const launcher = readJsonRecord(launcherPath);
  const mcp = readJsonRecord(mcpPath);
  const servers = nestedRecord(mcp?.['mcpServers']) ?? {};
  const migrated = nestedRecord(servers[E2E_MCP_SERVER_NAME]);
  const created = nestedRecord(servers[E2E_MCP_CREATED_SERVER_NAME]);
  const migratedEnv = nestedRecord(migrated?.['env']);
  const migratedArgs = Array.isArray(migrated?.['args']) ? migrated.args : [];
  const createdArgs = Array.isArray(created?.['args']) ? created.args : [];
  return {
    exists: mcp !== null,
    mode: existsSync(mcpPath) ? statSync(mcpPath).mode & 0o777 : null,
    ownedByOmniagents: launcher?.['mcpConfigOwnership'] === 'omniagents',
    migratedServerPresent: migrated !== null,
    migratedServerUpdated: migratedArgs.includes('--updated'),
    migratedSecretPreserved: migratedEnv?.['E2E_MCP_TOKEN'] === E2E_MCP_SECRET,
    createdServerPresent: created !== null,
    createdServerUpdated: createdArgs.includes('--created-v2'),
    managedServerPresent: nestedRecord(servers['omni-projects']) !== null,
  };
}

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
  chatConversations: [
    {
      sessionId: 'session-e2e-workspace-git',
      title: 'Canonical workspace thread',
      lastActiveAt: seededAt + 2,
      profileName: 'host',
      projectId: 'proj_e2e_workspace_git',
    },
    {
      sessionId: 'session-e2e-retained-thread',
      title: 'Retained canonical thread',
      lastActiveAt: seededAt + 1,
      profileName: 'host',
    },
  ],
});

const pooledWorkspacesSeed = (workspaceDir: string, profileName: 'host' | 'devbox' = 'host') => {
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
        profileName,
        profileNameExplicit: true,
        createdAt: seededAt,
        activatedAt: seededAt,
      },
      {
        id: 'code-e2e-pool-beta',
        projectId: 'proj_e2e_pool_beta',
        sessionId: 'session-e2e-pool-beta',
        workspaceDir: betaDir,
        profileName,
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

function seedMcpFixture(workspaceDir: string): void {
  writeFileSync(path.join(workspaceDir, E2E_MCP_FIXTURE_FILE), mcpFixtureScript, {
    encoding: 'utf-8',
    mode: 0o600,
  });
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
  const lazyState = [
    'no-workspace',
    'lazy-ready',
    'lazy-host-first-message',
    'lazy-devbox-first-message',
    'lazy-error-pending',
    'lazy-error-empty',
  ].includes(seedState);
  const errorWithoutPending = seedState === 'lazy-error-empty';
  const hostFirstMessage = seedState === 'lazy-host-first-message';
  const devboxFirstMessage = seedState === 'lazy-devbox-first-message';
  const firstMessage = hostFirstMessage || devboxFirstMessage;
  const firstMessageTabId = hostFirstMessage ? 'chat-e2e-host-first-message' : 'chat-e2e-devbox-first-message';
  const isolatedRunId = path.basename(path.dirname(workspaceDir));
  return {
    schemaVersion: 28,
    onboardingComplete: true,
    defaultProfileName: seedState.startsWith('lazy-error') ? errorProfile : firstMessage ? 'devbox' : 'host',
    modelsConfig: e2eModelsConfig(),
    envVars: '',
    ...(seedState === 'mcp-migration'
      ? {
          mcpConfig: {
            mcpServers: {
              [E2E_MCP_SERVER_NAME]: {
                type: 'stdio',
                command: process.execPath,
                args: [path.join(workspaceDir, E2E_MCP_FIXTURE_FILE)],
                env: { E2E_MCP_TOKEN: E2E_MCP_SECRET },
              },
            },
          },
        }
      : {}),
    ...(seedState !== 'no-workspace'
      ? {
          workspaceDir:
            seedState === 'workspace-files' || seedState === 'workspace-git' || firstMessage ? workspaceDir : '/tmp',
        }
      : {}),
    ...(lazyState
      ? {
          codeTabs: [
            {
              id: firstMessage ? firstMessageTabId : 'chat-e2e-lazy',
              projectId: null,
              profileName: seedState.startsWith('lazy-error') ? errorProfile : firstMessage ? 'devbox' : 'host',
              profileNameExplicit: seedState.startsWith('lazy-error') || devboxFirstMessage,
              createdAt: seededAt,
              ...(firstMessage
                ? {
                    sessionId: `session-${isolatedRunId}`,
                    snapshotRef: `snapshot-${isolatedRunId}`,
                  }
                : {}),
              ...(errorWithoutPending ? { sessionId: 'session-e2e-lazy-error', activatedAt: seededAt } : {}),
            },
          ],
          activeCodeTabId: firstMessage ? firstMessageTabId : 'chat-e2e-lazy',
        }
      : {}),
    ...(seedState === 'planning' ? planningSeed : {}),
    ...(seedState === 'workspace-files' ? workspaceFilesSeed(workspaceDir) : {}),
    ...(seedState === 'workspace-git' ? workspaceGitSeed(workspaceDir) : {}),
    ...(seedState === 'pooled-workspaces' ? pooledWorkspacesSeed(workspaceDir) : {}),
    ...(seedState === 'pooled-devboxes' ? pooledWorkspacesSeed(workspaceDir, 'devbox') : {}),
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
  if (seedState === 'mcp-migration') {
    seedMcpFixture(state.workspaceDir);
  }
  if (seedState === 'workspace-files') {
    seedWorkspaceFiles(state.workspaceDir);
  }
  if (seedState === 'workspace-git') {
    seedWorkspaceGit(state.workspaceDir);
  }
  if (seedState === 'pooled-workspaces' || seedState === 'pooled-devboxes') {
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
  if (seedState === 'mcp-migration') {
    seedMcpFixture(state.workspaceDir);
  }
  if (seedState === 'workspace-files') {
    seedWorkspaceFiles(state.workspaceDir);
  }
  if (seedState === 'workspace-git') {
    seedWorkspaceGit(state.workspaceDir);
  }
  if (seedState === 'pooled-workspaces' || seedState === 'pooled-devboxes') {
    seedPooledWorkspaces(state.workspaceDir);
  }
  const configDir = path.join(state.xdgConfigHome, 'Omni Code');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    path.join(configDir, 'config.json'),
    `${JSON.stringify(launcherConfig(seedState, state.workspaceDir), null, 2)}\n`,
    'utf-8'
  );
  const productConfigDir = path.join(state.xdgConfigHome, 'omni_code');
  if (seedState === 'codex-account') {
    mkdirSync(productConfigDir, { recursive: true });
    const destination = electronCodexCredentialPath(state);
    writeFileSync(destination, `${JSON.stringify(syntheticCodexTokens, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    chmodSync(destination, 0o600);
    return;
  }

  const codexPath = process.env.E2E_REAL_CODEX_FILE;
  if (codexPath) {
    mkdirSync(productConfigDir, { recursive: true });
    const destination = electronCodexCredentialPath(state);
    copyFileSync(codexPath, destination);
    chmodSync(destination, 0o600);
  }
}
