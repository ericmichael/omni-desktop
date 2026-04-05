import type { IpcListener } from '@electron-toolkit/typed-ipc/main';
import { ipcMain } from 'electron';

import { AgentProcess, type AgentProcessMode, type FetchFn } from '@/main/agent-process';
import type { PlatformClient } from '@/main/platform-client';
import type {
  AgentProcessStatus,
  CodeTabId,
  IpcEvents,
  IpcRendererEvents,
  SandboxBackend,
  SandboxVariant,
  WithTimestamp,
} from '@/shared/types';

type StartArg = {
  workspaceDir: string;
  sandboxVariant: SandboxVariant;
  local?: boolean;
  sandboxBackend?: SandboxBackend;
};

export class CodeManager {
  private processes = new Map<CodeTabId, AgentProcess>();
  private sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
  private fetchFn: FetchFn;

  /** Set by the platform integration when in enterprise mode. */
  platformClient: PlatformClient | null = null;

  /** Optional fallback for sandbox status — lets ProjectManager provide supervisor sandbox status. */
  statusFallback?: (tabId: CodeTabId) => WithTimestamp<AgentProcessStatus> | null;

  constructor(arg: { sendToWindow: CodeManager['sendToWindow']; fetchFn?: FetchFn }) {
    this.sendToWindow = arg.sendToWindow;
    this.fetchFn = arg.fetchFn ?? globalThis.fetch;
  }

  private getOrCreate(tabId: CodeTabId, mode: AgentProcessMode): AgentProcess {
    const existing = this.processes.get(tabId);
    if (existing && existing.mode === mode) {
      return existing;
    }
    // Mode changed or first creation — clean up old process if mode differs
    if (existing) {
      void existing.exit();
    }

    const proc = new AgentProcess({
      mode,
      ipcRawOutput: (data) => {
        this.sendToWindow('code:sandbox-raw-output', tabId, data);
      },
      onStatusChange: (status) => {
        this.sendToWindow('code:sandbox-status', tabId, status);
      },
      fetchFn: this.fetchFn,
      platformClient: this.platformClient ?? undefined,
    });

    this.processes.set(tabId, proc);
    return proc;
  }

  startSandbox = (tabId: CodeTabId, arg: StartArg): void => {
    let mode: AgentProcessMode;
    if (arg.local) {
      mode = 'local';
    } else if (this.platformClient) {
      mode = 'platform';
    } else if (arg.sandboxBackend === 'vm') {
      mode = 'vm';
    } else if (arg.sandboxBackend === 'podman') {
      mode = 'podman';
    } else {
      mode = 'sandbox';
    }
    const proc = this.getOrCreate(tabId, mode);
    proc.start(arg);
  };

  stopSandbox = async (tabId: CodeTabId): Promise<void> => {
    const proc = this.processes.get(tabId);
    if (!proc) return;
    await proc.stop();
    this.processes.delete(tabId);
  };

  rebuildSandbox = async (tabId: CodeTabId, fallbackArg: StartArg): Promise<void> => {
    let mode: AgentProcessMode;
    if (fallbackArg.local) {
      mode = 'local';
    } else if (this.platformClient) {
      mode = 'platform';
    } else if (fallbackArg.sandboxBackend === 'vm') {
      mode = 'vm';
    } else if (fallbackArg.sandboxBackend === 'podman') {
      mode = 'podman';
    } else {
      mode = 'sandbox';
    }
    const proc = this.getOrCreate(tabId, mode);
    await proc.rebuild(fallbackArg);
  };

  getSandboxStatus = (tabId: CodeTabId): WithTimestamp<AgentProcessStatus> => {
    const proc = this.processes.get(tabId);
    if (proc) return proc.getStatus();
    // Check if a supervisor sandbox is providing status for this tab
    const fallback = this.statusFallback?.(tabId);
    if (fallback) return fallback;
    return { type: 'uninitialized', timestamp: Date.now() };
  };

  resizePty = (tabId: CodeTabId, cols: number, rows: number): void => {
    const proc = this.processes.get(tabId);
    if (proc) proc.resizePty(cols, rows);
  };

  /**
   * Look up a running sandbox's WebSocket URL for a Code tab linked to the given ticketId.
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
  };
}

export const createCodeManager = (arg: {
  ipc: IpcListener<IpcEvents>;
  sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
  fetchFn?: FetchFn;
}) => {
  const { ipc, sendToWindow, fetchFn } = arg;

  const codeManager = new CodeManager({ sendToWindow, fetchFn });

  ipc.handle('code:start-sandbox', (_, tabId, startArg) => {
    codeManager.startSandbox(tabId, startArg);
  });
  ipc.handle('code:stop-sandbox', async (_, tabId) => {
    await codeManager.stopSandbox(tabId);
  });
  ipc.handle('code:rebuild-sandbox', async (_, tabId, fallbackArg) => {
    await codeManager.rebuildSandbox(tabId, fallbackArg);
  });
  ipc.handle('code:resize-sandbox', (_, tabId, cols, rows) => {
    codeManager.resizePty(tabId, cols, rows);
  });
  ipc.handle('code:get-sandbox-status', (_, tabId) => {
    return codeManager.getSandboxStatus(tabId);
  });

  const cleanup = async () => {
    await codeManager.cleanup();
    ipcMain.removeHandler('code:start-sandbox');
    ipcMain.removeHandler('code:stop-sandbox');
    ipcMain.removeHandler('code:rebuild-sandbox');
    ipcMain.removeHandler('code:resize-sandbox');
    ipcMain.removeHandler('code:get-sandbox-status');
  };

  return [codeManager, cleanup] as const;
};
