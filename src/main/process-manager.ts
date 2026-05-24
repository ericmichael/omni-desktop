import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { ipcMain } from 'electron';

import {
  AgentProcess,
  type AgentProcessMode,
  type AgentProcessSource,
  type AgentProcessStartArg,
  type FetchFn,
} from '@/main/agent-process';
import type { IComputeClient } from '@/main/platform-client';
import type { IIpcListener } from '@/shared/ipc-listener';
import type {
  AgentProcessStartOptions,
  AgentProcessStatus,
  IpcRendererEvents,
  Project,
  SandboxPauseResult,
  SandboxSwitchResult,
  WithTimestamp,
} from '@/shared/types';

export type ProcessManagerStoreData = {
  defaultProfileName: string;
  projects: Project[];
};

/**
 * Unified process manager for all agent processes (chat + code tabs).
 *
 * Every agent process is keyed by a string ID:
 *   - `"chat"` for the singleton chat process
 *   - A CodeTabId for code-tab processes
 *
 * Profile resolution: per-project override > user-default. Profile name
 * `"platform"` routes to the deferred PlatformClient code path; everything
 * else spawns ``omni serve --profile <resolved>``.
 */
export class ProcessManager {
  private processes = new Map<string, AgentProcess>();
  private lastStartArgs = new Map<string, AgentProcessStartOptions>();
  private sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
  private fetchFn: FetchFn;
  private getStoreData: () => ProcessManagerStoreData;
  private getExtraEnv?: () => Record<string, string>;
  /**
   * When set, every launch uses this profile regardless of the per-project
   * override or user default. Cloud deployments set it to the ACI profiles so
   * host/devbox can't be selected — but the user can still choose among the
   * allowed cloud profiles (e.g. `aci` fast vs `aci-desktop`).
   */
  private allowedProfileNames?: string[];

  /** Compute backend (omni-platform delegation). Set when configured. */
  platformClient: IComputeClient | null = null;

  constructor(arg: {
    sendToWindow: ProcessManager['sendToWindow'];
    fetchFn?: FetchFn;
    getStoreData?: () => ProcessManagerStoreData;
    /** Extra env for spawned `omni serve` (e.g. cloud `OMNI_RUNTIME_TOKEN`). */
    getExtraEnv?: () => Record<string, string>;
    /** Restrict launches to these profiles (cloud → the ACI profiles). The
     * user still picks among them; anything outside falls back to the default. */
    allowedProfileNames?: string[];
  }) {
    this.sendToWindow = arg.sendToWindow;
    this.fetchFn = arg.fetchFn ?? globalThis.fetch;
    this.getStoreData = arg.getStoreData ?? (() => ({
      defaultProfileName: 'host',
      projects: [],
    }));
    this.getExtraEnv = arg.getExtraEnv;
    this.allowedProfileNames = arg.allowedProfileNames;
  }

  private resolveProfileName(
    projectId: string | undefined,
    override: string | undefined
  ): string {
    const { defaultProfileName, projects } = this.getStoreData();
    const pick =
      override ??
      (projectId ? projects.find((p) => p.id === projectId)?.sandboxProfile : undefined) ??
      defaultProfileName;
    // An allow-list (cloud → the ACI profiles) constrains the choice: a pick
    // outside it (e.g. host/devbox) can't escape, falling back to the default.
    if (this.allowedProfileNames && !this.allowedProfileNames.includes(pick)) {
      return defaultProfileName;
    }
    return pick;
  }

  private resolveMode(profileName: string): AgentProcessMode {
    return profileName === 'platform' ? 'platform' : 'serve';
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
      } catch { /* ignore */ }

      return branch ? { url, branch } : { url };
    } catch {
      return undefined;
    }
  }

  private getOrCreate(processId: string, mode: AgentProcessMode): AgentProcess {
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
      platformClient: this.platformClient ?? undefined,
      getExtraEnv: this.getExtraEnv,
    });
    this.processes.set(processId, proc);
    return proc;
  }

  private buildStartArg(opts: AgentProcessStartOptions): AgentProcessStartArg {
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
    return startArg;
  }

  /**
   * Translate the project's stored ``ProjectSource`` (or, when missing,
   * the bare workspaceDir) into the ``AgentProcessSource`` ``omni serve``
   * needs. Distinguishes ``local`` from ``local-git`` by probing for a
   * ``.git`` entry, since the launcher's stored ``gitDetected`` flag
   * isn't guaranteed to be fresh for every code path that lands here.
   */
  private resolveProjectSources(
    workspaceDir: string,
    projectId: string | undefined
  ): AgentProcessSource[] {
    // Translate each Project.source (which carries id + mountName) into
    // the AgentProcessSource shape ``omni serve`` understands. Per-source
    // git-detection happens here so the wire format already commits to
    // ``local-git`` vs ``local``.
    if (projectId) {
      const { projects } = this.getStoreData();
      const project = projects.find((p) => p.id === projectId);
      if (project) {
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
          return {
            mountName: source.mountName,
            kind: this.directoryHasGit(source.workspaceDir) ? 'local-git' : 'local',
            workspaceDir: source.workspaceDir,
          };
        });
      }
    }
    // No project on file (Personal/scratch tab with raw workspaceDir):
    // synthesize one source from the workspaceDir we were given,
    // defaulting mountName to the basename.
    if (!workspaceDir) {
return [];
}
    this.ensureWorkspaceDir(workspaceDir);
    const mountName = path.basename(workspaceDir) || 'workspace';
    return [{
      mountName,
      kind: this.directoryHasGit(workspaceDir) ? 'local-git' : 'local',
      workspaceDir,
    }];
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
   * A `local` source's directory must exist or `omni serve` rejects it
   * ("Workspace directory not found"). On a fresh host (notably the cloud
   * container, where a project's default `~/Omni/Workspace` doesn't exist yet)
   * create it — an empty workspace is a valid starting point. Best-effort:
   * if creation fails, let omni serve surface the original error.
   */
  private ensureWorkspaceDir(workspaceDir: string): void {
    if (!workspaceDir) {
return;
}
    try {
      mkdirSync(workspaceDir, { recursive: true });
    } catch {
      // ignore — omni serve will report if the path is genuinely unusable
    }
  }

  start = (processId: string, opts: AgentProcessStartOptions): void => {
    this.lastStartArgs.set(processId, opts);
    const startArg = this.buildStartArg(opts);
    const mode = this.resolveMode(startArg.profileName);
    const proc = this.getOrCreate(processId, mode);
    proc.start(startArg);
  };

  stop = async (processId: string): Promise<void> => {
    const proc = this.processes.get(processId);
    if (!proc) {
return;
}
    await proc.stop();
    this.processes.delete(processId);
  };

  rebuild = async (processId: string, opts: AgentProcessStartOptions): Promise<void> => {
    const lastOpts = this.lastStartArgs.get(processId);
    const merged: AgentProcessStartOptions = {
      workspaceDir: opts.workspaceDir || lastOpts?.workspaceDir || '',
      ...(opts.projectId ?? lastOpts?.projectId
        ? { projectId: (opts.projectId ?? lastOpts?.projectId) as string }
        : {}),
      ...(opts.profileNameOverride ?? lastOpts?.profileNameOverride
        ? { profileNameOverride: (opts.profileNameOverride ?? lastOpts?.profileNameOverride) as string }
        : {}),
      ...(opts.sessionId ?? lastOpts?.sessionId
        ? { sessionId: (opts.sessionId ?? lastOpts?.sessionId) as string }
        : {}),
      ...(opts.containerId ?? lastOpts?.containerId
        ? { containerId: (opts.containerId ?? lastOpts?.containerId) as string }
        : {}),
    };
    const startArg = this.buildStartArg(merged);
    const mode = this.resolveMode(startArg.profileName);
    const proc = this.getOrCreate(processId, mode);
    await proc.rebuild(startArg);
  };

  getStatus = (processId: string): WithTimestamp<AgentProcessStatus> => {
    const proc = this.processes.get(processId);
    if (proc) {
return proc.getStatus();
}
    return { type: 'uninitialized', timestamp: Date.now() };
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

  cleanup = async (): Promise<void> => {
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
}) => {
  const { ipc, sendToWindow, fetchFn, getStoreData } = arg;

  const processManager = new ProcessManager({ sendToWindow, fetchFn, getStoreData });
  const channels = registerProcessHandlers(ipc, () => processManager);

  const cleanup = async () => {
    await processManager.cleanup();
    for (const ch of channels) {
      ipcMain.removeHandler(ch);
    }
  };

  return [processManager, cleanup] as const;
};
