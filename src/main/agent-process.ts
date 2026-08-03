import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

import c from 'ansi-colors';
import { shellEnvSync } from 'shell-env';
import { assert } from 'tsafe';
import { WebSocket as WsWebSocket } from 'ws';

import { getProductSlug } from '@/lib/product';
import { DEFAULT_ENV } from '@/lib/pty-utils';
import { SimpleLogger } from '@/lib/simple-logger';
import { wsAuthOptions } from '@/lib/ws-auth';
import { AgentHostControlClient } from '@/main/agent-host-control-client';
import { initializeMainRpcConnection } from '@/main/omniagents-rpc-handshake';
import type { IComputeClient } from '@/main/platform-client';
import { assertServeProtocolSupported } from '@/main/product-runtime';
import { resolveProfile } from '@/main/profile-resolver';
import { getSnapshotStore } from '@/main/snapshot-blob-store';
import { getOmniCliPath, getOmniConfigDir, isDirectory, pathExists } from '@/main/util';
import { downloadWorkspace } from '@/main/workspace-sync';
import type { AgentProcessData, AgentProcessStatus, LogEntry, SandboxPauseResult, WithTimestamp } from '@/shared/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Two paths exist after the v22 cut:
 *
 *   - ``serve``   — spawn one targetless ``omni serve`` AgentHost; consumer
 *                   Workspaces and profiles materialize independent execution
 *                   environments through its control plane.
 *   - ``compute`` — delegate the sandbox lifecycle to an {@link IComputeClient}
 *                   instead of spawning ``omni serve`` here. Two impls exist:
 *                   ``PlatformClient`` (omni-platform delegation) and
 *                   ``RemoteElectronComputeClient`` (computer-as-sandbox: the
 *                   sandbox runs on a laptop the user owns, driven over the
 *                   cloud↔laptop reverse-RPC WS). Both connect to a remote
 *                   AgentHost rather than a local child process.
 */
export type AgentProcessMode = 'serve' | 'compute';

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
/**
 * ``launcherOwned`` marks a host directory the launcher itself manages (a
 * per-conversation ``Sessions/<id>`` scratch dir or a managed project dir):
 * container changes auto-mirror back to it without confirmation, since there
 * is no foreign user data to clobber. User-attached folders never carry it —
 * they keep the explicit "Apply to my folder" gate. Launcher-side only; the
 * ``--source`` descriptor sent to omni serve does not include it.
 */
export type AgentProcessSource = { mountName: string; writable?: boolean } & (
  | { kind: 'local-git'; workspaceDir: string; ref?: string; launcherOwned?: boolean }
  | { kind: 'local'; workspaceDir: string; launcherOwned?: boolean }
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
   * Sources registered on the consumer Workspace. The selected environment
   * materializes them at ``/workspace/<mountName>``. Empty array = no seeding.
   */
  sources: AgentProcessSource[];
  /**
   * Selects the per-project default profile definition when the consumer is
   * registered.
   */
  projectId?: string;
  /**
   * Delegated-compute session identity. Local AgentHost Workspace identity is
   * deliberately independent.
   */
  sessionId?: string;
  /** Stable snapshot reference registered with the consumer Workspace. */
  snapshotRef?: string;
  /**
   * Used in serve mode as the spawn ``cwd`` for resolving relative
   * paths in source-path. For git-remote sources, the launcher passes
   * its own state dir since there's no project workspace on disk.
   */
  workspaceDir?: string;
  /** Compute mode: agent slug for the platform's policy resolution. */
  agentSlug?: string;
  /** Compute mode: domain slug override. */
  domain?: string;
  /** Compute mode: pre-synced share name (skips the one-shot upload). */
  preSyncedShareName?: string;
  /** Compute mode: git-remote URL the remote container clones. */
  gitRepo?: { url: string; branch?: string };
  /**
   * Local-compute (computer-as-sandbox) extras forwarded to the
   * `IComputeClient.startSession` extras param so the laptop's local
   * `ProcessManager` knows what profile / env / workspace to spawn against.
   * Ignored by `PlatformClient`.
   */
  localComputeExtras?: {
    sessionId?: string;
    profileName?: string;
    workspaceDir?: string;
    projectId?: string;
    env?: Record<string, string>;
  };
  /**
   * `{ envVarName: token }` for private git remotes, merged into the spawned
   * `omni serve` process env. The matching env var *name* is referenced by each
   * git-remote source's `auth.tokenEnv`; the token value lives only here (in
   * process env), never on disk or in the `--source` argv — mirroring how cloud
   * model/MCP secrets are injected.
   */
  gitTokenEnv?: Record<string, string>;
  /**
   * Boot-time credential descriptors for the sandbox: one per linked host the
   * project's sources reference (git-remote URL *and* each local-git checkout's
   * own remote). Forwarded as `--credential <json>` to `omni serve`, which
   * configures git + the host's CLI (`gh` / `az devops`) inside the container so
   * the agent authenticates for *every* source kind, not just cloned remotes.
   * Token values ride in `gitTokenEnv` (process env), referenced here by name.
   */
  credentials?: Array<{ url: string; username: string; tokenEnv: string }>;
  /**
   * Explicit profile file path, bypassing name-based resolution. Set by the
   * cloud for `local:<machineId>` (computer-as-sandbox) sessions: the launcher
   * writes a per-session `host_bridge` profile (pointing `omni serve`'s sandbox
   * at the user's laptop via the relay) and passes its path here. When set,
   * `profileName` is only used for labelling.
   */
  explicitProfilePath?: string;
};

export type AgentHostConsumerRuntime = {
  workspaceId: string;
  environmentId: string;
  services: Record<string, string>;
  containerId?: string;
  paused?: boolean;
};

export type FetchFn = typeof globalThis.fetch;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * JSON readiness payload printed by ``<prog> serve`` and consumed here.
 * Shape pinned by the launcher↔product serve contract (protocol v2);
 * keep aligned with omniagents ``docs/serve-protocol.md``.
 */
type ServeReadyPayload = {
  sandbox_url: string;
  ws_url: string;
  ui_url: string;
  /** Stable identity of the agent host that owns runtime registries. */
  agent_host_id: string;
  /** Null/absent until a launcher consumer is materialized through control. */
  workspace_id?: string | null;
  /** Null/absent until a launcher consumer is materialized through control. */
  environment_id?: string | null;
  /**
   * Bearer token WS clients must present as an ``Authorization: Bearer``
   * upgrade header (or exchange at ``POST /auth/ws-ticket``). ``ws_url``
   * is token-free — never parse credentials out of it.
   */
  auth_token?: string | null;
  services?: Record<string, string>;
  ports: { ui: number };
  container_id?: string | null;
  container_name?: string | null;
  _debug?: Record<string, unknown>;
};

const servePayloadToData = (payload: ServeReadyPayload): AgentProcessData => {
  assert(payload.ui_url, 'Missing ui_url in omni serve payload');
  assert(payload.ports?.ui, 'Missing ports.ui in omni serve payload');
  assert(
    typeof payload.agent_host_id === 'string' && payload.agent_host_id.trim(),
    'Missing agent_host_id in omni serve payload'
  );
  return {
    uiUrl: payload.ui_url,
    wsUrl: payload.ws_url,
    agentHostId: payload.agent_host_id,
    ...(typeof payload.workspace_id === 'string' && payload.workspace_id.trim()
      ? { workspaceId: payload.workspace_id }
      : {}),
    ...(typeof payload.environment_id === 'string' && payload.environment_id.trim()
      ? { environmentId: payload.environment_id }
      : {}),
    ...(payload.auth_token ? { authToken: payload.auth_token } : {}),
    sandboxUrl: payload.sandbox_url,
    services: payload.services ?? {},
    containerId: payload.container_id ?? undefined,
    containerName: payload.container_name ?? undefined,
    port: payload.ports.ui,
  };
};

/**
 * Redact bearer credentials from a raw output chunk before it reaches any
 * log surface (renderer log viewer, launcher stdout). The readiness line
 * `omni serve` prints carries the dedicated ``auth_token`` field — the
 * launcher must consume it, never display it.
 */
const redactAuthTokens = (chunk: string): string => chunk.replace(/("auth_token"\s*:\s*")[^"]*(")/g, '$1[redacted]$2');

const sourceDescriptor = (source: AgentProcessSource): Record<string, unknown> => {
  const descriptor: Record<string, unknown> = {
    kind: source.kind,
    mountName: source.mountName,
    writable: source.writable ?? true,
  };
  if (source.kind === 'local' || source.kind === 'local-git') {
    descriptor.path = source.workspaceDir;
  }
  if (source.kind === 'git-remote') {
    descriptor.repoUrl = source.repoUrl;
    if (source.auth) {
      descriptor.auth = source.auth;
    }
  }
  if ((source.kind === 'local-git' || source.kind === 'git-remote') && source.ref) {
    descriptor.ref = source.ref;
  }
  return descriptor;
};

const serveWorkspaceDirectory = (arg: AgentProcessStartArg): string => {
  const firstLocal = arg.sources.find((source) => source.kind === 'local' || source.kind === 'local-git');
  return firstLocal && (firstLocal.kind === 'local' || firstLocal.kind === 'local-git')
    ? firstLocal.workspaceDir
    : getOmniConfigDir();
};

const SERVER_CALL_TIMEOUT_MS = 8_000;

/**
 * Open a one-shot JSON-RPC WebSocket to omni serve, send one
 * ``server_call`` for *fn*, await the result, then close. Used by
 * lifecycle calls (pause/unpause) that don't need a long-lived control
 * channel. When the server is authenticated, *authToken* rides as an
 * ``Authorization: Bearer`` upgrade header — never in the URL.
 */
async function oneShotServerCall(
  wsUrl: string,
  environmentId: string,
  fn: string,
  args: Record<string, unknown> = {},
  timeoutMs: number = SERVER_CALL_TIMEOUT_MS,
  authToken?: string
): Promise<SandboxPauseResult> {
  return new Promise<SandboxPauseResult>((resolve) => {
    let settled = false;
    let nextId = 1;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    const finish = (result: SandboxPauseResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      for (const call of pending.values()) {
        call.reject(new Error(`${fn} connection closed`));
      }
      pending.clear();
      try {
        socket.close();
      } catch {
        // ignore
      }
      resolve(result);
    };

    const socket = new WsWebSocket(wsUrl, wsAuthOptions(authToken));
    const timer = setTimeout(() => finish({ ok: false, supported: false, reason: `${fn} timed out` }), timeoutMs);

    const request = (method: string, params: object): Promise<unknown> => {
      const id = nextId++;
      return new Promise((resolveRequest, rejectRequest) => {
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), (error) => {
          if (!error) {
            return;
          }
          pending.delete(id);
          rejectRequest(error);
        });
      });
    };

    socket.once('open', async () => {
      try {
        await initializeMainRpcConnection({
          name: 'omni-desktop-lifecycle',
          request: (method, params) => request(method, params),
          notify: (method, params) =>
            new Promise<void>((resolveSend, rejectSend) => {
              socket.send(JSON.stringify({ jsonrpc: '2.0', method, params }), (error) => {
                if (error) {
                  rejectSend(error);
                } else {
                  resolveSend();
                }
              });
            }),
        });
        const result = await request('server_call', { function: fn, args, environment_id: environmentId });
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
      } catch (err) {
        finish({
          ok: false,
          supported: false,
          reason: `${fn} send failed: ${(err as Error).message ?? err}`,
        });
      }
    });

    socket.on('message', (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (typeof msg !== 'object' || msg === null) {
        return;
      }
      const obj = msg as Record<string, unknown>;
      const id = obj.id;
      if (typeof id !== 'number') {
        return;
      }
      const call = pending.get(id);
      if (!call) {
        return;
      }
      pending.delete(id);
      if ('error' in obj && obj.error && typeof obj.error === 'object') {
        const errMsg = String((obj.error as Record<string, unknown>).message ?? `${fn} rpc error`);
        call.reject(new Error(errMsg));
        return;
      }
      call.resolve(obj.result);
    });

    socket.on('error', (err) => {
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
  private computeClient: IComputeClient | null = null;
  private computeSessionId: string | null = null;
  private getExtraEnv?: () => Record<string, string> | Promise<Record<string, string>>;
  private agentHostControlToken: string | null = null;
  private agentHostControlClient: AgentHostControlClient | null = null;
  /** Environment id -> durable Workspace snapshot reference. */
  private consumerSnapshotRefs = new Map<string, string>();
  /**
   * Children we deliberately killed via {@link killProcess} (SIGTERM → SIGKILL).
   * Their late `close` events should NOT flip status to `error("signal SIGKILL")`
   * — that's what the user asked for. Without this guard the late close from a
   * killed child can land AFTER a new child has been spawned by `start()` and
   * hijack the new process's status with a stale SIGKILL message.
   * WeakSet so the entry GCs with the ChildProcess.
   */
  private intentionallyKilled: WeakSet<ChildProcess> = new WeakSet();

  constructor(opts: {
    mode: AgentProcessMode;
    ipcLogger?: (entry: WithTimestamp<LogEntry>) => void;
    ipcRawOutput: (data: string) => void;
    onStatusChange: (status: WithTimestamp<AgentProcessStatus>) => void;
    fetchFn?: FetchFn;
    computeClient?: IComputeClient;
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
    this.computeClient = opts.computeClient ?? null;
    this.getExtraEnv = opts.getExtraEnv;
    this.status = { type: 'uninitialized', timestamp: Date.now() };
    this.log = new SimpleLogger((entry) => {
      this.ipcRawOutput(entry.message);
      console[entry.level](entry.message);
    });
  }

  // --- Public API ---

  getStatus = (): WithTimestamp<AgentProcessStatus> => this.status;

  /** Register and bind one launcher consumer inside this long-lived AgentHost. */
  configureConsumer = async (
    consumerId: string,
    workspaceId: string,
    arg: AgentProcessStartArg
  ): Promise<AgentHostConsumerRuntime> => {
    if (this.mode !== 'serve') {
      throw new Error('Delegated compute does not support AgentHost consumer configuration');
    }
    await this.ensureConsumerSources(arg);
    const data = await this.waitForRunningData();
    if (!data.wsUrl || !this.agentHostControlToken) {
      throw new Error('AgentHost control channel is unavailable');
    }
    const control =
      this.agentHostControlClient ??
      (this.agentHostControlClient = new AgentHostControlClient(data.wsUrl, this.agentHostControlToken));
    const snapshotRef = arg.snapshotRef ?? workspaceId;
    const snapshotDir = path.join(getOmniConfigDir(), 'snapshots');

    // Blob durability follows the Workspace being materialized, not whichever
    // consumer happened to start this shared AgentHost process first.
    try {
      const pulled = await getSnapshotStore().pull(snapshotRef, snapshotDir);
      if (pulled) {
        this.log.info(c.cyan(`Restored snapshot from blob for workspace ${snapshotRef}\r\n`));
      }
    } catch (error) {
      // Best-effort: the provisioner can still materialize a fresh workspace.
      console.error(`[snapshot-blob] pull failed for ${snapshotRef}:`, error);
    }

    let materializedEnvironmentId: string | undefined;
    const resolved = arg.explicitProfilePath
      ? ({ kind: 'file', path: arg.explicitProfilePath } as const)
      : resolveProfile(arg.profileName);
    if (resolved.kind === 'missing') {
      throw new Error(`Profile "${arg.profileName}" is no longer available`);
    }
    const definition: Record<string, unknown> =
      resolved.kind === 'file'
        ? { kind: 'path', path: resolved.path }
        : {
            kind: 'default',
            ...(arg.projectId ? { project_id: arg.projectId } : {}),
          };
    const profileId = `profile_${createHash('sha256').update(JSON.stringify(definition)).digest('hex').slice(0, 24)}`;
    // AgentHost's Thread identity is the conversation Session identity. The
    // launcher consumer is a UI/process attachment and may outlive or switch
    // conversations, so it must never become the RPC resource identifier.
    const threadId = arg.sessionId ?? consumerId;
    const controlContext = { consumerId, profileName: arg.profileName };
    await control.call(
      'agent_host_register_workspace',
      {
        workspace_id: workspaceId,
        materialization_path: serveWorkspaceDirectory(arg),
        snapshot_ref: snapshotRef,
        sources: arg.sources.map(sourceDescriptor),
        owner_user_id: 'token_user',
      },
      controlContext
    );
    await control.call(
      'agent_host_register_profile',
      {
        profile_id: profileId,
        definition,
        owner_user_id: 'token_user',
      },
      controlContext
    );
    const materialized = (await control.call(
      'agent_host_materialize_environment',
      {
        workspace_id: workspaceId,
        profile_id: profileId,
      },
      controlContext
    )) as Record<string, unknown>;
    const environmentId = String(materialized['environment_id'] ?? '').trim();
    if (!environmentId) {
      throw new Error('AgentHost materialization returned no environment_id');
    }
    materializedEnvironmentId = environmentId;
    const runtime: AgentHostConsumerRuntime = {
      workspaceId,
      environmentId,
      services:
        materialized['services'] && typeof materialized['services'] === 'object'
          ? (materialized['services'] as Record<string, string>)
          : {},
      ...(typeof materialized['container_id'] === 'string' && materialized['container_id']
        ? { containerId: materialized['container_id'] }
        : {}),
    };

    try {
      await control.call(
        'agent_host_bind_thread',
        {
          thread_id: threadId,
          binding: {
            workspace_id: runtime.workspaceId,
            environment_selection: {
              mode: 'existing',
              environment_id: runtime.environmentId,
            },
          },
        },
        controlContext
      );
    } catch (error) {
      if (materializedEnvironmentId) {
        try {
          await control.call('agent_host_stop_environment', {
            environment_id: materializedEnvironmentId,
          });
        } catch {
          // Preserve the binding error; environment cleanup is best-effort.
        }
      }
      throw error;
    }
    this.consumerSnapshotRefs.set(runtime.environmentId, snapshotRef);
    return runtime;
  };

  stopConsumerEnvironment = async (environmentId: string): Promise<void> => {
    if (!this.agentHostControlClient) {
      return;
    }
    await this.agentHostControlClient.call('agent_host_stop_environment', {
      environment_id: environmentId,
    });
    await this.pushConsumerSnapshot(environmentId);
  };

  discardConsumerSnapshot = async (environmentId: string): Promise<void> => {
    const data = await this.waitForRunningData();
    if (!data.wsUrl) {
      return;
    }
    await oneShotServerCall(
      data.wsUrl,
      environmentId,
      'sandbox.discard_snapshot',
      {},
      SERVER_CALL_TIMEOUT_MS,
      data.authToken
    );
  };

  start = async (arg: AgentProcessStartArg): Promise<void> => {
    if (this.status.type === 'starting' || this.status.type === 'connecting' || this.status.type === 'running') {
      return;
    }

    this.lastStartArg = arg;
    this.updateStatus({ type: 'starting' });

    if (this.mode === 'compute') {
      await this.startComputeSession(arg);
      return;
    }

    await this.startServeSession(arg);
  };

  stop = async (): Promise<void> => {
    if (this.mode === 'compute') {
      this.updateStatus({ type: 'stopping' });
      if (this.computeSessionId && this.computeClient) {
        const sessionId = this.computeSessionId;
        try {
          await this.computeClient.stopSession(sessionId);
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
            const { downloadSasUrl } = await this.computeClient.finalizeWorkspace(sessionId);
            await downloadWorkspace(this.lastStartArg.workspaceDir, downloadSasUrl, this.fetchFn, (msg) =>
              this.ipcRawOutput(`${msg}\r\n`)
            );
            this.ipcRawOutput('Workspace downloaded successfully\r\n');
          } catch (error) {
            this.ipcRawOutput(`Workspace download failed: ${(error as Error).message}\r\n`);
          }
        }

        this.computeSessionId = null;
      }
      this.updateStatus({ type: 'exited' });
      return;
    }

    // Serve mode — omni serve handles its own teardown on SIGTERM, so we
    // just kill the child and let it run the session.stop()/aclose() and
    // service cleanup in its own finally block.
    if (!this.childProcess) {
      this.closeAgentHostControl();
      return;
    }
    // Capture the WS URL + auth before flipping status — `stopping` carries no data.
    this.updateStatus({ type: 'stopping' });
    this.closeAgentHostControl();
    await this.killProcess();
    await this.pushAllConsumerSnapshots();
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
   * stop/shutdown if you want to free resources." The ProcessManager records
   * the returned paused state on the selected consumer runtime.
   */
  pause = async (environmentId?: string): Promise<SandboxPauseResult> => {
    return this.callSandboxLifecycle(environmentId, 'sandbox.pause');
  };

  /**
   * Thaw a paused sandbox container. Idempotent — calling on an
   * already-running container is a no-op as far as the user is concerned
   * (the server function returns supported=true, paused=false).
   */
  unpause = async (environmentId?: string): Promise<SandboxPauseResult> => {
    return this.callSandboxLifecycle(environmentId, 'sandbox.unpause');
  };

  /**
   * Fire-and-forget presence ping. Resets the sandbox's idle timer so it
   * doesn't pause while the user is actively interacting with a client
   * surface. Throttling is the renderer's responsibility — we just relay.
   */
  notifyActivity = (environmentId?: string): void => {
    if (this.status.type !== 'running' && this.status.type !== 'connecting') {
      return;
    }
    const data = (this.status as Extract<AgentProcessStatus, { type: 'running' | 'connecting' }>).data;
    if (!data.wsUrl || !environmentId) {
      return;
    }
    void oneShotServerCall(
      data.wsUrl,
      environmentId,
      'sandbox.notify_activity',
      {},
      SERVER_CALL_TIMEOUT_MS,
      data.authToken
    ).catch(() => {
      // Best-effort. A dropped ping costs us ~60s of headroom (the
      // renderer's throttle window) before the next one tries.
    });
  };

  private callSandboxLifecycle = async (
    environmentId: string | undefined,
    fn: 'sandbox.pause' | 'sandbox.unpause'
  ): Promise<SandboxPauseResult> => {
    if (this.mode === 'compute') {
      return { ok: false, supported: false, reason: 'compute mode does not implement pause yet' };
    }
    if (this.status.type !== 'running' && this.status.type !== 'connecting') {
      return { ok: false, supported: false, reason: 'sandbox is not running' };
    }
    const data = (this.status as Extract<AgentProcessStatus, { type: 'running' | 'connecting' }>).data;
    const wsUrl = data.wsUrl;
    if (!wsUrl) {
      return { ok: false, supported: false, reason: 'no ws_url available' };
    }
    if (!environmentId) {
      return { ok: false, supported: false, reason: 'no execution environment is available' };
    }
    try {
      return await oneShotServerCall(wsUrl, environmentId, fn, {}, SERVER_CALL_TIMEOUT_MS, data.authToken);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      return { ok: false, supported: true, reason: message };
    }
  };

  resizePty = (_cols: number, _rows: number): void => {};

  // --- Serve mode ---

  private ensureConsumerSources = async (arg: AgentProcessStartArg): Promise<void> => {
    for (const s of arg.sources) {
      if (s.kind === 'local' || s.kind === 'local-git') {
        if (!(await isDirectory(s.workspaceDir))) {
          try {
            const { mkdir } = await import('node:fs/promises');
            await mkdir(s.workspaceDir, { recursive: true });
          } catch (mkErr) {
            throw new Error(
              `Workspace directory not found: ${s.workspaceDir} (source ${s.mountName}) ` +
                `— mkdir failed: ${(mkErr as Error).message}`
            );
          }
          if (!(await isDirectory(s.workspaceDir))) {
            throw new Error(`Workspace directory not found: ${s.workspaceDir} (source ${s.mountName})`);
          }
        }
      }
    }
  };

  private startServeSession = async (arg: AgentProcessStartArg): Promise<void> => {
    const omniCli = getOmniCliPath();
    if (!(await pathExists(omniCli))) {
      this.updateStatus({
        type: 'error',
        error: { message: 'Omni runtime is not installed' },
      });
      return;
    }

    // Verify the installed product speaks the serve protocol this launcher
    // targets (omniagents docs/serve-protocol.md, v2) before spawning.
    try {
      await assertServeProtocolSupported();
    } catch (protoErr) {
      this.updateStatus({
        type: 'error',
        error: { message: (protoErr as Error).message },
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
    const clientAuthToken = randomBytes(32).toString('hex');
    this.agentHostControlToken = randomBytes(32).toString('hex');
    const args: string[] = [
      'serve',
      '--output',
      'json',
      '--auth-token',
      clientAuthToken,
      '--agent-host-control-token',
      this.agentHostControlToken,
    ];
    // One ``--credential <json>`` per linked host the project uses. Token values
    // are not here — they ride in ``gitTokenEnv`` (merged into env above) and are
    // referenced by ``tokenEnv`` name.
    for (const cred of arg.credentials ?? []) {
      args.push('--credential', JSON.stringify(cred));
    }
    // The provisioner stores each Workspace snapshot beneath this shared root;
    // the consumer's snapshot_ref is registered later through the control plane.
    const snapshotDir = path.join(getOmniConfigDir(), 'snapshots');
    args.push('--snapshot-dir', snapshotDir);
    // AgentHost startup is targetless. Workspace, source, profile, session,
    // and container placement data enters only through consumer materialization.
    const spawnCwd = getOmniConfigDir();

    this.log.info(c.cyan('Starting targetless omni serve AgentHost...\r\n'));
    const loggedArgs = args.map((value, index) =>
      args[index - 1] === '--auth-token' || args[index - 1] === '--agent-host-control-token' ? '[redacted]' : value
    );
    this.log.info(`> ${omniCli} ${loggedArgs.join(' ')}\r\n`);

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
        // Same guards as the `close` handler — don't hijack a newer spawn
        // or an intentional kill with a stale spawn-failure status.
        if (this.childProcess !== null && this.childProcess !== child) {
          return;
        }
        if (this.intentionallyKilled.has(child)) {
          return;
        }
        this.closeAgentHostControl();
        this.childProcess = null;
        this.updateStatus({ type: 'error', error: { message: error.message } });
      });
      child.on('close', (exitCode, signal) => {
        // A killed-child late close event must not blow away the status of a
        // newer process that `start()` may have spawned in the meantime. Two
        // independent checks:
        //   1. If childProcess points elsewhere (a newer spawn took over), the
        //      close belongs to an OLD child — ignore.
        //   2. If we intentionally killed this child via killProcess(), the
        //      next status was the caller's responsibility (`stopping` →
        //      `exited`), and the SIGTERM/SIGKILL signal lines are noise.
        if (this.childProcess !== null && this.childProcess !== child) {
          return;
        }
        if (this.intentionallyKilled.has(child)) {
          this.intentionallyKilled.delete(child);
          // Only clear childProcess if it still points at THIS child — a
          // concurrent start may have already assigned a new one.
          if (this.childProcess === child) {
            this.childProcess = null;
          }
          // Don't touch status: stop()/exit() already set it to 'exited' or
          // the caller transitioned to 'starting' for the replacement. The
          // lifecycle caller pushes every consumer snapshot after shutdown.
          return;
        }
        this.closeAgentHostControl();
        this.childProcess = null;
        // An unexpected host exit shuts down every environment. Persist all
        // Workspace snapshots; there is no distinguished "startup session".
        void this.pushAllConsumerSnapshots();
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

  // --- Compute mode (IComputeClient-backed: PlatformClient or
  //     RemoteElectronComputeClient; see AgentProcessMode docs) ---

  private startComputeSession = async (arg: AgentProcessStartArg): Promise<void> => {
    if (!this.computeClient) {
      this.updateStatus({ type: 'error', error: { message: 'Compute client not configured' } });
      return;
    }

    const agentSlug = arg.agentSlug ?? getProductSlug();

    try {
      this.log.info(c.cyan(`Requesting sandbox from compute backend (agent: ${agentSlug})...\r\n`));

      const session = await this.computeClient.startSession(agentSlug, arg.domain, arg.gitRepo, arg.localComputeExtras);
      this.computeSessionId = session.sessionId;

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

      const ready = await this.computeClient.waitForSession(session.sessionId);
      if (this.isStopping()) {
        return;
      }

      const wsUrl = ready.websocketUrl!;
      // Derive the UI/HTTP origin from the WS URL by mapping the scheme, NOT by
      // force-rewriting to ``https:``. ``PlatformClient`` returns a TLS gateway
      // (``wss://`` → ``https://``); ``RemoteElectronComputeClient`` returns the
      // laptop's plain-HTTP loopback (``ws://`` → ``http://``). Forcing https on
      // the latter made the readiness HTTP probe fail forever (TLS handshake
      // against a plain-HTTP server).
      let uiUrl = wsUrl.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:').replace(/\/ws$/, '');
      if (ready.authToken) {
        // Webview handoff only: the bundled web UI reads `?token=` off its own
        // location and exchanges it for a one-time /auth/ws-ticket ticket —
        // the token itself never rides a WS dial URL.
        const sep = uiUrl.includes('?') ? '&' : '?';
        uiUrl = `${uiUrl}${sep}token=${encodeURIComponent(ready.authToken)}`;
      }
      const data: AgentProcessData = {
        uiUrl,
        wsUrl,
        ...(ready.authToken ? { authToken: ready.authToken } : {}),
        containerId: ready.containerId,
      };

      // When the compute backend's ``waitForSession`` already guarantees the
      // sandbox is serving, skip our own HTTP/WS readiness probe.
      // ``RemoteElectronComputeClient`` only reports ``active`` once the
      // laptop's OWN ``AgentProcess`` reached ``running`` (its local readiness
      // probe passed), and the loopback ``wsUrl`` it returns isn't reachable
      // from the cloud anyway — re-probing it here is both redundant and wrong
      // (it's what hung the session at "connecting"). The proxy-rewriter
      // relabels these URLs to ``/proxy/local/<machineId>/<sessionId>/...`` for
      // the renderer downstream.
      if (this.computeClient.confirmsReadiness) {
        this.updateStatus({ type: 'running', data });
        this.log.info(c.green.bold('Compute sandbox started\r\n'));
        return;
      }

      this.updateStatus({ type: 'connecting', data });
      this.log.info(c.cyan('Waiting for compute backend services to accept connections...\r\n'));
      await this.waitForReady(data);
    } catch (error) {
      if (this.isStopping()) {
        return;
      }
      // Surface structured ComputeError envelopes (host-offline, machine-at-
      // capacity) so the renderer can show the right banner. ComputeError is
      // shaped { kind, machineId, machineLabel, extras } — `errorEnvelope`
      // splats those onto the AgentProcessStatus error field.
      type ErrorVariant = Extract<AgentProcessStatus, { type: 'error' }>;
      const errorEnvelope: ErrorVariant['error'] = {
        message: (error as Error).message,
      };
      const ce = error as {
        kind?: 'host-offline' | 'machine-at-capacity' | 'machine-removed';
        machineId?: string;
        machineLabel?: string;
        extras?: Record<string, unknown>;
      };
      if (ce.kind === 'host-offline' || ce.kind === 'machine-at-capacity') {
        errorEnvelope.kind = ce.kind;
        if (ce.machineId) {
          errorEnvelope.machineId = ce.machineId;
        }
        if (ce.machineLabel) {
          errorEnvelope.machineLabel = ce.machineLabel;
        }
        if (typeof ce.extras?.['maxSessions'] === 'number') {
          errorEnvelope.maxSessions = ce.extras['maxSessions'] as number;
        }
        if (typeof ce.extras?.['currentSessions'] === 'number') {
          errorEnvelope.currentSessions = ce.extras['currentSessions'] as number;
        }
      }
      this.updateStatus({ type: 'error', error: errorEnvelope });
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

  private waitForRunningData = async (): Promise<AgentProcessData> => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (this.status.type === 'running') {
        return this.status.data;
      }
      if (this.status.type === 'error') {
        throw new Error(this.status.error.message);
      }
      if (this.status.type === 'exited' || this.status.type === 'exiting') {
        throw new Error('AgentHost exited before it became ready');
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
    }
    throw new Error('Timed out waiting for AgentHost readiness');
  };

  private closeAgentHostControl = (): void => {
    this.agentHostControlClient?.close();
    this.agentHostControlClient = null;
    this.agentHostControlToken = null;
  };

  private pushConsumerSnapshot = async (environmentId: string): Promise<void> => {
    const snapshotRef = this.consumerSnapshotRefs.get(environmentId);
    if (!snapshotRef) {
      return;
    }
    this.consumerSnapshotRefs.delete(environmentId);
    const snapshotDir = path.join(getOmniConfigDir(), 'snapshots');
    try {
      await getSnapshotStore().push(snapshotRef, snapshotDir);
    } catch (error) {
      console.error(`[snapshot-blob] push failed for ${snapshotRef}:`, error);
    }
  };

  private pushAllConsumerSnapshots = async (): Promise<void> => {
    const environmentIds = [...this.consumerSnapshotRefs.keys()];
    await Promise.all(environmentIds.map((environmentId) => this.pushConsumerSnapshot(environmentId)));
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
    const echoed = redactAuthTokens(str);
    this.ipcRawOutput(echoed);
    process.stdout.write(echoed);
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
    const maxAttempts = 120;

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
          const socket = new WsWebSocket(url, wsAuthOptions(data.authToken));
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

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (this.isStopping()) {
        return;
      }
      const httpOk = await checkHttp(data.uiUrl);
      const wsOk = data.wsUrl ? await checkWs(data.wsUrl) : true;
      if (httpOk && wsOk) {
        if (this.isStopping()) {
          return;
        }
        this.updateStatus({ type: 'running', data });
        const label = this.mode === 'compute' ? 'Compute sandbox' : 'Sandbox';
        this.log.info(c.green.bold(`${label} started\r\n`));
        return;
      }
      await new Promise<void>((r) => {
        setTimeout(r, 1000);
      });
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

  /**
   * SIGTERM, then SIGKILL after the grace period.
   *
   * The grace was 10s; uvicorn under live WS connections regularly needs
   * 15-20s to drain (closes every client socket gracefully before
   * shutting down). 30s leaves comfortable headroom without making the
   * worst case feel unbounded.
   *
   * The child is added to {@link intentionallyKilled} so its `close`
   * event handler skips the `error("signal SIGKILL")` status update —
   * the caller is responsible for whatever status comes next (either
   * `exited` from stop()/exit(), or `starting` from a back-to-back
   * rebuild's start()).
   */
  private killProcess = (timeout = 30_000): Promise<void> => {
    const child = this.childProcess;
    if (!child || child.exitCode !== null) {
      this.childProcess = null;
      return Promise.resolve();
    }
    this.intentionallyKilled.add(child);
    return new Promise<void>((resolve) => {
      const onExit = (): void => {
        clearTimeout(timer);
        if (this.childProcess === child) {
          this.childProcess = null;
        }
        resolve();
      };
      child.once('close', onExit);
      child.kill('SIGTERM');
      const timer = setTimeout(() => {
        child.removeListener('close', onExit);
        child.kill('SIGKILL');
        if (this.childProcess === child) {
          this.childProcess = null;
        }
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
