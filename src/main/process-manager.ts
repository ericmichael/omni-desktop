import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { ipcMain } from 'electron';

import { mirrorContainerChangesToHost } from '@/lib/container-sync';
import {
  AgentProcess,
  type AgentProcessMode,
  type AgentProcessSource,
  type AgentProcessStartArg,
  type FetchFn,
} from '@/main/agent-process';
import type { IComputeClient } from '@/main/platform-client';
import { getDefaultWorkspaceDir } from '@/main/util';
import { gitTokenEnvName, resolveCredentialForUrl } from '@/shared/git-credentials';
import type { IIpcListener } from '@/shared/ipc-listener';
import type {
  AgentProcessStartOptions,
  AgentProcessStatus,
  GitCredential,
  IpcRendererEvents,
  Project,
  SandboxPauseResult,
  SandboxSwitchResult,
  WithTimestamp,
} from '@/shared/types';

export type ProcessManagerStoreData = {
  defaultProfileName: string;
  projects: Project[];
  /** Stored git credential metadata (host-scoped). Tokens are read lazily via
   *  `resolveGitToken`; this list only drives host matching. */
  gitCredentials?: GitCredential[];
};

/**
 * True for host directories the launcher itself manages: a per-conversation
 * scratch dir (`<workspace root>/Sessions/<sessionId>` — the root is
 * user-configurable, so the convention is the `Sessions` parent) or anything
 * under the default workspace tree (`~/Omni/Workspace`, which holds the
 * Personal root and managed `Projects/<slug>/` dirs). Container changes
 * auto-mirror into these without confirmation — the launcher created them, so
 * there is no foreign user data to clobber. This is only consulted for
 * synthesized sources; user-attached project sources never auto-mirror
 * regardless of where they live.
 */
export const isLauncherOwnedDir = (dir: string): boolean => {
  const resolved = path.resolve(dir);
  if (path.basename(path.dirname(resolved)) === 'Sessions') {
    return true;
  }
  const defaultRoot = path.resolve(getDefaultWorkspaceDir());
  return resolved === defaultRoot || resolved.startsWith(defaultRoot + path.sep);
};

/** How often the auto-mirror sweep checks running launcher-owned sandboxes. */
const AUTO_MIRROR_INTERVAL_MS = 15_000;

/**
 * Detect the `local:<machineId>` profile-name shape and pull out the
 * machine id. `null` for non-local profiles.
 */
export const parseLocalProfile = (profileName: string): string | null => {
  if (!profileName.startsWith('local:')) {
    return null;
  }
  const id = profileName.slice('local:'.length).trim();
  return id.length > 0 ? id : null;
};

/**
 * Computer-as-sandbox: prepares a per-session `host_bridge` sandbox profile
 * pointing the cloud `omni serve`'s sandbox at a user's laptop. Implemented by
 * `HostBridgePreparer` (cloud); injected so `ProcessManager` stays free of
 * server imports. `prepare` asks the laptop to stand up `omni sandbox-host`
 * and returns the profile path; `release` tears it down.
 */
export interface IHostBridgePreparer {
  prepare(machineId: string, sandboxKey: string, opts: { workspaceDir?: string }): Promise<{ profilePath: string }>;
  release(machineId: string, sandboxKey: string): Promise<void>;
  /** Live online state + friendly label for a machine, for the host-offline
   *  overlay. Backed by the cloud's `MachineRegistry`. */
  machineState(machineId: string): { online: boolean; label?: string };
}

/**
 * Result envelope from `compute:adopt-session` (Phase 6). The cloud calls it
 * after a laptop reconnects; an `adopted: true` flips the cloud's view of
 * the session from `disconnected` → `running` without a fresh spawn.
 */
export type AgentAdoptResult =
  | { adopted: true; wsUrl: string; uiUrl: string; containerId?: string }
  | { adopted: false };

/**
 * Unified process manager for all agent processes (chat + code tabs).
 *
 * Every agent process is keyed by a string ID:
 *   - `"chat"` for the singleton chat process
 *   - A CodeTabId for code-tab processes
 *
 * Profile resolution: per-project override > user-default. The `"platform"`
 * profile and any `local:<machineId>` profile route to `compute` mode (an
 * `IComputeClient` drives the lifecycle); everything else spawns
 * ``omni serve --profile <resolved>``.
 */
export class ProcessManager {
  private processes = new Map<string, AgentProcess>();
  private lastStartArgs = new Map<string, AgentProcessStartOptions>();
  private sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
  private fetchFn: FetchFn;
  private getStoreData: () => ProcessManagerStoreData;
  /**
   * Resolves the env merged into each `omni serve` spawn (model API keys,
   * runtime tokens, codex materialization, etc.).
   *
   * Public so the local-compute reverse handlers (cloud-dispatched starts on
   * this Electron) can swap in the cloud-shipped materialized env per-start
   * and restore the original afterwards. The cloud serialises its start calls
   * per machine, so the temporary swap is race-free in that path.
   */
  getExtraEnv?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Read a git token by credential id (from the SecretStore). Absent → no
   *  private-remote auth (tokens never reach this class except through here). */
  private resolveGitToken?: (credentialId: string) => Promise<string | undefined>;
  /**
   * When set, every launch uses this profile regardless of the per-project
   * override or user default. Cloud deployments set it to the ACI profiles so
   * host/devbox can't be selected — but the user can still choose among the
   * allowed cloud profiles (e.g. `aci` fast vs `aci-desktop`).
   */
  private allowedProfileNames?: string[];

  /** Compute backend (omni-platform delegation). Set when configured. */
  platformClient: IComputeClient | null = null;

  /**
   * Computer-as-sandbox: prepares a `host_bridge` profile so `local:<machineId>`
   * launches run `omni serve` HERE (the agent stays put) with the user's laptop
   * as the sandbox backend. Cloud-only; undefined elsewhere. See
   * `src/server/host-bridge-preparer.ts`.
   */
  private hostBridge?: IHostBridgePreparer;

  /** processId → machineId for live `local:<machineId>` sessions, so stop()
   *  can tell the laptop to tear down its `omni sandbox-host`. */
  private localSandboxKeys = new Map<string, string>();

  /** processId → launcher-owned local mounts whose container changes
   *  auto-mirror back to the host (chat scratch dirs, managed project dirs). */
  private mirrorSources = new Map<string, Array<{ mountName: string; workspaceDir: string }>>();
  private mirrorTimer: ReturnType<typeof setInterval> | null = null;
  private mirrorSweepRunning = false;

  constructor(arg: {
    sendToWindow: ProcessManager['sendToWindow'];
    fetchFn?: FetchFn;
    getStoreData?: () => ProcessManagerStoreData;
    /** Extra env for spawned `omni serve` (e.g. cloud `OMNI_RUNTIME_TOKEN`).
     *  May be async — used by cloud to materialize per-principal codex tokens
     *  to the spawn's config dir from PgSecretStore before omni-serve starts. */
    getExtraEnv?: () => Record<string, string> | Promise<Record<string, string>>;
    /** Read a git token by credential id, for private-remote auth at clone time. */
    resolveGitToken?: (credentialId: string) => Promise<string | undefined>;
    /** Restrict launches to these profiles (cloud → the ACI profiles). The
     * user still picks among them; anything outside falls back to the default. */
    allowedProfileNames?: string[];
    /** Computer-as-sandbox preparer (cloud-only). */
    hostBridge?: IHostBridgePreparer;
  }) {
    this.sendToWindow = arg.sendToWindow;
    this.fetchFn = arg.fetchFn ?? globalThis.fetch;
    this.getStoreData =
      arg.getStoreData ??
      (() => ({
        defaultProfileName: 'host',
        projects: [],
      }));
    this.getExtraEnv = arg.getExtraEnv;
    this.resolveGitToken = arg.resolveGitToken;
    this.allowedProfileNames = arg.allowedProfileNames;
    this.hostBridge = arg.hostBridge;
  }

  private resolveProfileName(projectId: string | undefined, override: string | undefined): string {
    const { defaultProfileName, projects } = this.getStoreData();
    const pick =
      override ??
      (projectId ? projects.find((p) => p.id === projectId)?.sandboxProfile : undefined) ??
      defaultProfileName;
    // An allow-list (cloud → the ACI profiles) constrains the choice: a pick
    // outside it (e.g. host/devbox) can't escape, falling back to the default.
    // Local-machine profiles (`local:<machineId>`) are an implicit override —
    // they're always allowed because the registry verified the principal owns
    // the machine before they ever appeared in the picker.
    if (parseLocalProfile(pick)) {
      return pick;
    }
    if (this.allowedProfileNames && !this.allowedProfileNames.includes(pick)) {
      return defaultProfileName;
    }
    return pick;
  }

  private resolveMode(profileName: string): AgentProcessMode {
    // `compute` mode = delegate to an `IComputeClient` (the omni-platform
    // delegation path). Everything else — including `local:<machineId>`
    // (computer-as-sandbox) — spawns `omni serve` here; `local:` differs only
    // in that it runs with a `host_bridge` profile pointing the sandbox at the
    // user's laptop.
    if (profileName === 'platform') {
      return 'compute';
    }
    return 'serve';
  }

  /**
   * The compute client to drive a launch of *profileName*, or `null` to mean
   * "spawn omni serve locally (serve mode)". Only the `'platform'` profile
   * (omni-platform delegation) uses a compute client.
   */
  resolveComputeClient(profileName: string): IComputeClient | null {
    if (profileName === 'platform') {
      return this.platformClient;
    }
    return null;
  }

  /**
   * Platform mode only: if the project has a git remote, the container can
   * clone instead of receiving an upload. Returns undefined for serve mode
   * (omni serve's manifest materialization handles workspace seeding).
   */
  private resolvePlatformGitRepo(
    profileName: string,
    workspaceDir: string,
    projectId: string | undefined
  ): { url: string; branch?: string } | undefined {
    if (profileName !== 'platform') {
      return undefined;
    }
    const { projects } = this.getStoreData();

    // Explicit git-remote project (single-source platform path; multi-source
    // not yet supported in platform mode — first git-remote source wins).
    if (projectId) {
      const project = projects.find((p) => p.id === projectId);
      const gitRemote = project?.sources.find((s) => s.kind === 'git-remote');
      if (gitRemote?.kind === 'git-remote') {
        return { url: gitRemote.repoUrl, branch: gitRemote.defaultBranch };
      }
    }

    // Local project with git — resolve remote URL so the platform container can clone
    if (workspaceDir) {
      return this.resolveGitRemote(workspaceDir);
    }
    return undefined;
  }

  /** Try to resolve the git remote URL and current branch from a workspace directory. */
  private resolveGitRemote(workspaceDir: string): { url: string; branch?: string } | undefined {
    try {
      const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: workspaceDir,
        timeout: 3000,
        encoding: 'utf-8',
      }).trim();
      if (!url) {
        return undefined;
      }

      let branch: string | undefined;
      try {
        branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: workspaceDir,
          timeout: 3000,
          encoding: 'utf-8',
        }).trim();
        if (branch === 'HEAD') {
          branch = undefined;
        } // detached HEAD
      } catch {
        /* ignore */
      }

      return branch ? { url, branch } : { url };
    } catch {
      return undefined;
    }
  }

  private getOrCreate(processId: string, mode: AgentProcessMode, computeClient?: IComputeClient | null): AgentProcess {
    const existing = this.processes.get(processId);
    if (existing && existing.mode === mode) {
      return existing;
    }
    if (existing) {
      void existing.exit();
    }
    const proc = new AgentProcess({
      mode,
      ipcRawOutput: (data) => {
        this.sendToWindow('agent-process:raw-output', processId, data);
      },
      onStatusChange: (status) => {
        this.sendToWindow('agent-process:status', processId, status);
      },
      fetchFn: this.fetchFn,
      computeClient: computeClient ?? this.platformClient ?? undefined,
      getExtraEnv: this.getExtraEnv,
    });
    this.processes.set(processId, proc);
    return proc;
  }

  private async buildStartArg(opts: AgentProcessStartOptions): Promise<AgentProcessStartArg> {
    const profileName = this.resolveProfileName(opts.projectId, opts.profileNameOverride);
    const sources = this.resolveProjectSources(opts.workspaceDir, opts.projectId);
    const startArg: AgentProcessStartArg = {
      profileName,
      sources,
      workspaceDir: opts.workspaceDir,
    };
    if (opts.projectId) {
      startArg.projectId = opts.projectId;
    }
    if (opts.sessionId) {
      startArg.sessionId = opts.sessionId;
    }
    if (opts.containerId) {
      startArg.containerId = opts.containerId;
    }
    const gitRepo = this.resolvePlatformGitRepo(profileName, opts.workspaceDir, opts.projectId);
    if (gitRepo) {
      startArg.gitRepo = gitRepo;
    }
    // Resolve a stored credential for each private git-remote source, attach the
    // auth hint to the descriptor, and collect the token env (value off-disk).
    const gitAuth = await this.resolveGitAuth(sources);
    if (gitAuth) {
      startArg.gitTokenEnv = gitAuth.env;
      if (gitAuth.credentials.length > 0) {
        startArg.credentials = gitAuth.credentials;
      }
    }
    return startArg;
  }

  /**
   * Resolve git credentials for the sandbox, scoped to the hosts the project's
   * sources actually reference. For each source we determine its remote URL —
   * a ``git-remote`` carries it directly; a ``local-git`` checkout's is read from
   * its own ``origin`` — match a stored credential by host, and read the token.
   *
   * Returns the `{ tokenEnvName: token }` env map (tokens never touch disk/argv;
   * only the env-var *name* travels) plus a deduped ``credentials`` bundle
   * (`{ url, username, tokenEnv }`) the launcher forwards as ``--credential`` so
   * ``omni serve`` configures git + the host's CLI (`gh` / `az devops`) at boot
   * for every linked host — covering local-git checkouts, not just clones.
   *
   * ``git-remote`` sources additionally get the in-place ``auth`` hint they need
   * for clone-time auth (the boot pass runs after ``create()``, too late to help
   * the clone itself).
   */
  private async resolveGitAuth(sources: AgentProcessSource[]): Promise<
    | {
        env: Record<string, string>;
        credentials: Array<{ url: string; username: string; tokenEnv: string }>;
      }
    | undefined
  > {
    const resolve = this.resolveGitToken;
    if (!resolve) {
      return undefined;
    }
    const { gitCredentials } = this.getStoreData();
    if (!gitCredentials?.length) {
      return undefined;
    }
    const env: Record<string, string> = {};
    const credentials: Array<{ url: string; username: string; tokenEnv: string }> = [];
    const seen = new Set<string>();
    for (const source of sources) {
      let url: string | undefined;
      if (source.kind === 'git-remote') {
        url = source.repoUrl;
      } else if (source.kind === 'local-git') {
        url = this.resolveGitRemote(source.workspaceDir)?.url;
      }
      if (!url) {
        continue;
      }
      const cred = resolveCredentialForUrl(gitCredentials, url);
      if (!cred) {
        continue;
      }
      const token = await resolve(cred.id);
      if (!token) {
        // The credential metadata matched the source's host, but no token could
        // be read from this runtime's secret store. Surface it — otherwise the
        // private clone proceeds unauthenticated and fails with an opaque error.
        console.warn(
          `[process-manager] credential for ${cred.host} (${cred.id}) is linked but its token ` +
            `could not be read here; re-link it in Settings → Git`
        );
        continue;
      }
      const tokenEnv = gitTokenEnvName(cred.id);
      env[tokenEnv] = token;
      if (source.kind === 'git-remote') {
        source.auth = { tokenEnv, username: cred.username };
      }
      const key = `${tokenEnv}|${url}`;
      if (!seen.has(key)) {
        seen.add(key);
        credentials.push({ url, username: cred.username, tokenEnv });
      }
    }
    return Object.keys(env).length > 0 ? { env, credentials } : undefined;
  }

  /**
   * Translate the project's stored ``ProjectSource`` (or, when missing,
   * the bare workspaceDir) into the ``AgentProcessSource`` ``omni serve``
   * needs. Distinguishes ``local`` from ``local-git`` by probing for a
   * ``.git`` entry, since the launcher's stored ``gitDetected`` flag
   * isn't guaranteed to be fresh for every code path that lands here.
   */
  private resolveProjectSources(workspaceDir: string, projectId: string | undefined): AgentProcessSource[] {
    // Translate each Project.source (which carries id + mountName) into
    // the AgentProcessSource shape ``omni serve`` understands. Per-source
    // git-detection happens here so the wire format already commits to
    // ``local-git`` vs ``local``.
    if (projectId) {
      const { projects } = this.getStoreData();
      const project = projects.find((p) => p.id === projectId);
      // A project with no attached sources (context-only / managed-dir
      // project) falls through to the synthesized-source path below so its
      // managed directory still seeds the workspace and mirrors back.
      if (project && project.sources.length > 0) {
        return project.sources.map((source): AgentProcessSource => {
          if (source.kind === 'git-remote') {
            const result: AgentProcessSource = {
              mountName: source.mountName,
              kind: 'git-remote',
              repoUrl: source.repoUrl,
            };
            if (source.defaultBranch) {
              result.ref = source.defaultBranch;
            }
            return result;
          }
          this.ensureWorkspaceDir(source.workspaceDir);
          // User-attached folders are never launcherOwned — applying
          // container changes to them stays an explicit user action.
          return {
            mountName: source.mountName,
            kind: this.directoryHasGit(source.workspaceDir) ? 'local-git' : 'local',
            workspaceDir: source.workspaceDir,
          };
        });
      }
    }
    // No attached sources (chat scratch dir / managed project dir / Personal
    // root): synthesize one source from the workspaceDir we were given,
    // defaulting mountName to the basename.
    if (!workspaceDir) {
      return [];
    }
    this.ensureWorkspaceDir(workspaceDir);
    const mountName = path.basename(workspaceDir) || 'workspace';
    return [
      {
        mountName,
        kind: this.directoryHasGit(workspaceDir) ? 'local-git' : 'local',
        workspaceDir,
        ...(isLauncherOwnedDir(workspaceDir) ? { launcherOwned: true } : {}),
      },
    ];
  }

  private directoryHasGit(workspaceDir: string): boolean {
    if (!workspaceDir) {
      return false;
    }
    try {
      return existsSync(path.join(workspaceDir, '.git'));
    } catch {
      return false;
    }
  }

  /**
   * A `local` source's directory must exist or the agent's pre-flight check
   * rejects it ("Workspace directory not found"). On a fresh host — notably
   * the cloud container, where a project's default `~/Omni/Workspace` doesn't
   * exist yet — create it. An empty workspace is a valid starting point.
   *
   * Failures are logged at WARN: the previous silent-catch made the
   * downstream "Workspace directory not found" error impossible to debug
   * because the actual mkdir failure (permission denied / EROFS / ENOENT on
   * the parent / etc.) never surfaced anywhere. The caller still treats
   * mkdir-failed as a normal "missing dir" so it can fall through to the
   * agent's own existence check; this log just lets us SEE why.
   */
  private ensureWorkspaceDir(workspaceDir: string): void {
    if (!workspaceDir) {
      return;
    }
    try {
      mkdirSync(workspaceDir, { recursive: true });
    } catch (err) {
      console.warn(`[process-manager] ensureWorkspaceDir failed for "${workspaceDir}": ${(err as Error).message}`);
    }
  }

  /**
   * For a `local:<machineId>` profile, ask the laptop (via the host bridge) to
   * stand up its `omni sandbox-host` and return the path of a per-session
   * `host_bridge` profile that points this spawn's sandbox at it. The agent
   * still runs HERE (serve mode); only the sandbox backend is the laptop.
   * Returns `null` for non-local profiles. The `sandboxKey` is the stable
   * processId — it keys the laptop's exec server and the relay path.
   */
  private async prepareHostBridge(
    processId: string,
    profileName: string,
    workspaceDir: string | undefined
  ): Promise<string | null> {
    const machineId = parseLocalProfile(profileName);
    if (!machineId) {
      return null;
    }
    if (!this.hostBridge) {
      throw new Error(`local sandbox needs a host bridge (machine ${machineId}) — not available`);
    }
    const { profilePath } = await this.hostBridge.prepare(machineId, processId, { workspaceDir });
    this.localSandboxKeys.set(processId, machineId);
    return profilePath;
  }

  start = async (processId: string, opts: AgentProcessStartOptions): Promise<void> => {
    this.lastStartArgs.set(processId, opts);
    const startArg = await this.buildStartArg(opts);
    const profilePath = await this.prepareHostBridge(processId, startArg.profileName, opts.workspaceDir);
    if (profilePath) {
      startArg.explicitProfilePath = profilePath;
    }
    const mode = this.resolveMode(startArg.profileName);
    const client = this.resolveComputeClient(startArg.profileName);
    const proc = this.getOrCreate(processId, mode, client);
    this.trackMirrorSources(processId, startArg.sources);
    proc.start(startArg);
  };

  stop = async (processId: string): Promise<void> => {
    const proc = this.processes.get(processId);
    if (!proc) {
      return;
    }
    this.mirrorSources.delete(processId);
    await proc.stop();
    this.processes.delete(processId);
    const machineId = this.localSandboxKeys.get(processId);
    if (machineId && this.hostBridge) {
      this.localSandboxKeys.delete(processId);
      void this.hostBridge.release(machineId, processId).catch(() => {});
    }
  };

  rebuild = async (processId: string, opts: AgentProcessStartOptions): Promise<void> => {
    const lastOpts = this.lastStartArgs.get(processId);
    const merged: AgentProcessStartOptions = {
      workspaceDir: opts.workspaceDir || lastOpts?.workspaceDir || '',
      ...((opts.projectId ?? lastOpts?.projectId)
        ? { projectId: (opts.projectId ?? lastOpts?.projectId) as string }
        : {}),
      ...((opts.profileNameOverride ?? lastOpts?.profileNameOverride)
        ? { profileNameOverride: (opts.profileNameOverride ?? lastOpts?.profileNameOverride) as string }
        : {}),
      ...((opts.sessionId ?? lastOpts?.sessionId)
        ? { sessionId: (opts.sessionId ?? lastOpts?.sessionId) as string }
        : {}),
      ...((opts.containerId ?? lastOpts?.containerId)
        ? { containerId: (opts.containerId ?? lastOpts?.containerId) as string }
        : {}),
    };
    const startArg = await this.buildStartArg(merged);
    const profilePath = await this.prepareHostBridge(processId, startArg.profileName, merged.workspaceDir);
    if (profilePath) {
      startArg.explicitProfilePath = profilePath;
    }
    const mode = this.resolveMode(startArg.profileName);
    const client = this.resolveComputeClient(startArg.profileName);
    const proc = this.getOrCreate(processId, mode, client);
    this.trackMirrorSources(processId, startArg.sources);
    await proc.rebuild(startArg);
  };

  getStatus = (processId: string): WithTimestamp<AgentProcessStatus> => {
    const proc = this.processes.get(processId);
    const status = proc ? proc.getStatus() : { type: 'uninitialized' as const, timestamp: Date.now() };
    return this.withHostOfflineOverlay(processId, status);
  };

  /**
   * Computer-as-sandbox sticky host-offline overlay. For a `running` session
   * whose laptop (`local:<machineId>`) WS has dropped, flag `data.hostOffline`
   * so the renderer shows a non-destructive banner over the still-running cloud
   * session (the agent + chat are in the cloud and unaffected; only its sandbox
   * tools are unreachable). Poll-driven, so the banner persists across polls and
   * clears automatically once the machine reconnects (and `resumeOnReconnect`
   * re-establishes the sandbox). No-op for non-local sessions or when online.
   */
  private withHostOfflineOverlay(
    processId: string,
    status: WithTimestamp<AgentProcessStatus>
  ): WithTimestamp<AgentProcessStatus> {
    const machineId = this.localSandboxKeys.get(processId);
    if (!machineId || !this.hostBridge || status.type !== 'running') {
      return status;
    }
    const st = this.hostBridge.machineState(machineId);
    if (st.online) {
      return status;
    }
    return {
      ...status,
      data: {
        ...status.data,
        hostOffline: true,
        ...(st.label ? { hostOfflineMachineLabel: st.label } : {}),
      },
    };
  }

  /**
   * Called when a machine goes offline. Broadcasts a `host-offline` overlay
   * (`agent-process:status` event) for every running local session on it, so
   * renderers flip to the banner immediately. The renderer poll early-returns
   * once a session is `running`, so without this push the overlay would never
   * surface for a live session (going offline produces no status-change event —
   * omni-serve keeps running in the cloud).
   */
  broadcastHostOffline = (machineId: string): void => {
    for (const [processId, mid] of this.localSandboxKeys.entries()) {
      if (mid !== machineId) {
        continue;
      }
      const proc = this.processes.get(processId);
      if (!proc) {
        continue;
      }
      const overlaid = this.withHostOfflineOverlay(processId, proc.getStatus());
      if (overlaid.type === 'running' && overlaid.data.hostOffline) {
        this.sendToWindow('agent-process:status', processId, overlaid);
      }
    }
  };

  /**
   * Called when a machine reconnects. Rebuilds every local session anchored to
   * it so the sandbox exec channel is re-established (a fresh `omni sandbox-host`
   * + `omni serve` with a new host_bridge profile). Chat history survives via
   * PgSessionStorage and the workspace lives on the laptop's disk, so this is a
   * clean resume — only an in-flight agent turn (if any) is lost. The cloud's
   * `localSandboxKeys` is the source of truth (the registry's per-machine anchors
   * are dropped while the machine is offline; these survive).
   */
  resumeOnReconnect = async (machineId: string): Promise<void> => {
    const toResume = [...this.localSandboxKeys.entries()]
      .filter(([, mid]) => mid === machineId)
      .map(([processId]) => processId);
    for (const processId of toResume) {
      // Skip if a (re)start is already in flight — guards against WS-reconnect
      // flapping triggering overlapping rebuilds.
      const st = this.processes.get(processId)?.getStatus().type;
      if (st === 'starting' || st === 'connecting') {
        continue;
      }
      const opts = this.lastStartArgs.get(processId);
      if (!opts) {
        continue;
      }
      try {
        await this.rebuild(processId, opts);
      } catch (err) {
        console.error(`[host-bridge] resume rebuild failed for ${processId}:`, (err as Error).message);
      }
    }
  };

  resizePty = (processId: string, cols: number, rows: number): void => {
    this.processes.get(processId)?.resizePty(cols, rows);
  };

  pause = async (processId: string): Promise<SandboxPauseResult> => {
    const proc = this.processes.get(processId);
    if (!proc) {
      return { ok: false, supported: false, reason: 'process not found' };
    }
    return proc.pause();
  };

  unpause = async (processId: string): Promise<SandboxPauseResult> => {
    const proc = this.processes.get(processId);
    if (!proc) {
      return { ok: false, supported: false, reason: 'process not found' };
    }
    return proc.unpause();
  };

  switchSandbox = async (processId: string, profileName: string): Promise<SandboxSwitchResult> => {
    const proc = this.processes.get(processId);
    if (!proc) {
      return { ok: false, reason: 'process not found' };
    }
    return proc.switchSandbox(profileName);
  };

  notifyActivity = (processId: string): void => {
    this.processes.get(processId)?.notifyActivity();
  };

  /**
   * Look up a running process's WebSocket URL for a code tab linked to the given ticketId.
   * Used by ProjectManager to reuse an existing sandbox instead of creating a duplicate.
   */
  getRunningWsUrlForTicket(ticketId: string, codeTabs: Array<{ id: string; ticketId?: string }>): string | null {
    for (const tab of codeTabs) {
      if (tab.ticketId !== ticketId) {
        continue;
      }
      const proc = this.processes.get(tab.id);
      if (!proc) {
        continue;
      }
      const status = proc.getStatus();
      if (status.type === 'running' && status.data.wsUrl) {
        return status.data.wsUrl;
      }
    }
    return null;
  }

  /**
   * Find a running docker container id for the given project. Used by
   * ProjectManager to ``docker exec`` against the agent's workspace for
   * PR-diff and merge operations.
   *
   * Returns the first running process's container id (any process for
   * the project is fine — they all share the per-project snapshot).
   */
  getProjectContainerId(projectId: string): string | null {
    for (const [processId, opts] of this.lastStartArgs.entries()) {
      if (opts.projectId !== projectId) {
        continue;
      }
      const proc = this.processes.get(processId);
      if (!proc) {
        continue;
      }
      const status = proc.getStatus();
      // ``running`` is the post-connect state; ``connecting`` already has
      // ``data.containerId`` because the readiness payload arrives before
      // the WS handshake completes. Accept both so PR queries don't have
      // to wait for the agent's WS to be fully open.
      if ((status.type === 'running' || status.type === 'connecting') && status.data.containerId) {
        return status.data.containerId;
      }
    }
    return null;
  }

  getProcessContainerId(processId: string): string | null {
    const proc = this.processes.get(processId);
    if (!proc) {
      return null;
    }
    const status = proc.getStatus();
    if ((status.type === 'running' || status.type === 'connecting') && status.data.containerId) {
      return status.data.containerId;
    }
    return null;
  }

  /**
   * Container ids of every live agent process (``connecting`` or
   * ``running``). Feeds the startup orphan sweep's protected set so it
   * never removes a container a session of this launcher instance is
   * already attached to.
   */
  getAllContainerIds(): string[] {
    const ids: string[] = [];
    for (const proc of this.processes.values()) {
      const status = proc.getStatus();
      if ((status.type === 'running' || status.type === 'connecting') && status.data.containerId) {
        ids.push(status.data.containerId);
      }
    }
    return ids;
  }

  /**
   * The host workspace dir the given process was last started against (e.g.
   * the chat session's per-conversation scratch dir). Authoritative for
   * mount-name derivation — the store's `workspaceDir` is the workspace
   * *root*, not the live session's mount source.
   */
  getProcessWorkspaceDir(processId: string): string | null {
    return this.lastStartArgs.get(processId)?.workspaceDir || null;
  }

  /**
   * Remember which of a launch's mounts auto-mirror, and make sure the sweep
   * timer is running when at least one process has any. Only docker-backed
   * sessions ever mirror — the sweep keys off `getProcessContainerId`, which
   * is null for host/ACI/host_bridge backends.
   */
  private trackMirrorSources(processId: string, sources: AgentProcessSource[]): void {
    const owned = sources
      .filter(
        (s): s is Extract<AgentProcessSource, { workspaceDir: string }> =>
          (s.kind === 'local' || s.kind === 'local-git') && s.launcherOwned === true
      )
      .map((s) => ({ mountName: s.mountName, workspaceDir: s.workspaceDir }));
    if (owned.length === 0) {
      this.mirrorSources.delete(processId);
      return;
    }
    this.mirrorSources.set(processId, owned);
    if (!this.mirrorTimer) {
      this.mirrorTimer = setInterval(() => {
        void this.sweepMirrors();
      }, AUTO_MIRROR_INTERVAL_MS);
      // Mirroring must never keep the process alive on its own.
      this.mirrorTimer.unref?.();
    }
  }

  /**
   * One auto-mirror pass: for every running launcher-owned mount, mirror the
   * container's changed-vs-seed set onto the host dir. The mirror is
   * idempotent (it copies current files, not patches), so a no-change sweep
   * is a cheap git-diff inside the container. Re-entrancy guarded — slow
   * docker execs must not stack sweeps.
   */
  private sweepMirrors = async (): Promise<void> => {
    if (this.mirrorSweepRunning) {
      return;
    }
    this.mirrorSweepRunning = true;
    try {
      for (const [processId, mounts] of this.mirrorSources.entries()) {
        const containerId = this.getProcessContainerId(processId);
        if (!containerId) {
          continue;
        }
        for (const mount of mounts) {
          try {
            await mirrorContainerChangesToHost(containerId, mount.mountName, mount.workspaceDir);
          } catch {
            // Transient (container mid-restart, docker hiccup) — next sweep retries.
          }
        }
      }
    } finally {
      this.mirrorSweepRunning = false;
    }
  };

  cleanup = async (): Promise<void> => {
    if (this.mirrorTimer) {
      clearInterval(this.mirrorTimer);
      this.mirrorTimer = null;
    }
    this.mirrorSources.clear();
    const exits = Array.from(this.processes.values()).map((p) => p.exit());
    await Promise.allSettled(exits);
    this.processes.clear();
    this.lastStartArgs.clear();
  };
}

/**
 * Register the `agent-process:*` IPC handlers. `resolve(event)` picks the
 * ProcessManager to act on — `() => mgr` for the single-manager Electron app,
 * or `event => registry.get(event.tenantId).processManager` for the per-tenant
 * server. Returns the channel names for cleanup.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function registerProcessHandlers(ipc: IIpcListener, resolve: (event: unknown) => ProcessManager): string[] {
  const channels: string[] = [];
  const h = (ch: string, fn: (pm: ProcessManager, ...args: any[]) => unknown): void => {
    ipc.handle(ch, (event: unknown, ...args: any[]) => fn(resolve(event), ...args));
    channels.push(ch);
  };

  h('agent-process:start', (pm, processId, startArg) => pm.start(processId, startArg));
  h('agent-process:stop', (pm, processId) => pm.stop(processId));
  h('agent-process:rebuild', (pm, processId, rebuildArg) => pm.rebuild(processId, rebuildArg));
  h('agent-process:resize', (pm, processId, cols, rows) => pm.resizePty(processId, cols, rows));
  h('agent-process:get-status', (pm, processId) => pm.getStatus(processId));
  h('agent-process:pause', (pm, processId) => pm.pause(processId));
  h('agent-process:unpause', (pm, processId) => pm.unpause(processId));
  h('agent-process:notify-activity', (pm, processId) => pm.notifyActivity(processId));
  h('agent-process:switch-sandbox', (pm, processId, profileName) => pm.switchSandbox(processId, profileName));

  return channels;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export const createProcessManager = (arg: {
  ipc: IIpcListener;
  sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
  fetchFn?: FetchFn;
  getStoreData?: () => ProcessManagerStoreData;
  resolveGitToken?: (credentialId: string) => Promise<string | undefined>;
  getExtraEnv?: () => Record<string, string> | Promise<Record<string, string>>;
}) => {
  const { ipc, sendToWindow, fetchFn, getStoreData, resolveGitToken, getExtraEnv } = arg;

  const processManager = new ProcessManager({ sendToWindow, fetchFn, getStoreData, resolveGitToken, getExtraEnv });
  const channels = registerProcessHandlers(ipc, () => processManager);

  const cleanup = async () => {
    await processManager.cleanup();
    for (const ch of channels) {
      ipcMain.removeHandler(ch);
    }
  };

  return [processManager, cleanup] as const;
};
