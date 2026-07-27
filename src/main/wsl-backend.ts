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
import type { IpcRendererEvents, RemoteBackend, WslBackendStatus, WslDetectResult } from '@/shared/types';

const HEALTH_POLL_INTERVAL_MS = 500;
const HEALTH_PROBE_TIMEOUT_MS = 1_000;
/** After this many consecutive daemon exits without a healthy period, stop
 *  retrying and surface the stderr tail — the next explicit link/boot resets. */
const MAX_CONSECUTIVE_FAILURES = 5;
const MAX_BACKOFF_MS = 30_000;
/** Rolling stderr capture for error status — enough for a stack trace. */
const STDERR_TAIL_CHARS = 4_096;

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
  /** Injectable exec/spawn/net/fs seams — required by the unit tests. */
  runWsl?: RunWsl;
  spawnWsl?: SpawnWsl;
  fetchFn?: typeof globalThis.fetch;
  platform?: NodeJS.Platform;
  payloadPath?: () => string;
  pickFreePort?: () => Promise<number>;
};

export class WslBackendManager {
  private readonly store: WslBackendManagerArgs['store'];
  private readonly sendToWindow: WslBackendManagerArgs['sendToWindow'];
  private readonly launcherVersion: string;
  private readonly runWsl: RunWsl;
  private readonly spawnWsl: SpawnWsl;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly platform: NodeJS.Platform;
  private readonly payloadPath: () => string;
  private readonly pickFreePort: () => Promise<number>;

  private status: WslBackendStatus = { state: 'idle', docker: 'unknown', timestamp: Date.now() };
  private distro: string | null = null;
  private port: number | null = null;
  /** Per-boot token-signing secret; held in memory only, never persisted. */
  private secret: string | null = null;
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
    this.runWsl = arg.runWsl ?? defaultRunWsl;
    this.spawnWsl = arg.spawnWsl ?? defaultSpawnWsl;
    this.fetchFn = arg.fetchFn ?? globalThis.fetch;
    this.platform = arg.platform ?? process.platform;
    this.payloadPath = arg.payloadPath ?? defaultPayloadPath;
    this.pickFreePort = arg.pickFreePort ?? defaultPickFreePort;
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
   * Full boot sequence: provision-if-needed → reap stale daemon → spawn →
   * health-wait. Never throws and never hangs past the cap — on timeout or
   * error the caller creates the window anyway (the WS transport reconnects
   * and the settings card shows the error status).
   */
  async boot(distro: string): Promise<void> {
    if (this.platform !== 'win32') {
      return;
    }
    let provisioned = false;
    try {
      provisioned = await this.provisionIfNeeded(distro);
      await this.reapStaleDaemon(distro);
      await this.start(distro);
    } catch (err) {
      this.setStatus({ state: 'error', error: errorMessage(err) });
      return;
    }
    // First boot unpacks the Node runtime — give it a bigger budget.
    await this.waitForSettled(provisioned ? 120_000 : 30_000);
  }

  /**
   * Pick a port, persist it into `store.remoteBackend` (the bootstrap URL in
   * main-process-manager derives from this, so it must land BEFORE window
   * creation), generate the per-boot secret, and spawn the daemon.
   */
  async start(distro: string): Promise<void> {
    if (this.platform !== 'win32') {
      return;
    }
    this.distro = distro;
    this.port = await this.pickFreePort();
    this.secret = randomBytes(32).toString('hex');
    this.store.set('remoteBackend', { kind: 'wsl', distro, port: this.port });
    this.enabled = true;
    this.consecutiveFailures = 0;
    this.spawnDaemon();
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
    this.child?.kill();
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
    child.once('exit', (code) => this.onChildExit(gen, code));
    this.child = child;
    this.setStatus({ state: 'starting', distro, port });
    void this.pollUntilHealthy(gen);
  }

  private onChildExit(gen: number, code: number | null): void {
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
        error: this.stderrTail.trim() || `daemon exited with code ${code ?? 'unknown'}`,
      });
      return;
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawnDaemon();
    }, backoffDelayMs(this.consecutiveFailures));
  }

  private async pollUntilHealthy(gen: number): Promise<void> {
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
        return;
      }
      await sleep(HEALTH_POLL_INTERVAL_MS);
    }
  }

  private async probeHealth(): Promise<boolean> {
    if (this.port === null) {
      return false;
    }
    try {
      const res = await this.fetchFn(`http://127.0.0.1:${this.port}/api/health`, {
        signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
      });
      if (!res.ok) {
        return false;
      }
      const body = (await res.json()) as { ok?: boolean };
      return body.ok === true;
    } catch {
      return false;
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
    const next: WslBackendStatus = { ...this.status, ...patch, timestamp: Date.now() };
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
