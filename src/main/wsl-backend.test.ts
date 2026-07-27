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
import type { WslBackend } from '@/shared/types';

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
  /** `version` reported by the fake /api/health (defaults to the launcher's). */
  fetchVersion?: string;
  /** Full fetch override — takes precedence over fetchOk/fetchVersion. */
  fetchImpl?: () => Promise<Response>;
  /** Preloaded durable secret, as if a previous session stored one. */
  storedSecret?: string;
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
  const secretState: { value: string | null } = { value: opts.storedSecret ?? null };
  const secrets = {
    getSecret: () => Promise.resolve(secretState.value),
    setSecret: (value: string) => {
      secretState.value = value;
      return Promise.resolve();
    },
    deleteSecret: () => {
      secretState.value = null;
      return Promise.resolve();
    },
  };
  const fetchFn = (opts.fetchImpl ??
    (opts.fetchOk
      ? () =>
          Promise.resolve(
            new Response(JSON.stringify({ ok: true, version: opts.fetchVersion ?? '1.2.3' }), { status: 200 })
          )
      : () => Promise.reject(new Error('connection refused')))) as unknown as typeof globalThis.fetch;
  const [manager, cleanup] = createWslBackendManager({
    store: { set: storeSet },
    sendToWindow: vi.fn(),
    launcherVersion: '1.2.3',
    secrets,
    platform: opts.platform ?? 'win32',
    runWsl,
    spawnWsl,
    fetchFn,
    payloadPath: () => payloadFile,
    pickFreePort: () => Promise.resolve(43_210),
  });
  return { manager, cleanup, runCalls, spawns, storeSet, secretState };
}

const isProvisionCall = (call: RunCall): boolean => call.args.some((a) => a.includes('tar xzf -'));
// The VERSION read runs as `--exec sh -c 'cat …'` — the script is one argv element.
const hasCatScript = (args: string[]): boolean => args.some((a) => a.startsWith('cat '));
const isVersionCall = (call: RunCall): boolean => hasCatScript(call.args);
// Persistent-mode daemon start runs as a one-shot `nohup … &` script.
const isDetachedSpawnCall = (call: RunCall): boolean => call.args.some((a) => a.includes('nohup'));
// REAP_SCRIPT kills by pidfile; the detached spawn script only writes it.
const isReapCall = (call: RunCall): boolean => call.args.some((a) => a.includes('daemon.pid && kill'));

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

// ---------------------------------------------------------------------------
// Persistent daemon mode — adopt-or-respawn boot, supervision, transitions.
// ---------------------------------------------------------------------------

const STORED_SECRET = 'ab'.repeat(32);

const persistentBackend: WslBackend = { kind: 'wsl', distro: 'Ubuntu-22.04', port: 43_210, persistent: true };

describe('persistent daemon mode', () => {
  it('adopts a healthy version-matched daemon: no respawn, stored secret mints valid tokens', async () => {
    vi.useFakeTimers();
    const { manager, cleanup, runCalls, spawns } = makeManager({
      respond: () => ok(),
      fetchOk: true,
      storedSecret: STORED_SECRET,
    });
    try {
      await manager.boot({ ...persistentBackend });
      expect(manager.getStatus().state).toBe('running');
      expect(manager.getStatus().persistent).toBe(true);
      // Adopted, not respawned: no tracked child, no detached nohup, and the
      // existing install is left alone (no provision, no reap).
      expect(spawns).toHaveLength(0);
      expect(runCalls.some(isDetachedSpawnCall)).toBe(false);
      expect(runCalls.some(isProvisionCall)).toBe(false);
      expect(runCalls.some(isReapCall)).toBe(false);
      const claims = verifyRuntimeToken(STORED_SECRET, manager.getWsToken());
      expect(claims).not.toBeNull();
      expect(claims?.tenantId).toBe('local');
    } finally {
      cleanup();
    }
  });

  it('reaps + provisions + respawns detached when the daemon reports a mismatched version', async () => {
    vi.useFakeTimers();
    const { manager, cleanup, runCalls, spawns, storeSet } = makeManager({
      respond: (args) => (hasCatScript(args) ? ok('1.0.0\n') : ok()),
      fetchOk: true,
      fetchVersion: '9.9.9',
      storedSecret: STORED_SECRET,
    });
    try {
      const boot = manager.boot({ ...persistentBackend });
      await vi.advanceTimersByTimeAsync(5_000);
      await boot;
      expect(runCalls.some(isProvisionCall)).toBe(true);
      expect(runCalls.some(isReapCall)).toBe(true);
      const detached = runCalls.find(isDetachedSpawnCall);
      expect(detached).toBeDefined();
      // The durable secret is reused for the fresh daemon; no tracked child.
      expect(detached?.args.join(' ')).toContain(`OMNI_RUNTIME_TOKEN_SECRET=${STORED_SECRET}`);
      expect(spawns).toHaveLength(0);
      expect(manager.getStatus().state).toBe('running');
      expect(storeSet).toHaveBeenLastCalledWith('remoteBackend', {
        kind: 'wsl',
        distro: 'Ubuntu-22.04',
        port: 43_210,
        persistent: true,
      });
    } finally {
      cleanup();
    }
  });

  it('supervision declares death after 3 missed probes, reaps + respawns, and errors out terminally', async () => {
    vi.useFakeTimers();
    let healthy = true;
    const fetchImpl = () =>
      healthy
        ? Promise.resolve(new Response(JSON.stringify({ ok: true, version: '1.2.3' }), { status: 200 }))
        : Promise.reject(new Error('connection refused'));
    const { manager, cleanup, runCalls } = makeManager({
      respond: () => ok(),
      fetchImpl,
      storedSecret: STORED_SECRET,
    });
    try {
      await manager.boot({ ...persistentBackend });
      expect(manager.getStatus().state).toBe('running');
      const callsBefore = runCalls.length;

      healthy = false;
      // 5s supervision probe misses, then two quick 1s re-probes miss —
      // a single miss (slow GC) must not count as a death.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(manager.getStatus().state).toBe('running');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(manager.getStatus().state).toBe('running');
      // Third miss → died → 1s backoff → reap + detached respawn.
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      const afterDeath = runCalls.slice(callsBefore);
      expect(afterDeath.some(isReapCall)).toBe(true);
      expect(afterDeath.some(isDetachedSpawnCall)).toBe(true);

      // Still unreachable: each respawn exhausts the bounded startup probe
      // budget, walking the same backoff progression to the terminal error
      // after 5 consecutive failures.
      await vi.advanceTimersByTimeAsync(300_000);
      expect(manager.getStatus().state).toBe('error');
      expect(manager.getStatus().error).toMatch(/unreachable/);
    } finally {
      cleanup();
    }
  });

  it('turning persistence on stores a durable secret and switches to a detached spawn', async () => {
    vi.useFakeTimers();
    const { manager, cleanup, runCalls, spawns, storeSet, secretState } = makeManager({
      respond: () => ok(),
      fetchOk: true,
    });
    try {
      await manager.start('Ubuntu-22.04');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(manager.getStatus().state).toBe('running');
      expect(spawns).toHaveLength(1);
      expect(secretState.value).toBeNull();

      await manager.setPersistent(true);
      // Old tracked child killed + reaped; a durable secret now exists and
      // rides in the detached spawn script; no new tracked child.
      expect(spawns[0]?.child.killed).toBe(true);
      expect(runCalls.some(isReapCall)).toBe(true);
      expect(secretState.value).toMatch(/^[0-9a-f]{64}$/);
      const detached = runCalls.find(isDetachedSpawnCall);
      expect(detached?.args.join(' ')).toContain(`OMNI_RUNTIME_TOKEN_SECRET=${secretState.value}`);
      expect(spawns).toHaveLength(1);
      expect(storeSet).toHaveBeenLastCalledWith('remoteBackend', {
        kind: 'wsl',
        distro: 'Ubuntu-22.04',
        port: 43_210,
        persistent: true,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(manager.getStatus().state).toBe('running');
      expect(manager.getStatus().persistent).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('turning persistence off deletes the stored secret and returns to a tracked spawn', async () => {
    vi.useFakeTimers();
    const { manager, cleanup, runCalls, spawns, storeSet, secretState } = makeManager({
      respond: () => ok(),
      fetchOk: true,
      storedSecret: STORED_SECRET,
    });
    try {
      await manager.boot({ ...persistentBackend });
      expect(manager.getStatus().persistent).toBe(true);

      await manager.setPersistent(false);
      expect(secretState.value).toBeNull();
      expect(runCalls.some(isReapCall)).toBe(true);
      expect(runCalls.some(isDetachedSpawnCall)).toBe(false);
      expect(spawns).toHaveLength(1);
      expect(storeSet).toHaveBeenLastCalledWith('remoteBackend', {
        kind: 'wsl',
        distro: 'Ubuntu-22.04',
        port: 43_210,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(manager.getStatus().state).toBe('running');
      expect(manager.getStatus().persistent).toBe(false);
    } finally {
      cleanup();
    }
  });
});
