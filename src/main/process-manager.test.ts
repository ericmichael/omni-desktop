/**
 * Tests for ProcessManager — profile-name resolution, status fallback,
 * getRunningWsUrlForTicket, and lifecycle operations.
 *
 * Mocks AgentProcess to avoid real process spawning.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  configureConsumerFailure: null as string | null,
  configureConsumerGate: null as Promise<void> | null,
  agentProcessInstances: [] as Array<{
    mode: string;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    exit: ReturnType<typeof vi.fn>;
    rebuild: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
    getRuntimeConnection: ReturnType<typeof vi.fn>;
    getManagementMutationCapabilities: ReturnType<typeof vi.fn>;
    getManagementAccountStatus: ReturnType<typeof vi.fn>;
    getManagementMcpStatus: ReturnType<typeof vi.fn>;
    usesLocalAgentHostConfig: ReturnType<typeof vi.fn>;
    callManagementAdmin: ReturnType<typeof vi.fn>;
    resizePty: ReturnType<typeof vi.fn>;
    configureConsumer: ReturnType<typeof vi.fn>;
    stopConsumerEnvironment: ReturnType<typeof vi.fn>;
    discardConsumerSnapshot: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    unpause: ReturnType<typeof vi.fn>;
    notifyActivity: ReturnType<typeof vi.fn>;
    emitStatus: (status: WithTimestamp<AgentProcessStatus>) => void;
  }>,
}));

vi.mock('@/main/agent-process', () => ({
  AgentProcess: class MockAgentProcess {
    mode: string;
    start = vi.fn();
    stop = vi.fn(async () => ({
      scope: 'host',
      shutdown: 'graceful',
      snapshotPersistence: 'complete',
      pendingSnapshotRefs: [],
    }));
    exit = vi.fn(async () => {});
    rebuild = vi.fn(async () => {});
    getStatus = vi.fn(() => ({ type: 'uninitialized', timestamp: Date.now() }));
    getRuntimeConnection = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:9000',
      authToken: 'ordinary-consumer-token',
    }));
    getManagementMutationCapabilities = vi.fn(async () => ({ validateConfig: true, writeConfig: true }));
    getManagementAccountStatus = vi.fn(async () => ({
      providers: [{ id: 'openai-chatgpt', state: 'signed_out', identity: null }],
      mutation_persistence: { codex_oauth: { durable: true, scope: 'host' } },
    }));
    getManagementMcpStatus = vi.fn(async () => ({
      servers: [],
      user_mcp_allowed: true,
      write_target: '/config/mcp.json',
      mutation_persistence: {
        user_config: { durable: true, scope: 'host' },
        oauth_tokens: { durable: true, scope: 'host' },
        pending_auth: { durable: false, scope: 'process' },
        managed_servers: ['omni-projects'],
      },
    }));
    usesLocalAgentHostConfig = vi.fn(() => this.mode === 'serve');
    callManagementAdmin = vi.fn(async (method: string) => ({ ok: true, method }));
    resizePty = vi.fn();
    configureConsumer = vi.fn(async (_threadId: string, workspaceId: string, _arg: unknown) => {
      await hoisted.configureConsumerGate;
      if (hoisted.configureConsumerFailure) {
        throw new Error(hoisted.configureConsumerFailure);
      }
      return {
        workspaceId,
        environmentId: `environment-${workspaceId}`,
        environmentGeneration: 3,
        workspaceRoot: `/runtime/${workspaceId}`,
        services: {},
        containerId: `container-${workspaceId}`,
      };
    });
    stopConsumerEnvironment = vi.fn(async () => ({
      scope: 'environment',
      shutdown: 'not-applicable',
      snapshotPersistence: 'complete',
      pendingSnapshotRefs: [],
    }));
    discardConsumerSnapshot = vi.fn(async () => {});
    pause = vi.fn(async () => ({ ok: true, supported: true, paused: true }));
    unpause = vi.fn(async () => ({ ok: true, supported: true, paused: false }));
    notifyActivity = vi.fn();
    emitStatus: (status: WithTimestamp<AgentProcessStatus>) => void;

    constructor(opts: { mode: string; onStatusChange: (status: WithTimestamp<AgentProcessStatus>) => void }) {
      this.mode = opts.mode;
      this.emitStatus = opts.onStatusChange;
      hoisted.agentProcessInstances.push(this);
    }
  },
}));

vi.mock('@/main/store', () => ({
  store: { get: vi.fn(() => undefined), set: vi.fn() },
  getStore: vi.fn(() => ({ get: vi.fn(() => undefined), set: vi.fn() })),
}));

// node:child_process is touched by resolveGitRemote — stub to no remote.
vi.mock('node:child_process', async () => {
  const actual = (await vi.importActual('node:child_process')) as typeof import('node:child_process');
  return {
    ...actual,
    execFileSync: vi.fn(() => {
      throw new Error('no git remote in test');
    }),
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  type IHostBridgePreparer,
  isLauncherOwnedDir,
  ProcessManager,
  type ProcessManagerStoreData,
} from '@/main/process-manager';
import { getDefaultWorkspaceDir } from '@/main/util';
import { gitTokenEnvName } from '@/shared/git-credentials';
import type { AgentProcessStatus, GitCredential, Project, WithTimestamp } from '@/shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePm(opts?: {
  storeData?: Partial<ProcessManagerStoreData>;
  resolveGitToken?: (credentialId: string) => Promise<string | undefined>;
  hostBridge?: IHostBridgePreparer;
  waitForRuntimeInstall?: () => Promise<void>;
  durableLocalCodexAccountMutations?: boolean;
  durableLocalMcpMutations?: boolean;
  prepareLocalMcpOwnership?: (status: Record<string, unknown>) => void | Promise<void>;
}) {
  hoisted.agentProcessInstances = [];
  const sendCalls: Array<{ channel: string; args: unknown[] }> = [];
  const storeData: ProcessManagerStoreData = {
    defaultProfileName: 'host',
    projects: [],
    ...opts?.storeData,
  };
  const pm = new ProcessManager({
    sendToWindow: ((channel: string, ...args: unknown[]) => {
      sendCalls.push({ channel, args });
    }) as never,
    getStoreData: () => storeData,
    resolveGitToken: opts?.resolveGitToken,
    hostBridge: opts?.hostBridge,
    waitForRuntimeInstall: opts?.waitForRuntimeInstall,
    durableLocalCodexAccountMutations: opts?.durableLocalCodexAccountMutations,
    durableLocalMcpMutations: opts?.durableLocalMcpMutations,
    prepareLocalMcpOwnership: opts?.prepareLocalMcpOwnership,
  });
  return { pm, sendCalls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isLauncherOwnedDir', () => {
  it('classifies per-conversation Sessions scratch dirs as launcher-owned', () => {
    expect(isLauncherOwnedDir('/custom/root/Sessions/abc-123')).toBe(true);
  });

  it('classifies dirs under the default workspace tree as launcher-owned', () => {
    expect(isLauncherOwnedDir(`${getDefaultWorkspaceDir()}/Projects/my-project`)).toBe(true);
    expect(isLauncherOwnedDir(getDefaultWorkspaceDir())).toBe(true);
  });

  it('classifies arbitrary user folders as user-linked', () => {
    expect(isLauncherOwnedDir('/home/someone/Documents/my-folder')).toBe(false);
  });
});

describe('ProcessManager', () => {
  beforeEach(() => {
    hoisted.agentProcessInstances = [];
    hoisted.configureConsumerFailure = null;
    hoisted.configureConsumerGate = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('mode resolution', () => {
    it.each([
      ['host', 'serve'],
      ['devbox', 'serve'],
      ['custom-profile', 'serve'],
      ['platform', 'compute'],
    ] as const)('defaultProfileName=%s resolves to mode=%s', async (profileName, expectedMode) => {
      const { pm } = makePm({ storeData: { defaultProfileName: profileName } });
      await pm.start('test-1', { workspaceDir: '/tmp/ws' });

      expect(hoisted.agentProcessInstances).toHaveLength(1);
      expect(hoisted.agentProcessInstances[0]!.mode).toBe(expectedMode);
    });

    it('per-project sandboxProfile overrides defaultProfileName', async () => {
      const project: Project = {
        id: 'proj_1',
        label: 'Proj',
        slug: 'proj',
        sources: [],
        createdAt: 0,
        sandboxProfile: 'platform',
      };
      const { pm } = makePm({
        storeData: { defaultProfileName: 'host', projects: [project] },
      });
      await pm.start('tab-1', { workspaceDir: '/tmp/ws', projectId: 'proj_1' });

      expect(hoisted.agentProcessInstances[0]!.mode).toBe('compute');
    });

    it('forwards profileName + projectId in the start arg', async () => {
      const { pm } = makePm({ storeData: { defaultProfileName: 'devbox' } });
      await pm.start('tab-1', { workspaceDir: '/tmp', projectId: 'proj_x' });

      expect(hoisted.agentProcessInstances[0]!.start).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceDir: '/tmp',
          profileName: 'devbox',
          projectId: 'proj_x',
        })
      );
    });

    it('keeps local-machine compute on the explicitly safe host_bridge serve path', async () => {
      const hostBridge: IHostBridgePreparer = {
        prepare: vi.fn(async () => ({ profilePath: '/tmp/host-bridge-machine-1.yml' })),
        release: vi.fn(async () => {}),
        machineState: vi.fn(() => ({ online: true, label: 'Laptop' })),
      };
      const { pm } = makePm({ storeData: { defaultProfileName: 'local:machine-1' }, hostBridge });
      await pm.start('tab-local', { workspaceDir: '/tmp/local-workspace' });

      expect(hoisted.agentProcessInstances[0]!.mode).toBe('serve');
      expect(hoisted.agentProcessInstances[0]!.start).toHaveBeenCalledWith(
        expect.objectContaining({
          profileName: 'local:machine-1',
          explicitProfilePath: '/tmp/host-bridge-machine-1.yml',
        })
      );
    });

    it('forwards complete platform execution routing and consumer credentials to the renderer', async () => {
      const { pm, sendCalls } = makePm({ storeData: { defaultProfileName: 'platform' } });
      await pm.start('tab-platform', { workspaceDir: '/tmp/platform-workspace', sessionId: 'conversation-1' });
      const process = hoisted.agentProcessInstances[0]!;
      const status: WithTimestamp<AgentProcessStatus> = {
        type: 'running',
        timestamp: 10,
        data: {
          uiUrl: 'https://runtime.example.test',
          wsUrl: 'wss://runtime.example.test/ws',
          agentHostId: 'remote-agent-host-1',
          workspaceId: 'remote-workspace-1',
          environmentId: 'remote-environment-1',
          environmentGeneration: 7,
          workspaceRoot: '/workspace/project',
          defaultCwd: '/workspace/project',
          services: { code_server: 'https://code.example.test' },
          authToken: 'ordinary-consumer-token',
        },
      };
      process.getStatus.mockReturnValue(status);
      process.emitStatus(status);

      expect(pm.getStatus('tab-platform')).toEqual(status);
      expect(sendCalls.at(-1)).toEqual({
        channel: 'agent-process:status',
        args: ['tab-platform', status],
      });
    });
  });

  describe('product management connection', () => {
    it('does not create or start an AgentHost until the runtime install overlay finishes', async () => {
      let finishInstall!: () => void;
      const install = new Promise<void>((resolve) => {
        finishInstall = resolve;
      });
      const waitForRuntimeInstall = vi.fn(() => install);
      const { pm } = makePm({ waitForRuntimeInstall });

      const management = pm.ensureManagementConnection();
      await vi.waitFor(() => expect(waitForRuntimeInstall).toHaveBeenCalledOnce());
      expect(hoisted.agentProcessInstances).toHaveLength(0);

      finishInstall();
      await management;
      expect(hoisted.agentProcessInstances).toHaveLength(1);
      expect(hoisted.agentProcessInstances[0]!.start).toHaveBeenCalledOnce();
    });

    it('starts a targetless serve host without materializing an environment', async () => {
      const { pm } = makePm({ storeData: { defaultProfileName: 'platform' } });

      await expect(pm.ensureManagementConnection()).resolves.toEqual({
        baseUrl: 'http://127.0.0.1:9000',
        authToken: 'ordinary-consumer-token',
        mutationCapabilities: { validateConfig: true, writeConfig: true },
      });

      const host = hoisted.agentProcessInstances[0]!;
      expect(host.mode).toBe('serve');
      expect(host.start).toHaveBeenCalledWith(
        expect.objectContaining({ profileName: 'host', workspaceDir: '', sources: [] })
      );
      expect(host.configureConsumer).not.toHaveBeenCalled();
      expect(host.getRuntimeConnection).toHaveBeenCalledOnce();
      expect(host.getManagementMutationCapabilities).toHaveBeenCalledOnce();
    });

    it('deduplicates concurrent management connection requests', async () => {
      const { pm } = makePm();

      const [first, second] = await Promise.all([pm.ensureManagementConnection(), pm.ensureManagementConnection()]);

      expect(first).toEqual(second);
      expect(hoisted.agentProcessInstances).toHaveLength(1);
      expect(hoisted.agentProcessInstances[0]!.getRuntimeConnection).toHaveBeenCalledOnce();
    });

    it('routes only allowlisted mutations through the host admin client', async () => {
      const { pm } = makePm();

      await expect(
        pm.mutateManagement({ method: 'validate_config', params: { updates: { temperature: 0.2 } } })
      ).resolves.toEqual({ ok: true, method: 'validate_config' });

      const host = hoisted.agentProcessInstances[0]!;
      expect(host.callManagementAdmin).toHaveBeenCalledWith('validate_config', {
        updates: { temperature: 0.2 },
      });
      await expect(pm.mutateManagement({ method: 'agent_host_list_resources', params: {} })).rejects.toThrow(
        'not allowed'
      );
      expect(host.callManagementAdmin).toHaveBeenCalledOnce();
    });

    it('denies account mutations by default for server and other non-Electron managers', async () => {
      const { pm } = makePm();

      await expect(
        pm.mutateManagement({
          method: 'account_logout',
          params: { provider: 'openai-chatgpt' },
        })
      ).rejects.toThrow('outside local single-user Electron');

      const host = hoisted.agentProcessInstances[0]!;
      expect(host.getManagementAccountStatus).not.toHaveBeenCalled();
      expect(host.callManagementAdmin).not.toHaveBeenCalled();
    });

    it('requires runtime durable-host attestation as well as the Electron topology flag', async () => {
      const { pm } = makePm({ durableLocalCodexAccountMutations: true });
      await pm.ensureManagementConnection();
      const host = hoisted.agentProcessInstances[0]!;
      host.getManagementAccountStatus.mockResolvedValue({
        providers: [{ id: 'openai-chatgpt', state: 'signed_out', identity: null }],
        mutation_persistence: { codex_oauth: { durable: false, scope: null } },
      });

      await expect(
        pm.mutateManagement({
          method: 'account_logout',
          params: { provider: 'openai-chatgpt' },
        })
      ).rejects.toThrow('did not attest durable host-scoped');
      expect(host.callManagementAdmin).not.toHaveBeenCalled();
    });

    it('permits only the durable Codex OAuth subset after both gates pass', async () => {
      const { pm } = makePm({ durableLocalCodexAccountMutations: true });

      await expect(
        pm.mutateManagement({
          method: 'account_login_start',
          params: { provider: 'openai-chatgpt', mode: 'device_code' },
        })
      ).resolves.toEqual({ ok: true, method: 'account_login_start' });

      const host = hoisted.agentProcessInstances[0]!;
      expect(host.getManagementAccountStatus).toHaveBeenCalledOnce();
      expect(host.callManagementAdmin).toHaveBeenCalledWith('account_login_start', {
        provider: 'openai-chatgpt',
        mode: 'device_code',
      });
    });

    it.each([
      { method: 'account_login_start', params: { provider: 'openai', mode: 'api_key', api_key: 'secret' } },
      { method: 'account_logout', params: { provider: 'openai' } },
      { method: 'account_refresh', params: { provider: 'anthropic' } },
      { method: 'account_select', params: { provider: 'openai-chatgpt' } },
    ])('denies non-Codex or non-durable account mutation $method', async (request) => {
      const { pm } = makePm({ durableLocalCodexAccountMutations: true });

      await expect(pm.mutateManagement(request)).rejects.toThrow('Only durable ChatGPT OAuth');
      const host = hoisted.agentProcessInstances[0]!;
      expect(host.getManagementAccountStatus).not.toHaveBeenCalled();
      expect(host.callManagementAdmin).not.toHaveBeenCalled();
    });

    it('gates MCP mutations on Electron topology, runtime durability, and ownership preparation', async () => {
      const prepare = vi.fn();
      const { pm } = makePm({ durableLocalMcpMutations: true, prepareLocalMcpOwnership: prepare });
      await pm.ensureManagementConnection();
      const host = hoisted.agentProcessInstances[0]!;
      host.getStatus.mockReturnValue({ type: 'running', timestamp: Date.now() });

      await expect(
        pm.mutateManagement({
          method: 'mcp_create_server',
          params: { server_name: 'github', type: 'http', params: { url: 'https://mcp.test' } },
        })
      ).resolves.toEqual({ ok: true, method: 'mcp_create_server' });

      expect(host.getManagementMcpStatus).toHaveBeenCalledOnce();
      expect(prepare).toHaveBeenCalledOnce();
      expect(host.callManagementAdmin).toHaveBeenNthCalledWith(1, 'mcp_create_server', {
        server_name: 'github',
        type: 'http',
        params: { url: 'https://mcp.test' },
      });
      expect(host.callManagementAdmin).toHaveBeenNthCalledWith(2, 'mcp_reload_server', {});
    });

    it('does not let MCP or global methods borrow one another topology gates', async () => {
      const noMcp = makePm({ durableLocalCodexAccountMutations: true }).pm;
      await expect(
        noMcp.mutateManagement({ method: 'mcp_delete_server', params: { server_name: 'github' } })
      ).rejects.toThrow('outside local single-user Electron');

      const noAccount = makePm({ durableLocalMcpMutations: true }).pm;
      await expect(
        noAccount.mutateManagement({ method: 'account_logout', params: { provider: 'openai-chatgpt' } })
      ).rejects.toThrow('outside local single-user Electron');

      await expect(
        noAccount.mutateManagement({ method: 'write_config', params: { updates: { enabled: true } } })
      ).resolves.toEqual({ ok: true, method: 'write_config' });
    });

    it('rejects managed omni-projects mutations before invoking the runtime', async () => {
      const { pm } = makePm({ durableLocalMcpMutations: true });
      await expect(
        pm.mutateManagement({ method: 'mcp_delete_server', params: { server_name: 'omni-projects' } })
      ).rejects.toThrow('managed by Omni Desktop');
      const host = hoisted.agentProcessInstances[0]!;
      expect(host.getManagementMcpStatus).not.toHaveBeenCalled();
      expect(host.callManagementAdmin).not.toHaveBeenCalled();
    });

    it('requires the complete runtime MCP durability attestation', async () => {
      const { pm } = makePm({ durableLocalMcpMutations: true });
      await pm.ensureManagementConnection();
      const host = hoisted.agentProcessInstances[0]!;
      host.getManagementMcpStatus.mockResolvedValue({
        servers: [],
        mutation_persistence: {
          user_config: { durable: true, scope: 'host' },
          oauth_tokens: { durable: false, scope: null },
          managed_servers: ['omni-projects'],
        },
      });
      await expect(
        pm.mutateManagement({ method: 'mcp_delete_server', params: { server_name: 'github' } })
      ).rejects.toThrow('did not attest durable host-scoped MCP');
      expect(host.callManagementAdmin).not.toHaveBeenCalled();
    });

    it('stops and evicts a distinct live host when post-commit reload fails', async () => {
      const { pm } = makePm({
        storeData: { defaultProfileName: 'devbox', projects: [] },
        durableLocalMcpMutations: true,
        prepareLocalMcpOwnership: vi.fn(),
      });
      await pm.start('agent:mcp-peer', { workspaceDir: '/tmp/mcp-peer' });
      await pm.ensureManagementConnection();
      expect(hoisted.agentProcessInstances).toHaveLength(2);
      const [peer, management] = hoisted.agentProcessInstances;
      peer!.getStatus.mockReturnValue({ type: 'running', timestamp: Date.now() });
      management!.getStatus.mockReturnValue({ type: 'running', timestamp: Date.now() });
      peer!.callManagementAdmin.mockImplementation(async (method: string) => {
        if (method === 'mcp_reload_server') {
          throw new Error('peer control channel lost');
        }
        return { ok: true, method };
      });

      await expect(
        pm.mutateManagement({
          method: 'mcp_update_server',
          params: { server_name: 'github', params: { url: 'https://new.test' } },
        })
      ).rejects.toThrow('mutation committed, but stale AgentHost invalidation failed');

      expect(peer!.stop).toHaveBeenCalledOnce();
      expect(management!.stop).not.toHaveBeenCalled();
      expect(pm.getStatus('agent:mcp-peer').type).toBe('uninitialized');
      expect(management!.callManagementAdmin).toHaveBeenCalledWith('mcp_reload_server', {});
    });
  });

  describe('multi-project scope (projectIds)', () => {
    const project = (id: string, sources: Project['sources']): Project => ({
      id,
      label: id,
      slug: id,
      sources,
      createdAt: 0,
    });

    it('mounts the union of scoped projects with collision-suffixed mount names', async () => {
      const projects = [
        project('p1', [{ id: 's1', mountName: 'api', kind: 'git-remote', repoUrl: 'https://github.com/acme/api.git' }]),
        project('p2', [
          { id: 's2', mountName: 'api', kind: 'git-remote', repoUrl: 'https://github.com/acme/api2.git' },
          { id: 's3', mountName: 'web', kind: 'git-remote', repoUrl: 'https://github.com/acme/web.git' },
        ]),
        // Source-less (context-only) project contributes no mounts.
        project('p3', []),
      ];
      const { pm } = makePm({ storeData: { defaultProfileName: 'devbox', projects } });
      await pm.start('agent:bob', {
        workspaceDir: '/tmp/agents/bob',
        projectIds: ['p1', 'p2', 'p3', 'missing'],
        extraSources: [{ mountName: 'home', workspaceDir: '/tmp/agents/bob' }],
      });

      const arg = hoisted.agentProcessInstances[0]!.start.mock.calls[0]![0] as {
        sources: Array<{ mountName: string }>;
        projectId?: string;
      };
      expect(arg.sources.map((s) => s.mountName)).toEqual(['api', 'api-2', 'web', 'home']);
      // projectIds starts never set the single projectId (per-project profile
      // layer and PR container matching are single-project concepts).
      expect(arg.projectId).toBeUndefined();
    });

    it('excludes projectIds processes from getProjectContainerId', async () => {
      const projects = [
        project('p1', [{ id: 's1', mountName: 'api', kind: 'git-remote', repoUrl: 'https://github.com/acme/api.git' }]),
      ];
      const { pm } = makePm({ storeData: { defaultProfileName: 'devbox', projects } });
      await pm.start('agent:bob', { workspaceDir: '/tmp/agents/bob', projectIds: ['p1'] });
      hoisted.agentProcessInstances[0]!.getStatus.mockReturnValue({
        type: 'running',
        timestamp: 1,
        data: { uiUrl: 'http://x', containerId: 'c1' },
      });

      expect(pm.getProjectContainerId('p1')).toBeNull();
    });
  });

  describe('source writability', () => {
    it('maps missing readOnly to writable and readOnly to non-writable for every source kind', async () => {
      const localDir = mkdtempSync(path.join(tmpdir(), 'omni-source-local-'));
      const localGitDir = mkdtempSync(path.join(tmpdir(), 'omni-source-git-'));
      mkdirSync(path.join(localGitDir, '.git'));
      const project: Project = {
        id: 'proj_sources',
        label: 'Sources',
        slug: 'sources',
        createdAt: 0,
        sources: [
          { id: 'local', mountName: 'local', kind: 'local', workspaceDir: localDir },
          { id: 'local-git', mountName: 'local-git', kind: 'local', workspaceDir: localGitDir, readOnly: true },
          {
            id: 'remote',
            mountName: 'remote',
            kind: 'git-remote',
            repoUrl: 'https://github.com/acme/reference.git',
            readOnly: true,
          },
        ],
      };
      const { pm } = makePm({ storeData: { projects: [project] } });

      await pm.start('tab-1', { workspaceDir: localDir, projectId: project.id });

      const arg = hoisted.agentProcessInstances[0]!.start.mock.calls[0]![0] as {
        sources: Array<{ kind: string; writable?: boolean }>;
      };
      expect(arg.sources.map(({ kind, writable }) => ({ kind, writable }))).toEqual([
        { kind: 'local', writable: true },
        { kind: 'local-git', writable: false },
        { kind: 'git-remote', writable: false },
      ]);
    });

    it('keeps project source identity while applying an isolated local workspace override', async () => {
      const declaredDir = mkdtempSync(path.join(tmpdir(), 'omni-declared-'));
      const isolatedDir = mkdtempSync(path.join(tmpdir(), 'omni-isolated-'));
      const project: Project = {
        id: 'proj_isolated',
        label: 'Isolated',
        slug: 'isolated',
        createdAt: 0,
        sources: [
          { id: 'source-primary', mountName: 'app', kind: 'local', workspaceDir: declaredDir },
          {
            id: 'source-docs',
            mountName: 'docs',
            kind: 'local',
            workspaceDir: mkdtempSync(path.join(tmpdir(), 'omni-docs-')),
          },
        ],
      };
      const { pm } = makePm({ storeData: { projects: [project] } });

      await pm.start('tab-isolated', {
        workspaceDir: isolatedDir,
        sourceOverrideDir: isolatedDir,
        projectId: project.id,
      });

      const arg = hoisted.agentProcessInstances[0]!.start.mock.calls[0]![0] as {
        sources: Array<{ id?: string; mountName: string; workspaceDir?: string }>;
      };
      expect(arg.sources).toEqual([
        expect.objectContaining({ id: 'source-primary', mountName: 'app', workspaceDir: isolatedDir }),
        expect.objectContaining({ id: 'source-docs', mountName: 'docs' }),
      ]);
      expect(arg.sources[0]!.workspaceDir).not.toBe(declaredDir);
    });

    it('publishes external Git metadata for a synthesized local worktree source', async () => {
      const primary = mkdtempSync(path.join(tmpdir(), 'omni-synth-primary-'));
      const checkout = `${primary}-checkout`;
      const cp = (await vi.importActual('node:child_process')) as typeof import('node:child_process');
      cp.execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: primary });
      cp.execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: primary });
      cp.execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: primary });
      writeFileSync(path.join(primary, 'tracked.txt'), 'tracked\n');
      cp.execFileSync('git', ['add', '-A'], { cwd: primary });
      cp.execFileSync('git', ['commit', '-qm', 'init'], { cwd: primary });
      cp.execFileSync('git', ['worktree', 'add', '-q', '-b', 'feature', checkout], { cwd: primary });
      const { pm } = makePm();

      await pm.start('tab-worktree', { workspaceDir: checkout });

      const arg = hoisted.agentProcessInstances[0]!.start.mock.calls[0]![0] as {
        sources: Array<{ kind: string; gitDir?: string; gitCommonDir?: string }>;
      };
      expect(arg.sources[0]).toMatchObject({
        kind: 'local-git',
        gitDir: path.join(primary, '.git', 'worktrees', path.basename(checkout)),
        gitCommonDir: path.join(primary, '.git'),
      });
    });
  });

  describe('getStatus', () => {
    it('returns uninitialized for unknown processId', () => {
      const { pm } = makePm();
      const status = pm.getStatus('unknown-id');
      expect(status.type).toBe('uninitialized');
    });

    it('returns status from AgentProcess when process exists', async () => {
      const { pm } = makePm();
      await pm.start('proc-1', { workspaceDir: '/tmp' });

      const mockStatus: WithTimestamp<AgentProcessStatus> = {
        type: 'running',
        timestamp: 1000,
        data: { wsUrl: 'ws://localhost:9000/ws', uiUrl: 'http://localhost:9000' },
      };
      hoisted.agentProcessInstances[0]!.getStatus.mockReturnValue(mockStatus);

      expect(pm.getStatus('proc-1')).toMatchObject({
        ...mockStatus,
        data: {
          ...mockStatus.data,
          workspaceId: expect.stringMatching(/^workspace_/),
          environmentId: expect.stringMatching(/^environment-workspace_/),
        },
      });
    });
  });

  describe('getRunningWsUrlForTicket', () => {
    it('returns null when no code tabs match the ticketId', () => {
      const { pm } = makePm();
      const result = pm.getRunningWsUrlForTicket('ticket-1', [{ id: 'tab-1', ticketId: 'ticket-2' }, { id: 'tab-2' }]);
      expect(result).toBeNull();
    });

    it('returns null when matching tab has no process', () => {
      const { pm } = makePm();
      const result = pm.getRunningWsUrlForTicket('ticket-1', [{ id: 'tab-1', ticketId: 'ticket-1' }]);
      expect(result).toBeNull();
    });

    it('returns wsUrl when matching tab has a running process', async () => {
      const { pm } = makePm();
      await pm.start('tab-1', { workspaceDir: '/tmp' });

      hoisted.agentProcessInstances[0]!.getStatus.mockReturnValue({
        type: 'running',
        timestamp: 1000,
        data: { wsUrl: 'ws://localhost:9000/ws', uiUrl: 'http://localhost:9000' },
      });

      const result = pm.getRunningWsUrlForTicket('ticket-1', [{ id: 'tab-1', ticketId: 'ticket-1' }]);
      expect(result).toBe('ws://localhost:9000/ws');
    });

    it('returns null when matching tab process is not running', async () => {
      const { pm } = makePm();
      await pm.start('tab-1', { workspaceDir: '/tmp' });

      hoisted.agentProcessInstances[0]!.getStatus.mockReturnValue({
        type: 'starting',
        timestamp: 1000,
      });

      const result = pm.getRunningWsUrlForTicket('ticket-1', [{ id: 'tab-1', ticketId: 'ticket-1' }]);
      expect(result).toBeNull();
    });
  });

  describe('lifecycle', () => {
    it('does not start a session AgentHost until the runtime install overlay finishes', async () => {
      let finishInstall!: () => void;
      const install = new Promise<void>((resolve) => {
        finishInstall = resolve;
      });
      const waitForRuntimeInstall = vi.fn(() => install);
      const { pm } = makePm({ waitForRuntimeInstall });

      const starting = pm.start('proc-1', { workspaceDir: '/tmp' });
      await vi.waitFor(() => expect(waitForRuntimeInstall).toHaveBeenCalledOnce());
      expect(hoisted.agentProcessInstances).toHaveLength(0);

      finishInstall();
      await starting;
      expect(hoisted.agentProcessInstances).toHaveLength(1);
      expect(hoisted.agentProcessInstances[0]!.start).toHaveBeenCalledOnce();
    });

    it('shares one in-flight start transaction for duplicate first intent', async () => {
      const { pm } = makePm({ storeData: { defaultProfileName: 'devbox' } });
      let release!: () => void;
      hoisted.configureConsumerGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const opts = {
        workspaceDir: '/tmp/ws',
        profileNameOverride: 'host',
        sessionId: 'session-1',
        snapshotRef: 'snapshot-1',
      };

      const first = pm.start('proc-1', opts);
      const duplicate = pm.start('proc-1', { ...opts });

      expect(duplicate).toBe(first);
      await vi.waitFor(() => expect(hoisted.agentProcessInstances).toHaveLength(1));
      const host = hoisted.agentProcessInstances[0]!;
      await vi.waitFor(() => expect(host.configureConsumer).toHaveBeenCalledTimes(1));
      expect(host.start).toHaveBeenCalledTimes(1);

      release();
      await Promise.all([first, duplicate]);
      expect(host.configureConsumer).toHaveBeenCalledTimes(1);
    });

    it('invalidates and retires a materialization when stop wins the race', async () => {
      const { pm } = makePm();
      let release!: () => void;
      hoisted.configureConsumerGate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const starting = pm.start('proc-race', { workspaceDir: '/tmp/race' });
      await vi.waitFor(() => expect(hoisted.agentProcessInstances[0]?.configureConsumer).toHaveBeenCalledTimes(1));
      const host = hoisted.agentProcessInstances[0]!;
      const stopping = pm.stop('proc-race');
      expect(host.stopConsumerEnvironment).not.toHaveBeenCalled();

      release();
      await Promise.all([starting, stopping]);

      expect(host.stopConsumerEnvironment).toHaveBeenCalledWith(expect.objectContaining({ environmentGeneration: 3 }));
      expect(host.stop).toHaveBeenCalledTimes(1);
      expect(pm.getStatus('proc-race').type).toBe('uninitialized');
    });

    it('cleanup invalidates and drains a pending materialization', async () => {
      const { pm } = makePm();
      let release!: () => void;
      hoisted.configureConsumerGate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const starting = pm.start('proc-cleanup-race', { workspaceDir: '/tmp/race' });
      await vi.waitFor(() => expect(hoisted.agentProcessInstances[0]?.configureConsumer).toHaveBeenCalledTimes(1));
      const host = hoisted.agentProcessInstances[0]!;
      const cleanup = pm.cleanup();
      await Promise.resolve();
      expect(host.stopConsumerEnvironment).not.toHaveBeenCalled();

      release();
      await Promise.all([starting, cleanup]);

      expect(host.stopConsumerEnvironment).toHaveBeenCalledTimes(1);
      expect(host.stop).toHaveBeenCalledTimes(1);
      expect(pm.getStatus('proc-cleanup-race').type).toBe('uninitialized');
    });

    it('publishes only the newest intent when workspace changes during materialization', async () => {
      const { pm, sendCalls } = makePm();
      let release!: () => void;
      hoisted.configureConsumerGate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const first = pm.start('proc-newer-intent', { workspaceDir: '/tmp/first' });
      await vi.waitFor(() => expect(hoisted.agentProcessInstances[0]?.configureConsumer).toHaveBeenCalledTimes(1));
      const staleHost = hoisted.agentProcessInstances[0]!;
      const staleWorkspaceId = staleHost.configureConsumer.mock.calls[0]![1];
      const second = pm.start('proc-newer-intent', { workspaceDir: '/tmp/second' });

      release();
      await Promise.all([first, second]);

      expect(hoisted.agentProcessInstances).toHaveLength(2);
      expect(staleHost.stopConsumerEnvironment).toHaveBeenCalledTimes(1);
      expect(staleHost.stop).toHaveBeenCalledTimes(1);
      const currentHost = hoisted.agentProcessInstances[1]!;
      currentHost.getStatus.mockReturnValue({
        type: 'running',
        data: { wsUrl: 'ws://localhost/ws', uiUrl: 'http://localhost' },
        timestamp: Date.now(),
      } satisfies WithTimestamp<AgentProcessStatus>);
      expect(pm.getProcessWorkspaceDir('proc-newer-intent')).toBe('/tmp/second');
      expect(pm.getStatus('proc-newer-intent')).toMatchObject({
        type: 'running',
        data: { workspaceId: currentHost.configureConsumer.mock.calls[0]![1] },
      });
      expect(
        sendCalls.some(
          ({ channel, args }) =>
            channel === 'agent-process:status' &&
            (args[1] as { data?: { workspaceId?: string } })?.data?.workspaceId === staleWorkspaceId
        )
      ).toBe(false);
    });

    it('start creates an AgentProcess and calls start', async () => {
      const { pm } = makePm();
      await pm.start('proc-1', { workspaceDir: '/tmp/ws' });

      expect(hoisted.agentProcessInstances).toHaveLength(1);
      expect(hoisted.agentProcessInstances[0]!.start).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceDir: '/tmp/ws' })
      );
    });

    it('detaches a failed consumer so a retry gets a clean host', async () => {
      const { pm } = makePm();
      hoisted.configureConsumerFailure = 'binding failed';
      await expect(pm.start('proc-1', { workspaceDir: '/tmp/ws' })).rejects.toThrow('binding failed');
      const createdHost = hoisted.agentProcessInstances[0]!;
      expect(createdHost.stop).toHaveBeenCalledTimes(1);
      expect(pm.getStatus('proc-1').type).toBe('uninitialized');

      hoisted.configureConsumerFailure = null;
      await pm.start('proc-1', { workspaceDir: '/tmp/ws' });
      expect(hoisted.agentProcessInstances).toHaveLength(2);
    });

    it('start rebinds a consumer in the same host when its workspace changes', async () => {
      const { pm } = makePm();
      await pm.start('proc-1', { workspaceDir: '/tmp/ws' });
      const host = hoisted.agentProcessInstances[0]!;
      const firstWorkspaceId = host.configureConsumer.mock.calls[0]![1] as string;
      host.getStatus.mockReturnValue({
        type: 'running',
        data: { wsUrl: 'ws://localhost:9000/ws', uiUrl: 'http://localhost:9000' },
        timestamp: Date.now(),
      } satisfies WithTimestamp<AgentProcessStatus>);
      await pm.start('proc-1', { workspaceDir: '/tmp/ws2' });

      expect(hoisted.agentProcessInstances).toHaveLength(1);
      expect(host.exit).not.toHaveBeenCalled();
      expect(host.start).toHaveBeenCalledTimes(1);
      expect(host.configureConsumer).toHaveBeenCalledTimes(2);
      const secondWorkspaceId = host.configureConsumer.mock.calls[1]![1] as string;
      expect(secondWorkspaceId).not.toBe(firstWorkspaceId);
      expect(host.stopConsumerEnvironment).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: firstWorkspaceId,
          environmentId: `environment-${firstWorkspaceId}`,
          environmentGeneration: 3,
        })
      );
      expect(pm.getProcessWorkspaceDir('proc-1')).toBe('/tmp/ws2');
    });

    it('preserves the prior Workspace binding when a same-host rebind fails', async () => {
      const { pm } = makePm();
      await pm.start('proc-1', { workspaceDir: '/tmp/ws' });
      const host = hoisted.agentProcessInstances[0]!;
      const firstWorkspaceId = host.configureConsumer.mock.calls[0]![1] as string;
      host.getStatus.mockReturnValue({
        type: 'running',
        data: { wsUrl: 'ws://localhost:9000/ws', uiUrl: 'http://localhost:9000' },
        timestamp: Date.now(),
      } satisfies WithTimestamp<AgentProcessStatus>);
      hoisted.configureConsumerFailure = 'new workspace failed';

      await expect(pm.start('proc-1', { workspaceDir: '/tmp/ws2' })).rejects.toThrow('new workspace failed');

      expect(pm.getStatus('proc-1')).toMatchObject({
        type: 'running',
        data: { workspaceId: firstWorkspaceId, environmentId: `environment-${firstWorkspaceId}` },
      });
      expect(pm.getProcessWorkspaceDir('proc-1')).toBe('/tmp/ws');
      expect(host.stopConsumerEnvironment).not.toHaveBeenCalled();
      expect(host.stop).not.toHaveBeenCalled();
    });

    it('compatible tabs attach to one running agent host', async () => {
      const { pm, sendCalls } = makePm();
      await pm.start('tab-a', { workspaceDir: '/tmp/ws', projectId: 'project-1', sessionId: 'thread-a' });
      const host = hoisted.agentProcessInstances[0]!;
      host.getStatus.mockReturnValue({
        type: 'running',
        data: { wsUrl: 'ws://localhost:9000/ws', uiUrl: 'http://localhost:9000' },
        timestamp: Date.now(),
      } satisfies WithTimestamp<AgentProcessStatus>);

      await pm.start('tab-b', { workspaceDir: '/tmp/ws', projectId: 'project-1', sessionId: 'thread-b' });

      expect(hoisted.agentProcessInstances).toHaveLength(1);
      expect(host.start).toHaveBeenCalledTimes(1);
      expect(pm.getStatus('tab-b')).toMatchObject({ type: 'running' });

      const updated = {
        ...host.getStatus(),
        timestamp: Date.now() + 1,
      } as WithTimestamp<AgentProcessStatus>;
      host.emitStatus(updated);
      const recipients = sendCalls
        .filter(
          (call) =>
            call.channel === 'agent-process:status' &&
            (call.args[1] as WithTimestamp<AgentProcessStatus>).timestamp === updated.timestamp
        )
        .map((call) => call.args[0]);
      expect(recipients).toEqual(['tab-a', 'tab-b']);
    });

    it("does not expose another consumer's runtime while a pooled environment is materializing", async () => {
      const { pm } = makePm();
      await pm.start('tab-a', { workspaceDir: '/tmp/a' });
      const host = hoisted.agentProcessInstances[0]!;
      host.getStatus.mockReturnValue({
        type: 'running',
        data: {
          wsUrl: 'ws://localhost:9000/ws',
          uiUrl: 'http://localhost:9000',
          workspaceId: 'workspace-a',
          environmentId: 'environment-a',
        },
        timestamp: Date.now(),
      } satisfies WithTimestamp<AgentProcessStatus>);

      let finishMaterializing!: (runtime: {
        workspaceId: string;
        environmentId: string;
        services: Record<string, string>;
      }) => void;
      host.configureConsumer.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishMaterializing = resolve;
          })
      );
      const starting = pm.start('tab-b', { workspaceDir: '/tmp/b' });
      await vi.waitFor(() => expect(host.configureConsumer).toHaveBeenCalledTimes(2));

      expect(pm.getStatus('tab-b')).toMatchObject({ type: 'starting' });
      expect(pm.getStatus('tab-b')).not.toHaveProperty('data');

      finishMaterializing({ workspaceId: 'workspace-b', environmentId: 'environment-b', services: {} });
      await starting;
      expect(pm.getStatus('tab-b')).toMatchObject({
        type: 'running',
        data: { workspaceId: 'workspace-b', environmentId: 'environment-b' },
      });
      const tabAWorkspaceId = host.configureConsumer.mock.calls[0]![1] as string;
      expect(pm.getProcessContainerId('tab-a')).toBe(`container-${tabAWorkspaceId}`);
      expect(pm.getProcessContainerId('tab-b')).toBeNull();
      expect(pm.getContainerOwners()).toEqual([{ processId: 'tab-a', containerId: `container-${tabAWorkspaceId}` }]);
    });

    it('stopping one compatible tab leaves the shared host running', async () => {
      const { pm } = makePm();
      await pm.start('tab-a', { workspaceDir: '/tmp/ws', projectId: 'project-1' });
      const host = hoisted.agentProcessInstances[0]!;
      host.getStatus.mockReturnValue({
        type: 'running',
        data: { wsUrl: 'ws://localhost:9000/ws', uiUrl: 'http://localhost:9000' },
        timestamp: Date.now(),
      } satisfies WithTimestamp<AgentProcessStatus>);
      await pm.start('tab-b', { workspaceDir: '/tmp/ws', projectId: 'project-1' });
      const tabAWorkspaceId = host.configureConsumer.mock.calls[0]![1] as string;
      await pm.stop('tab-a');
      expect(host.stop).not.toHaveBeenCalled();
      expect(host.stopConsumerEnvironment).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: tabAWorkspaceId,
          environmentId: `environment-${tabAWorkspaceId}`,
          environmentGeneration: 3,
        })
      );
      expect(pm.getStatus('tab-a').type).toBe('uninitialized');
      expect(pm.getStatus('tab-b').type).toBe('running');

      await pm.stop('tab-b');
      expect(host.stop).toHaveBeenCalledTimes(1);
    });

    it('keeps a consumer bound until environment stop completes and cleanup drains it', async () => {
      const { pm } = makePm();
      await pm.start('tab-a', { workspaceDir: '/tmp/a' });
      const host = hoisted.agentProcessInstances[0]!;
      host.getStatus.mockReturnValue({
        type: 'running',
        data: { wsUrl: 'ws://localhost:9000/ws', uiUrl: 'http://localhost:9000' },
        timestamp: Date.now(),
      } satisfies WithTimestamp<AgentProcessStatus>);
      await pm.start('tab-b', { workspaceDir: '/tmp/b' });

      let finishStop!: () => void;
      host.stopConsumerEnvironment.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishStop = resolve;
          })
      );
      const stopping = pm.stop('tab-a');
      await vi.waitFor(() => expect(host.stopConsumerEnvironment).toHaveBeenCalledTimes(1));
      expect(pm.getStatus('tab-a').type).toBe('running');

      const cleanup = pm.cleanup();
      await Promise.resolve();
      expect(host.exit).not.toHaveBeenCalled();
      finishStop();
      await stopping;
      await cleanup;

      expect(pm.getStatus('tab-a').type).toBe('uninitialized');
      expect(host.exit).toHaveBeenCalledTimes(1);
    });

    it('rebuilds one tab environment without restarting its shared host', async () => {
      const { pm } = makePm();
      await pm.start('tab-a', { workspaceDir: '/tmp/a' });
      const host = hoisted.agentProcessInstances[0]!;
      const tabAWorkspaceId = host.configureConsumer.mock.calls[0]![1] as string;
      host.getStatus.mockReturnValue({
        type: 'running',
        data: { wsUrl: 'ws://localhost:9000/ws', uiUrl: 'http://localhost:9000' },
        timestamp: Date.now(),
      } satisfies WithTimestamp<AgentProcessStatus>);
      await pm.start('tab-b', { workspaceDir: '/tmp/b' });

      let finishRebuild!: (runtime: {
        workspaceId: string;
        environmentId: string;
        services: Record<string, string>;
        containerId: string;
      }) => void;
      host.configureConsumer.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRebuild = resolve;
          })
      );
      const rebuilding = pm.rebuild('tab-a', { workspaceDir: '/tmp/a' });
      await vi.waitFor(() =>
        expect(host.stopConsumerEnvironment).toHaveBeenCalledWith(
          expect.objectContaining({
            workspaceId: tabAWorkspaceId,
            environmentId: `environment-${tabAWorkspaceId}`,
            environmentGeneration: 3,
          })
        )
      );
      expect(pm.getStatus('tab-a')).toMatchObject({ type: 'starting' });
      expect(pm.getStatus('tab-a')).not.toHaveProperty('data');
      expect(pm.getStatus('tab-b')).toMatchObject({
        type: 'running',
        data: { environmentId: expect.stringMatching(/^environment-/) },
      });
      finishRebuild({
        workspaceId: 'workspace-a',
        environmentId: 'environment-rebuilt',
        services: {},
        containerId: 'container-rebuilt',
      });
      await rebuilding;

      expect(host.rebuild).not.toHaveBeenCalled();
      expect(host.stopConsumerEnvironment).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: tabAWorkspaceId,
          environmentId: `environment-${tabAWorkspaceId}`,
          environmentGeneration: 3,
        })
      );
      expect(host.configureConsumer).toHaveBeenLastCalledWith(
        'tab-a',
        expect.stringMatching(/^workspace_/),
        expect.objectContaining({ workspaceDir: '/tmp/a' })
      );
      expect(host.stopConsumerEnvironment.mock.invocationCallOrder.at(-1)).toBeLessThan(
        host.configureConsumer.mock.invocationCallOrder.at(-1)!
      );
    });

    it('rebinds one tab profile without mutating a host shared by two tabs', async () => {
      const { pm } = makePm();
      await pm.start('tab-a', { workspaceDir: '/tmp/ws', projectId: 'project-1' });
      const host = hoisted.agentProcessInstances[0]!;
      host.getStatus.mockReturnValue({
        type: 'running',
        data: { wsUrl: 'ws://localhost:9000/ws', uiUrl: 'http://localhost:9000' },
        timestamp: Date.now(),
      } satisfies WithTimestamp<AgentProcessStatus>);
      await pm.start('tab-b', { workspaceDir: '/tmp/ws', projectId: 'project-1' });
      const tabAWorkspaceId = host.configureConsumer.mock.calls[0]![1] as string;
      host.configureConsumer.mockImplementationOnce(async () => ({
        workspaceId: tabAWorkspaceId,
        environmentId: 'environment-rebound',
        services: {},
      }));

      await expect(pm.switchSandbox('tab-a', 'devbox')).resolves.toMatchObject({ ok: true, profile: 'devbox' });
      expect(host.configureConsumer).toHaveBeenCalledWith(
        'tab-a',
        expect.stringMatching(/^workspace_/),
        expect.objectContaining({ profileName: 'devbox' })
      );
      expect(host.stopConsumerEnvironment).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: tabAWorkspaceId,
          environmentId: `environment-${tabAWorkspaceId}`,
          environmentGeneration: 3,
        })
      );
    });

    it('routes lifecycle calls and snapshot discard to the selected consumer environment', async () => {
      const { pm } = makePm();
      await pm.start('tab-a', { workspaceDir: '/tmp/ws' });
      const host = hoisted.agentProcessInstances[0]!;
      const workspaceId = host.configureConsumer.mock.calls[0]![1] as string;
      const environmentId = `environment-${workspaceId}`;
      host.getStatus.mockReturnValue({
        type: 'running',
        data: { wsUrl: 'ws://localhost:9000/ws', uiUrl: 'http://localhost:9000' },
        timestamp: Date.now(),
      } satisfies WithTimestamp<AgentProcessStatus>);

      await expect(pm.pause('tab-a')).resolves.toMatchObject({ ok: true, paused: true });
      expect(host.pause).toHaveBeenCalledWith(expect.objectContaining({ environmentId, environmentGeneration: 3 }));
      expect(pm.getStatus('tab-a')).toMatchObject({ data: { paused: true } });

      await expect(pm.unpause('tab-a')).resolves.toMatchObject({ ok: true, paused: false });
      expect(host.unpause).toHaveBeenCalledWith(expect.objectContaining({ environmentId, environmentGeneration: 3 }));
      pm.notifyActivity('tab-a');
      expect(host.notifyActivity).toHaveBeenCalledWith(
        expect.objectContaining({ environmentId, environmentGeneration: 3 })
      );

      await pm.stop('tab-a', { discardSnapshot: true });
      expect(host.discardConsumerSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ environmentId, environmentGeneration: 3 })
      );
      expect(host.stop).toHaveBeenCalledTimes(1);
    });

    it('keeps an exclusively attached host after a profile rebind', async () => {
      const { pm } = makePm();
      await pm.start('tab-a', { workspaceDir: '/tmp/ws', projectId: 'project-1' });
      const host = hoisted.agentProcessInstances[0]!;
      host.getStatus.mockReturnValue({
        type: 'running',
        data: { wsUrl: 'ws://localhost:9000/ws', uiUrl: 'http://localhost:9000' },
        timestamp: Date.now(),
      } satisfies WithTimestamp<AgentProcessStatus>);

      await expect(pm.switchSandbox('tab-a', 'devbox')).resolves.toMatchObject({ ok: true });
      await pm.start('tab-b', {
        workspaceDir: '/tmp/ws',
        projectId: 'project-1',
        profileNameOverride: 'devbox',
      });

      expect(hoisted.agentProcessInstances).toHaveLength(1);
      expect(host.configureConsumer).toHaveBeenCalledWith(
        'tab-a',
        expect.stringMatching(/^workspace_/),
        expect.objectContaining({ profileName: 'devbox' })
      );
      expect(host.start).toHaveBeenCalledTimes(1);
    });

    it('start creates new process when mode changes', async () => {
      const storeData: ProcessManagerStoreData = {
        defaultProfileName: 'host',
        projects: [],
      };
      const pm = new ProcessManager({
        sendToWindow: (() => {}) as never,
        getStoreData: () => storeData,
      });

      await pm.start('proc-1', { workspaceDir: '/tmp' });
      expect(hoisted.agentProcessInstances).toHaveLength(1);
      expect(hoisted.agentProcessInstances[0]!.mode).toBe('serve');

      // Flip to platform profile — different mode (compute) → new instance
      storeData.defaultProfileName = 'platform';
      await pm.start('proc-1', { workspaceDir: '/tmp' });

      expect(hoisted.agentProcessInstances).toHaveLength(2);
      expect(hoisted.agentProcessInstances[1]!.mode).toBe('compute');
      expect(hoisted.agentProcessInstances[0]!.exit).toHaveBeenCalled();
    });

    it('start adopts a live process instead of restarting it', async () => {
      const { pm, sendCalls } = makePm();
      await pm.start('proc-1', { workspaceDir: '/tmp/ws', sessionId: 's1' });

      const proc = hoisted.agentProcessInstances[0]!;
      const running: WithTimestamp<AgentProcessStatus> = {
        type: 'running',
        data: { wsUrl: 'ws://localhost:9000/ws', uiUrl: 'http://localhost:9000' },
        timestamp: Date.now(),
      };
      proc.getStatus.mockReturnValue(running);

      // A reconnected renderer re-issues start for the same launch.
      await pm.start('proc-1', { workspaceDir: '/tmp/ws', sessionId: 's1' });

      expect(proc.start).toHaveBeenCalledTimes(1);
      expect(sendCalls.filter((c) => c.channel === 'agent-process:status')).toHaveLength(2);
    });

    it('a different conversation on the same Workspace retains its Workspace identity', async () => {
      const { pm } = makePm();
      await pm.start('proc-1', { workspaceDir: '/tmp/ws', sessionId: 's1' });

      const proc = hoisted.agentProcessInstances[0]!;
      proc.getStatus.mockReturnValue({
        type: 'running',
        data: { wsUrl: 'ws://localhost:9000/ws', uiUrl: 'http://localhost:9000' },
        timestamp: Date.now(),
      } satisfies WithTimestamp<AgentProcessStatus>);

      await pm.start('proc-1', { workspaceDir: '/tmp/ws', sessionId: 's2' });

      expect(proc.start).toHaveBeenCalledTimes(1);
      expect(proc.configureConsumer.mock.calls[1]![1]).toBe(proc.configureConsumer.mock.calls[0]![1]);
      expect(proc.stopConsumerEnvironment).not.toHaveBeenCalled();
    });

    it('stop removes process from map', async () => {
      const { pm } = makePm();
      await pm.start('proc-1', { workspaceDir: '/tmp' });

      await expect(pm.stop('proc-1')).resolves.toEqual({
        scope: 'host',
        shutdown: 'graceful',
        snapshotPersistence: 'complete',
        pendingSnapshotRefs: [],
      });

      expect(hoisted.agentProcessInstances[0]!.stop).toHaveBeenCalled();
      expect(pm.getStatus('proc-1').type).toBe('uninitialized');
    });

    it('cleanup exits all processes', async () => {
      const { pm } = makePm();
      await pm.start('a', { workspaceDir: '/tmp/a' });
      await pm.start('b', { workspaceDir: '/tmp/b' });

      await pm.cleanup();

      expect(hoisted.agentProcessInstances).toHaveLength(1);
      expect(hoisted.agentProcessInstances[0]!.exit).toHaveBeenCalled();
      expect(pm.getStatus('a').type).toBe('uninitialized');
      expect(pm.getStatus('b').type).toBe('uninitialized');
    });
  });

  describe('git-remote auth', () => {
    const gitProject = (): Project => ({
      id: 'proj_git',
      label: 'Git',
      slug: 'git',
      createdAt: 0,
      sources: [{ id: 'src1', mountName: 'svc', kind: 'git-remote', repoUrl: 'https://github.com/acme/private.git' }],
    });
    const cred: GitCredential = {
      id: 'cred-123',
      host: 'github.com',
      username: 'x-access-token',
      last4: 'beef',
      createdAt: 0,
    };

    afterEach(() => {
      // Reset the stubbed git-remote lookup so it doesn't leak between tests.
      vi.mocked(execFileSync).mockReset();
    });

    it('attaches auth + injects the token env when a host credential matches', async () => {
      const { pm } = makePm({
        storeData: { projects: [gitProject()], gitCredentials: [cred] },
        resolveGitToken: async (id) => (id === 'cred-123' ? 'ghp_thetoken' : undefined),
      });
      await pm.start('proc-1', { workspaceDir: '/tmp', projectId: 'proj_git' });

      const startArg = hoisted.agentProcessInstances[0]!.start.mock.calls[0]![0] as {
        sources: Array<{ kind: string; auth?: { tokenEnv: string; username: string } }>;
        gitTokenEnv?: Record<string, string>;
        credentials?: Array<{ url: string; username: string; tokenEnv: string }>;
      };
      const envName = gitTokenEnvName('cred-123');
      expect(startArg.sources[0]!.auth).toEqual({ tokenEnv: envName, username: 'x-access-token' });
      expect(startArg.gitTokenEnv).toEqual({ [envName]: 'ghp_thetoken' });
      // Boot-time bundle: one descriptor for the git-remote host (no token value).
      expect(startArg.credentials).toEqual([
        { url: 'https://github.com/acme/private.git', username: 'x-access-token', tokenEnv: envName },
      ]);
    });

    it('builds a credential for a local-git checkout from its own remote (no clone auth hint)', async () => {
      // Real temp git repo with a real origin remote so directoryHasGit() and
      // resolveGitRemote() (both real, via uninstrumented fs/git) resolve without
      // relying on module-mock propagation into the source under test.
      const checkout = mkdtempSync(path.join(tmpdir(), 'omni-localgit-'));
      const cp = (await vi.importActual('node:child_process')) as typeof import('node:child_process');
      cp.execFileSync('git', ['init', '-q'], { cwd: checkout });
      cp.execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/private.git'], { cwd: checkout });
      const localProject: Project = {
        id: 'proj_local',
        label: 'Local',
        slug: 'local',
        createdAt: 0,
        sources: [{ id: 'src1', mountName: 'svc', kind: 'local', workspaceDir: checkout }],
      };
      const { pm } = makePm({
        storeData: { projects: [localProject], gitCredentials: [cred] },
        resolveGitToken: async (id) => (id === 'cred-123' ? 'ghp_thetoken' : undefined),
      });
      await pm.start('proc-1', { workspaceDir: checkout, projectId: 'proj_local' });

      const startArg = hoisted.agentProcessInstances[0]!.start.mock.calls[0]![0] as {
        sources: Array<{ kind: string; auth?: unknown }>;
        gitTokenEnv?: Record<string, string>;
        credentials?: Array<{ url: string; username: string; tokenEnv: string }>;
      };
      const envName = gitTokenEnvName('cred-123');
      expect(startArg.sources[0]!.kind).toBe('local-git');
      // local-git is seeded by archive, not cloned → no clone-time auth hint…
      expect(startArg.sources[0]!.auth).toBeUndefined();
      // …but the token + boot-time credential are still injected for git/gh/az.
      expect(startArg.gitTokenEnv).toEqual({ [envName]: 'ghp_thetoken' });
      expect(startArg.credentials).toEqual([
        { url: 'https://github.com/acme/private.git', username: 'x-access-token', tokenEnv: envName },
      ]);
    });

    it('leaves the source unauthenticated when no credential matches the host', async () => {
      const { pm } = makePm({
        storeData: { projects: [gitProject()], gitCredentials: [{ ...cred, host: 'gitlab.com' }] },
        resolveGitToken: async () => 'unused',
      });
      await pm.start('proc-1', { workspaceDir: '/tmp', projectId: 'proj_git' });

      const startArg = hoisted.agentProcessInstances[0]!.start.mock.calls[0]![0] as {
        sources: Array<{ auth?: unknown }>;
        gitTokenEnv?: Record<string, string>;
      };
      expect(startArg.sources[0]!.auth).toBeUndefined();
      expect(startArg.gitTokenEnv).toBeUndefined();
    });
  });
});
