import type { IpcListener } from '@electron-toolkit/typed-ipc/main';
import { ipcMain } from 'electron';

import type { FetchFn } from '@/main/sandbox-manager';
import { SandboxManager } from '@/main/sandbox-manager';
import type {
  CodeTabId,
  IpcEvents,
  IpcRendererEvents,
  SandboxProcessStatus,
  SandboxVariant,
  WithTimestamp,
} from '@/shared/types';

type StartArg = {
  workspaceDir: string;
  sandboxVariant: SandboxVariant;
};

export class CodeManager {
  private sandboxes = new Map<CodeTabId, SandboxManager>();
  private sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
  private fetchFn: FetchFn;

  constructor(arg: { sendToWindow: CodeManager['sendToWindow']; fetchFn?: FetchFn }) {
    this.sendToWindow = arg.sendToWindow;
    this.fetchFn = arg.fetchFn ?? globalThis.fetch;
  }

  private getOrCreateSandbox(tabId: CodeTabId): SandboxManager {
    let sandbox = this.sandboxes.get(tabId);
    if (sandbox) {
      return sandbox;
    }

    sandbox = new SandboxManager({
      ipcLogger: () => {},
      ipcRawOutput: (data) => {
        this.sendToWindow('code:sandbox-raw-output', tabId, data);
      },
      onStatusChange: (status) => {
        this.sendToWindow('code:sandbox-status', tabId, status);
      },
      fetchFn: this.fetchFn,
    });

    this.sandboxes.set(tabId, sandbox);
    return sandbox;
  }

  startSandbox = (tabId: CodeTabId, arg: StartArg): void => {
    const sandbox = this.getOrCreateSandbox(tabId);
    sandbox.start(arg);
  };

  stopSandbox = async (tabId: CodeTabId): Promise<void> => {
    const sandbox = this.sandboxes.get(tabId);
    if (!sandbox) {
      return;
    }
    await sandbox.stop();
    this.sandboxes.delete(tabId);
  };

  rebuildSandbox = async (tabId: CodeTabId, fallbackArg: StartArg): Promise<void> => {
    const sandbox = this.getOrCreateSandbox(tabId);
    await sandbox.rebuild(fallbackArg);
  };

  getSandboxStatus = (tabId: CodeTabId): WithTimestamp<SandboxProcessStatus> => {
    const sandbox = this.sandboxes.get(tabId);
    if (!sandbox) {
      return { type: 'uninitialized', timestamp: Date.now() };
    }
    return sandbox.getStatus();
  };

  resizePty = (tabId: CodeTabId, cols: number, rows: number): void => {
    const sandbox = this.sandboxes.get(tabId);
    if (sandbox) {
      sandbox.resizePty(cols, rows);
    }
  };

  cleanup = async (): Promise<void> => {
    const exits = Array.from(this.sandboxes.values()).map((s) => s.exit());
    await Promise.allSettled(exits);
    this.sandboxes.clear();
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
