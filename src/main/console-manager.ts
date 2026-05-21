import { ipcMain } from 'electron';

import type { ProcessManager } from '@/main/process-manager';
import { ConsoleError, TerminalProxy } from '@/main/terminal-proxy';
import type { IIpcListener } from '@/shared/ipc-listener';
import type { IpcRendererEvents } from '@/shared/types';

/**
 * Routes the renderer's `terminal:*` IPC into `omni serve`'s WebSocket
 * protocol via :class:`TerminalProxy`. The shell runs inside the
 * sandbox session (same user/cwd/network as the agent's bash tool); the
 * launcher no longer owns a host node-pty path.
 *
 * When a tab has no running omni serve process, `terminal:create` throws
 * a :class:`ConsoleError` with `kind='process_not_ready'`; the renderer
 * surfaces a toast.
 */
export class ConsoleManager {
  constructor(private readonly proxy: TerminalProxy) {}

  createConsole(tabId: string): Promise<string> {
    return this.proxy.create(tabId);
  }

  write(id: string, data: string): void {
    this.proxy.write(id, data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.proxy.resize(id, cols, rows);
  }

  disposeOne(id: string): Promise<void> {
    return this.proxy.dispose(id);
  }

  disposeAll(): Promise<void> {
    return this.proxy.disposeAll();
  }

  disposeAllForTab(tabId: string): Promise<void> {
    return this.proxy.disposeAllForTab(tabId);
  }

  listIdsForTab(tabId: string): string[] {
    return this.proxy.listIdsForTab(tabId);
  }
}

export const createConsoleManager = (arg: {
  ipc: IIpcListener;
  sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
  processManager: ProcessManager;
}): [ConsoleManager, () => Promise<void>] => {
  const { ipc, sendToWindow, processManager } = arg;

  const proxy = new TerminalProxy({ processManager, sendToWindow });
  const consoleManager = new ConsoleManager(proxy);

  ipc.handle('terminal:create', async (_, tabId) => {
    try {
      return await consoleManager.createConsole(tabId);
    } catch (err) {
      if (err instanceof ConsoleError) {
        // Throwing across IPC produces an Error in the renderer; tag the
        // message so the renderer can distinguish `process_not_ready`
        // from generic failures.
        const e = new Error(`[${err.kind}] ${err.message}`);
        (e as Error & { kind?: string }).kind = err.kind;
        throw e;
      }
      throw err;
    }
  });

  ipc.handle('terminal:dispose', async (_, id) => {
    await consoleManager.disposeOne(id);
  });

  ipc.handle('terminal:dispose-all-for-tab', async (_, tabId) => {
    await consoleManager.disposeAllForTab(tabId);
  });

  ipc.handle('terminal:resize', (_, id, cols, rows) => {
    consoleManager.resize(id, cols, rows);
  });

  ipc.handle('terminal:write', (_, id, data) => {
    consoleManager.write(id, data);
  });

  ipc.handle('terminal:list', (_, tabId) => {
    return consoleManager.listIdsForTab(tabId);
  });

  const cleanup = async () => {
    await consoleManager.disposeAll();
    ipcMain.removeHandler('terminal:create');
    ipcMain.removeHandler('terminal:dispose');
    ipcMain.removeHandler('terminal:dispose-all-for-tab');
    ipcMain.removeHandler('terminal:resize');
    ipcMain.removeHandler('terminal:write');
    ipcMain.removeHandler('terminal:list');
  };

  return [consoleManager, cleanup];
};
