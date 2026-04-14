import c from 'ansi-colors';
import { ipcMain } from 'electron';
import { createWriteStream, type WriteStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { serializeError } from 'serialize-error';
import { shellEnvSync } from 'shell-env';

import { CommandRunner } from '@/lib/command-runner';
import { OMNI_CODE_VERSION } from '@/lib/omni-version';
import { DEFAULT_ENV } from '@/lib/pty-utils';
import { withResultAsync } from '@/lib/result';
import { SimpleLogger } from '@/lib/simple-logger';
import {
  getOmniLogsDir,
  getOmniRuntimeDir,
  getOmniVenvPath,
  getUVExecutablePath,
  isFile,
  pathExists,
} from '@/main/util';
import type { IIpcListener } from '@/shared/ipc-listener';
import type { IpcRendererEvents, LogEntry, OmniInstallProcessStatus, WithTimestamp } from '@/shared/types';

const PYTHON_VERSION = '3.11';
const EXTRA_INDEX_URL = 'https://pypi.fury.io/ericmichael/';
const MAX_INSTALL_LOGS = 5;

// Strip common ANSI CSI sequences so the on-disk log is readable in plain
// text editors. Not exhaustive — just good enough for uv/pip progress output.
// eslint-disable-next-line no-control-regex
const ANSI_CSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
const stripAnsi = (s: string): string => s.replace(ANSI_CSI_RE, '');

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
  private installLogStream: WriteStream | null = null;
  private installLogPath: string | null = null;

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
      this.emitOutput(entry.message);
      console[entry.level](entry.message);
    });
    this.isCancellationRequested = false;
  }

  private emitOutput = (data: string): void => {
    this.ipcRawOutput(data);
    if (this.installLogStream) {
      this.installLogStream.write(stripAnsi(data));
    }
  };

  private rotateInstallLogs = async (logsDir: string): Promise<void> => {
    try {
      const entries = await fs.readdir(logsDir);
      const installLogs = entries.filter((f) => f.startsWith('omni-install-') && f.endsWith('.log')).sort();
      const keep = MAX_INSTALL_LOGS - 1;
      const toDelete = installLogs.slice(0, Math.max(0, installLogs.length - keep));
      await Promise.all(toDelete.map((f) => fs.unlink(path.join(logsDir, f)).catch(() => undefined)));
    } catch {
      // Logs dir may not exist yet on first run — nothing to rotate.
    }
  };

  private openInstallLog = async (): Promise<void> => {
    try {
      const logsDir = getOmniLogsDir();
      await fs.mkdir(logsDir, { recursive: true });
      await this.rotateInstallLogs(logsDir);
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const logPath = path.join(logsDir, `omni-install-${ts}.log`);
      const stream = createWriteStream(logPath, { flags: 'a' });
      stream.write(`=== Omni Code install log ${new Date().toISOString()} ===\n`);
      stream.write(`platform=${process.platform} arch=${process.arch} node=${process.version}\n`);
      stream.write(`runtimeDir=${getOmniRuntimeDir()}\n`);
      stream.write(`venvPath=${getOmniVenvPath()}\n`);
      stream.write(`uvPath=${getUVExecutablePath()}\n`);
      stream.write(`userProfile=${process.env.USERPROFILE ?? process.env.HOME ?? '<unset>'}\n\n`);
      this.installLogStream = stream;
      this.installLogPath = logPath;
      this.log.info(c.gray(`Install log: ${logPath}\r\n`));
    } catch (err) {
      // Never let logging setup block the install itself.
      console.error('Failed to open install log:', err);
      this.installLogStream = null;
      this.installLogPath = null;
    }
  };

  private closeInstallLog = (): void => {
    if (this.installLogStream) {
      try {
        this.installLogStream.end();
      } catch {
        // swallow — stream may already be closed
      }
      this.installLogStream = null;
    }
  };

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
            this.emitOutput(data);
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
        error: {
          message: `Failed to install Python (uv python install: ${result.error.message})`,
          context: serializeError(result.error),
        },
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
      error: {
        message: `Failed to install Python (uv python install --reinstall: ${retryResult.error.message})`,
        context: serializeError(retryResult.error),
      },
    });
    return 'error';
  };

  private cleanVenvDir = async (venvPath: string, force: boolean): Promise<void> => {
    const tryRm = async (): Promise<void> => {
      try {
        await fs.rm(venvPath, { recursive: true, force: true });
      } catch (err) {
        // Surface to the install log so dirty-dir failures stop being invisible.
        // We don't rethrow: uv venv will fail with its own message if the dir
        // is still dirty, and that message is more informative than ours.
        this.log.warn(c.yellow(`Failed to remove existing venv dir at ${venvPath}: ${(err as Error).message}\r\n`));
      }
    };

    if (force) {
      await tryRm();
      return;
    }

    const activatePath = path.join(venvPath, process.platform === 'win32' ? 'Scripts' : 'bin', 'activate');
    const isValidVenv = await isFile(activatePath);
    if (!isValidVenv && (await pathExists(venvPath))) {
      await tryRm();
    }
  };

  private createVenv = async (
    uvPath: string,
    venvPath: string,
    options: { cwd: string; env: Record<string, string> },
    repair?: boolean
  ): Promise<'success' | 'canceled' | 'error'> => {
    await this.cleanVenvDir(venvPath, !!repair);

    // --link-mode=copy sidesteps two Windows failure modes seen on unsigned
    // builds: (1) antivirus briefly locking the managed python.exe while uv
    // tries to hardlink it into the venv, and (2) hardlinks silently failing
    // across reparse points (e.g. OneDrive-redirected %APPDATA%). Costs ~30MB
    // of disk per venv in exchange for reliability.
    const venvArgs = [
      'venv',
      '--relocatable',
      '--prompt',
      'omni',
      '--python',
      PYTHON_VERSION,
      '--python-preference',
      'only-managed',
      '--link-mode',
      'copy',
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
        error: {
          message: `Failed to create virtual environment at ${venvPath} (uv venv: ${result.error.message})`,
          context: serializeError(result.error),
        },
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
      error: {
        message: `Failed to create virtual environment at ${venvPath} after retry (uv venv: ${retryResult.error.message})`,
        context: serializeError(retryResult.error),
      },
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
      error: {
        message: `Failed to install omni-code==${OMNI_CODE_VERSION} (uv pip install: ${result.error.message})`,
        context: serializeError(result.error),
      },
    });
    return 'error';
  };

  startInstall = async (repair?: boolean) => {
    this.isCancellationRequested = false;
    this.updateStatus({ type: 'starting' });

    await this.openInstallLog();

    try {
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
          error: {
            message: `Failed to access uv executable at ${uvPath}: ${uvPathCheck.error.message}`,
            context: serializeError(uvPathCheck.error),
          },
        });
        return;
      }

      await fs.mkdir(getOmniRuntimeDir(), { recursive: true });

      if (this.commandRunner.isRunning()) {
        this.commandRunner.kill();
      }

      // shell-env spawns a login shell to inherit PATH — a macOS-only workaround
      // for GUI-launched apps. On Windows it's useless (and has been observed to
      // hang or return garbage depending on COMSPEC / PowerShell policy), so skip it.
      const inheritedShellEnv = process.platform === 'win32' ? {} : shellEnvSync();
      const runProcessOptions = {
        env: { ...process.env, ...DEFAULT_ENV, ...inheritedShellEnv } as Record<string, string>,
        cwd: getOmniRuntimeDir(),
      };

      // Probe uv before committing to the install. If SmartScreen or antivirus
      // is blocking the unsigned binary, this gives us a distinctive error up
      // front instead of a confusing "venv creation failed" two steps later.
      this.log.info(c.cyan('Verifying uv executable...\r\n'));
      this.log.info(`> ${uvPath} --version\r\n`);
      const uvProbe = await withResultAsync(() => this.runCommand(uvPath, ['--version'], runProcessOptions));
      if (uvProbe.isErr()) {
        this.log.error(c.red(`uv executable failed to run: ${uvProbe.error.message}\r\n`));
        this.updateStatus({
          type: 'error',
          error: {
            message: `uv executable at ${uvPath} failed to run — antivirus or SmartScreen may be blocking it (${uvProbe.error.message})`,
            context: serializeError(uvProbe.error),
          },
        });
        return;
      }
      if (uvProbe.value === 'canceled') {
        this.log.warn(c.yellow('Installation canceled\r\n'));
        this.updateStatus({ type: 'canceled' });
        return;
      }

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
    } finally {
      this.closeInstallLog();
    }
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
  ipc: IIpcListener;
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
