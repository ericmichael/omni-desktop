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
  resourceSnapshot: null as Record<string, unknown> | null,
  resourceSnapshotQueue: [] as Record<string, unknown>[],
  snapshotPull: vi.fn(async () => false),
  snapshotVerify: vi.fn(async () => true),
  snapshotPush: vi.fn(async () => true),
  ledgerRecord: vi.fn(() => true),
  ledgerComplete: vi.fn(() => true),
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

vi.mock('@/main/product-runtime', () => ({
  assertServeProtocolSupported: vi.fn(async () => {}),
}));

vi.mock('@/main/agent-host-control-client', () => ({
  AgentHostControlClient: class {
    async call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
      hoisted.controlCalls.push({ method, params });
      if (method === 'agent_host_list_resources') {
        if (hoisted.resourceSnapshotQueue.length > 0) {
          return hoisted.resourceSnapshotQueue.shift()!;
        }
        if (hoisted.resourceSnapshot) {
          return hoisted.resourceSnapshot;
        }
        const workspaceCalls = hoisted.controlCalls.filter((call) => call.method === 'agent_host_register_workspace');
        const profileCalls = hoisted.controlCalls.filter((call) => call.method === 'agent_host_register_profile');
        const materialized = hoisted.controlCalls.some((call) => call.method === 'agent_host_materialize_environment');
        const stopped = hoisted.controlCalls.some((call) => call.method === 'agent_host_stop_environment');
        return {
          agent_host_id: 'agent-host-test',
          workspaces: workspaceCalls.map((call) => ({
            workspace_id: call.params.workspace_id,
            owner_user_id: call.params.owner_user_id,
            snapshot_ref: call.params.snapshot_ref,
            sources: call.params.sources,
          })),
          profiles: Object.fromEntries(
            profileCalls.map((call) => [call.params.profile_id, call.params.definition]) as Array<[string, unknown]>
          ),
          environments: materialized
            ? [
                {
                  environment_id: 'environment-materialized',
                  workspace_id: workspaceCalls.at(-1)?.params.workspace_id ?? 'workspace-2',
                  generation: 3,
                  state: stopped ? 'stopped' : 'ready',
                },
              ]
            : [],
        };
      }
      if (method === hoisted.controlFailureMethod) {
        throw new Error(`${method} failed`);
      }
      if (method === 'agent_host_materialize_environment') {
        return {
          environment_id: 'environment-materialized',
          generation: 3,
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
    verify: hoisted.snapshotVerify,
    push: hoisted.snapshotPush,
    remove: vi.fn(async () => {}),
  }),
}));
vi.mock('@/main/snapshot-upload-ledger', () => ({
  recordPendingSnapshotUpload: hoisted.ledgerRecord,
  completePendingSnapshotUpload: hoisted.ledgerComplete,
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
import type { IComputeClient, PlatformSession } from '@/main/platform-client';
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

const makeHarness = (
  opts: {
    processStopTimeoutMs?: number;
    snapshotRetryDelayMs?: number;
    stopReconcilePollMs?: number;
    stopReconcileTimeoutMs?: number;
  } = {}
): Harness => {
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
    ...(opts.processStopTimeoutMs !== undefined ? { processStopTimeoutMs: opts.processStopTimeoutMs } : {}),
    ...(opts.snapshotRetryDelayMs !== undefined ? { snapshotRetryDelayMs: opts.snapshotRetryDelayMs } : {}),
    ...(opts.stopReconcilePollMs !== undefined ? { stopReconcilePollMs: opts.stopReconcilePollMs } : {}),
    ...(opts.stopReconcileTimeoutMs !== undefined ? { stopReconcileTimeoutMs: opts.stopReconcileTimeoutMs } : {}),
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
    hoisted.resourceSnapshot = null;
    hoisted.resourceSnapshotQueue.length = 0;
    hoisted.snapshotPull.mockClear();
    hoisted.snapshotVerify.mockReset();
    hoisted.snapshotVerify.mockResolvedValue(true);
    hoisted.snapshotPush.mockClear();
    hoisted.snapshotPush.mockReset();
    hoisted.snapshotPush.mockResolvedValue(true);
    hoisted.ledgerRecord.mockClear();
    hoisted.ledgerComplete.mockClear();
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
      environmentGeneration: 3,
      workspaceRoot: '/workspace',
      defaultCwd: '/workspace',
      services: { code_server: 'http://service' },
      containerId: 'container-materialized',
    });
    expect(hoisted.controlCalls.map((call) => call.method)).toEqual([
      'agent_host_list_resources',
      'agent_host_register_workspace',
      'agent_host_register_profile',
      'agent_host_materialize_environment',
      'agent_host_bind_thread',
    ]);
    expect(hoisted.controlCalls[1]!.params).toMatchObject({
      workspace_id: 'workspace-2',
      materialization_path: '/repos/second',
      snapshot_ref: 'workspace-2',
      owner_user_id: 'token_user',
    });
    expect(hoisted.controlCalls[4]!.params).toMatchObject({
      thread_id: 'thread-2',
      binding: {
        workspace_id: 'workspace-2',
        environment_selection: {
          mode: 'existing',
          environment_id: 'environment-materialized',
          environment_generation: 3,
        },
      },
    });
    await h.proc.stopConsumerEnvironment(runtime.environmentId);
    expect(hoisted.controlCalls.at(-1)).toEqual({
      method: 'agent_host_stop_environment',
      params: { environment_id: 'environment-materialized' },
    });
  });

  it('adopts an authoritative ready environment after a control/renderer reconnect', async () => {
    const h = makeHarness();
    const arg: AgentProcessStartArg = {
      profileName: 'host',
      sources: [localSource('/repos/reconnect', 'reconnect')],
      sessionId: 'conversation-reconnect',
    };
    await h.proc.start(arg);
    const mutable = h.proc as unknown as { status: WithTimestamp<AgentProcessStatus> };
    mutable.status = {
      type: 'running',
      timestamp: Date.now(),
      data: {
        uiUrl: 'http://127.0.0.1:9000',
        wsUrl: 'ws://127.0.0.1:9000/ws',
        agentHostId: 'agent-host-test',
      },
    };

    const first = await h.proc.configureConsumer('tab-reconnect', 'workspace-reconnect', arg);
    const firstCallCount = hoisted.controlCalls.length;
    const second = await h.proc.configureConsumer('tab-reconnect', 'workspace-reconnect', arg);

    expect(second).toEqual(first);
    expect(hoisted.controlCalls.slice(firstCallCount).map((call) => call.method)).toEqual([
      'agent_host_list_resources',
      'agent_host_bind_thread',
    ]);
    expect(hoisted.snapshotPull).toHaveBeenCalledTimes(1);
  });

  it('fails closed when reconciliation reaches a different AgentHost', async () => {
    const h = makeHarness();
    const arg: AgentProcessStartArg = { profileName: 'host', sources: [localSource('/repos/mismatch')] };
    await h.proc.start(arg);
    const mutable = h.proc as unknown as { status: WithTimestamp<AgentProcessStatus> };
    mutable.status = {
      type: 'running',
      timestamp: Date.now(),
      data: {
        uiUrl: 'http://127.0.0.1:9000',
        wsUrl: 'ws://127.0.0.1:9000/ws',
        agentHostId: 'expected-host',
      },
    };
    hoisted.resourceSnapshot = {
      agent_host_id: 'unexpected-host',
      workspaces: [],
      profiles: {},
      environments: [],
    };

    await expect(h.proc.configureConsumer('tab', 'workspace', arg)).rejects.toThrow('host restart required');
    expect(hoisted.controlCalls.map((call) => call.method)).toEqual(['agent_host_list_resources']);
  });

  it('refuses to stop a newer environment generation through a stale target', async () => {
    const h = makeHarness();
    await h.proc.start({ profileName: 'host', sources: [localSource('/ws')] });
    const mutable = h.proc as unknown as { status: WithTimestamp<AgentProcessStatus> };
    mutable.status = {
      type: 'running',
      timestamp: Date.now(),
      data: { uiUrl: 'http://127.0.0.1:9000', wsUrl: 'ws://127.0.0.1:9000/ws' },
    };
    const runtime = await h.proc.configureConsumer('thread', 'workspace', {
      profileName: 'host',
      sources: [localSource('/ws')],
    });
    hoisted.resourceSnapshot = {
      agent_host_id: 'agent-host-test',
      workspaces: [],
      profiles: {},
      environments: [
        {
          environment_id: runtime.environmentId,
          workspace_id: runtime.workspaceId,
          generation: runtime.environmentGeneration + 1,
          state: 'ready',
        },
      ],
    };

    await expect(h.proc.stopConsumerEnvironment(runtime)).rejects.toThrow('Refusing to stop stale environment target');
    expect(hoisted.controlCalls.filter((call) => call.method === 'agent_host_stop_environment')).toHaveLength(0);
  });

  it('reconciles a lost stop response before persisting the snapshot', async () => {
    const h = makeHarness();
    await h.proc.start({ profileName: 'host', sources: [localSource('/ws')] });
    const mutable = h.proc as unknown as { status: WithTimestamp<AgentProcessStatus> };
    mutable.status = {
      type: 'running',
      timestamp: Date.now(),
      data: { uiUrl: 'http://127.0.0.1:9000', wsUrl: 'ws://127.0.0.1:9000/ws' },
    };
    const runtime = await h.proc.configureConsumer('thread', 'workspace', {
      profileName: 'host',
      sources: [localSource('/ws')],
      snapshotRef: 'snapshot-reconcile',
    });
    hoisted.controlFailureMethod = 'agent_host_stop_environment';

    await expect(h.proc.stopConsumerEnvironment(runtime)).resolves.toMatchObject({
      scope: 'environment',
      snapshotPersistence: 'complete',
    });
    expect(
      hoisted.controlCalls.filter((call) => call.method === 'agent_host_list_resources').length
    ).toBeGreaterThanOrEqual(3);
    expect(hoisted.snapshotPush).toHaveBeenCalledWith('snapshot-reconcile', path.join('/fake/config', 'snapshots'));
  });

  it('waits for an already-committed stopping environment instead of retrying the mutation', async () => {
    const h = makeHarness({ stopReconcilePollMs: 1, stopReconcileTimeoutMs: 100 });
    await h.proc.start({ profileName: 'host', sources: [localSource('/ws')] });
    const mutable = h.proc as unknown as { status: WithTimestamp<AgentProcessStatus> };
    mutable.status = {
      type: 'running',
      timestamp: Date.now(),
      data: { uiUrl: 'http://127.0.0.1:9000', wsUrl: 'ws://127.0.0.1:9000/ws' },
    };
    const runtime = await h.proc.configureConsumer('thread-stopping', 'workspace-stopping', {
      profileName: 'host',
      sources: [localSource('/ws')],
      snapshotRef: 'snapshot-stopping',
    });
    const resources = (state: 'stopping' | 'stopped'): Record<string, unknown> => ({
      agent_host_id: 'agent-host-test',
      workspaces: [],
      profiles: {},
      environments: [
        {
          environment_id: runtime.environmentId,
          workspace_id: runtime.workspaceId,
          generation: runtime.environmentGeneration,
          state,
        },
      ],
    });
    hoisted.resourceSnapshotQueue.push(resources('stopping'), resources('stopped'));
    const stopCallsBefore = hoisted.controlCalls.filter((call) => call.method === 'agent_host_stop_environment').length;

    await expect(h.proc.stopConsumerEnvironment(runtime)).resolves.toMatchObject({
      snapshotPersistence: 'complete',
    });
    expect(hoisted.controlCalls.filter((call) => call.method === 'agent_host_stop_environment')).toHaveLength(
      stopCallsBefore
    );
    expect(hoisted.snapshotPush).toHaveBeenCalledWith('snapshot-stopping', path.join('/fake/config', 'snapshots'));
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

    expect(hoisted.controlCalls[1]!.params.materialization_path).toBe('/repos/second');
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

    const result = await h.proc.stop();

    expect(result).toEqual({
      scope: 'host',
      shutdown: 'graceful',
      snapshotPersistence: 'complete',
      pendingSnapshotRefs: [],
    });
    expect(hoisted.snapshotVerify).toHaveBeenCalledWith('snapshot-thread-1', path.join('/fake/config', 'snapshots'));
    expect(hoisted.snapshotPush).toHaveBeenCalledWith('snapshot-thread-1', path.join('/fake/config', 'snapshots'));
  });

  it('retains snapshot retry bookkeeping until a committed stop is durably uploaded', async () => {
    const h = makeHarness({ snapshotRetryDelayMs: 1 });
    await h.proc.start({ profileName: 'host', sources: [localSource('/ws')] });
    const mutable = h.proc as unknown as { status: WithTimestamp<AgentProcessStatus> };
    mutable.status = {
      type: 'running',
      timestamp: Date.now(),
      data: { uiUrl: 'http://127.0.0.1:9000', wsUrl: 'ws://127.0.0.1:9000/ws' },
    };
    const runtime = await h.proc.configureConsumer('thread-retry', 'workspace-retry', {
      profileName: 'host',
      sources: [localSource('/ws')],
      snapshotRef: 'snapshot-retry',
    });
    hoisted.snapshotPush.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(h.proc.stopConsumerEnvironment(runtime)).resolves.toEqual({
      scope: 'environment',
      shutdown: 'not-applicable',
      snapshotPersistence: 'uncertain',
      pendingSnapshotRefs: ['snapshot-retry'],
    });
    expect(hoisted.ledgerRecord).toHaveBeenCalledWith(
      'snapshot-retry',
      path.join('/fake/config', 'snapshots'),
      'retryable'
    );
    await vi.waitFor(() => expect(hoisted.snapshotPush).toHaveBeenCalledTimes(2));
    expect(hoisted.ledgerComplete).toHaveBeenCalledWith('snapshot-retry', path.join('/fake/config', 'snapshots'));
    await expect(h.proc.stopConsumerEnvironment(runtime)).resolves.toEqual({
      scope: 'environment',
      shutdown: 'not-applicable',
      snapshotPersistence: 'complete',
      pendingSnapshotRefs: [],
    });
    expect(hoisted.snapshotPush).toHaveBeenCalledTimes(2);
  });

  it('reports uncertain persistence when a graceful pooled-host teardown leaves no valid snapshot', async () => {
    const h = makeHarness();
    await h.proc.start({ profileName: 'host', sources: [localSource('/ws')] });
    const mutable = h.proc as unknown as { status: WithTimestamp<AgentProcessStatus> };
    mutable.status = {
      type: 'running',
      timestamp: Date.now(),
      data: { uiUrl: 'http://127.0.0.1:9000', wsUrl: 'ws://127.0.0.1:9000/ws' },
    };
    await h.proc.configureConsumer('thread-invalid', 'workspace-invalid', {
      profileName: 'host',
      sources: [localSource('/ws')],
      snapshotRef: 'snapshot-invalid',
    });
    hoisted.snapshotVerify.mockResolvedValue(false);

    await expect(h.proc.stop()).resolves.toEqual({
      scope: 'host',
      shutdown: 'graceful',
      snapshotPersistence: 'uncertain',
      pendingSnapshotRefs: ['snapshot-invalid'],
    });
    expect(hoisted.snapshotPush).not.toHaveBeenCalled();
  });

  it('reports forced shutdown and never uploads a possibly partial snapshot after SIGKILL', async () => {
    const h = makeHarness({ processStopTimeoutMs: 1 });
    h.child.kill.mockImplementation((signal?: string) => {
      if (signal === 'SIGKILL') {
        h.child.exitCode = 0;
        setImmediate(() => h.child.emit('close', null, 'SIGKILL'));
      }
      return true;
    });
    await h.proc.start({ profileName: 'host', sources: [localSource('/ws')] });
    const mutable = h.proc as unknown as { status: WithTimestamp<AgentProcessStatus> };
    mutable.status = {
      type: 'running',
      timestamp: Date.now(),
      data: { uiUrl: 'http://127.0.0.1:9000', wsUrl: 'ws://127.0.0.1:9000/ws' },
    };
    await h.proc.configureConsumer('thread-forced', 'workspace-forced', {
      profileName: 'host',
      sources: [localSource('/ws')],
      snapshotRef: 'snapshot-forced',
    });

    await expect(h.proc.stop()).resolves.toEqual({
      scope: 'host',
      shutdown: 'forced',
      snapshotPersistence: 'uncertain',
      pendingSnapshotRefs: ['snapshot-forced'],
    });
    expect(h.child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(hoisted.ledgerRecord).toHaveBeenCalledWith(
      'snapshot-forced',
      path.join('/fake/config', 'snapshots'),
      'forced-uncertain'
    );
    expect(hoisted.snapshotVerify).not.toHaveBeenCalled();
    expect(hoisted.snapshotPush).not.toHaveBeenCalled();
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
    expect(hoisted.controlCalls[1]!.params.materialization_path).toBe(
      path.join('/fake/config', 'workspaces', 'workspace-1')
    );
    expect(hoisted.controlCalls[1]!.params.sources).toEqual([
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

describe('AgentProcess (platform compute mode)', () => {
  it('publishes complete routed AgentHost data with only the ordinary consumer credential', async () => {
    const ready: PlatformSession = {
      sessionId: 'platform-session-1',
      status: 'active',
      agentHostId: 'remote-agent-host-1',
      workspaceId: 'remote-workspace-1',
      environmentId: 'remote-environment-1',
      environmentGeneration: 7,
      workspaceRoot: '/workspace/project',
      defaultCwd: '/workspace/project',
      services: { code_server: 'https://code.example.test' },
      consumerCredential: { token: 'ordinary-consumer-token', scope: 'consumer', kind: 'ordinary' },
      websocketUrl: 'wss://runtime.example.test/ws',
      containerId: 'remote-container-1',
    };
    const computeClient: IComputeClient = {
      confirmsReadiness: true,
      startSession: vi.fn(
        async (): Promise<PlatformSession> => ({ ...ready, status: 'pending', websocketUrl: undefined })
      ),
      waitForSession: vi.fn(async () => ready),
      stopSession: vi.fn(async () => {}),
      finalizeWorkspace: vi.fn(async () => ({ downloadSasUrl: 'https://download.example.test' })),
    };
    const statuses: WithTimestamp<AgentProcessStatus>[] = [];
    const proc = new AgentProcess({
      mode: 'compute',
      computeClient,
      ipcRawOutput: () => {},
      onStatusChange: (status) => statuses.push(status),
    });

    await proc.start({ profileName: 'platform', sources: [], sessionId: 'conversation-1' });

    const running = statuses.at(-1);
    expect(running).toMatchObject({
      type: 'running',
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
        containerId: 'remote-container-1',
      },
    });
    if (running?.type === 'running') {
      expect(running.data.uiUrl).not.toContain('token');
      expect(JSON.stringify(running.data)).not.toContain('admin');
    }
  });
});
