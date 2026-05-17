import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { ipcMain } from 'electron';

import {
  AgentProcess,
  type AgentProcessMode,
  type AgentProcessSource,
  type AgentProcessStartArg,
  type FetchFn,
} from '@/main/agent-process';
import type { PlatformClient } from '@/main/platform-client';
import type { IIpcListener } from '@/shared/ipc-listener';
import type {
  AgentProcessStartOptions,
  AgentProcessStatus,
  IpcRendererEvents,
  Project,
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

  /** Set by the platform integration when in enterprise mode. */
  platformClient: PlatformClient | null = null;

  constructor(arg: {
    sendToWindow: ProcessManager['sendToWindow'];
    fetchFn?: FetchFn;
    getStoreData?: () => ProcessManagerStoreData;
  }) {
    this.sendToWindow = arg.sendToWindow;
    this.fetchFn = arg.fetchFn ?? globalThis.fetch;
    this.getStoreData = arg.getStoreData ?? (() => ({
      defaultProfileName: 'host',
      projects: [],
    }));
  }

  private resolveProfileName(
    projectId: string | undefined,
    override: string | undefined
  ): string {
    if (override) {
      return override;
    }
    const { defaultProfileName, projects } = this.getStoreData();
    if (!projectId) {
      return defaultProfileName;
    }
    const project = projects.find((p) => p.id === projectId);
    return project?.sandboxProfile ?? defaultProfileName;
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
    if (profileName !== 'platform') return undefined;
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
      if (!url) return undefined;

      let branch: string | undefined;
      try {
        branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: workspaceDir,
          timeout: 3000,
          encoding: 'utf-8',
        }).trim();
        if (branch === 'HEAD') branch = undefined; // detached HEAD
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
    if (!workspaceDir) return [];
    const mountName = path.basename(workspaceDir) || 'workspace';
    return [{
      mountName,
      kind: this.directoryHasGit(workspaceDir) ? 'local-git' : 'local',
      workspaceDir,
    }];
  }

  private directoryHasGit(workspaceDir: string): boolean {
    if (!workspaceDir) return false;
    try {
      return existsSync(path.join(workspaceDir, '.git'));
    } catch {
      return false;
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
    if (!proc) return;
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
    };
    const startArg = this.buildStartArg(merged);
    const mode = this.resolveMode(startArg.profileName);
    const proc = this.getOrCreate(processId, mode);
    await proc.rebuild(startArg);
  };

  getStatus = (processId: string): WithTimestamp<AgentProcessStatus> => {
    const proc = this.processes.get(processId);
    if (proc) return proc.getStatus();
    return { type: 'uninitialized', timestamp: Date.now() };
  };

  resizePty = (processId: string, cols: number, rows: number): void => {
    this.processes.get(processId)?.resizePty(cols, rows);
  };

  /**
   * Look up a running process's WebSocket URL for a code tab linked to the given ticketId.
   * Used by ProjectManager to reuse an existing sandbox instead of creating a duplicate.
   */
  getRunningWsUrlForTicket(ticketId: string, codeTabs: Array<{ id: string; ticketId?: string }>): string | null {
    for (const tab of codeTabs) {
      if (tab.ticketId !== ticketId) continue;
      const proc = this.processes.get(tab.id);
      if (!proc) continue;
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
      if (opts.projectId !== projectId) continue;
      const proc = this.processes.get(processId);
      if (!proc) continue;
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

export const createProcessManager = (arg: {
  ipc: IIpcListener;
  sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
  fetchFn?: FetchFn;
  getStoreData?: () => ProcessManagerStoreData;
}) => {
  const { ipc, sendToWindow, fetchFn, getStoreData } = arg;

  const processManager = new ProcessManager({ sendToWindow, fetchFn, getStoreData });

  ipc.handle('agent-process:start', (_, processId, startArg) => {
    processManager.start(processId, startArg);
  });
  ipc.handle('agent-process:stop', async (_, processId) => {
    await processManager.stop(processId);
  });
  ipc.handle('agent-process:rebuild', async (_, processId, rebuildArg) => {
    await processManager.rebuild(processId, rebuildArg);
  });
  ipc.handle('agent-process:resize', (_, processId, cols, rows) => {
    processManager.resizePty(processId, cols, rows);
  });
  ipc.handle('agent-process:get-status', (_, processId) => {
    return processManager.getStatus(processId);
  });

  const cleanup = async () => {
    await processManager.cleanup();
    ipcMain.removeHandler('agent-process:start');
    ipcMain.removeHandler('agent-process:stop');
    ipcMain.removeHandler('agent-process:rebuild');
    ipcMain.removeHandler('agent-process:resize');
    ipcMain.removeHandler('agent-process:get-status');
  };

  return [processManager, cleanup] as const;
};
