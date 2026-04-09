import type { IpcListener } from '@electron-toolkit/typed-ipc/main';
import { ipcMain } from 'electron';

import { AgentProcess, type AgentProcessMode, type AgentProcessStartArg, type FetchFn } from '@/main/agent-process';
import type { PlatformClient } from '@/main/platform-client';
import type {
  AgentProcessStartOptions,
  AgentProcessStatus,
  IpcEvents,
  IpcRendererEvents,
  SandboxBackend,
  SandboxVariant,
  WithTimestamp,
} from '@/shared/types';

export type ProcessManagerStoreData = {
  sandboxEnabled: boolean;
  sandboxBackend: SandboxBackend;
  sandboxVariant: SandboxVariant;
};

/**
 * Unified process manager for all agent processes (chat + code tabs).
 *
 * Every agent process is keyed by a string ID:
 *   - `"chat"` for the singleton chat process
 *   - A CodeTabId for code-tab processes
 */
export class ProcessManager {
  private processes = new Map<string, AgentProcess>();
  private lastStartArgs = new Map<string, AgentProcessStartOptions>();
  private sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
  private fetchFn: FetchFn;
  private getStoreData: () => ProcessManagerStoreData;

  /** Set by the platform integration when in enterprise mode. */
  platformClient: PlatformClient | null = null;

  /** Optional fallback for sandbox status — lets ProjectManager provide supervisor sandbox status. */
  statusFallback?: (processId: string) => WithTimestamp<AgentProcessStatus> | null;

  constructor(arg: {
    sendToWindow: ProcessManager['sendToWindow'];
    fetchFn?: FetchFn;
    getStoreData?: () => ProcessManagerStoreData;
  }) {
    this.sendToWindow = arg.sendToWindow;
    this.fetchFn = arg.fetchFn ?? globalThis.fetch;
    this.getStoreData = arg.getStoreData ?? (() => ({
      sandboxEnabled: false,
      sandboxBackend: 'docker' as const,
      sandboxVariant: 'work' as const,
    }));
  }

  private resolveMode(): AgentProcessMode {
    // Platform compute only when explicitly opted in — having a platformClient
    // means governance is active (policy, dashboards, audit), not that compute
    // should be delegated to cloud containers.
    if (this.platformClient && process.env.OMNI_COMPUTE_MODE === 'platform') return 'platform';
    const { sandboxEnabled, sandboxBackend } = this.getStoreData();
    if (!sandboxEnabled) return 'local';
    if (sandboxBackend === 'vm') return 'vm';
    if (sandboxBackend === 'podman') return 'podman';
    return 'sandbox';
  }

  private getOrCreate(processId: string, mode: AgentProcessMode): AgentProcess {
    const existing = this.processes.get(processId);
    if (existing && existing.mode === mode) return existing;

    // Mode changed or first creation — clean up old process
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

  start = (processId: string, opts: AgentProcessStartOptions): void => {
    this.lastStartArgs.set(processId, opts);
    const mode = this.resolveMode();
    const proc = this.getOrCreate(processId, mode);
    const startArg: AgentProcessStartArg = {
      workspaceDir: opts.workspaceDir,
      sandboxVariant: this.getStoreData().sandboxVariant,
    };
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
    const workspaceDir = opts.workspaceDir || lastOpts?.workspaceDir || '';
    const mode = this.resolveMode();
    const proc = this.getOrCreate(processId, mode);
    const fallbackArg: AgentProcessStartArg = {
      workspaceDir,
      sandboxVariant: this.getStoreData().sandboxVariant,
    };
    await proc.rebuild(fallbackArg);
  };

  getStatus = (processId: string): WithTimestamp<AgentProcessStatus> => {
    const proc = this.processes.get(processId);
    if (proc) return proc.getStatus();
    const fallback = this.statusFallback?.(processId);
    if (fallback) return fallback;
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

  cleanup = async (): Promise<void> => {
    const exits = Array.from(this.processes.values()).map((p) => p.exit());
    await Promise.allSettled(exits);
    this.processes.clear();
    this.lastStartArgs.clear();
  };
}

export const createProcessManager = (arg: {
  ipc: IpcListener<IpcEvents>;
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
