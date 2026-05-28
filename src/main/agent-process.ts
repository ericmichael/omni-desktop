import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import path from 'node:path';

import c from 'ansi-colors';
import { shellEnvSync } from 'shell-env';
import { assert } from 'tsafe';
import { WebSocket as WsWebSocket } from 'ws';

import { DEFAULT_ENV } from '@/lib/pty-utils';
import { SimpleLogger } from '@/lib/simple-logger';
import type { IComputeClient } from '@/main/platform-client';
import { resolveProfile } from '@/main/profile-resolver';
import { getSnapshotStore } from '@/main/snapshot-blob-store';
import { getOmniCliPath, getOmniConfigDir, isDirectory, pathExists } from '@/main/util';
import { downloadWorkspace } from '@/main/workspace-sync';
import type {
  AgentProcessData,
  AgentProcessStatus,
  LogEntry,
  SandboxPauseResult,
  SandboxSwitchResult,
  WithTimestamp,
} from '@/shared/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Two paths exist after the v22 cut:
 *
 *   - ``serve``    — spawn ``omni serve --profile <path>``; the resolved
 *                    profile drives the SandboxSession (unix_local / docker
 *                    / e2b / …) and any long-running services in it.
 *   - ``platform`` — call ``PlatformClient.startSession`` and connect to the
 *                    cloud-hosted agent. Deferred refactor: a follow-up
 *                    converts this into a custom ``SandboxClient`` so it
 *                    rejoins the ``serve`` path.
 */
export type AgentProcessMode = 'serve' | 'platform';

/**
 * How one source for the sandbox workspace should be seeded. Mirrors
 * the three project source kinds the launcher exposes:
 *
 *   - ``local-git`` — host directory under git control. The seed entry
 *     is ``LocalGitArchive`` (race-free, gitignore-aware).
 *   - ``local`` — host directory without git. The seed entry is the
 *     SDK's ``LocalDir`` (rejects symlinks; correct default for
 *     non-developer workspaces).
 *   - ``git-remote`` — repo URL the container clones at boot (SDK's
 *     ``GitRepo`` entry). No host directory is read.
 *
 * ``mountName`` is the subdirectory under ``/workspace/`` inside the
 * container. A multi-source project gets N entries that materialize at
 * ``/workspace/<mountName>/`` each.
 */
export type AgentProcessSource = { mountName: string } & (
  | { kind: 'local-git'; workspaceDir: string; ref?: string }
  | { kind: 'local'; workspaceDir: string }
  | {
      kind: 'git-remote';
      repoUrl: string;
      ref?: string;
      /**
       * Authentication hint for a private remote. Carries the *name* of the env
       * var holding the token (the value travels in ``gitTokenEnv`` on the start
       * arg, never on disk or argv) plus the HTTPS basic-auth username. Absent
       * for public repos. omni serve routes a source with ``auth`` to the
       * ``AuthenticatedGitRepo`` seed entry, which configures a git credential
       * helper from the env var so clone + fetch + push all authenticate.
       */
      auth?: { tokenEnv: string; username: string };
    }
);

export type AgentProcessStartArg = {
  /** Profile name to resolve (``host``, ``devbox``, custom user profile, …). */
  profileName: string;
  /**
   * Sources to seed into the sandbox workspace. Each one is passed as a
   * separate ``--source`` JSON descriptor to ``omni serve`` and ends up
   * mounted at ``/workspace/<mountName>``. Empty array = no seeding.
   */
  sources: AgentProcessSource[];
  /**
   * Forwarded to ``omni serve --project`` so the per-project profile
   * layer applies. (Snapshot keying is driven by ``sessionId``, not this.)
   */
  projectId?: string;
  /**
   * Stable id for this resumable workspace. Forwarded as ``--session-id``
   * to ``omni serve`` so the snapshot tar is keyed by it. If absent on
   * first start, omni serve auto-generates one and emits it in the
   * readiness payload; the launcher captures it via ``AgentProcessData``
   * and persists it on the owning record (ticket / chat tab / etc.).
   */
  sessionId?: string;
  /**
   * Docker container id captured from a previous run. Forwarded as
   * ``--container-id`` so omni serve can attempt a warm reattach via
   * ``client.resume(state)`` instead of always creating a fresh container.
   * Safe to pass a stale id — the SDK falls back to a fresh container +
   * snapshot rehydrate if the original is gone.
   */
  containerId?: string;
  /**
   * Used in serve mode as the spawn ``cwd`` for resolving relative
   * paths in source-path. For git-remote sources, the launcher passes
   * its own state dir since there's no project workspace on disk.
   */
  workspaceDir?: string;
  /** Platform mode: agent slug for the platform's policy resolution. */
  agentSlug?: string;
  /** Platform mode: domain slug override. */
  domain?: string;
  /** Platform mode: pre-synced share name (skips the one-shot upload). */
  preSyncedShareName?: string;
  /** Platform mode: git-remote URL the platform container clones. */
  gitRepo?: { url: string; branch?: string };
  /**
   * `{ envVarName: token }` for private git remotes, merged into the spawned
   * `omni serve` process env. The matching env var *name* is referenced by each
   * git-remote source's `auth.tokenEnv`; the token value lives only here (in
   * process env), never on disk or in the `--source` argv — mirroring how cloud
   * model/MCP secrets are injected.
   */
  gitTokenEnv?: Record<string, string>;
};

export type FetchFn = typeof globalThis.fetch;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * JSON readiness payload printed by ``omni serve`` and consumed here.
 * Shape pinned by the launcher↔omni-code contract; keep aligned with
 * ``omni-code/omni_code/serve_cli.py``.
 */
type ServeReadyPayload = {
  sandbox_url: string;
  ws_url: string;
  ui_url: string;
  services: Record<string, string>;
  ports: { ui: number };
  container_id?: string | null;
  container_name?: string | null;
  /** Which resume tier the SDK ended up taking. See ``AgentProcessData.resume``. */
  resume?: 'reused' | 'rehydrated' | 'fresh' | null;
  _debug?: Record<string, unknown>;
};

const servePayloadToData = (payload: ServeReadyPayload): AgentProcessData => {
  assert(payload.ui_url, 'Missing ui_url in omni serve payload');
  assert(payload.ports?.ui, 'Missing ports.ui in omni serve payload');
  return {
    uiUrl: payload.ui_url,
    wsUrl: payload.ws_url,
    sandboxUrl: payload.sandbox_url,
    services: payload.services ?? {},
    containerId: payload.container_id ?? undefined,
    containerName: payload.container_name ?? undefined,
    port: payload.ports.ui,
    ...(payload.resume ? { resume: payload.resume } : {}),
  };
};

const SERVER_CALL_TIMEOUT_MS = 8_000;

/**
 * Open a one-shot JSON-RPC WebSocket to omni serve, send one
 * ``server_call`` for *fn*, await the result, then close. Used by
 * lifecycle calls (pause/unpause) that don't need a long-lived control
 * channel. Auth tokens travel in the wsUrl query string so we don't have
 * to re-derive them here.
 */
async function oneShotServerCall(
  wsUrl: string,
  fn: string,
  args: Record<string, unknown> = {}
): Promise<SandboxPauseResult> {
  return new Promise<SandboxPauseResult>((resolve) => {
    let settled = false;
    const finish = (result: SandboxPauseResult) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        socket.close();
      } catch {
        // ignore
      }
      resolve(result);
    };

    const socket = new WsWebSocket(wsUrl);
    const timer = setTimeout(
      () => finish({ ok: false, supported: false, reason: `${fn} timed out` }),
      SERVER_CALL_TIMEOUT_MS
    );

    socket.once('open', () => {
      try {
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'server_call',
            params: { function: fn, args },
          })
        );
      } catch (err) {
        clearTimeout(timer);
        finish({
          ok: false,
          supported: false,
          reason: `${fn} send failed: ${(err as Error).message ?? err}`,
        });
      }
    });

    socket.on('message', (raw) => {
      clearTimeout(timer);
      let msg: unknown;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        finish({ ok: false, supported: false, reason: `${fn} returned unparseable payload` });
        return;
      }
      if (typeof msg !== 'object' || msg === null) {
        finish({ ok: false, supported: false, reason: `${fn} returned non-object payload` });
        return;
      }
      const obj = msg as Record<string, unknown>;
      if ('error' in obj && obj.error && typeof obj.error === 'object') {
        const errMsg = String((obj.error as Record<string, unknown>).message ?? `${fn} rpc error`);
        finish({ ok: false, supported: false, reason: errMsg });
        return;
      }
      const result = obj.result;
      if (typeof result !== 'object' || result === null) {
        finish({ ok: false, supported: false, reason: `${fn} returned no result` });
        return;
      }
      const r = result as Record<string, unknown>;
      finish({
        ok: r.ok === true,
        supported: r.supported !== false,
        data: r,
        ...(typeof r.paused === 'boolean' ? { paused: r.paused } : {}),
        ...(typeof r.reason === 'string' ? { reason: r.reason } : {}),
      });
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      finish({
        ok: false,
        supported: false,
        reason: `${fn} ws error: ${(err as Error).message ?? err}`,
      });
    });

    socket.on('close', () => {
      // If the socket closes before we got a result, treat as failure.
      // The settled guard makes this a no-op in the normal path.
      finish({ ok: false, supported: false, reason: `${fn} ws closed unexpectedly` });
    });
  });
}

// ---------------------------------------------------------------------------
// AgentProcess
// ---------------------------------------------------------------------------

export class AgentProcess {
  readonly mode: AgentProcessMode;

  private status: WithTimestamp<AgentProcessStatus>;
  private ipcRawOutput: (data: string) => void;
  private onStatusChange: (status: WithTimestamp<AgentProcessStatus>) => void;
  private log: SimpleLogger;
  private childProcess: ChildProcess | null = null;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private jsonEmitted = false;
  private lastStartArg: AgentProcessStartArg | null = null;
  private fetchFn: FetchFn;
  private platformClient: IComputeClient | null = null;
  private platformSessionId: string | null = null;
  private getExtraEnv?: () => Record<string, string> | Promise<Record<string, string>>;

  constructor(opts: {
    mode: AgentProcessMode;
    ipcLogger?: (entry: WithTimestamp<LogEntry>) => void;
    ipcRawOutput: (data: string) => void;
    onStatusChange: (status: WithTimestamp<AgentProcessStatus>) => void;
    fetchFn?: FetchFn;
    platformClient?: IComputeClient;
    /**
     * Extra env merged into the spawned `omni serve` (serve mode), evaluated
     * per start. Cloud uses this to inject a fresh per-tenant
     * `OMNI_RUNTIME_TOKEN` for the agent's HTTP MCP calls, AND for the
     * codex-token materialization side effect (writing the per-principal
     * codex.json to the spawn's config dir before omni-serve starts).
     */
    getExtraEnv?: () => Record<string, string> | Promise<Record<string, string>>;
  }) {
    this.mode = opts.mode;
    this.ipcRawOutput = opts.ipcRawOutput;
    this.onStatusChange = opts.onStatusChange;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
    this.platformClient = opts.platformClient ?? null;
    this.getExtraEnv = opts.getExtraEnv;
    this.status = { type: 'uninitialized', timestamp: Date.now() };
    this.log = new SimpleLogger((entry) => {
      this.ipcRawOutput(entry.message);
      console[entry.level](entry.message);
    });
  }

  // --- Public API ---

  getStatus = (): WithTimestamp<AgentProcessStatus> => this.status;

  start = async (arg: AgentProcessStartArg): Promise<void> => {
    if (this.status.type === 'starting' || this.status.type === 'connecting' || this.status.type === 'running') {
      return;
    }

    this.lastStartArg = arg;
    this.updateStatus({ type: 'starting' });

    if (this.mode === 'platform') {
      await this.startPlatformSession(arg);
      return;
    }

    await this.startServeSession(arg);
  };

  stop = async (): Promise<void> => {
    if (this.mode === 'platform') {
      this.updateStatus({ type: 'stopping' });
      if (this.platformSessionId && this.platformClient) {
        const sessionId = this.platformSessionId;
        try {
          await this.platformClient.stopSession(sessionId);
        } catch {
          // best-effort cleanup
        }

        // Download workspace files back from Azure Files share unless the
        // sync manager handles it or the source is a git-remote (container
        // pushes to git).
        if (
          this.lastStartArg &&
          this.lastStartArg.workspaceDir &&
          !this.lastStartArg.preSyncedShareName &&
          !this.lastStartArg.gitRepo
        ) {
          try {
            this.ipcRawOutput('Finalizing workspace download...\r\n');
            const { downloadSasUrl } = await this.platformClient.finalizeWorkspace(sessionId);
            await downloadWorkspace(this.lastStartArg.workspaceDir, downloadSasUrl, this.fetchFn, (msg) =>
              this.ipcRawOutput(`${msg}\r\n`)
            );
            this.ipcRawOutput('Workspace downloaded successfully\r\n');
          } catch (error) {
            this.ipcRawOutput(`Workspace download failed: ${(error as Error).message}\r\n`);
          }
        }

        this.platformSessionId = null;
      }
      this.updateStatus({ type: 'exited' });
      return;
    }

    // Serve mode — omni serve handles its own teardown on SIGTERM, so we
    // just kill the child and let it run the session.stop()/aclose() and
    // service cleanup in its own finally block.
    if (!this.childProcess) {
      return;
    }
    this.updateStatus({ type: 'stopping' });
    await this.killProcess();
    this.updateStatus({ type: 'exited' });
  };

  rebuild = async (fallbackArg: AgentProcessStartArg): Promise<void> => {
    const arg = this.lastStartArg ?? fallbackArg;
    await this.stop();
    await this.start(arg);
  };

  exit = async (): Promise<void> => {
    this.updateStatus({ type: 'exiting' });
    await this.stop();
  };

  /**
   * Freeze every process in the sandbox container without releasing it.
   * Returns the result the omni-code server function emitted: ``ok``,
   * ``supported``, ``paused``, optional ``reason``. Callers should treat
   * ``supported: false`` as "this backend doesn't pause — fall back to
   * stop/shutdown if you want to free resources." A successful pause flips
   * ``AgentProcessData.paused`` to true for the renderer.
   */
  pause = async (): Promise<SandboxPauseResult> => {
    return this.callSandboxLifecycle('sandbox.pause', true);
  };

  /**
   * Thaw a paused sandbox container. Idempotent — calling on an
   * already-running container is a no-op as far as the user is concerned
   * (the server function returns supported=true, paused=false).
   */
  unpause = async (): Promise<SandboxPauseResult> => {
    return this.callSandboxLifecycle('sandbox.unpause', false);
  };

  /**
   * Switch this running agent's sandbox to *profileName* in place via the
   * ``sandbox.switch`` server function — no process restart, the WS stays up,
   * the conversation never drops. On success, patch the running status'
   * ``services``/``containerId`` so the renderer's in-sandbox panes (code-
   * server / VNC) reload to the new URLs; ``uiUrl``/``wsUrl`` are unchanged
   * (same serve process). Returns ``ok:false`` for profiles that can't switch
   * in place (``host`` / a missing file) so the caller can fall back to a
   * stop+relaunch.
   */
  switchSandbox = async (profileName: string): Promise<SandboxSwitchResult> => {
    if (this.mode === 'platform') {
      return { ok: false, fallback: true, reason: 'platform mode does not support in-place sandbox switch' };
    }
    if (this.status.type !== 'running' && this.status.type !== 'connecting') {
      return { ok: false, fallback: true, reason: 'sandbox is not running' };
    }
    const resolved = resolveProfile(profileName);
    if (resolved.kind !== 'file') {
      // ``host`` (builtin-default) and missing profiles have no --profile path
      // to switch to; the caller falls back to a full stop+relaunch.
      return {
        ok: false,
        fallback: true,
        reason: `profile "${profileName}" cannot switch in place (${resolved.kind})`,
      };
    }
    const data = (this.status as Extract<AgentProcessStatus, { type: 'running' | 'connecting' }>).data;
    const wsUrl = data.wsUrl;
    if (!wsUrl) {
      return { ok: false, fallback: true, reason: 'no ws_url available' };
    }
    // Flag the transition so the renderer can overlay a scrim over the (still
    // mounted) conversation. Cleared in `finally` regardless of outcome.
    this.updateAgentProcessData({ switching: true });
    try {
      const res = await oneShotServerCall(wsUrl, 'sandbox.switch', { profile: resolved.path });
      const raw = res.data ?? {};
      if (!res.ok) {
        const recovered = raw.recovered === 'lost' || raw.recovered === 'rolled_back' ? raw.recovered : undefined;
        // Rolled back → the old session is alive; don't relaunch. Lost (or no
        // recovery info) → the sandbox is gone; relaunch to recover.
        return {
          ok: false,
          fallback: recovered !== 'rolled_back',
          ...(recovered ? { recovered } : {}),
          reason: res.reason ?? 'switch failed',
        };
      }
      const services =
        raw.services && typeof raw.services === 'object' ? (raw.services as Record<string, string>) : undefined;
      const containerId = typeof raw.container_id === 'string' ? raw.container_id : undefined;
      const backend = typeof raw.backend === 'string' ? raw.backend : undefined;
      const profile = typeof raw.profile === 'string' ? raw.profile : profileName;
      // uiUrl/wsUrl stay put (same omni serve) — only the service panes reload.
      this.updateAgentProcessData({ ...(services ? { services } : {}), containerId });
      // Keep a future cold relaunch aligned with the now-active profile.
      if (this.lastStartArg) {
        this.lastStartArg = { ...this.lastStartArg, profileName };
      }
      return { ok: true, profile, backend, containerId, services };
    } finally {
      this.updateAgentProcessData({ switching: false });
    }
  };

  /**
   * Fire-and-forget presence ping. Resets the sandbox's idle timer so it
   * doesn't pause while the user is actively interacting with a client
   * surface. Throttling is the renderer's responsibility — we just relay.
   */
  notifyActivity = (): void => {
    if (this.status.type !== 'running' && this.status.type !== 'connecting') {
      return;
    }
    const data = (this.status as Extract<AgentProcessStatus, { type: 'running' | 'connecting' }>).data;
    if (!data.wsUrl) {
      return;
    }
    void oneShotServerCall(data.wsUrl, 'sandbox.notify_activity').catch(() => {
      // Best-effort. A dropped ping costs us ~60s of headroom (the
      // renderer's throttle window) before the next one tries.
    });
  };

  private callSandboxLifecycle = async (
    fn: 'sandbox.pause' | 'sandbox.unpause',
    intendedPaused: boolean
  ): Promise<SandboxPauseResult> => {
    if (this.mode === 'platform') {
      return { ok: false, supported: false, reason: 'platform mode does not implement pause yet' };
    }
    if (this.status.type !== 'running' && this.status.type !== 'connecting') {
      return { ok: false, supported: false, reason: 'sandbox is not running' };
    }
    const data = (this.status as Extract<AgentProcessStatus, { type: 'running' | 'connecting' }>).data;
    const wsUrl = data.wsUrl;
    if (!wsUrl) {
      return { ok: false, supported: false, reason: 'no ws_url available' };
    }
    try {
      const result = await oneShotServerCall(wsUrl, fn);
      // Trust the server function's reported paused state when supported.
      if (result.ok && result.supported) {
        this.updateAgentProcessData({
          paused: result.paused ?? intendedPaused,
        });
      } else if (!result.supported) {
        // Backend doesn't support pause — surface that to callers but
        // don't pretend the local state changed.
      }
      return result;
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      return { ok: false, supported: true, reason: message };
    }
  };

  resizePty = (_cols: number, _rows: number): void => {};

  // --- Serve mode ---

  private startServeSession = async (arg: AgentProcessStartArg): Promise<void> => {
    // Every local-* source must exist on disk before we shell out.
    for (const s of arg.sources) {
      if (s.kind === 'local' || s.kind === 'local-git') {
        if (!(await isDirectory(s.workspaceDir))) {
          this.updateStatus({
            type: 'error',
            error: { message: `Workspace directory not found: ${s.workspaceDir} (source ${s.mountName})` },
          });
          return;
        }
      }
    }

    const omniCli = getOmniCliPath();
    if (!(await pathExists(omniCli))) {
      this.updateStatus({
        type: 'error',
        error: { message: 'Omni runtime is not installed' },
      });
      return;
    }

    const resolved = resolveProfile(arg.profileName);
    if (resolved.kind === 'missing') {
      this.updateStatus({
        type: 'error',
        error: {
          message:
            `Profile "${arg.profileName}" not found. Expected at ${resolved.expected} ` +
            `or a launcher-bundled assets/profiles/${arg.profileName}.yml.`,
        },
      });
      return;
    }

    if (this.childProcess) {
      await this.killProcess();
    }
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.jsonEmitted = false;

    const extra = (await this.getExtraEnv?.()) ?? {};
    const env = {
      ...process.env,
      ...DEFAULT_ENV,
      ...shellEnvSync(),
      ...extra,
      // Per-launch git tokens for private remotes. Last so a token env name can
      // never be shadowed by ambient/extra env.
      ...(arg.gitTokenEnv ?? {}),
    } as Record<string, string>;
    const args: string[] = ['serve', '--output', 'json'];
    // One ``--source <json>`` per source — omni serve's argparse uses
    // ``action="append"``, so each emits a fresh dict.
    for (const s of arg.sources) {
      const desc: Record<string, unknown> = { kind: s.kind, mountName: s.mountName };
      if (s.kind === 'local' || s.kind === 'local-git') {
        desc.path = s.workspaceDir;
      }
      if (s.kind === 'git-remote') {
        desc.repoUrl = s.repoUrl;
        if (s.auth) {
          desc.auth = s.auth;
        }
      }
      if (s.kind === 'local-git' || s.kind === 'git-remote') {
        if (s.ref) {
          desc.ref = s.ref;
        }
      }
      args.push('--source', JSON.stringify(desc));
    }
    if (arg.projectId) {
      args.push('--project', arg.projectId);
    }
    // Snapshot is keyed by sessionId, not projectId. Enabling --snapshot-dir
    // unconditionally lets omni serve generate a session_id on first start
    // (we capture it from the readiness payload) and resume from the stored
    // tar on subsequent starts when the caller passes sessionId back.
    const snapshotDir = path.join(getOmniConfigDir(), 'snapshots');
    args.push('--snapshot-dir', snapshotDir);
    if (arg.sessionId) {
      args.push('--session-id', arg.sessionId);
      // Cloud durability: launcher container disk is ephemeral, so pull a
      // prior snapshot tar from Azure Blob if one exists. No-op when
      // OMNI_AZURE_SNAPSHOT_CONTAINER isn't set (desktop, self-hosted).
      try {
        const pulled = await getSnapshotStore().pull(arg.sessionId, snapshotDir);
        if (pulled) {
          this.log.info(c.cyan(`Restored snapshot from blob for session ${arg.sessionId}\r\n`));
        }
      } catch (err) {
        // Best-effort — omni serve will start fresh if the pull fails.
        console.error('[snapshot-blob] pull failed:', err);
      }
    }
    // ``--container-id`` flips omni serve to ``client.resume(state)`` for a
    // warm reattach. The SDK silently falls back to a fresh container +
    // snapshot rehydrate if the id is stale, so it is always safe to pass.
    if (arg.containerId) {
      args.push('--container-id', arg.containerId);
    }
    if (resolved.kind === 'file') {
      args.push('--profile', resolved.path);
    }
    // `host` profile (kind === 'builtin-default') passes no --profile, so
    // omni serve uses its bundled default.

    // cwd: prefer the first local source's workspaceDir for resolving
    // relative paths in shell. With no local source, fall back to the
    // launcher config dir. Same value is forwarded as --workspace so
    // omni serve can substitute ${workspace_dir} in the resolved profile.
    const firstLocal = arg.sources.find((s) => s.kind === 'local' || s.kind === 'local-git');
    const spawnCwd =
      firstLocal && (firstLocal.kind === 'local' || firstLocal.kind === 'local-git')
        ? firstLocal.workspaceDir
        : getOmniConfigDir();
    args.push('--workspace', spawnCwd);

    this.log.info(c.cyan(`Starting omni serve (profile: ${arg.profileName})...\r\n`));
    this.log.info(`> ${omniCli} ${args.join(' ')}\r\n`);

    try {
      const child = spawn(omniCli, args, {
        cwd: spawnCwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.childProcess = child;
      child.stdout.on('data', this.handleStdout);
      child.stderr.on('data', this.handleStderr);
      child.on('error', (error: Error) => {
        if (this.childProcess && this.childProcess !== child) {
          return;
        }
        this.childProcess = null;
        this.updateStatus({ type: 'error', error: { message: error.message } });
      });
      child.on('close', (exitCode, signal) => {
        if (this.childProcess && this.childProcess !== child) {
          return;
        }
        this.childProcess = null;
        // Push the snapshot tar to blob durability before reporting status.
        // No-op when not configured or when sessionId is unset. Fire-and-
        // forget — the renderer's exit handling shouldn't wait on Azure I/O.
        if (arg.sessionId) {
          void getSnapshotStore()
            .push(arg.sessionId, snapshotDir)
            .catch((err) => console.error('[snapshot-blob] push failed:', err));
        }
        if (this.status.type === 'exiting' || this.status.type === 'stopping') {
          this.updateStatus({ type: 'exited' });
          return;
        }
        if (exitCode === 0) {
          this.updateStatus({ type: 'exited' });
          return;
        }
        const reason = signal ? `signal ${signal}` : `code ${exitCode}`;
        // omni serve emits structured launch failures (bad source, seed-size
        // cap, profile errors) as a ``{"error": "..."}`` line. Surface that
        // message directly; otherwise fall back to the raw stderr tail.
        const structured = this.structuredError();
        const tail = this.tailStderr();
        const message = structured
          ? structured
          : tail
            ? `omni serve exited (${reason})\n\n${tail}`
            : `omni serve exited (${reason})`;
        this.updateStatus({ type: 'error', error: { message } });
      });
    } catch (error) {
      this.childProcess = null;
      this.updateStatus({ type: 'error', error: { message: (error as Error).message } });
    }
  };

  // --- Platform mode (deferred refactor; see AgentProcessMode docs) ---

  private startPlatformSession = async (arg: AgentProcessStartArg): Promise<void> => {
    if (!this.platformClient) {
      this.updateStatus({ type: 'error', error: { message: 'Platform client not configured' } });
      return;
    }

    const agentSlug = arg.agentSlug ?? 'omni_code';

    try {
      this.log.info(c.cyan(`Requesting sandbox from platform (agent: ${agentSlug})...\r\n`));

      const session = await this.platformClient.startSession(agentSlug, arg.domain, arg.gitRepo);
      this.platformSessionId = session.sessionId;

      if (arg.gitRepo) {
        this.log.info(
          c.cyan(
            `Container will clone ${arg.gitRepo.url}` + `${arg.gitRepo.branch ? ` (${arg.gitRepo.branch})` : ''}\r\n`
          )
        );
      } else if (arg.preSyncedShareName) {
        this.log.info(c.cyan(`Using pre-synced share: ${arg.preSyncedShareName}\r\n`));
      } else {
        this.log.info(c.yellow('Workspace upload disabled — container starts with an empty workspace\r\n'));
      }

      this.log.info(c.cyan(`Session ${session.sessionId} created, waiting for container...\r\n`));
      this.updateStatus({ type: 'connecting', data: { uiUrl: '' } });

      const ready = await this.platformClient.waitForSession(session.sessionId);
      if (this.isStopping()) {
        return;
      }

      const wsUrl = ready.websocketUrl!;
      let uiUrl = wsUrl.replace(/^wss?:/, 'https:').replace(/\/ws$/, '');
      if (ready.authToken) {
        const sep = uiUrl.includes('?') ? '&' : '?';
        uiUrl = `${uiUrl}${sep}token=${encodeURIComponent(ready.authToken)}`;
      }
      const data: AgentProcessData = {
        uiUrl,
        wsUrl,
        containerId: ready.containerId,
      };
      this.updateStatus({ type: 'connecting', data });
      this.log.info(c.cyan('Waiting for platform container services to accept connections...\r\n'));
      await this.waitForReady(data);
    } catch (error) {
      if (this.isStopping()) {
        return;
      }
      this.updateStatus({ type: 'error', error: { message: (error as Error).message } });
    }
  };

  // --- Internals ---

  private isStopping = (): boolean => {
    const t = this.status.type;
    return t === 'stopping' || t === 'exiting';
  };

  private updateStatus = (status: AgentProcessStatus): void => {
    this.status = { ...status, timestamp: Date.now() };
    this.onStatusChange(this.status);
  };

  /** Patch fields on the embedded ``AgentProcessData`` without changing the
   *  status state. No-op unless we're in a state that carries data
   *  (``running`` or ``connecting``). Used by pause/unpause to flip the
   *  ``paused`` indicator without redoing the readiness payload. */
  private updateAgentProcessData = (patch: Partial<AgentProcessData>): void => {
    if (this.status.type !== 'running' && this.status.type !== 'connecting') {
      return;
    }
    const current = this.status as Extract<WithTimestamp<AgentProcessStatus>, { type: 'running' | 'connecting' }>;
    this.status = {
      ...current,
      data: { ...current.data, ...patch },
      timestamp: Date.now(),
    };
    this.onStatusChange(this.status);
  };

  // -- Stdout/stderr handling --

  private handleStdout = (data: Buffer): void => {
    const str = data.toString();
    this.ipcRawOutput(str);
    process.stdout.write(str);
    if (this.jsonEmitted) {
      return;
    }
    this.stdoutBuffer += str;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      this.tryParseStdoutLine(line);
    }
  };

  private handleStderr = (data: Buffer): void => {
    const str = data.toString();
    this.stderrBuffer += str;
    this.ipcRawOutput(str);
    process.stderr.write(str);
  };

  private tryParseStdoutLine = (line: string): void => {
    if (this.jsonEmitted) {
      return;
    }
    const trimmed = line.trim();
    if (!(trimmed.startsWith('{') && trimmed.endsWith('}'))) {
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!('sandbox_url' in parsed) || !('ui_url' in parsed)) {
      return;
    }
    const data = servePayloadToData(parsed as unknown as ServeReadyPayload);
    this.jsonEmitted = true;
    this.updateStatus({ type: 'connecting', data });
    this.log.info(c.cyan('Waiting for services to accept connections...\r\n'));
    void this.waitForReady(data);
  };

  // -- Readiness polling --

  private waitForReady = async (data: AgentProcessData): Promise<void> => {
    const maxAttempts = this.mode === 'platform' ? 120 : 120;

    const checkHttp = async (url: string): Promise<boolean> => {
      try {
        const response = await this.fetchFn(url, { method: 'GET' });
        return response.status < 500;
      } catch {
        return false;
      }
    };

    const checkWs = async (url: string): Promise<boolean> => {
      try {
        return await new Promise<boolean>((resolve) => {
          let settled = false;
          const socket = new WsWebSocket(url);
          const finish = (result: boolean): void => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timer);
            try {
              socket.close();
            } catch {
              /* ignore */
            }
            resolve(result);
          };
          const timer = setTimeout(() => finish(false), 2_000);
          socket.on('open', () => finish(true));
          socket.on('error', () => finish(false));
          socket.on('close', () => finish(false));
        });
      } catch {
        return false;
      }
    };

    // Platform mode requires the auth token on WS connections; carry it
    // through from the uiUrl query.
    let wsCheckUrl = data.wsUrl;
    if (wsCheckUrl && this.mode === 'platform') {
      try {
        const uiParsed = new URL(data.uiUrl);
        const token = uiParsed.searchParams.get('token');
        if (token) {
          const wsUrlObj = new URL(wsCheckUrl);
          wsUrlObj.searchParams.set('token', token);
          wsCheckUrl = wsUrlObj.toString();
        }
      } catch {
        /* ignore parse errors */
      }
    }

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (this.isStopping()) {
        return;
      }
      const httpOk = await checkHttp(data.uiUrl);
      const wsOk = wsCheckUrl ? await checkWs(wsCheckUrl) : true;
      if (httpOk && wsOk) {
        if (this.isStopping()) {
          return;
        }
        this.updateStatus({ type: 'running', data });
        const label = this.mode === 'platform' ? 'Platform sandbox' : 'Sandbox';
        this.log.info(c.green.bold(`${label} started\r\n`));
        return;
      }
      await new Promise<void>((r) => setTimeout(r, 1000));
    }

    if (this.isStopping()) {
      return;
    }
    this.updateStatus({
      type: 'error',
      error: { message: `Services did not become ready within ${maxAttempts} seconds.` },
    });
  };

  // -- Process management --

  private killProcess = (timeout = 10_000): Promise<void> => {
    const child = this.childProcess;
    if (!child || child.exitCode !== null) {
      this.childProcess = null;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const onExit = (): void => {
        clearTimeout(timer);
        this.childProcess = null;
        resolve();
      };
      child.once('close', onExit);
      child.kill('SIGTERM');
      const timer = setTimeout(() => {
        child.removeListener('close', onExit);
        child.kill('SIGKILL');
        this.childProcess = null;
        resolve();
      }, timeout);
    });
  };

  // eslint-disable-next-line no-control-regex
  private static readonly ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

  /**
   * Extract a structured launch error from stderr. ``omni serve`` prints
   * launch failures as a single JSON line ``{"error": "source: …"}`` (bad
   * source, seed-size cap, profile errors). Returns the last such message, or
   * null if stderr carries only a raw traceback / log noise.
   */
  private structuredError = (): string | null => {
    const cleaned = this.stderrBuffer.replace(AgentProcess.ANSI_RE, '');
    const lines = cleaned
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('{') && l.includes('"error"'));
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) {
        continue;
      }
      try {
        const obj = JSON.parse(line) as { error?: unknown };
        if (typeof obj.error === 'string' && obj.error.trim()) {
          return obj.error;
        }
      } catch {
        /* not a JSON error line — keep scanning */
      }
    }
    return null;
  };

  private tailStderr = (maxLines = 20, maxChars = 2000): string => {
    const cleaned = this.stderrBuffer.replace(AgentProcess.ANSI_RE, '');
    const lines = cleaned
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);
    const tail = lines.slice(-maxLines).join('\n');
    if (tail.length <= maxChars) {
      return tail;
    }
    return `…${tail.slice(tail.length - maxChars)}`;
  };
}
