/**
 * Tests for ExtensionManager — descriptor listing, enable/disable,
 * instance status queries, refcount lifecycle, and cleanup.
 *
 * Mocks child_process.spawn, net.fetch, and the extension registry
 * so no real subprocesses or network calls occur.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted state
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => {
  const TEST_MANIFEST = {
    id: 'test-ext',
    name: 'Test Extension',
    description: 'A test extension',
    command: {
      buildExe: () => '/usr/bin/test-ext',
      buildArgs: (ctx: { port: number }) => ['--port', String(ctx.port)],
    },
    readiness: { type: 'http' as const, path: '/health', timeoutMs: 5000 },
    surface: {
      type: 'webview' as const,
      buildBaseUrl: (ctx: { port: number }) => `http://localhost:${ctx.port}`,
      buildContentUrl: (ctx: { port: number }, p: string) => `http://localhost:${ctx.port}/${p}`,
    },
    contentTypes: [{ extension: '.test', label: 'Test File' }],
    scope: 'per-cwd' as const,
    idleShutdownMs: 30_000,
  };

  return {
    spawnedProcs: [] as unknown[],
    fetchResults: new Map<string, { status: number }>(),
    TEST_MANIFEST,
  };
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('child_process', async () => {
  const { EventEmitter: EE } = await import('node:events');
  const spawnMock = vi.fn((_cmd: string, _args: string[], _opts: unknown) => {
    const proc = new EE() as InstanceType<typeof EE> & {
      pid: number;
      exitCode: number | null;
      stdout: InstanceType<typeof EE>;
      stderr: InstanceType<typeof EE>;
      kill: ReturnType<typeof vi.fn>;
    };
    proc.pid = 12345 + hoisted.spawnedProcs.length;
    proc.exitCode = null;
    proc.stdout = new EE();
    proc.stderr = new EE();
    proc.kill = vi.fn((signal?: string) => {
      proc.exitCode = signal === 'SIGKILL' ? 137 : 0;
      proc.emit('exit', proc.exitCode, signal);
      return true;
    });
    hoisted.spawnedProcs.push(proc);
    return proc;
  });
  return { spawn: spawnMock, default: { spawn: spawnMock } };
});

vi.mock('electron', () => ({
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() },
  net: {
    fetch: vi.fn(async (url: string) => {
      const result = hoisted.fetchResults.get(url);
      if (result) {
        return { status: result.status };
      }
      throw new Error('ECONNREFUSED');
    }),
  },
}));

vi.mock('@/main/store', () => ({
  store: { get: vi.fn(() => undefined), set: vi.fn() },
}));

vi.mock('@/main/extensions/registry', () => ({
  BUILTIN_EXTENSIONS: [hoisted.TEST_MANIFEST],
  getManifest: (id: string) => (id === 'test-ext' ? hoisted.TEST_MANIFEST : null),
}));

vi.mock('@/lib/free-port', () => ({
  getFreePort: vi.fn(async () => 9999),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { ExtensionManager } from '@/main/extension-manager';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore() {
  const data: Record<string, unknown> = {};
  return {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
    _data: data,
  };
}

function makeMgr() {
  hoisted.spawnedProcs = [];
  hoisted.fetchResults.clear();
  const store = makeStore();
  const sendCalls: Array<{ channel: string; args: unknown[] }> = [];
  const mgr = new ExtensionManager({
    store: store as never,
    sendToWindow: ((channel: string, ...args: unknown[]) => {
      sendCalls.push({ channel, args });
    }) as never,
  });
  return { mgr, store, sendCalls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ExtensionManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('listDescriptors', () => {
    it('returns builtin extensions with enabled status', () => {
      const { mgr } = makeMgr();
      const descriptors = mgr.listDescriptors();

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]!.id).toBe('test-ext');
      expect(descriptors[0]!.name).toBe('Test Extension');
      expect(descriptors[0]!.enabled).toBe(false);
    });

    it('reflects enabled state from store', () => {
      const { mgr, store } = makeMgr();
      store.set('enabledExtensions', { 'test-ext': true });

      const descriptors = mgr.listDescriptors();
      expect(descriptors[0]!.enabled).toBe(true);
    });
  });

  describe('isEnabled', () => {
    it('returns false when not enabled', () => {
      const { mgr } = makeMgr();
      expect(mgr.isEnabled('test-ext')).toBe(false);
    });

    it('returns true when enabled in store', () => {
      const { mgr, store } = makeMgr();
      store.set('enabledExtensions', { 'test-ext': true });
      expect(mgr.isEnabled('test-ext')).toBe(true);
    });

    it('returns false for unknown extension', () => {
      const { mgr } = makeMgr();
      expect(mgr.isEnabled('nonexistent')).toBe(false);
    });
  });

  describe('setEnabled', () => {
    it('persists enabled state to store', async () => {
      const { mgr, store } = makeMgr();
      await mgr.setEnabled('test-ext', true);

      expect(store.set).toHaveBeenCalledWith('enabledExtensions', { 'test-ext': true });
    });

    it('is a no-op for unknown extension', async () => {
      const { mgr, store } = makeMgr();
      await mgr.setEnabled('nonexistent', true);

      // Should not have called set (no-op for unknown)
      expect(store.set).not.toHaveBeenCalled();
    });
  });

  describe('getInstanceStatus', () => {
    it('returns idle for unknown instance', () => {
      const { mgr } = makeMgr();
      const status = mgr.getInstanceStatus('test-ext', '/tmp/cwd');
      expect(status).toEqual({ state: 'idle' });
    });
  });

  describe('getLogs', () => {
    it('returns empty string for unknown instance', () => {
      const { mgr } = makeMgr();
      expect(mgr.getLogs('test-ext', '/tmp/cwd')).toBe('');
    });
  });

  describe('ensureInstance', () => {
    it('rejects when extension is not enabled', async () => {
      const { mgr } = makeMgr();
      await expect(mgr.ensureInstance('test-ext', '/tmp')).rejects.toThrow('not enabled');
    });

    it('rejects for unknown extension', async () => {
      const { mgr, store } = makeMgr();
      store.set('enabledExtensions', { 'unknown-ext': true });
      await expect(mgr.ensureInstance('unknown-ext', '/tmp')).rejects.toThrow('Unknown extension');
    });

    it('spawns process and transitions to running when readiness probe succeeds', async () => {
      const { mgr, store, sendCalls } = makeMgr();
      store.set('enabledExtensions', { 'test-ext': true });

      // Make readiness probe succeed immediately
      hoisted.fetchResults.set('http://localhost:9999/health', { status: 200 });

      const result = await mgr.ensureInstance('test-ext', '/tmp/ws');

      expect(result.url).toBe('http://localhost:9999');
      expect(result.port).toBe(9999);
      expect(hoisted.spawnedProcs).toHaveLength(1);

      // Should have transitioned through starting → running
      const transitions = sendCalls.filter((c) => c.channel === 'extension:status-changed');
      expect(transitions.length).toBeGreaterThanOrEqual(2);
      const lastTransition = transitions[transitions.length - 1]!;
      expect(lastTransition.args[2]).toEqual(
        expect.objectContaining({ state: 'running', port: 9999 })
      );
    });

    it('returns cached result for already-running instance', async () => {
      const { mgr, store } = makeMgr();
      store.set('enabledExtensions', { 'test-ext': true });
      hoisted.fetchResults.set('http://localhost:9999/health', { status: 200 });

      const first = await mgr.ensureInstance('test-ext', '/tmp/ws');
      const second = await mgr.ensureInstance('test-ext', '/tmp/ws');

      // Same result, only 1 process spawned
      expect(first).toEqual(second);
      expect(hoisted.spawnedProcs).toHaveLength(1);
    });

    it('increments refcount on repeated ensure calls', async () => {
      const { mgr, store } = makeMgr();
      store.set('enabledExtensions', { 'test-ext': true });
      hoisted.fetchResults.set('http://localhost:9999/health', { status: 200 });

      await mgr.ensureInstance('test-ext', '/tmp');
      await mgr.ensureInstance('test-ext', '/tmp');

      // Release once — should not trigger shutdown yet
      mgr.releaseInstance('test-ext', '/tmp');
      const status = mgr.getInstanceStatus('test-ext', '/tmp');
      expect(status.state).toBe('running');
    });
  });

  describe('releaseInstance', () => {
    it('is a no-op for unknown instance', () => {
      const { mgr } = makeMgr();
      mgr.releaseInstance('test-ext', '/tmp'); // should not throw
    });
  });

  describe('cleanup', () => {
    it('stops all running instances', async () => {
      const { mgr, store } = makeMgr();
      store.set('enabledExtensions', { 'test-ext': true });
      hoisted.fetchResults.set('http://localhost:9999/health', { status: 200 });

      await mgr.ensureInstance('test-ext', '/tmp');
      expect(hoisted.spawnedProcs).toHaveLength(1);

      await mgr.cleanup();

      // Process should have been killed
      const proc = hoisted.spawnedProcs[0] as { kill: ReturnType<typeof vi.fn> };
      expect(proc.kill).toHaveBeenCalled();

      // Status should reset
      expect(mgr.getInstanceStatus('test-ext', '/tmp')).toEqual({ state: 'idle' });
    });
  });
});
