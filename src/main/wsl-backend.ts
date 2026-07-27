/**
 * WSL backend daemon lifecycle (docs/windows-wsl-backend-plan.md, Phase 2).
 *
 * Electron main owns the daemon: the server build (`out/server/index.mjs`)
 * runs as a child of `wsl.exe` inside the linked distro, started before the
 * BrowserWindow is created and killed on app quit. Auth is a per-boot shared
 * secret passed as `OMNI_RUNTIME_TOKEN_SECRET` — main mints WS tokens locally
 * with `signRuntimeToken`, no HTTP token fetch and no reliance on the WSL2
 * NAT loopback allowlist.
 *
 * Persistent mode (`WslBackend.persistent`): the daemon is spawned detached
 * (`nohup … &` via a one-shot runWsl) with a durable secret from the injected
 * secret store, survives app quit, and is adopted on the next boot when it is
 * healthy and version-matched. Failure detection has no exit event, so a
 * supervision health-poll drives the same backoff/terminal progression.
 *
 * Windows-only: every entry point no-ops (or reports `{ wsl: 'missing' }` /
 * idle status) on other platforms.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { app } from 'electron';

import { uuidv4 } from '@/lib/uuid';
import { signRuntimeToken } from '@/server/runtime-token';
import { DEFAULT_TENANT } from '@/server/ws-handler';
import type { IpcRendererEvents, RemoteBackend, WslBackend, WslBackendStatus, WslDetectResult } from '@/shared/types';

const HEALTH_POLL_INTERVAL_MS = 500;
const HEALTH_PROBE_TIMEOUT_MS = 1_000;
/** After this many consecutive daemon exits without a healthy period, stop
 *  retrying and surface the stderr tail — the next explicit link/boot resets. */
const MAX_CONSECUTIVE_FAILURES = 5;
const MAX_BACKOFF_MS = 30_000;
/** Rolling stderr capture for error status — enough for a stack trace. */
const STDERR_TAIL_CHARS = 4_096;
/** Persistent-mode supervision cadence once the daemon is `running`. */
const SUPERVISION_INTERVAL_MS = 5_000;
/** Quick re-probe spacing after a failed supervision probe — a slow GC pause
 *  or transient stall must not read as a death. */
const SUPERVISION_RETRY_MS = 1_000;
/** Consecutive failed supervision probes (initial + quick re-probes) before
 *  the detached daemon is declared dead. */
const SUPERVISION_MAX_MISSES = 3;
/** Detached daemons emit no exit event, so the startup health wait is bounded
 *  — a crash-looping daemon must still reach the backoff/terminal path. */
const STARTUP_PROBE_ATTEMPTS = 60;
/** Truncated at spawn time once it exceeds {@link MAX_DAEMON_LOG_BYTES} — a
 *  daemon that outlives the app would otherwise grow it unbounded. */
const MAX_DAEMON_LOG_BYTES = 1_000_000;

/** In-distro install root. Data dirs (`~/.config/Omni Code`, projects SQLite)
 *  live elsewhere, so re-provisioning this path never touches user data. */
const REMOTE_ROOT = '~/.omni/launcher';

/**
 * Every in-distro command runs as `wsl.exe -d <distro> --exec <argv…>`.
 * `--exec` passes argv to execvp exactly; the plain `--` form re-joins argv
 * with spaces and hands the string to the user's default shell, which destroys
 * the quoting around `sh -c <script>` (operators leak to the outer shell, env
 * assignments detach from the final command) and breaks under non-POSIX
 * default shells. Tilde expansion inside the scripts is done by the `sh -c`
 * we exec, not by wsl.exe.
 */
const execArgs = (distro: string, script: string): string[] => ['-d', distro, '--exec', 'sh', '-c', script];

/** Stage-then-swap unpack: a torn stdin stream can only ever corrupt the tmp
 *  dir, never a live install. */
const PROVISION_SCRIPT = `rm -rf ${REMOTE_ROOT}.tmp && mkdir -p ${REMOTE_ROOT}.tmp && tar xzf - -C ${REMOTE_ROOT}.tmp && rm -rf ${REMOTE_ROOT} && mv ${REMOTE_ROOT}.tmp ${REMOTE_ROOT}`;

/** A daemon left over from a crashed previous app holds an unknown secret and
 *  the pidfile's port — always replace it before spawning. */
const REAP_SCRIPT = `test -f ${REMOTE_ROOT}/daemon.pid && kill $(cat ${REMOTE_ROOT}/daemon.pid) 2>/dev/null; true`;

/** `exec` keeps the pidfile pointing at the node process itself, so REAP_SCRIPT
 *  kills the daemon and not a wrapper shell. */
const DAEMON_SCRIPT = `echo $$ > ${REMOTE_ROOT}/daemon.pid && exec ${REMOTE_ROOT}/node/bin/node ${REMOTE_ROOT}/server/index.mjs`;

const DAEMON_LOG = `${REMOTE_ROOT}/daemon.log`;

/**
 * Persistent-mode spawn: `nohup … &` detaches the daemon from wsl.exe, so it
 * (and the WSL VM) survives app quit. `env` execs into node keeping its pid,
 * so `$!` lands the node pid in the pidfile and REAP_SCRIPT works unchanged
 * across both modes. `;` separators keep the log-truncate check from
 * short-circuiting the spawn when the log doesn't exist yet.
 */
const detachedDaemonScript = (secret: string, port: number, launcherVersion: string): string =>
  `mkdir -p ${REMOTE_ROOT}; ` +
  `[ -f ${DAEMON_LOG} ] && [ "$(wc -c < ${DAEMON_LOG})" -gt ${MAX_DAEMON_LOG_BYTES} ] && : > ${DAEMON_LOG}; ` +
  `nohup env OMNI_RUNTIME_TOKEN_SECRET=${secret} PORT=${port} HOST=127.0.0.1 OMNI_LAUNCHER_VERSION=${launcherVersion} ` +
  `${REMOTE_ROOT}/node/bin/node ${REMOTE_ROOT}/server/index.mjs >> ${DAEMON_LOG} 2>&1 & ` +
  `echo $! > ${REMOTE_ROOT}/daemon.pid`;

/**
 * `wsl.exe` writes UTF-16LE to pipes (the classic silent parser bug — every
 * other byte is NUL). Decode as UTF-16LE when NUL bytes are present, else as
 * UTF-8 (already-decoded fixtures, hypothetical future wsl.exe versions).
 */
export function decodeWslOutput(raw: Buffer | string): string {
  if (typeof raw === 'string') {
    return raw.replaceAll('\0', '');
  }
  return raw.toString(raw.includes(0) ? 'utf16le' : 'utf8').replaceAll('\0', '');
}

/** Docker Desktop's plumbing distros — not usable targets for the daemon. */
const NOISE_DISTROS = new Set(['docker-desktop', 'docker-desktop-data']);

/** Parse `wsl.exe -l -q` output: one distro name per line, no header. */
export function parseWslDistroNames(raw: Buffer | string): string[] {
  return decodeWslOutput(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !NOISE_DISTROS.has(line));
}

/**
 * Parse the default distro from `wsl.exe -l -v` output. The `*` marker in the
 * first column is the locale-independent default indicator — plain `wsl -l`
 * appends a localized `(Default)` suffix that can't be matched reliably.
 * Distro names cannot contain whitespace, so the first token after `*` is the
 * full name.
 */
export function parseWslDefaultDistro(raw: Buffer | string): string | null {
  for (const line of decodeWslOutput(raw).split(/\r?\n/)) {
    const match = /^\s*\*\s+(\S+)/.exec(line);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

/** Capped exponential restart backoff: 1s → 2s → 4s → … → 30s. */
export function backoffDelayMs(consecutiveFailures: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, consecutiveFailures - 1), MAX_BACKOFF_MS);
}

export type RunWslResult = { code: number; stdout: Buffer; stderr: Buffer };

/** One-shot `wsl.exe <args>` execution; `stdinFile` streams a file into the
 *  child's stdin (used to pipe the payload tarball into `tar xzf -`). */
export type RunWsl = (args: string[], opts?: { stdinFile?: string }) => Promise<RunWslResult>;

/** Minimal tracked-child surface — lets tests inject an EventEmitter fake. */
export type WslDaemonChild = {
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
  once(event: 'exit', listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
};

export type SpawnWsl = (args: string[]) => WslDaemonChild;

/**
 * Launch `exe args…` elevated (UAC) — used by `install('platform')`, where
 * enabling the WSL Windows features requires admin. The elevated process is
 * detached and unobservable; the result reflects only the launcher process
 * (powershell) — non-zero when the UAC prompt is declined.
 */
export type RunElevated = (exe: string, args: string[]) => Promise<RunWslResult>;

/** Durable-secret persistence seam (persistent mode only). Production wraps
 *  the LocalSecretStore under a stable id; tests inject an in-memory fake. */
export type WslSecretStore = {
  getSecret(): Promise<string | null>;
  setSecret(value: string): Promise<void>;
  deleteSecret(): Promise<void>;
};

const defaultRunWsl: RunWsl = (args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn('wsl.exe', args, { windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({ code: code ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    if (opts?.stdinFile) {
      const stream = createReadStream(opts.stdinFile);
      stream.once('error', (err) => {
        child.kill();
        reject(err);
      });
      stream.pipe(child.stdin);
    } else {
      child.stdin.end();
    }
  });

const defaultSpawnWsl: SpawnWsl = (args) =>
  spawn('wsl.exe', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

/**
 * `Start-Process -Verb RunAs` is the supported way to trigger a UAC prompt
 * from an unelevated process. Powershell itself exits promptly: 0 once the
 * elevated (detached) process has been launched, non-zero when the prompt is
 * declined — that exit is all the caller can observe.
 */
const defaultRunElevated: RunElevated = (exe, args) =>
  new Promise((resolve, reject) => {
    const argumentList = args.map((a) => `'${a}'`).join(',');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-Command', `Start-Process ${exe} -ArgumentList ${argumentList} -Verb RunAs`],
      { windowsHide: true }
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({ code: code ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    child.stdin.end();
  });

/**
 * Bind-probe a free port on the Windows loopback. WSL2 NAT maps localhost
 * ports 1:1 (Windows→distro), so a port free here is the daemon's usable
 * listen port.
 */
const defaultPickFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port);
        } else {
          reject(new Error('port bind probe returned no address'));
        }
      });
    });
  });

/** Packaged: `extraResources`. Dev: the payload assembled into out/wsl-payload. */
const defaultPayloadPath = (): string =>
  app.isPackaged
    ? join(process.resourcesPath, 'omni-wsl-payload.tar.gz')
    : join(app.getAppPath(), 'out', 'wsl-payload', 'omni-wsl-payload.tar.gz');

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

type WslBackendManagerArgs = {
  /** Only the `remoteBackend` write is needed — reads happen in index.ts. */
  store: { set(key: 'remoteBackend', value: RemoteBackend): void };
  sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
  launcherVersion: string;
  /** Durable token-signing secret for persistent daemon mode. */
  secrets: WslSecretStore;
  /** Injectable exec/spawn/net/fs seams — required by the unit tests. */
  runWsl?: RunWsl;
  spawnWsl?: SpawnWsl;
  runElevated?: RunElevated;
  fetchFn?: typeof globalThis.fetch;
  platform?: NodeJS.Platform;
  payloadPath?: () => string;
  pickFreePort?: () => Promise<number>;
  supervisionIntervalMs?: number;
};

export class WslBackendManager {
  private readonly store: WslBackendManagerArgs['store'];
  private readonly sendToWindow: WslBackendManagerArgs['sendToWindow'];
  private readonly launcherVersion: string;
  private readonly secrets: WslSecretStore;
  private readonly runWsl: RunWsl;
  private readonly spawnWsl: SpawnWsl;
  private readonly runElevated: RunElevated;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly platform: NodeJS.Platform;
  private readonly payloadPath: () => string;
  private readonly pickFreePort: () => Promise<number>;
  private readonly supervisionIntervalMs: number;

  private status: WslBackendStatus = { state: 'idle', docker: 'unknown', timestamp: Date.now() };
  private distro: string | null = null;
  private port: number | null = null;
  /** Token-signing secret. Per-boot random in tracked mode (memory only);
   *  the durable stored secret in persistent mode. */
  private secret: string | null = null;
  /** Current lifecycle; set from the stored flag in boot() and flipped by
   *  setPersistent(). */
  private persistent = false;
  private child: WslDaemonChild | null = null;
  /** Bumped on every spawn (and on dispose) so stale exit handlers and health
   *  poll loops from a previous child can recognize themselves and bail. */
  private generation = 0;
  private consecutiveFailures = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** False until start(); flipped off on dispose and on terminal error. */
  private enabled = false;
  private stderrTail = '';

  constructor(arg: WslBackendManagerArgs) {
    this.store = arg.store;
    this.sendToWindow = arg.sendToWindow;
    this.launcherVersion = arg.launcherVersion;
    this.secrets = arg.secrets;
    this.runWsl = arg.runWsl ?? defaultRunWsl;
    this.spawnWsl = arg.spawnWsl ?? defaultSpawnWsl;
    this.runElevated = arg.runElevated ?? defaultRunElevated;
    this.fetchFn = arg.fetchFn ?? globalThis.fetch;
    this.platform = arg.platform ?? process.platform;
    this.payloadPath = arg.payloadPath ?? defaultPayloadPath;
    this.pickFreePort = arg.pickFreePort ?? defaultPickFreePort;
    this.supervisionIntervalMs = arg.supervisionIntervalMs ?? SUPERVISION_INTERVAL_MS;
  }

  getStatus(): WslBackendStatus {
    return this.status;
  }

  /** Probe for WSL and list installed distros (Docker Desktop noise excluded). */
  async detect(): Promise<WslDetectResult> {
    if (this.platform !== 'win32') {
      return { wsl: 'missing' };
    }
    let statusRes: RunWslResult;
    try {
      statusRes = await this.runWsl(['--status']);
    } catch {
      // spawn ENOENT — no wsl.exe on PATH at all.
      return { wsl: 'missing' };
    }
    if (statusRes.code !== 0) {
      return { wsl: 'missing' };
    }
    const listRes = await this.runWsl(['-l', '-q']);
    if (listRes.code !== 0) {
      // WSL installed but no distros registered (`wsl -l` exits non-zero).
      return { wsl: 'ok', distros: [] };
    }
    const names = parseWslDistroNames(listRes.stdout);
    let defaultName: string | null = null;
    try {
      const verbose = await this.runWsl(['-l', '-v']);
      if (verbose.code === 0) {
        defaultName = parseWslDefaultDistro(verbose.stdout);
      }
    } catch {
      // Default marker is best-effort — the list itself is still useful.
    }
    return { wsl: 'ok', distros: names.map((name) => ({ name, isDefault: name === defaultName })) };
  }

  /**
   * `wsl:install` — get a usable WSL onto a machine that has none.
   *
   * - `'platform'` (WSL entirely missing): enabling the Windows features
   *   needs elevation, so launch a one-shot elevated
   *   `wsl.exe --install --no-launch` via {@link RunElevated}. Fire-and-
   *   forget — the elevated process is detached and unobservable (likely
   *   ends in a reboot), so resolution only means the UAC prompt was
   *   accepted; a declined prompt exits non-zero and rejects.
   * - `'distro'` (WSL present, zero distros): `wsl.exe --install -d Ubuntu
   *   --no-launch` registers the WSL-default Ubuntu — no elevation, but the
   *   Store download can take minutes. This is a wsl.exe flag invocation,
   *   not an in-distro command, so it does NOT go through execArgs/--exec.
   *
   * Windows-only no-op elsewhere.
   */
  async install(mode: 'platform' | 'distro'): Promise<void> {
    if (this.platform !== 'win32') {
      return;
    }
    if (mode === 'platform') {
      const res = await this.runElevated('wsl.exe', ['--install', '--no-launch']);
      if (res.code !== 0) {
        throw new Error(`WSL install did not start (exit ${res.code}): ${decodeWslOutput(res.stderr).trim()}`);
      }
      return;
    }
    const res = await this.runWsl(['--install', '-d', 'Ubuntu', '--no-launch']);
    if (res.code !== 0) {
      throw new Error(`Ubuntu install failed (exit ${res.code}): ${decodeWslOutput(res.stderr).trim()}`);
    }
  }

  /**
   * Sync the in-distro payload with this launcher version. Returns whether a
   * provision actually ran (boot uses this to size the health-wait budget).
   * Rejects with captured stderr on failure — `wsl:link` runs this inline so
   * errors surface to the caller before any restart.
   */
  async provisionIfNeeded(distro: string): Promise<boolean> {
    if (this.platform !== 'win32') {
      return false;
    }
    const versionRes = await this.runWsl(execArgs(distro, `cat ${REMOTE_ROOT}/VERSION`));
    const remoteVersion = versionRes.code === 0 ? decodeWslOutput(versionRes.stdout).trim() : null;
    if (remoteVersion === this.launcherVersion) {
      return false;
    }
    const payload = this.payloadPath();
    if (!existsSync(payload)) {
      throw new Error(
        `WSL payload not found at ${payload}${
          app.isPackaged ? '' : ' — build it with `npm run build:server && npm run build:wsl-payload`'
        }`
      );
    }
    this.setStatus({ state: 'provisioning', distro });
    const res = await this.runWsl(execArgs(distro, PROVISION_SCRIPT), { stdinFile: payload });
    if (res.code !== 0) {
      throw new Error(`WSL provisioning failed (exit ${res.code}): ${decodeWslOutput(res.stderr).trim()}`);
    }
    return true;
  }

  /**
   * Full boot sequence: adopt-or-respawn (persistent mode) → provision-if-
   * needed → reap stale daemon → spawn → health-wait. Never throws and never
   * hangs past the cap — on timeout or error the caller creates the window
   * anyway (the WS transport reconnects and the settings card shows the error
   * status).
   */
  async boot(backend: WslBackend): Promise<void> {
    if (this.platform !== 'win32') {
      return;
    }
    this.persistent = backend.persistent === true;
    if (this.persistent && (await this.tryAdopt(backend))) {
      return;
    }
    let provisioned = false;
    try {
      provisioned = await this.provisionIfNeeded(backend.distro);
      await this.reapStaleDaemon(backend.distro);
      await this.start(backend.distro);
    } catch (err) {
      this.setStatus({ state: 'error', error: errorMessage(err) });
      return;
    }
    // First boot unpacks the Node runtime — give it a bigger budget.
    await this.waitForSettled(provisioned ? 120_000 : 30_000);
  }

  /**
   * Persistent-mode fast path: if the store points at a daemon left running by
   * a previous app session AND it is healthy AND it reports this exact
   * launcher version (renderer/daemon must never skew), adopt it — keep the
   * stored secret + port, run the docker check, no respawn. Anything else
   * falls through to the normal reap + provision + fresh-spawn boot, whose
   * REAP_SCRIPT kills the stale daemon by pidfile.
   */
  private async tryAdopt(backend: WslBackend): Promise<boolean> {
    if (backend.port <= 0) {
      return false;
    }
    const secret = await this.secrets.getSecret();
    if (!secret) {
      return false;
    }
    this.distro = backend.distro;
    this.port = backend.port;
    const health = await this.fetchHealth();
    if (!health || health.version !== this.launcherVersion) {
      return false;
    }
    this.secret = secret;
    this.enabled = true;
    this.consecutiveFailures = 0;
    const gen = ++this.generation;
    this.setStatus({ state: 'running', distro: backend.distro, port: backend.port });
    void this.checkDocker();
    void this.supervise(gen);
    return true;
  }

  /**
   * Pick a port, persist it into `store.remoteBackend` (the bootstrap URL in
   * main-process-manager derives from this, so it must land BEFORE window
   * creation), resolve the secret (per-boot random, or the durable stored one
   * in persistent mode), and spawn the daemon.
   */
  async start(distro: string): Promise<void> {
    if (this.platform !== 'win32') {
      return;
    }
    this.distro = distro;
    this.port = await this.pickFreePort();
    this.secret = this.persistent ? await this.ensureDurableSecret() : randomBytes(32).toString('hex');
    this.store.set('remoteBackend', {
      kind: 'wsl',
      distro,
      port: this.port,
      ...(this.persistent ? { persistent: true } : {}),
    });
    this.enabled = true;
    this.consecutiveFailures = 0;
    this.spawnDaemon();
  }

  /** Persistent mode signs tokens with a durable secret so a daemon left
   *  running by this session can be adopted next boot; reused on respawns. */
  private async ensureDurableSecret(): Promise<string> {
    const existing = await this.secrets.getSecret();
    if (existing) {
      return existing;
    }
    const generated = randomBytes(32).toString('hex');
    await this.secrets.setSecret(generated);
    return generated;
  }

  /**
   * Mode transition (`wsl:set-persistent`): restart the daemon into the new
   * lifecycle — tracked child (off) ↔ detached nohup (on). Turning on stores
   * a durable secret; turning off deletes it, back to per-boot. start()
   * persists the flag into `store.remoteBackend`. The restart interrupts any
   * agent work running in the daemon — the settings card copy warns about it.
   */
  async setPersistent(persistent: boolean): Promise<void> {
    if (this.platform !== 'win32') {
      return;
    }
    const distro = this.distro;
    if (!distro) {
      throw new Error('WSL backend is not active');
    }
    if (this.persistent === persistent) {
      return;
    }
    // Tear down the current lifecycle: stop loops/timers, kill the tracked
    // child, and reap by pidfile (which covers the detached daemon).
    this.enabled = false;
    this.generation += 1;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.child?.kill();
    this.child = null;
    await this.reapStaleDaemon(distro);
    this.persistent = persistent;
    if (!persistent) {
      await this.secrets.deleteSecret();
    }
    await this.start(distro);
  }

  /** Mint a WS auth token for the renderer (`wsl:get-ws-token`). */
  getWsToken(): string {
    if (!this.secret) {
      throw new Error('WSL daemon is not running');
    }
    return signRuntimeToken(this.secret, { tenantId: DEFAULT_TENANT, sessionId: uuidv4() });
  }

  dispose(): void {
    this.enabled = false;
    this.generation += 1;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    // Persistent mode: the daemon outliving the app is the whole point — stop
    // the poll/supervision loops (generation bump above) but leave the process
    // running to be adopted on the next boot.
    if (!this.persistent) {
      this.child?.kill();
    }
    this.child = null;
  }

  private async reapStaleDaemon(distro: string): Promise<void> {
    await this.runWsl(execArgs(distro, REAP_SCRIPT));
  }

  private spawnDaemon(): void {
    const { distro, port, secret } = this;
    if (!distro || port === null || !secret) {
      return;
    }
    const gen = ++this.generation;
    this.stderrTail = '';
    if (this.persistent) {
      this.setStatus({ state: 'starting', distro, port });
      void this.spawnDetached(gen, distro, port, secret);
      return;
    }
    const child = this.spawnWsl([
      '-d',
      distro,
      '--exec',
      'env',
      `OMNI_RUNTIME_TOKEN_SECRET=${secret}`,
      `PORT=${port}`,
      'HOST=127.0.0.1',
      `OMNI_LAUNCHER_VERSION=${this.launcherVersion}`,
      'sh',
      '-c',
      DAEMON_SCRIPT,
    ]);
    child.stderr?.on('data', (chunk) => {
      // wsl.exe's own error messages (bad distro, WSL not running) are
      // UTF-16LE; the daemon's Linux-side stderr is UTF-8. Decode per chunk.
      this.stderrTail = (this.stderrTail + decodeWslOutput(chunk)).slice(-STDERR_TAIL_CHARS);
    });
    child.once('exit', (code) => this.onDaemonDied(gen, code));
    this.child = child;
    this.setStatus({ state: 'starting', distro, port });
    void this.pollUntilHealthy(gen);
  }

  /** Persistent-mode spawn: the wsl.exe invocation backgrounds the daemon and
   *  returns immediately — from here on, failure is only observable through
   *  the health probes (bounded startup wait, then supervision). */
  private async spawnDetached(gen: number, distro: string, port: number, secret: string): Promise<void> {
    let res: RunWslResult;
    try {
      res = await this.runWsl(execArgs(distro, detachedDaemonScript(secret, port, this.launcherVersion)));
    } catch (err) {
      if (gen !== this.generation || !this.enabled) {
        return;
      }
      this.stderrTail = errorMessage(err);
      this.onDaemonDied(gen, null);
      return;
    }
    if (gen !== this.generation || !this.enabled) {
      return;
    }
    if (res.code !== 0) {
      this.stderrTail = decodeWslOutput(res.stderr).slice(-STDERR_TAIL_CHARS);
      this.onDaemonDied(gen, res.code);
      return;
    }
    void this.pollUntilHealthy(gen);
  }

  /** Shared death handler for both lifecycles: a tracked child's `exit`
   *  event, or a detached daemon's failed startup/supervision probes. */
  private onDaemonDied(gen: number, code: number | null): void {
    if (gen !== this.generation || !this.enabled) {
      return;
    }
    this.child = null;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      // Terminal until the next explicit link/boot.
      this.enabled = false;
      this.setStatus({
        state: 'error',
        error:
          this.stderrTail.trim() ||
          (this.persistent && code === null
            ? `daemon became unreachable — check ${DAEMON_LOG} in the distro`
            : `daemon exited with code ${code ?? 'unknown'}`),
      });
      return;
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.restartDaemon();
    }, backoffDelayMs(this.consecutiveFailures));
  }

  /** Backoff restart. A detached daemon has no tracked child to kill, and a
   *  half-dead one may still hold the port — reap by pidfile before
   *  respawning in persistent mode. */
  private async restartDaemon(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    if (this.persistent && this.distro) {
      const gen = this.generation;
      await this.reapStaleDaemon(this.distro);
      if (gen !== this.generation || !this.enabled) {
        return;
      }
    }
    this.spawnDaemon();
  }

  private async pollUntilHealthy(gen: number): Promise<void> {
    // Detached daemons emit no exit event, so persistent mode bounds the
    // startup wait; tracked children keep the unbounded wait (their exit
    // event drives failure detection).
    let attempts = 0;
    while (gen === this.generation && this.enabled) {
      if (await this.probeHealth()) {
        if (gen !== this.generation || !this.enabled) {
          return;
        }
        // A healthy period resets the backoff — only *consecutive* fast
        // exits escalate to the error state.
        this.consecutiveFailures = 0;
        this.setStatus({ state: 'running' });
        void this.checkDocker();
        if (this.persistent) {
          void this.supervise(gen);
        }
        return;
      }
      attempts += 1;
      if (this.persistent && attempts >= STARTUP_PROBE_ATTEMPTS) {
        this.onDaemonDied(gen, null);
        return;
      }
      await sleep(HEALTH_POLL_INTERVAL_MS);
    }
  }

  /**
   * Persistent-mode failure detection — there is no `exit` event, so poll the
   * health endpoint after reaching `running`. A failed probe is re-probed
   * twice more quickly (a slow GC pause must not read as a death); three
   * consecutive misses reap + respawn through the same backoff/terminal
   * progression as a tracked child exit. A successful probe resets both the
   * miss count and the consecutive-failure counter. Respects `generation` and
   * `enabled` exactly like pollUntilHealthy.
   */
  private async supervise(gen: number): Promise<void> {
    let misses = 0;
    while (gen === this.generation && this.enabled) {
      await sleep(misses === 0 ? this.supervisionIntervalMs : SUPERVISION_RETRY_MS);
      if (gen !== this.generation || !this.enabled) {
        return;
      }
      if (await this.probeHealth()) {
        misses = 0;
        this.consecutiveFailures = 0;
        continue;
      }
      misses += 1;
      if (misses >= SUPERVISION_MAX_MISSES) {
        if (gen !== this.generation || !this.enabled) {
          return;
        }
        this.onDaemonDied(gen, null);
        return;
      }
    }
  }

  private async probeHealth(): Promise<boolean> {
    return (await this.fetchHealth()) !== null;
  }

  /** GET /api/health → `{ ok, version }`; null on any failure. The version is
   *  only consulted by the adopt path — probes just need liveness. */
  private async fetchHealth(): Promise<{ version: string } | null> {
    if (this.port === null) {
      return null;
    }
    try {
      const res = await this.fetchFn(`http://127.0.0.1:${this.port}/api/health`, {
        signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
      });
      if (!res.ok) {
        return null;
      }
      const body = (await res.json()) as { ok?: boolean; version?: string };
      return body.ok === true ? { version: body.version ?? '' } : null;
    } catch {
      return null;
    }
  }

  /** Non-fatal environment check, run async after the daemon is healthy. */
  private async checkDocker(): Promise<void> {
    const distro = this.distro;
    if (!distro) {
      return;
    }
    try {
      const res = await this.runWsl(execArgs(distro, 'docker info'));
      if (res.code === 0) {
        this.setStatus({ docker: 'ok' });
        return;
      }
      const output = decodeWslOutput(res.stderr) + decodeWslOutput(res.stdout);
      // Shell "command not found" exits 127; anything else is an installed
      // docker CLI that can't reach its daemon.
      this.setStatus({ docker: res.code === 127 || /not found/i.test(output) ? 'missing' : 'daemon-down' });
    } catch {
      this.setStatus({ docker: 'daemon-down' });
    }
  }

  /** Resolve once the manager reaches a settled state (running/error) or the
   *  budget elapses — the boot cap that keeps window creation unblockable. */
  private async waitForSettled(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.status.state === 'running' || this.status.state === 'error') {
        return;
      }
      await sleep(250);
    }
  }

  private setStatus(patch: Partial<Omit<WslBackendStatus, 'timestamp'>>): void {
    const next: WslBackendStatus = { ...this.status, ...patch, persistent: this.persistent, timestamp: Date.now() };
    if (patch.state && patch.state !== 'error') {
      delete next.error;
    }
    this.status = next;
    this.sendToWindow('wsl:status-changed', this.status);
  }
}

export const createWslBackendManager = (arg: WslBackendManagerArgs): [WslBackendManager, () => void] => {
  const manager = new WslBackendManager(arg);
  return [manager, () => manager.dispose()];
};
