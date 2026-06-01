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
  agentProcessInstances: [] as Array<{
    mode: string;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    exit: ReturnType<typeof vi.fn>;
    rebuild: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
    resizePty: ReturnType<typeof vi.fn>;
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

    constructor(opts: { mode: string }) {
      this.mode = opts.mode;
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

import { ProcessManager, type ProcessManagerStoreData } from '@/main/process-manager';
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

describe('ProcessManager', () => {
  beforeEach(() => {
    hoisted.agentProcessInstances = [];
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

      expect(pm.getStatus('proc-1')).toBe(mockStatus);
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

    it('start reuses existing process on same mode', async () => {
      const { pm } = makePm();
      await pm.start('proc-1', { workspaceDir: '/tmp/ws' });
      await pm.start('proc-1', { workspaceDir: '/tmp/ws2' });

      expect(hoisted.agentProcessInstances).toHaveLength(1);
      expect(hoisted.agentProcessInstances[0]!.start).toHaveBeenCalledTimes(2);
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

      expect(hoisted.agentProcessInstances[0]!.exit).toHaveBeenCalled();
      expect(hoisted.agentProcessInstances[1]!.exit).toHaveBeenCalled();
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
