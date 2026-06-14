// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  nextChild: null as unknown,
  spawnCalls: [] as unknown[][],
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

vi.mock('shell-env', () => ({ shellEnvSync: () => ({}) }));
vi.mock('@/lib/pty-utils', () => ({ DEFAULT_ENV: {} }));
vi.mock('@/main/workspace-sync', () => ({
  uploadWorkspace: vi.fn(async () => {}),
  downloadWorkspace: vi.fn(async () => {}),
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
  services: { code_server: 'http://127.0.0.1:8080', vnc: 'http://127.0.0.1:6080' },
  ports: { ui: 9000 },
  container_id: null,
  container_name: 'omni-serve-unix_local',
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentProcess (serve mode)', () => {
  beforeEach(() => {
    hoisted.nextChild = null;
    hoisted.spawnCalls.length = 0;
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

  // Pull the JSON descriptor strings out of an args array so tests can
  // assert on their parsed shape rather than substring-matching.
  const sourceDescriptors = (args: string[]): unknown[] => {
    const out: unknown[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--source' && typeof args[i + 1] === 'string') {
        out.push(JSON.parse(args[i + 1]!));
      }
    }
    return out;
  };

  it('spawns `omni serve` with a --source JSON descriptor for a local git source', async () => {
    const h = makeHarness();
    await h.proc.start({
      profileName: 'devbox',
      sources: [localGitSource('/test/workspace', 'launcher')],
    });

    expect(spawnCallCount()).toBe(1);
    const [binary, args] = spawnCall(0);
    expect(binary).toBe('/fake/bin/omni');
    expect(args).toContain('serve');
    expect(args).toContain('--profile');
    expect(args).toContain('/fake/config/sandbox/devbox.yml');
    expect(args).toContain('--output');
    expect(args).toContain('json');
    expect(args).toContain('--workspace');
    expect(args[args.indexOf('--workspace') + 1]).toBe('/test/workspace');
    expect(sourceDescriptors(args)).toEqual([{ kind: 'local-git', mountName: 'launcher', path: '/test/workspace' }]);
  });

  it('emits multiple --source descriptors for a multi-source project', async () => {
    const h = makeHarness();
    await h.proc.start({
      profileName: 'host',
      sources: [
        localGitSource('/repos/launcher', 'launcher'),
        localGitSource('/repos/omni-code', 'omni-code'),
        remoteSource('https://github.com/me/omniagents.git', 'omniagents', 'main'),
      ],
    });
    const [, args] = spawnCall(0);
    expect(sourceDescriptors(args)).toEqual([
      { kind: 'local-git', mountName: 'launcher', path: '/repos/launcher' },
      { kind: 'local-git', mountName: 'omni-code', path: '/repos/omni-code' },
      { kind: 'git-remote', mountName: 'omniagents', repoUrl: 'https://github.com/me/omniagents.git', ref: 'main' },
    ]);
  });

  it('includes ref in the git-remote descriptor when set', async () => {
    const h = makeHarness();
    await h.proc.start({
      profileName: 'host',
      sources: [remoteSource('https://github.com/foo/bar.git', 'bar', 'main')],
    });
    expect(sourceDescriptors(spawnCall(0)[1])[0]).toEqual({
      kind: 'git-remote',
      mountName: 'bar',
      repoUrl: 'https://github.com/foo/bar.git',
      ref: 'main',
    });
  });

  it('omits --profile for the host profile (uses omni serve bundled default)', async () => {
    const h = makeHarness();
    await h.proc.start({ profileName: 'host', sources: [localSource('/ws')] });

    const [, args] = spawnCall(0);
    expect(args).not.toContain('--profile');
  });

  it('forwards --project and --snapshot-dir when projectId is set', async () => {
    const h = makeHarness();
    await h.proc.start({
      profileName: 'host',
      sources: [localSource('/ws')],
      projectId: 'proj_abc',
    });

    const [, args] = spawnCall(0);
    expect(args).toContain('--project');
    expect(args).toContain('proj_abc');
    expect(args).toContain('--snapshot-dir');
    expect(args).toContain('/fake/config/snapshots');
  });

  it('always passes --snapshot-dir; --session-id only when caller supplies one', async () => {
    const h = makeHarness();
    await h.proc.start({ profileName: 'host', sources: [localSource('/ws')] });
    const [, args1] = spawnCall(0);
    // --snapshot-dir is always present — omni serve auto-generates a
    // session_id and the launcher captures it from the readiness payload.
    expect(args1).toContain('--snapshot-dir');
    // No sessionId on this start, so --session-id is omitted (fresh start).
    expect(args1).not.toContain('--session-id');

    // Subsequent start with a captured session id forwards it for resume.
    await h.proc.stop();
    hoisted.spawnCalls.length = 0;
    await h.proc.start({
      profileName: 'host',
      sources: [localSource('/ws')],
      sessionId: 'sess_xyz',
    });
    const [, args2] = spawnCall(0);
    expect(args2).toContain('--session-id');
    expect(args2).toContain('sess_xyz');
  });

  it('reports an error and does not spawn when the profile cannot be resolved', async () => {
    const h = makeHarness();
    await h.proc.start({ profileName: 'missing', sources: [localSource('/ws')] });

    expect(spawnCallCount()).toBe(0);
    const last = h.statuses.at(-1);
    expect(last?.type).toBe('error');
    if (last?.type === 'error') {
      expect(last.error.message).toMatch(/Profile "missing" not found/);
    }
  });

  it('parses the JSON readiness payload into AgentProcessData (services map preserved)', async () => {
    const h = makeHarness();
    await h.proc.start({ profileName: 'devbox', sources: [localSource('/ws')] });
    h.child.emitStdout(`${SERVE_PAYLOAD}\n`);

    const connecting = h.statuses.find((s) => s.type === 'connecting');
    expect(connecting?.type).toBe('connecting');
    if (connecting?.type === 'connecting') {
      expect(connecting.data.uiUrl).toBe('http://127.0.0.1:9000');
      expect(connecting.data.wsUrl).toBe('ws://127.0.0.1:9000/ws');
      expect(connecting.data.services).toEqual({
        code_server: 'http://127.0.0.1:8080',
        vnc: 'http://127.0.0.1:6080',
      });
      expect(connecting.data.port).toBe(9000);
    }
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
    (utilMock.isDirectory as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

    const h = makeHarness();
    await h.proc.start({ profileName: 'host', sources: [localSource('/missing')] });
    expect(spawnCallCount()).toBe(0);
    const last = h.statuses.at(-1);
    expect(last?.type).toBe('error');
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
    expect(isDirSpy).not.toHaveBeenCalled();
    expect(spawnCallCount()).toBe(1);
  });
});
