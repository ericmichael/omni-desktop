// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  nextChild: null as unknown,
  spawnCalls: [] as unknown[][],
  controlCalls: [] as Array<{ method: string; params: Record<string, unknown> }>,
  controlFailureMethod: null as string | null,
  snapshotPull: vi.fn(async () => false),
  snapshotPush: vi.fn(async () => {}),
}));

vi.mock('node:child_process', async () => {
  const actual = (await vi.importActual('node:child_process')) as typeof import('node:child_process');
  const spawnMock = ((...args: unknown[]) => {
    hoisted.spawnCalls.push(args);
    return hoisted.nextChild as ReturnType<typeof import('node:child_process').spawn>;
  }) as unknown as typeof import('node:child_process').spawn;
  return { ...actual, spawn: spawnMock };
});

vi.mock('@/main/util', () => ({
  ensureDirectory: vi.fn(async () => {}),
  getBundledBinPath: vi.fn(() => '/fake/bundled/bin'),
  getOmniCliPath: vi.fn(() => '/fake/bin/omni'),
  getOmniConfigDir: vi.fn(() => '/fake/config'),
  isDevelopment: vi.fn(() => false),
  isDirectory: vi.fn(async () => true),
  isFile: vi.fn(async () => false),
  pathExists: vi.fn(async () => true),
}));

vi.mock('@/main/profile-resolver', () => ({
  HOST_PROFILE_NAME: 'host',
  resolveProfile: vi.fn((name: string) => {
    if (name === 'host') {
      return { kind: 'builtin-default' };
    }
    if (name === 'missing') {
      return { kind: 'missing', expected: '/fake/config/sandbox/missing.yml' };
    }
    return { kind: 'file', path: `/fake/config/sandbox/${name}.yml` };
  }),
}));

vi.mock('@/main/agent-host-control-client', () => ({
  AgentHostControlClient: class {
    async call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
      hoisted.controlCalls.push({ method, params });
      if (method === hoisted.controlFailureMethod) {
        throw new Error(`${method} failed`);
      }
      if (method === 'agent_host_materialize_environment') {
        return {
          environment_id: 'environment-materialized',
          workspace_root: '/workspace',
          default_cwd: '/workspace',
          services: { code_server: 'http://service' },
          container_id: 'container-materialized',
        };
      }
      return {};
    }
    close(): void {}
  },
}));

vi.mock('shell-env', () => ({ shellEnvSync: () => ({}) }));
vi.mock('@/lib/pty-utils', () => ({ DEFAULT_ENV: {} }));
vi.mock('@/main/workspace-sync', () => ({
  uploadWorkspace: vi.fn(async () => {}),
  downloadWorkspace: vi.fn(async () => {}),
}));
vi.mock('@/main/snapshot-blob-store', () => ({
  getSnapshotStore: () => ({
    pull: hoisted.snapshotPull,
    push: hoisted.snapshotPush,
    remove: vi.fn(async () => {}),
  }),
}));
vi.mock('@/lib/simple-logger', () => ({
  SimpleLogger: class {
    constructor(_handler: unknown) {}
    debug(): void {}
    info(): void {}
    warn(): void {}
    error(): void {}
  },
}));

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeWebSocket extends EventEmitter {
    constructor(_url: string) {
      super();
      setImmediate(() => this.emit('error', new Error('mock')));
    }
    close(): void {}
  }
  return { WebSocket: FakeWebSocket };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import path from 'node:path';

import { AgentProcess, type AgentProcessStartArg } from '@/main/agent-process';
import type { AgentProcessStatus, WithTimestamp } from '@/shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  emitStdout: (data: string) => void;
  emitStderr: (data: string) => void;
  emitClose: (code: number | null, signal?: string | null) => void;
};

const makeMockChild = (): MockChild => {
  const child = new EventEmitter() as MockChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.kill = vi.fn((_signal?: string) => {
    if (child.exitCode === null) {
      child.exitCode = 0;
      setImmediate(() => child.emit('close', 0, _signal ?? null));
    }
    return true;
  }) as unknown as MockChild['kill'];
  child.emitStdout = (data: string) => child.stdout.emit('data', Buffer.from(data));
  child.emitStderr = (data: string) => child.stderr.emit('data', Buffer.from(data));
  child.emitClose = (code: number | null, signal: string | null = null) => {
    child.exitCode = code;
    child.emit('close', code, signal);
  };
  return child;
};

type Harness = {
  proc: AgentProcess;
  statuses: WithTimestamp<AgentProcessStatus>[];
  child: MockChild;
  fetchFn: ReturnType<typeof vi.fn>;
};

const makeHarness = (): Harness => {
  const child = makeMockChild();
  hoisted.nextChild = child;
  hoisted.spawnCalls.length = 0;

  const statuses: WithTimestamp<AgentProcessStatus>[] = [];
  const fetchFn = vi.fn(async () => {
    throw new Error('mock fetch unavailable');
  });

  const proc = new AgentProcess({
    mode: 'serve',
    ipcRawOutput: () => {},
    onStatusChange: (s) => statuses.push(s),
    fetchFn: fetchFn as unknown as typeof globalThis.fetch,
  });

  return { proc, statuses, child, fetchFn };
};

const spawnCallCount = () => hoisted.spawnCalls.length;
const spawnCall = (i: number) => hoisted.spawnCalls[i] as [string, string[], { env: Record<string, string> }];

const SERVE_PAYLOAD = JSON.stringify({
  sandbox_url: 'http://127.0.0.1:9000',
  ws_url: 'ws://127.0.0.1:9000/ws',
  ui_url: 'http://127.0.0.1:9000',
  agent_host_id: 'agent-host-test',
  ports: { ui: 9000 },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentProcess (serve mode)', () => {
  beforeEach(() => {
    hoisted.nextChild = null;
    hoisted.spawnCalls.length = 0;
    hoisted.controlCalls.length = 0;
    hoisted.controlFailureMethod = null;
    hoisted.snapshotPull.mockClear();
    hoisted.snapshotPush.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  type Source = AgentProcessStartArg['sources'][number];
  const localSource = (workspaceDir = '/test/workspace', mountName = 'ws'): Source => ({
    mountName,
    kind: 'local',
    workspaceDir,
  });
  const localGitSource = (workspaceDir = '/test/workspace', mountName = 'ws'): Source => ({
    mountName,
    kind: 'local-git',
    workspaceDir,
  });
  const remoteSource = (repoUrl = 'https://github.com/foo/bar.git', mountName = 'bar', ref?: string): Source => {
    const s: Source = { mountName, kind: 'git-remote', repoUrl };
    if (ref) {
      s.ref = ref;
    }
    return s;
  };

  it('spawns a targetless AgentHost without consumer placement flags', async () => {
    const h = makeHarness();
    await h.proc.start({
      profileName: 'devbox',
      sources: [localGitSource('/test/workspace', 'launcher')],
    });

    expect(spawnCallCount()).toBe(1);
    const [binary, args] = spawnCall(0);
    expect(binary).toBe('/fake/bin/omni');
    expect(args).toContain('serve');
    expect(args).toContain('--output');
    expect(args).toContain('json');
    expect(args).toContain('--snapshot-dir');
    for (const placementFlag of [
      '--source',
      '--profile',
      '--project',
      '--session-id',
      '--container-id',
      '--workspace',
    ]) {
      expect(args).not.toContain(placementFlag);
    }
  });

  it('spawns with distinct renderer and main-process control credentials', async () => {
    const h = makeHarness();
    await h.proc.start({ profileName: 'host', sources: [localSource('/ws')] });

    const [, args] = spawnCall(0);
    const clientToken = args[args.indexOf('--auth-token') + 1];
    const controlToken = args[args.indexOf('--agent-host-control-token') + 1];
    expect(clientToken).toMatch(/^[0-9a-f]{64}$/);
    expect(controlToken).toMatch(/^[0-9a-f]{64}$/);
    expect(controlToken).not.toBe(clientToken);
  });

  it('registers, materializes, and binds a second consumer through the control plane', async () => {
    const h = makeHarness();
    const arg: AgentProcessStartArg = {
      profileName: 'devbox',
      sources: [{ ...localGitSource('/repos/second', 'second'), id: 'source-second' }],
      projectId: 'project-2',
    };
    await h.proc.start(arg);
    const mutable = h.proc as unknown as { status: WithTimestamp<AgentProcessStatus> };
    mutable.status = {
      type: 'running',
      timestamp: Date.now(),
      data: {
        uiUrl: 'http://127.0.0.1:9000',
        wsUrl: 'ws://127.0.0.1:9000/ws',
      },
    };

    const runtime = await h.proc.configureConsumer('thread-2', 'workspace-2', arg);

    expect(runtime).toEqual({
      workspaceId: 'workspace-2',
      environmentId: 'environment-materialized',
      workspaceRoot: '/workspace',
      defaultCwd: '/workspace',
      services: { code_server: 'http://service' },
      containerId: 'container-materialized',
    });
    expect(hoisted.controlCalls.map((call) => call.method)).toEqual([
      'agent_host_register_workspace',
      'agent_host_register_profile',
      'agent_host_materialize_environment',
      'agent_host_bind_thread',
    ]);
    expect(hoisted.controlCalls[0]!.params).toMatchObject({
      workspace_id: 'workspace-2',
      materialization_path: '/repos/second',
      snapshot_ref: 'workspace-2',
      owner_user_id: 'token_user',
    });
    expect(hoisted.controlCalls[3]!.params).toMatchObject({
      thread_id: 'thread-2',
      binding: {
        workspace_id: 'workspace-2',
        environment_selection: {
          mode: 'existing',
          environment_id: 'environment-materialized',
        },
      },
    });
    await h.proc.stopConsumerEnvironment(runtime.environmentId);
    expect(hoisted.controlCalls.at(-1)).toEqual({
      method: 'agent_host_stop_environment',
      params: { environment_id: 'environment-materialized' },
    });
  });

  it('binds the conversation session rather than the launcher consumer', async () => {
    const h = makeHarness();
    const arg: AgentProcessStartArg = {
      profileName: 'host',
      sources: [localSource('/repos/second', 'second')],
      sessionId: 'conversation-session',
    };
    await h.proc.start(arg);
    const mutable = h.proc as unknown as { status: WithTimestamp<AgentProcessStatus> };
    mutable.status = {
      type: 'running',
      timestamp: Date.now(),
      data: { uiUrl: 'http://127.0.0.1:9000', wsUrl: 'ws://127.0.0.1:9000/ws' },
    };

    await h.proc.configureConsumer('ui-tab-consumer', 'workspace-2', arg);

    expect(hoisted.controlCalls[0]!.params.materialization_path).toBe('/repos/second');
    expect(hoisted.controlCalls.find((call) => call.method === 'agent_host_bind_thread')?.params).toMatchObject({
      thread_id: 'conversation-session',
    });
  });

  it('restores and persists snapshots for each consumer Workspace', async () => {
    const h = makeHarness();
    await h.proc.start({ profileName: 'host', sources: [localSource('/ws')] });
    const mutable = h.proc as unknown as { status: WithTimestamp<AgentProcessStatus> };
    mutable.status = {
      type: 'running',
      timestamp: Date.now(),
      data: { uiUrl: 'http://127.0.0.1:9000', wsUrl: 'ws://127.0.0.1:9000/ws' },
    };

    const runtime = await h.proc.configureConsumer('thread-2', 'workspace-2', {
      profileName: 'host',
      sources: [localSource('/repos/second', 'second')],
      sessionId: 'conversation-thread-2',
      snapshotRef: 'snapshot-thread-2',
    });

    expect(hoisted.snapshotPull).toHaveBeenCalledWith('snapshot-thread-2', path.join('/fake/config', 'snapshots'));
    expect(hoisted.snapshotPush).not.toHaveBeenCalled();
    await h.proc.stopConsumerEnvironment(runtime.environmentId);
    expect(hoisted.snapshotPush).toHaveBeenCalledWith('snapshot-thread-2', path.join('/fake/config', 'snapshots'));
  });

  it('persists every active consumer snapshot when its AgentHost stops', async () => {
    const h = makeHarness();
    await h.proc.start({ profileName: 'host', sources: [localSource('/ws')] });
    const mutable = h.proc as unknown as { status: WithTimestamp<AgentProcessStatus> };
    mutable.status = {
      type: 'running',
      timestamp: Date.now(),
      data: { uiUrl: 'http://127.0.0.1:9000', wsUrl: 'ws://127.0.0.1:9000/ws' },
    };
    await h.proc.configureConsumer('thread-1', 'workspace-1', {
      profileName: 'host',
      sources: [localSource('/ws')],
      sessionId: 'conversation-thread-1',
      snapshotRef: 'snapshot-thread-1',
    });

    await h.proc.stop();

    expect(hoisted.snapshotPush).toHaveBeenCalledWith('snapshot-thread-1', path.join('/fake/config', 'snapshots'));
  });

  it('stops a newly materialized environment when thread binding fails', async () => {
    const h = makeHarness();
    const arg: AgentProcessStartArg = {
      profileName: 'devbox',
      sources: [localGitSource('/repos/second', 'second')],
    };
    await h.proc.start(arg);
    const mutable = h.proc as unknown as { status: WithTimestamp<AgentProcessStatus> };
    mutable.status = {
      type: 'running',
      timestamp: Date.now(),
      data: {
        uiUrl: 'http://127.0.0.1:9000',
        wsUrl: 'ws://127.0.0.1:9000/ws',
      },
    };
    hoisted.controlFailureMethod = 'agent_host_bind_thread';

    await expect(h.proc.configureConsumer('thread-2', 'workspace-2', arg)).rejects.toThrow(
      'agent_host_bind_thread failed'
    );

    expect(hoisted.controlCalls.at(-1)).toEqual({
      method: 'agent_host_stop_environment',
      params: { environment_id: 'environment-materialized' },
    });
  });

  it('registers all project sources through the consumer workspace', async () => {
    const h = makeHarness();
    await h.proc.start({
      profileName: 'host',
      sources: [
        localGitSource('/repos/launcher', 'launcher'),
        localGitSource('/repos/omni-code', 'omni-code'),
        remoteSource('https://github.com/me/omniagents.git', 'omniagents', 'main'),
      ],
    });
    const mutable = h.proc as unknown as { status: WithTimestamp<AgentProcessStatus> };
    mutable.status = {
      type: 'running',
      timestamp: Date.now(),
      data: { uiUrl: 'http://127.0.0.1:9000', wsUrl: 'ws://127.0.0.1:9000/ws' },
    };
    await h.proc.configureConsumer('thread-1', 'workspace-1', {
      profileName: 'host',
      sources: [
        localGitSource('/repos/launcher', 'launcher'),
        localGitSource('/repos/omni-code', 'omni-code'),
        remoteSource('https://github.com/me/omniagents.git', 'omniagents', 'main'),
      ],
    });
    expect(hoisted.controlCalls[0]!.params.materialization_path).toBe(
      path.join('/fake/config', 'workspaces', 'workspace-1')
    );
    expect(hoisted.controlCalls[0]!.params.sources).toEqual([
      { kind: 'local-git', mountName: 'launcher', writable: true, path: '/repos/launcher' },
      { kind: 'local-git', mountName: 'omni-code', writable: true, path: '/repos/omni-code' },
      {
        kind: 'git-remote',
        mountName: 'omniagents',
        writable: true,
        repoUrl: 'https://github.com/me/omniagents.git',
        ref: 'main',
      },
    ]);
  });

  it('keeps project selection off AgentHost argv', async () => {
    const h = makeHarness();
    await h.proc.start({
      profileName: 'host',
      sources: [localSource('/ws')],
      projectId: 'proj_abc',
    });

    const [, args] = spawnCall(0);
    expect(args).not.toContain('--project');
    expect(args).not.toContain('proj_abc');
    expect(args).toContain('--snapshot-dir');
    expect(args).toContain(path.join('/fake/config', 'snapshots'));
  });

  it('always passes --snapshot-dir but keeps session identity off AgentHost argv', async () => {
    const h = makeHarness();
    await h.proc.start({ profileName: 'host', sources: [localSource('/ws')] });
    const [, args1] = spawnCall(0);
    expect(args1).toContain('--snapshot-dir');
    expect(args1).not.toContain('--session-id');

    await h.proc.stop();
    hoisted.spawnCalls.length = 0;
    await h.proc.start({
      profileName: 'host',
      sources: [localSource('/ws')],
      sessionId: 'sess_xyz',
    });
    const [, args2] = spawnCall(0);
    expect(args2).not.toContain('--session-id');
    expect(args2).not.toContain('sess_xyz');
  });

  it('resolves a consumer profile during materialization, not host startup', async () => {
    const h = makeHarness();
    const arg = { profileName: 'missing', sources: [localSource('/ws')] };
    await h.proc.start(arg);
    const mutable = h.proc as unknown as { status: WithTimestamp<AgentProcessStatus> };
    mutable.status = {
      type: 'running',
      timestamp: Date.now(),
      data: { uiUrl: 'http://127.0.0.1:9000', wsUrl: 'ws://127.0.0.1:9000/ws' },
    };

    expect(spawnCallCount()).toBe(1);
    await expect(h.proc.configureConsumer('thread-1', 'workspace-1', arg)).rejects.toThrow(
      'Profile "missing" is no longer available'
    );
  });

  it('parses targetless JSON readiness without consumer runtime data', async () => {
    const h = makeHarness();
    await h.proc.start({ profileName: 'devbox', sources: [localSource('/ws')] });
    h.child.emitStdout(`${SERVE_PAYLOAD}\n`);

    const connecting = h.statuses.find((s) => s.type === 'connecting');
    expect(connecting?.type).toBe('connecting');
    if (connecting?.type === 'connecting') {
      expect(connecting.data.uiUrl).toBe('http://127.0.0.1:9000');
      expect(connecting.data.wsUrl).toBe('ws://127.0.0.1:9000/ws');
      expect(connecting.data.agentHostId).toBe('agent-host-test');
      expect(connecting.data.workspaceId).toBeUndefined();
      expect(connecting.data.environmentId).toBeUndefined();
      expect(connecting.data.services).toEqual({});
      expect(connecting.data.port).toBe(9000);
    }
  });

  it('does not issue sandbox lifecycle RPCs without an execution environment', async () => {
    const h = makeHarness();
    const mutable = h.proc as unknown as { status: WithTimestamp<AgentProcessStatus> };
    mutable.status = {
      type: 'running',
      timestamp: Date.now(),
      data: { uiUrl: 'http://127.0.0.1:9000', wsUrl: 'ws://127.0.0.1:9000/ws' },
    };

    await expect(h.proc.pause()).resolves.toMatchObject({
      ok: false,
      supported: false,
      reason: expect.stringContaining('execution environment'),
    });
  });

  it('rejects readiness without an AgentHost identity', async () => {
    const h = makeHarness();
    await h.proc.start({ profileName: 'host', sources: [localSource('/ws')] });
    const payload = JSON.parse(SERVE_PAYLOAD) as Record<string, unknown>;
    delete payload.agent_host_id;

    expect(() => h.child.emitStdout(`${JSON.stringify(payload)}\n`)).toThrow('Missing agent_host_id');
    expect(h.statuses.some((status) => status.type === 'connecting')).toBe(false);
  });

  it('handles split-buffer payloads (line not complete in first write)', async () => {
    const h = makeHarness();
    await h.proc.start({ profileName: 'host', sources: [localSource('/ws')] });

    const mid = Math.floor(SERVE_PAYLOAD.length / 2);
    h.child.emitStdout(SERVE_PAYLOAD.slice(0, mid));
    expect(h.statuses.find((s) => s.type === 'connecting')).toBeUndefined();
    h.child.emitStdout(`${SERVE_PAYLOAD.slice(mid)}\n`);
    expect(h.statuses.find((s) => s.type === 'connecting')).toBeDefined();
  });

  it('ignores duplicate JSON payloads after the first', async () => {
    const h = makeHarness();
    await h.proc.start({ profileName: 'host', sources: [localSource('/ws')] });

    h.child.emitStdout(`${SERVE_PAYLOAD}\n`);
    h.child.emitStdout(`${SERVE_PAYLOAD}\n`);

    const connecting = h.statuses.filter((s) => s.type === 'connecting');
    expect(connecting.length).toBe(1);
  });

  it('transitions to error on non-zero exit when not stopping', async () => {
    const h = makeHarness();
    await h.proc.start({ profileName: 'host', sources: [localSource('/ws')] });
    h.child.emitStderr('boom\n');
    h.child.emitClose(2);

    const last = h.statuses.at(-1);
    expect(last?.type).toBe('error');
    if (last?.type === 'error') {
      expect(last.error.message).toContain('omni serve exited');
    }
  });

  it('transitions to exited on close after stop()', async () => {
    const h = makeHarness();
    await h.proc.start({ profileName: 'host', sources: [localSource('/ws')] });
    await h.proc.stop();

    const last = h.statuses.at(-1);
    expect(last?.type).toBe('exited');
  });

  it('errors when workspace dir does not exist (local sources only)', async () => {
    const utilMock = await import('@/main/util');
    (utilMock.isDirectory as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    const h = makeHarness();
    const arg = { profileName: 'host', sources: [localSource('/missing')] };
    await h.proc.start(arg);
    await expect(h.proc.configureConsumer('thread-1', 'workspace-1', arg)).rejects.toThrow(
      'Workspace directory not found'
    );
    expect(spawnCallCount()).toBe(1);
  });

  it('does not check workspaceDir for git-remote sources', async () => {
    const utilMock = await import('@/main/util');
    const isDirSpy = utilMock.isDirectory as ReturnType<typeof vi.fn>;
    isDirSpy.mockClear();

    const h = makeHarness();
    await h.proc.start({
      profileName: 'host',
      sources: [remoteSource('https://github.com/foo/bar.git')],
    });
    const mutable = h.proc as unknown as { status: WithTimestamp<AgentProcessStatus> };
    mutable.status = {
      type: 'running',
      timestamp: Date.now(),
      data: { uiUrl: 'http://127.0.0.1:9000', wsUrl: 'ws://127.0.0.1:9000/ws' },
    };
    await h.proc.configureConsumer('thread-1', 'workspace-1', {
      profileName: 'host',
      sources: [remoteSource('https://github.com/foo/bar.git')],
    });
    expect(isDirSpy).not.toHaveBeenCalled();
    expect(spawnCallCount()).toBe(1);
  });
});
