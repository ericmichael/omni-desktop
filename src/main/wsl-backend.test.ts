import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  backoffDelayMs,
  createWslBackendManager,
  parseWslDefaultDistro,
  parseWslDistroNames,
  type RunWsl,
  type RunWslResult,
  type SpawnWsl,
  type WslDaemonChild,
} from '@/main/wsl-backend';
import { verifyRuntimeToken } from '@/server/runtime-token';

// ---------------------------------------------------------------------------
// Fixtures — realistic wsl.exe output. wsl.exe writes UTF-16LE to pipes, so
// fixtures are built by encoding the human-readable text the same way.
// ---------------------------------------------------------------------------

const LIST_QUIET = Buffer.from('Ubuntu-22.04\r\ndocker-desktop\r\ndocker-desktop-data\r\nDebian\r\n\r\n', 'utf16le');

const LIST_VERBOSE = Buffer.from(
  '  NAME                   STATE           VERSION\r\n' +
    '* Ubuntu-22.04           Running         2\r\n' +
    '  docker-desktop         Stopped         2\r\n' +
    '  Debian                 Stopped         2\r\n',
  'utf16le'
);

describe('wsl.exe output parsing', () => {
  it('decodes UTF-16LE -l -q output, dropping CRs, blanks, and Docker Desktop noise', () => {
    expect(parseWslDistroNames(LIST_QUIET)).toEqual(['Ubuntu-22.04', 'Debian']);
  });

  it('finds the default distro via the locale-independent * marker in -l -v output', () => {
    expect(parseWslDefaultDistro(LIST_VERBOSE)).toBe('Ubuntu-22.04');
  });

  it('returns null when no default marker is present', () => {
    const raw = Buffer.from('  NAME    STATE     VERSION\r\n  Debian  Stopped   2\r\n', 'utf16le');
    expect(parseWslDefaultDistro(raw)).toBeNull();
  });

  it('tolerates already-decoded (UTF-8) input', () => {
    expect(parseWslDistroNames('Ubuntu\nDebian\n')).toEqual(['Ubuntu', 'Debian']);
  });
});

describe('backoffDelayMs', () => {
  it('doubles from 1s and caps at 30s', () => {
    expect(backoffDelayMs(1)).toBe(1_000);
    expect(backoffDelayMs(2)).toBe(2_000);
    expect(backoffDelayMs(3)).toBe(4_000);
    expect(backoffDelayMs(4)).toBe(8_000);
    expect(backoffDelayMs(5)).toBe(16_000);
    expect(backoffDelayMs(6)).toBe(30_000);
    expect(backoffDelayMs(10)).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// Manager harness — injected exec/spawn/net/fetch seams.
// ---------------------------------------------------------------------------

class FakeChild extends EventEmitter implements WslDaemonChild {
  stderr = new EventEmitter();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

type RunCall = { args: string[]; stdinFile?: string };

const ok = (stdout = ''): RunWslResult => ({ code: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) });
const fail = (code: number, stderr = ''): RunWslResult => ({
  code,
  stdout: Buffer.alloc(0),
  stderr: Buffer.from(stderr),
});

const scratchDir = mkdtempSync(join(tmpdir(), 'wsl-backend-test-'));
const payloadFile = join(scratchDir, 'omni-wsl-payload.tar.gz');
writeFileSync(payloadFile, 'not-a-real-tarball');

function makeManager(opts: {
  respond: (args: string[]) => RunWslResult;
  autoExitCode?: number | null;
  fetchOk?: boolean;
  platform?: NodeJS.Platform;
}) {
  const runCalls: RunCall[] = [];
  const runWsl: RunWsl = (args, o) => {
    runCalls.push({ args, ...(o?.stdinFile ? { stdinFile: o.stdinFile } : {}) });
    return Promise.resolve(opts.respond(args));
  };
  const spawns: { args: string[]; child: FakeChild }[] = [];
  const spawnWsl: SpawnWsl = (args) => {
    const child = new FakeChild();
    spawns.push({ args, child });
    if (opts.autoExitCode !== undefined) {
      // Emitted on a microtask so the manager attaches its exit listener first.
      queueMicrotask(() => child.emit('exit', opts.autoExitCode));
    }
    return child;
  };
  const storeSet = vi.fn();
  const fetchFn = (opts.fetchOk
    ? () => Promise.resolve(new Response(JSON.stringify({ ok: true, version: '1.2.3' }), { status: 200 }))
    : () => Promise.reject(new Error('connection refused'))) as unknown as typeof globalThis.fetch;
  const [manager, cleanup] = createWslBackendManager({
    store: { set: storeSet },
    sendToWindow: vi.fn(),
    launcherVersion: '1.2.3',
    platform: opts.platform ?? 'win32',
    runWsl,
    spawnWsl,
    fetchFn,
    payloadPath: () => payloadFile,
    pickFreePort: () => Promise.resolve(43_210),
  });
  return { manager, cleanup, runCalls, spawns, storeSet };
}

const isProvisionCall = (call: RunCall): boolean => call.args.some((a) => a.includes('tar xzf -'));
// The VERSION read runs as `--exec sh -c 'cat …'` — the script is one argv element.
const hasCatScript = (args: string[]): boolean => args.some((a) => a.startsWith('cat '));
const isVersionCall = (call: RunCall): boolean => hasCatScript(call.args);

afterEach(() => {
  vi.useRealTimers();
});

describe('provisioning decision', () => {
  it('skips provisioning when the remote VERSION matches the launcher version', async () => {
    const { manager, cleanup, runCalls } = makeManager({
      respond: (args) => (hasCatScript(args) ? ok('1.2.3\n') : ok()),
    });
    try {
      await expect(manager.provisionIfNeeded('Ubuntu-22.04')).resolves.toBe(false);
      expect(runCalls.some(isVersionCall)).toBe(true);
      expect(runCalls.some(isProvisionCall)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('provisions on VERSION mismatch, streaming the payload tarball via stdin', async () => {
    const { manager, cleanup, runCalls } = makeManager({
      respond: (args) => (hasCatScript(args) ? ok('1.0.0\n') : ok()),
    });
    try {
      await expect(manager.provisionIfNeeded('Ubuntu-22.04')).resolves.toBe(true);
      const provision = runCalls.find(isProvisionCall);
      expect(provision).toBeDefined();
      expect(provision?.stdinFile).toBe(payloadFile);
      // Stage-then-swap: unpack into launcher.tmp, then atomically replace.
      expect(provision?.args.join(' ')).toContain('launcher.tmp');
      // `--exec` is load-bearing: the plain `--` form re-joins argv through the
      // default shell and destroys the sh -c quoting (see execArgs).
      expect(provision?.args).toContain('--exec');
    } finally {
      cleanup();
    }
  });

  it('provisions when the remote VERSION file is missing', async () => {
    const { manager, cleanup, runCalls } = makeManager({
      respond: (args) => (hasCatScript(args) ? fail(1, 'cat: no such file') : ok()),
    });
    try {
      await expect(manager.provisionIfNeeded('Ubuntu-22.04')).resolves.toBe(true);
      expect(runCalls.some(isProvisionCall)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('rejects with the captured stderr when the provision command fails', async () => {
    const { manager, cleanup } = makeManager({
      respond: (args) => {
        if (hasCatScript(args)) {
          return fail(1);
        }
        // Linux-side stderr (tar) is plain UTF-8 — unlike wsl.exe's own
        // UTF-16LE chatter — and must decode verbatim.
        return args.some((a) => a.includes('tar xzf -')) ? fail(2, 'tar: unexpected EOF') : ok();
      },
    });
    try {
      await expect(manager.provisionIfNeeded('Ubuntu-22.04')).rejects.toThrow(/tar: unexpected EOF/);
    } finally {
      cleanup();
    }
  });

  it('no-ops off Windows', async () => {
    const { manager, cleanup, runCalls } = makeManager({ respond: () => ok(), platform: 'linux' });
    try {
      await expect(manager.provisionIfNeeded('Ubuntu-22.04')).resolves.toBe(false);
      expect(runCalls).toHaveLength(0);
      expect(await manager.detect()).toEqual({ wsl: 'missing' });
      expect(manager.getStatus().state).toBe('idle');
    } finally {
      cleanup();
    }
  });
});

describe('detect', () => {
  it('lists distros with the default flagged from -l -v', async () => {
    const { manager, cleanup } = makeManager({
      respond: (args) => {
        if (args[0] === '--status') {
          return ok();
        }
        if (args.join(' ') === '-l -q') {
          return { code: 0, stdout: LIST_QUIET, stderr: Buffer.alloc(0) };
        }
        if (args.join(' ') === '-l -v') {
          return { code: 0, stdout: LIST_VERBOSE, stderr: Buffer.alloc(0) };
        }
        return fail(1);
      },
    });
    try {
      await expect(manager.detect()).resolves.toEqual({
        wsl: 'ok',
        distros: [
          { name: 'Ubuntu-22.04', isDefault: true },
          { name: 'Debian', isDefault: false },
        ],
      });
    } finally {
      cleanup();
    }
  });

  it('reports missing when wsl --status fails', async () => {
    const { manager, cleanup } = makeManager({
      respond: (args) => (args[0] === '--status' ? fail(1) : ok()),
    });
    try {
      await expect(manager.detect()).resolves.toEqual({ wsl: 'missing' });
    } finally {
      cleanup();
    }
  });
});

describe('daemon restart backoff', () => {
  it('restarts with capped exponential backoff and errors out after 5 consecutive failures', async () => {
    vi.useFakeTimers();
    const { manager, cleanup, spawns, storeSet } = makeManager({
      respond: () => ok(),
      autoExitCode: 1,
      fetchOk: false,
    });
    try {
      await manager.start('Ubuntu-22.04');
      // Port persisted into the store BEFORE any window could exist.
      expect(storeSet).toHaveBeenCalledWith('remoteBackend', {
        kind: 'wsl',
        distro: 'Ubuntu-22.04',
        port: 43_210,
      });
      expect(spawns).toHaveLength(1);

      // Failure 1 → 1s delay.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(999);
      expect(spawns).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(spawns).toHaveLength(2);

      // Failure 2 → 2s delay.
      await vi.advanceTimersByTimeAsync(1_999);
      expect(spawns).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(spawns).toHaveLength(3);

      // Failure 3 → 4s, failure 4 → 8s.
      await vi.advanceTimersByTimeAsync(4_000);
      expect(spawns).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(spawns).toHaveLength(5);

      // Failure 5 → terminal error state; no further restarts ever.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(spawns).toHaveLength(5);
      expect(manager.getStatus().state).toBe('error');
      expect(manager.getStatus().error).toMatch(/exited with code 1/);
    } finally {
      cleanup();
    }
  });

  it('reaches running (and resets the failure counter) once health reports ok', async () => {
    vi.useFakeTimers();
    const { manager, cleanup, spawns } = makeManager({ respond: () => ok(), fetchOk: true });
    try {
      await manager.start('Ubuntu-22.04');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(manager.getStatus().state).toBe('running');
      expect(manager.getStatus().docker).toBe('ok');
      expect(spawns).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});

describe('token minting', () => {
  it('mints tokens that round-trip through verifyRuntimeToken with the spawned secret', async () => {
    const { manager, cleanup, spawns } = makeManager({ respond: () => ok(), fetchOk: false });
    try {
      await manager.start('Ubuntu-22.04');
      const spawned = spawns.at(0);
      expect(spawned).toBeDefined();
      const secretArg = spawned?.args.find((a) => a.startsWith('OMNI_RUNTIME_TOKEN_SECRET='));
      expect(secretArg).toBeDefined();
      const secret = (secretArg ?? '').slice('OMNI_RUNTIME_TOKEN_SECRET='.length);
      expect(secret).toMatch(/^[0-9a-f]{64}$/);

      const token = manager.getWsToken();
      const claims = verifyRuntimeToken(secret, token);
      expect(claims).not.toBeNull();
      expect(claims?.tenantId).toBe('local');
      expect(claims?.sessionId).toMatch(/^[0-9a-f-]{36}$/);

      // Tampered tokens verify to null.
      expect(verifyRuntimeToken(secret, `${token}x`)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('refuses to mint before the daemon has been started', () => {
    const { manager, cleanup } = makeManager({ respond: () => ok() });
    try {
      expect(() => manager.getWsToken()).toThrow(/not running/);
    } finally {
      cleanup();
    }
  });
});
