import { ipcMain } from 'electron';
import { nanoid } from 'nanoid';

import type { PtyCallbacks, PtyEntry } from '@/lib/pty-utils';
import { createPtyBuffer, createPtyProcess, killPtyProcessAsync, setupPtyCallbacks } from '@/lib/pty-utils';
import { getActivateVenvCommand, getBundledBinPath, getHomeDirectory, getShell, isDirectory } from '@/main/util';
import type { IIpcListener } from '@/shared/ipc-listener';
import type { IpcRendererEvents } from '@/shared/types';

/**
 * ConsoleManager manages multiple interactive shell PTYs for the terminal/console.
 */
export class ConsoleManager {
  private entries = new Map<string, PtyEntry>();

  constructor() {}

  /**
   * Create a new console PTY.
   * Returns the console ID.
   */
  async createConsole(
    callbacks: {
      onData: (id: string, data: string) => void;
      onExit: (id: string, exitCode: number, signal?: number) => void;
    },
    initialCwd?: string
  ): Promise<string> {
    const id = nanoid();
    const shell = getShell();
    const ansiBuffer = createPtyBuffer();

    const process = createPtyProcess({
      command: shell,
      args: [],
      cwd: getHomeDirectory(),
    });

    const ptyCallbacks: PtyCallbacks = {
      onData: (data) => {
        callbacks.onData(id, data);
      },
      onExit: (exitCode, signal) => {
        this.entries.delete(id);
        callbacks.onData(id, `Process exited with code ${exitCode}${signal ? `, signal: ${signal}` : ''}`);
        callbacks.onExit(id, exitCode, signal);
      },
    };

    setupPtyCallbacks(process, ptyCallbacks, ansiBuffer);

    this.entries.set(id, { id, process, ansiSequenceBuffer: ansiBuffer });

    // Initialize the console environment
    await this.initializeConsole(id, initialCwd);

    return id;
  }

  /**
   * Initialize the console with PATH and optional venv activation
   */
  private async initializeConsole(id: string, cwd?: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;

    // Add the bundled bin dir to the PATH env var
    if (process.platform === 'win32') {
      entry.process.write(`$env:Path='${getBundledBinPath()};'+$env:Path\r`);
    } else {
      entry.process.write(`export PATH="${getBundledBinPath()}:$PATH"\r`);
    }

    if (cwd && (await isDirectory(cwd))) {
      entry.process.write(`cd ${cwd}\r`);

      // If the cwd contains a .venv, activate it
      const venvPath = `${cwd}/.venv`;
      if (await isDirectory(venvPath)) {
        const activateVenvCmd = getActivateVenvCommand(cwd);
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
    if (!entry) return;
    this.entries.delete(id);
    await killPtyProcessAsync(entry.process);
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
   * List all active console IDs
   */
  listIds(): string[] {
    return [...this.entries.keys()];
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

  const onData = (id: string, data: string) => {
    sendToWindow('terminal:output', id, data);
  };

  const onExit = (id: string, exitCode: number) => {
    sendToWindow('terminal:exited', id, exitCode);
  };

  // IPC handlers
  ipc.handle('terminal:create', (_, cwd) => {
    return consoleManager.createConsole({ onData, onExit }, cwd);
  });

  ipc.handle('terminal:dispose', async (_, id) => {
    await consoleManager.disposeOne(id);
  });

  ipc.handle('terminal:resize', (_, id, cols, rows) => {
    consoleManager.resize(id, cols, rows);
  });

  ipc.handle('terminal:write', (_, id, data) => {
    consoleManager.write(id, data);
  });

  ipc.handle('terminal:list', (_) => {
    return consoleManager.listIds();
  });

  const cleanup = async () => {
    await consoleManager.disposeAll();
    ipcMain.removeHandler('terminal:create');
    ipcMain.removeHandler('terminal:dispose');
    ipcMain.removeHandler('terminal:resize');
    ipcMain.removeHandler('terminal:write');
    ipcMain.removeHandler('terminal:list');
  };

  return [consoleManager, cleanup];
};
