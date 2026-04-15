// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Hoisted shared state for the `node:child_process` mock. Vitest hoists vi.mock
// factories above imports, so the factory cannot reference test-level variables
// directly. vi.hoisted() gives us a place to park state that the factory can
// safely close over.
const hoisted = vi.hoisted(() => ({
  nextChild: null as unknown,
  spawnCalls: [] as unknown[][],
}));

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  const actual = (await vi.importActual('node:child_process')) as typeof import('node:child_process');

  // execFile mock: provide a promisify.custom that short-circuits to success so
  // `promisify(execFile)(...)` resolves immediately. checkDocker/checkPodman
  // thus succeed without any real subprocess.
  const execFileMock = ((_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
    if (typeof cb === 'function') {
      (cb as (err: Error | null, res: { stdout: string; stderr: string }) => void)(null, {
        stdout: '',
        stderr: '',
      });
    }
    return { on: () => {} };
  }) as unknown as typeof import('node:child_process').execFile;
  (execFileMock as unknown as { [k: symbol]: unknown })[promisify.custom] = async () => ({
    stdout: '',
    stderr: '',
  });

  // Spawn mock: return whatever `hoisted.nextChild` currently points at and
  // record the call arguments for assertions.
  const spawnMock = ((...args: unknown[]) => {
    hoisted.spawnCalls.push(args);
    return hoisted.nextChild as ReturnType<typeof import('node:child_process').spawn>;
  }) as unknown as typeof import('node:child_process').spawn;

  return {
    ...actual,
    spawn: spawnMock,
    execFile: execFileMock,
  };
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

vi.mock('shell-env', () => ({ shellEnvSync: () => ({}) }));

vi.mock('@/lib/pty-utils', () => ({
  DEFAULT_ENV: {},
}));

vi.mock('@/main/workspace-sync', () => ({
  uploadWorkspace: vi.fn(async () => {}),
  downloadWorkspace: vi.fn(async () => {}),
}));

// Silence SimpleLogger so the test output isn't cluttered with startup banners.
vi.mock('@/lib/simple-logger', () => ({
  SimpleLogger: class {
    constructor(_handler: unknown) {}
    debug(): void {}
    info(): void {}
    warn(): void {}
    error(): void {}
  },
}));

vi.mock('@/main/store', () => ({
  store: {
    get: vi.fn((_key: string) => undefined),
    set: vi.fn(),
  },
  getStore: vi.fn(() => ({
    get: vi.fn((_key: string) => undefined),
    set: vi.fn(),
  })),
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
  // When killProcess() calls kill('SIGTERM'), immediately emit a 'close' event
  // so stop()/exit() don't hang waiting on the teardown handshake.
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

const makeHarness = (mode: 'none' | 'local' | 'sandbox' | 'podman'): Harness => {
  const child = makeMockChild();
  hoisted.nextChild = child;
  hoisted.spawnCalls.length = 0;

  const statuses: WithTimestamp<AgentProcessStatus>[] = [];
  const fetchFn = vi.fn(async () => {
    throw new Error('mock fetch unavailable');
  });

  const proc = new AgentProcess({
    mode,
    ipcRawOutput: () => {},
    onStatusChange: (s) => statuses.push(s),
    fetchFn: fetchFn as unknown as typeof globalThis.fetch,
  });

  return { proc, statuses, child, fetchFn };
};

const spawnCallCount = () => hoisted.spawnCalls.length;
const spawnCall = (i: number) => hoisted.spawnCalls[i] as [string, string[], { env: Record<string, string> }];

const START_ARG: AgentProcessStartArg = { workspaceDir: '/test/workspace' };

const SANDBOX_PAYLOAD = JSON.stringify({
  sandbox_url: 'http://sandbox:8000',
  ws_url: 'ws://sandbox:9000/ws',
  ui_url: 'http://sandbox:9000',
  code_server_url: null,
  novnc_url: null,
  container_id: 'abc123',
  container_name: 'omni-test',
  ports: { sandbox: 8000, ui: 9000, code_server: null, vnc: null },
});

const lastStatus = (statuses: WithTimestamp<AgentProcessStatus>[]) => statuses[statuses.length - 1]!;
const hasStatusType = (statuses: WithTimestamp<AgentProcessStatus>[], type: AgentProcessStatus['type']) =>
  statuses.some((s) => s.type === type);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentProcess', () => {
  beforeEach(() => {
    hoisted.spawnCalls.length = 0;
    hoisted.nextChild = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('start() idempotency', () => {
    it('is a no-op when already in starting state', async () => {
      const h = makeHarness('sandbox');
      await h.proc.start(START_ARG);
      expect(spawnCallCount()).toBe(1);
      expect(hasStatusType(h.statuses, 'starting')).toBe(true);

      await h.proc.start(START_ARG);
      expect(spawnCallCount()).toBe(1);

      await h.proc.exit();
    });

    it('is a no-op when already in connecting state', async () => {
      const h = makeHarness('sandbox');
      await h.proc.start(START_ARG);
      h.child.emitStdout(`${SANDBOX_PAYLOAD  }\n`);
      expect(lastStatus(h.statuses).type).toBe('connecting');

      await h.proc.start(START_ARG);
      expect(spawnCallCount()).toBe(1);
      await h.proc.exit();
    });
  });

  describe('stdout JSON parsing', () => {
    it('transitions to connecting on a valid sandbox JSON payload', async () => {
      const h = makeHarness('sandbox');
      await h.proc.start(START_ARG);
      h.child.emitStdout(`${SANDBOX_PAYLOAD  }\n`);

      const last = lastStatus(h.statuses);
      expect(last.type).toBe('connecting');
      if (last.type === 'connecting') {
        expect(last.data.uiUrl).toBe('http://sandbox:9000');
        expect(last.data.wsUrl).toBe('ws://sandbox:9000/ws');
        expect(last.data.containerName).toBe('omni-test');
        expect(last.data.containerId).toBe('abc123');
        expect(last.data.port).toBe(9000);
      }
      await h.proc.exit();
    });

    it('ignores malformed JSON lines', async () => {
      const h = makeHarness('sandbox');
      await h.proc.start(START_ARG);
      const before = h.statuses.length;
      h.child.emitStdout('not-json\n');
      h.child.emitStdout('{ this is { broken }\n');
      expect(h.statuses.length).toBe(before);
      expect(lastStatus(h.statuses).type).toBe('starting');
      await h.proc.exit();
    });

    it('buffers partial lines until a newline arrives', async () => {
      const h = makeHarness('sandbox');
      await h.proc.start(START_ARG);
      const before = h.statuses.length;
      const mid = Math.floor(SANDBOX_PAYLOAD.length / 2);
      h.child.emitStdout(SANDBOX_PAYLOAD.slice(0, mid));
      expect(h.statuses.length).toBe(before);
      h.child.emitStdout(`${SANDBOX_PAYLOAD.slice(mid)  }\n`);

      const connectingCount = h.statuses.filter((s) => s.type === 'connecting').length;
      expect(connectingCount).toBe(1);
      await h.proc.exit();
    });

    it('only parses the first valid JSON payload (jsonEmitted guard)', async () => {
      const h = makeHarness('sandbox');
      await h.proc.start(START_ARG);
      h.child.emitStdout(`${SANDBOX_PAYLOAD  }\n`);
      h.child.emitStdout(`${SANDBOX_PAYLOAD  }\n`);
      const connectingCount = h.statuses.filter((s) => s.type === 'connecting').length;
      expect(connectingCount).toBe(1);
      await h.proc.exit();
    });
  });

  describe('exit handling', () => {
    it('exit code 0 transitions to exited', async () => {
      const h = makeHarness('sandbox');
      await h.proc.start(START_ARG);
      h.child.emitClose(0);
      expect(lastStatus(h.statuses).type).toBe('exited');
    });

    it('SIGTERM while stopping transitions to exited (not error)', async () => {
      const h = makeHarness('sandbox');
      await h.proc.start(START_ARG);
      const stopPromise = h.proc.stop();
      expect(h.statuses.some((s) => s.type === 'stopping')).toBe(true);
      h.child.emitClose(null, 'SIGTERM');
      await stopPromise;
      expect(lastStatus(h.statuses).type).toBe('exited');
    });

    it('non-zero exit transitions to error', async () => {
      const h = makeHarness('sandbox');
      await h.proc.start(START_ARG);
      h.child.emitClose(1);
      const last = lastStatus(h.statuses);
      expect(last.type).toBe('error');
      if (last.type === 'error') {
        expect(last.error.message).toMatch(/code 1/);
      }
    });

    it('produces a port-conflict error message when stderr matches', async () => {
      const h = makeHarness('sandbox');
      await h.proc.start(START_ARG);
      h.child.emitStderr('Error: bind: address already in use\n');
      h.child.emitClose(1);
      const last = lastStatus(h.statuses);
      expect(last.type).toBe('error');
      if (last.type === 'error') {
        expect(last.error.message.toLowerCase()).toContain('port');
      }
    });

    it('spawn error event transitions to error status', async () => {
      const h = makeHarness('none');
      await h.proc.start(START_ARG);
      h.child.emit('error', new Error('boom'));
      const errStatus = h.statuses.find((s) => s.type === 'error');
      expect(errStatus).toBeDefined();
      if (errStatus?.type === 'error') {
        expect(errStatus.error.message).toBe('boom');
      }
    });
  });

  describe('arg building via spawn invocation', () => {
    it('sandbox mode includes --mode server, --workspace, --output json', async () => {
      const h = makeHarness('sandbox');
      await h.proc.start({ workspaceDir: '/test/ws' });
      expect(spawnCallCount()).toBe(1);
      const [binary, args] = spawnCall(0);
      expect(binary).toBe('/fake/bin/omni');
      expect(args).toContain('sandbox');
      expect(args).toContain('--mode');
      expect(args).toContain('server');
      expect(args).toContain('--workspace');
      expect(args).toContain('/test/ws');
      expect(args).toContain('--output');
      expect(args).toContain('json');
      await h.proc.exit();
    });

    it('podman mode sets OMNI_CONTAINER_RUNTIME=podman in spawn env', async () => {
      const h = makeHarness('podman');
      await h.proc.start({ workspaceDir: '/test/ws' });
      expect(spawnCallCount()).toBe(1);
      const [, , opts] = spawnCall(0);
      expect(opts.env['OMNI_CONTAINER_RUNTIME']).toBe('podman');
      await h.proc.exit();
    });

    it('none mode uses omni CLI directly with --mode server', async () => {
      const h = makeHarness('none');
      await h.proc.start({ workspaceDir: '/test/ws' });
      expect(spawnCallCount()).toBe(1);
      const [binary, args] = spawnCall(0);
      expect(binary).toBe('/fake/bin/omni');
      expect(args).toContain('--mode');
      expect(args).toContain('server');
      expect(args).toContain('--host');
      expect(args).toContain('127.0.0.1');
      // None mode transitions to connecting immediately (local port known upfront).
      expect(hasStatusType(h.statuses, 'connecting')).toBe(true);
      await h.proc.exit();
    });

    it('sandbox mode passes gitRepo url as env var', async () => {
      const h = makeHarness('sandbox');
      await h.proc.start({
        workspaceDir: '/test/ws',
        gitRepo: { url: 'https://github.com/x/y.git', branch: 'main' },
      });
      const [, args] = spawnCall(0);
      expect(args).toContain('--env');
      expect(args.some((a) => a === 'OMNI_GIT_REPO_URL=https://github.com/x/y.git')).toBe(true);
      expect(args.some((a) => a === 'OMNI_GIT_BRANCH=main')).toBe(true);
      await h.proc.exit();
    });
  });
});
