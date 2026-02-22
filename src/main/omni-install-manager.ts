import type { IpcListener } from '@electron-toolkit/typed-ipc/main';
import c from 'ansi-colors';
import { ipcMain } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { serializeError } from 'serialize-error';
import { shellEnvSync } from 'shell-env';

import { CommandRunner } from '@/lib/command-runner';
import { DEFAULT_ENV } from '@/lib/pty-utils';
import { withResultAsync } from '@/lib/result';
import { SimpleLogger } from '@/lib/simple-logger';
import { getOmniRuntimeDir, getOmniVenvPath, getUVExecutablePath, isFile, pathExists } from '@/main/util';
import type { IpcEvents, IpcRendererEvents, LogEntry, OmniInstallProcessStatus, WithTimestamp } from '@/shared/types';

const PYTHON_VERSION = '3.11';
const EXTRA_INDEX_URL = 'https://pypi.fury.io/ericmichael/';
const OMNI_CODE_VERSION = '0.4.12';

export class OmniInstallManager {
  private status: WithTimestamp<OmniInstallProcessStatus>;
  private ipcLogger: (entry: WithTimestamp<LogEntry>) => void;
  private ipcRawOutput: (data: string) => void;
  private onStatusChange: (status: WithTimestamp<OmniInstallProcessStatus>) => void;
  private log: SimpleLogger;
  private commandRunner: CommandRunner;
  private cols: number | undefined;
  private rows: number | undefined;
  private isCancellationRequested: boolean;

  constructor(arg: {
    ipcLogger: OmniInstallManager['ipcLogger'];
    ipcRawOutput: OmniInstallManager['ipcRawOutput'];
    onStatusChange: OmniInstallManager['onStatusChange'];
  }) {
    this.ipcLogger = arg.ipcLogger;
    this.ipcRawOutput = arg.ipcRawOutput;
    this.onStatusChange = arg.onStatusChange;
    this.commandRunner = new CommandRunner();
    this.status = { type: 'uninitialized', timestamp: Date.now() };
    this.log = new SimpleLogger((entry) => {
      this.ipcRawOutput(entry.message);
      console[entry.level](entry.message);
    });
    this.isCancellationRequested = false;
  }

  private runCommand = async (
    command: string,
    args: string[],
    options?: { cwd?: string; env?: Record<string, string> }
  ): Promise<'success' | 'canceled'> => {
    if (this.isCancellationRequested) {
      return 'canceled';
    }

    try {
      const result = await this.commandRunner.runCommand(
        command,
        args,
        {
          cwd: options?.cwd,
          env: options?.env,
          rows: this.rows,
          cols: this.cols,
        },
        {
          onData: (data) => {
            this.ipcRawOutput(data);
            process.stdout.write(data);
          },
        }
      );

      if (this.isCancellationRequested) {
        return 'canceled';
      }

      if (result.exitCode === 0) {
        return 'success';
      }

      throw new Error(`Process exited with code ${result.exitCode}`);
    } catch (error) {
      if (this.isCancellationRequested) {
        return 'canceled';
      }
      throw error;
    }
  };

  resizePty = (cols: number, rows: number): void => {
    this.cols = cols;
    this.rows = rows;
    this.commandRunner.resize(cols, rows);
  };

  getStatus = (): WithTimestamp<OmniInstallProcessStatus> => {
    return this.status;
  };

  updateStatus = (status: OmniInstallProcessStatus): void => {
    this.status = { ...status, timestamp: Date.now() };
    this.onStatusChange(this.status);
  };

  private installPython = async (
    uvPath: string,
    options: { cwd: string; env: Record<string, string> },
    repair?: boolean
  ): Promise<'success' | 'canceled' | 'error'> => {
    const pythonInstallArgs = ['python', 'install', PYTHON_VERSION, '--python-preference', 'only-managed'];

    this.log.info(c.cyan(`Installing Python ${PYTHON_VERSION}...\r\n`));
    this.log.info(`> ${uvPath} ${pythonInstallArgs.join(' ')}\r\n`);

    const result = await withResultAsync(() => this.runCommand(uvPath, pythonInstallArgs, options));

    if (result.isOk()) {
      return result.value;
    }

    if (repair) {
      this.log.error(c.red(`Failed to install Python: ${result.error.message}\r\n`));
      this.updateStatus({
        type: 'error',
        error: { message: 'Failed to install Python', context: serializeError(result.error) },
      });
      return 'error';
    }

    this.log.warn(c.yellow('Python install failed, retrying with --reinstall...\r\n'));

    const retryArgs = [...pythonInstallArgs, '--reinstall'];

    this.log.info(`> ${uvPath} ${retryArgs.join(' ')}\r\n`);

    const retryResult = await withResultAsync(() => this.runCommand(uvPath, retryArgs, options));

    if (retryResult.isOk()) {
      return retryResult.value;
    }

    this.log.error(c.red(`Failed to install Python: ${retryResult.error.message}\r\n`));
    this.updateStatus({
      type: 'error',
      error: { message: 'Failed to install Python', context: serializeError(retryResult.error) },
    });
    return 'error';
  };

  private cleanVenvDir = async (venvPath: string, force: boolean): Promise<void> => {
    if (force) {
      await fs.rm(venvPath, { recursive: true, force: true }).catch(() => undefined);
      return;
    }

    const activatePath = path.join(venvPath, process.platform === 'win32' ? 'Scripts' : 'bin', 'activate');
    const isValidVenv = await isFile(activatePath);
    if (!isValidVenv && (await pathExists(venvPath))) {
      await fs.rm(venvPath, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  private createVenv = async (
    uvPath: string,
    venvPath: string,
    options: { cwd: string; env: Record<string, string> },
    repair?: boolean
  ): Promise<'success' | 'canceled' | 'error'> => {
    await this.cleanVenvDir(venvPath, !!repair);

    const venvArgs = [
      'venv',
      '--relocatable',
      '--prompt',
      'omni',
      '--python',
      PYTHON_VERSION,
      '--python-preference',
      'only-managed',
      venvPath,
    ];

    this.log.info(c.cyan('Creating virtual environment...\r\n'));
    this.log.info(`> ${uvPath} ${venvArgs.join(' ')}\r\n`);

    const result = await withResultAsync(() => this.runCommand(uvPath, venvArgs, options));

    if (result.isOk()) {
      return result.value;
    }

    if (repair) {
      this.log.error(c.red(`Failed to create virtual environment: ${result.error.message}\r\n`));
      this.updateStatus({
        type: 'error',
        error: { message: 'Failed to create virtual environment', context: serializeError(result.error) },
      });
      return 'error';
    }

    this.log.warn(c.yellow('Venv creation failed, retrying with a clean directory...\r\n'));
    await this.cleanVenvDir(venvPath, true);

    this.log.info(`> ${uvPath} ${venvArgs.join(' ')}\r\n`);

    const retryResult = await withResultAsync(() => this.runCommand(uvPath, venvArgs, options));

    if (retryResult.isOk()) {
      return retryResult.value;
    }

    this.log.error(c.red(`Failed to create virtual environment: ${retryResult.error.message}\r\n`));
    this.updateStatus({
      type: 'error',
      error: { message: 'Failed to create virtual environment', context: serializeError(retryResult.error) },
    });
    return 'error';
  };

  private installOmniCode = async (
    uvPath: string,
    options: { cwd: string; env: Record<string, string> },
    repair?: boolean
  ): Promise<'success' | 'canceled' | 'error'> => {
    const installArgs = [
      'pip',
      'install',
      '--python',
      PYTHON_VERSION,
      '--python-preference',
      'only-managed',
      '--extra-index-url',
      EXTRA_INDEX_URL,
      ...(repair ? ['--force-reinstall'] : []),
      `omni-code==${OMNI_CODE_VERSION}`,
    ];

    this.log.info(c.cyan('Installing omni-code...\r\n'));
    this.log.info(`> ${uvPath} ${installArgs.join(' ')}\r\n`);

    const result = await withResultAsync(() => this.runCommand(uvPath, installArgs, options));

    if (result.isOk()) {
      return result.value;
    }

    this.log.error(c.red(`Failed to install omni-code: ${result.error.message}\r\n`));
    this.updateStatus({
      type: 'error',
      error: { message: 'Failed to install omni-code', context: serializeError(result.error) },
    });
    return 'error';
  };

  startInstall = async (repair?: boolean) => {
    this.isCancellationRequested = false;
    this.updateStatus({ type: 'starting' });

    const uvPath = getUVExecutablePath();

    const uvPathCheck = await withResultAsync(async () => {
      await fs.access(uvPath);
      if (!(await isFile(uvPath))) {
        throw new Error(`UV executable is not a file: ${uvPath}`);
      }
    });

    if (uvPathCheck.isErr()) {
      this.log.error(c.red(`Failed to access uv executable: ${uvPathCheck.error.message}\r\n`));
      this.updateStatus({
        type: 'error',
        error: { message: 'Failed to access uv executable', context: serializeError(uvPathCheck.error) },
      });
      return;
    }

    await fs.mkdir(getOmniRuntimeDir(), { recursive: true });

    if (this.commandRunner.isRunning()) {
      this.commandRunner.kill();
    }

    const runProcessOptions = {
      env: { ...process.env, ...DEFAULT_ENV, ...shellEnvSync() } as Record<string, string>,
      cwd: getOmniRuntimeDir(),
    };

    this.updateStatus({ type: 'installing' });

    const pythonInstallResult = await this.installPython(uvPath, runProcessOptions, repair);

    if (pythonInstallResult === 'error') {
      return;
    }

    if (pythonInstallResult === 'canceled') {
      this.log.warn(c.yellow('Installation canceled\r\n'));
      this.updateStatus({ type: 'canceled' });
      return;
    }

    const venvPath = getOmniVenvPath();
    const venvResult = await this.createVenv(uvPath, venvPath, runProcessOptions, repair);

    if (venvResult === 'error') {
      return;
    }

    if (venvResult === 'canceled') {
      this.log.warn(c.yellow('Installation canceled\r\n'));
      this.updateStatus({ type: 'canceled' });
      return;
    }

    runProcessOptions.env.VIRTUAL_ENV = venvPath;
    const installResult = await this.installOmniCode(uvPath, runProcessOptions, repair);

    if (installResult === 'error') {
      return;
    }

    if (installResult === 'canceled') {
      this.log.warn(c.yellow('Installation canceled\r\n'));
      this.updateStatus({ type: 'canceled' });
      return;
    }

    this.updateStatus({ type: 'completed' });
    this.log.info(c.green.bold('Installation completed successfully\r\n'));
  };

  cancelInstall = async (): Promise<void> => {
    const installInProgress = this.status.type === 'installing' || this.status.type === 'starting';

    if (!installInProgress) {
      this.log.debug('No installation to cancel\r\n');
      return;
    }

    this.isCancellationRequested = true;
    this.log.warn(c.yellow('Canceling installation...\r\n'));
    this.updateStatus({ type: 'canceling' });

    if (this.commandRunner.isRunning()) {
      await this.commandRunner.kill();
    }
  };
}

export const createOmniInstallManager = (arg: {
  ipc: IpcListener<IpcEvents>;
  sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
}) => {
  const { ipc, sendToWindow } = arg;

  const omniInstallManager = new OmniInstallManager({
    ipcLogger: (entry) => {
      sendToWindow('omni-install-process:log', entry);
    },
    ipcRawOutput: (data) => {
      sendToWindow('omni-install-process:raw-output', data);
    },
    onStatusChange: (status) => {
      sendToWindow('omni-install-process:status', status);
    },
  });

  ipc.handle('omni-install-process:start-install', (_, repair) => {
    omniInstallManager.startInstall(repair);
  });
  ipc.handle('omni-install-process:cancel-install', async () => {
    await omniInstallManager.cancelInstall();
  });
  ipc.handle('omni-install-process:resize', (_, cols, rows) => {
    omniInstallManager.resizePty(cols, rows);
  });

  const cleanupOmniInstallManager = async () => {
    await omniInstallManager.cancelInstall();
    ipcMain.removeHandler('omni-install-process:start-install');
    ipcMain.removeHandler('omni-install-process:cancel-install');
    ipcMain.removeHandler('omni-install-process:resize');
  };

  return [omniInstallManager, cleanupOmniInstallManager] as const;
};
