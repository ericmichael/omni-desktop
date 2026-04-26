import { ipcMain } from 'electron';
import { nanoid } from 'nanoid';

import type { PtyCallbacks, PtyEntry } from '@/lib/pty-utils';
import { createPtyBuffer, createPtyProcess, killPtyProcessAsync, setupPtyCallbacks } from '@/lib/pty-utils';

type TabScopedEntry = PtyEntry & { tabId: string };
import { getActivateVenvCommand, getBundledBinPath, getHomeDirectory, getShell, isDirectory } from '@/main/util';
import type { IIpcListener } from '@/shared/ipc-listener';
import type { IpcRendererEvents } from '@/shared/types';

// ---------------------------------------------------------------------------
// Injectable deps
// ---------------------------------------------------------------------------

export interface ConsoleManagerDeps {
  createPty: typeof createPtyProcess;
  createBuffer: typeof createPtyBuffer;
  setupCallbacks: typeof setupPtyCallbacks;
  killPty: typeof killPtyProcessAsync;
  getShell: typeof getShell;
  getHomeDir: typeof getHomeDirectory;
  getBinPath: typeof getBundledBinPath;
  getActivateCmd: typeof getActivateVenvCommand;
  isDir: typeof isDirectory;
  newId: () => string;
}

const defaultDeps = (): ConsoleManagerDeps => ({
  createPty: createPtyProcess,
  createBuffer: createPtyBuffer,
  setupCallbacks: setupPtyCallbacks,
  killPty: killPtyProcessAsync,
  getShell,
  getHomeDir: getHomeDirectory,
  getBinPath: getBundledBinPath,
  getActivateCmd: getActivateVenvCommand,
  isDir: isDirectory,
  newId: nanoid,
});

/**
 * ConsoleManager manages multiple interactive shell PTYs for the terminal/console.
 * Each PTY is owned by a workspace tab (column); terminals are scoped by tabId.
 */
export class ConsoleManager {
  private entries = new Map<string, TabScopedEntry>();
  private deps: ConsoleManagerDeps;

  constructor(deps?: Partial<ConsoleManagerDeps>) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  /**
   * Create a new console PTY owned by `tabId`.
   * Returns the console ID.
   */
  async createConsole(
    tabId: string,
    callbacks: {
      onData: (tabId: string, id: string, data: string) => void;
      onExit: (tabId: string, id: string, exitCode: number, signal?: number) => void;
    },
    initialCwd?: string
  ): Promise<string> {
    const id = this.deps.newId();
    const shell = this.deps.getShell();
    const ansiBuffer = this.deps.createBuffer();

    const process = this.deps.createPty({
      command: shell,
      args: [],
      cwd: this.deps.getHomeDir(),
    });

    const ptyCallbacks: PtyCallbacks = {
      onData: (data) => {
        callbacks.onData(tabId, id, data);
      },
      onExit: (exitCode, signal) => {
        this.entries.delete(id);
        callbacks.onData(tabId, id, `Process exited with code ${exitCode}${signal ? `, signal: ${signal}` : ''}`);
        callbacks.onExit(tabId, id, exitCode, signal);
      },
    };

    this.deps.setupCallbacks(process, ptyCallbacks, ansiBuffer);

    this.entries.set(id, { id, tabId, process, ansiSequenceBuffer: ansiBuffer });

    // Initialize the console environment
    await this.initializeConsole(id, initialCwd);

    return id;
  }

  /**
   * Initialize the console with PATH and optional venv activation
   */
  private async initializeConsole(id: string, cwd?: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) {
return;
}

    // Add the bundled bin dir to the PATH env var
    const binPath = this.deps.getBinPath();
    if (process.platform === 'win32') {
      entry.process.write(`$env:Path='${binPath};'+$env:Path\r`);
    } else {
      entry.process.write(`export PATH="${binPath}:$PATH"\r`);
    }

    if (cwd && (await this.deps.isDir(cwd))) {
      entry.process.write(`cd ${cwd}\r`);

      // If the cwd contains a .venv, activate it
      const venvPath = `${cwd}/.venv`;
      if (await this.deps.isDir(venvPath)) {
        const activateVenvCmd = this.deps.getActivateCmd(cwd);
        entry.process.write(`${activateVenvCmd}\r`);
      }
    }
  }

  /**
   * Write data to a console
   */
  write(id: string, data: string): void {
    this.entries.get(id)?.process.write(data);
  }

  /**
   * Resize a console PTY
   */
  resize(id: string, cols: number, rows: number): void {
    this.entries.get(id)?.process.resize(cols, rows);
  }

  /**
   * Dispose of a single console PTY
   */
  async disposeOne(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) {
return;
}
    this.entries.delete(id);
    await this.deps.killPty(entry.process);
    entry.ansiSequenceBuffer.clear();
  }

  /**
   * Dispose of all console PTYs
   */
  async disposeAll(): Promise<void> {
    const ids = [...this.entries.keys()];
    await Promise.allSettled(ids.map((id) => this.disposeOne(id)));
  }

  /**
   * Dispose all PTYs owned by a tab (called when a workspace column closes).
   */
  async disposeAllForTab(tabId: string): Promise<void> {
    const ids = [...this.entries.values()].filter((e) => e.tabId === tabId).map((e) => e.id);
    await Promise.allSettled(ids.map((id) => this.disposeOne(id)));
  }

  /**
   * List active console IDs owned by a tab.
   */
  listIdsForTab(tabId: string): string[] {
    return [...this.entries.values()].filter((e) => e.tabId === tabId).map((e) => e.id);
  }

  /**
   * Check if any console is currently active
   */
  isActive(): boolean {
    return this.entries.size > 0;
  }
}

/**
 * Create a ConsoleManager instance and set up IPC handlers
 * Returns the manager instance and a cleanup function
 */
export const createConsoleManager = (arg: {
  ipc: IIpcListener;
  sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
}): [ConsoleManager, () => void] => {
  const { ipc, sendToWindow } = arg;

  const consoleManager = new ConsoleManager();

  const onData = (tabId: string, id: string, data: string) => {
    sendToWindow('terminal:output', tabId, id, data);
  };

  const onExit = (tabId: string, id: string, exitCode: number) => {
    sendToWindow('terminal:exited', tabId, id, exitCode);
  };

  // IPC handlers
  ipc.handle('terminal:create', (_, tabId, cwd) => {
    return consoleManager.createConsole(tabId, { onData, onExit }, cwd);
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
