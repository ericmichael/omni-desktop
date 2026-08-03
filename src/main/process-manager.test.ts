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
  agentProcessInstances: [] as Array<{
    mode: string;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    exit: ReturnType<typeof vi.fn>;
    rebuild: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
    resizePty: ReturnType<typeof vi.fn>;
    switchSandbox: ReturnType<typeof vi.fn>;
    configureConsumer: ReturnType<typeof vi.fn>;
    stopConsumerEnvironment: ReturnType<typeof vi.fn>;
    emitStatus: (status: WithTimestamp<AgentProcessStatus>) => void;
  }>,
}));

vi.mock('@/main/agent-process', () => ({
  AgentProcess: class MockAgentProcess {
    mode: string;
    start = vi.fn();
    stop = vi.fn(async () => {});
    exit = vi.fn(async () => {});
    rebuild = vi.fn(async () => {});
    getStatus = vi.fn(() => ({ type: 'uninitialized', timestamp: Date.now() }));
    resizePty = vi.fn();
    switchSandbox = vi.fn(async () => ({ ok: true }));
    configureConsumer = vi.fn(
      async (_threadId: string, workspaceId: string, _arg: unknown, useStartupEnvironment: boolean) => {
        if (hoisted.configureConsumerFailure) {
          throw new Error(hoisted.configureConsumerFailure);
        }
        return {
          workspaceId: useStartupEnvironment ? 'workspace-startup' : workspaceId,
          environmentId: useStartupEnvironment ? 'environment-startup' : `environment-${workspaceId}`,
          services: {},
          containerId: useStartupEnvironment ? 'container-startup' : `container-${workspaceId}`,
        };
      }
    );
    stopConsumerEnvironment = vi.fn(async () => {});
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
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { isLauncherOwnedDir, ProcessManager, type ProcessManagerStoreData } from '@/main/process-manager';
import { getDefaultWorkspaceDir } from '@/main/util';
import { gitTokenEnvName } from '@/shared/git-credentials';
import type { AgentProcessStatus, GitCredential, Project, WithTimestamp } from '@/shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePm(opts?: {
  storeData?: Partial<ProcessManagerStoreData>;
  resolveGitToken?: (credentialId: string) => Promise<string | undefined>;
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
          workspaceId: 'workspace-startup',
          environmentId: 'environment-startup',
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
      expect(pm.getProcessContainerId('tab-a')).toBe('container-startup');
      expect(pm.getProcessContainerId('tab-b')).toBeNull();
      expect(pm.getContainerOwners()).toEqual([{ processId: 'tab-a', containerId: 'container-startup' }]);
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

      await pm.stop('tab-a');
      expect(host.stop).not.toHaveBeenCalled();
      expect(host.stopConsumerEnvironment).toHaveBeenCalledWith('environment-startup');
      expect(pm.getStatus('tab-a').type).toBe('uninitialized');
      expect(pm.getStatus('tab-b').type).toBe('running');

      await pm.stop('tab-b');
      expect(host.stop).toHaveBeenCalledTimes(1);
    });

    it('rebuilds one tab environment without restarting its shared host', async () => {
      const { pm } = makePm();
      await pm.start('tab-a', { workspaceDir: '/tmp/a' });
      const host = hoisted.agentProcessInstances[0]!;
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
      await vi.waitFor(() => expect(host.stopConsumerEnvironment).toHaveBeenCalledWith('environment-startup'));
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
      expect(host.stopConsumerEnvironment).toHaveBeenCalledWith('environment-startup');
      expect(host.configureConsumer).toHaveBeenLastCalledWith(
        'tab-a',
        expect.stringMatching(/^workspace_/),
        expect.objectContaining({ workspaceDir: '/tmp/a' }),
        false
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

      await expect(pm.switchSandbox('tab-a', 'devbox')).resolves.toMatchObject({ ok: true, profile: 'devbox' });
      expect(host.switchSandbox).not.toHaveBeenCalled();
      expect(host.configureConsumer).toHaveBeenCalledWith(
        'tab-a',
        expect.stringMatching(/^workspace_/),
        expect.objectContaining({ profileName: 'devbox' }),
        false
      );
      expect(host.stopConsumerEnvironment).toHaveBeenCalledWith('environment-startup');
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
      expect(host.switchSandbox).not.toHaveBeenCalled();
      expect(host.configureConsumer).toHaveBeenCalledWith(
        'tab-a',
        expect.stringMatching(/^workspace_/),
        expect.objectContaining({ profileName: 'devbox' }),
        false
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

    it('a different thread on the same workspace keeps the compatible live host', async () => {
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
    });

    it('stop removes process from map', async () => {
      const { pm } = makePm();
      await pm.start('proc-1', { workspaceDir: '/tmp' });

      await pm.stop('proc-1');

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
