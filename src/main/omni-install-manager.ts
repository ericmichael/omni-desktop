import c from 'ansi-colors';
import { execFile } from 'child_process';
import { ipcMain, net } from 'electron';
import { createWriteStream, type WriteStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { serializeError } from 'serialize-error';
import { shellEnvSync } from 'shell-env';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

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

  // Remove venvPath with retries, then fall back to renaming it aside.
  //
  // Why: on Windows, fs.rm fails when a file inside .venv is locked — typically
  // because antivirus is mid-scan on a freshly-extracted binary, or because a
  // stray process from a prior crashed run still holds a handle. Retrying with
  // backoff clears the AV case. If even that fails, renaming the directory
  // only requires the *parent* to be writable, not exclusive access to the
  // contents — so it recovers from genuinely locked files too. The renamed
  // directory becomes garbage for the next startInstall to sweep.
  private removeOrRenameAside = async (targetPath: string): Promise<void> => {
    const RM_ATTEMPTS = 3;
    const RM_BACKOFF_MS = [0, 500, 1500];

    for (let attempt = 0; attempt < RM_ATTEMPTS; attempt++) {
      if (RM_BACKOFF_MS[attempt] > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, RM_BACKOFF_MS[attempt]);
        });
      }
      try {
        await fs.rm(targetPath, { recursive: true, force: true });
        return;
      } catch (err) {
        const msg = (err as Error).message;
        if (attempt < RM_ATTEMPTS - 1) {
          this.log.warn(
            c.yellow(`Failed to remove ${targetPath} (attempt ${attempt + 1}/${RM_ATTEMPTS}): ${msg} — retrying\r\n`)
          );
        } else {
          this.log.warn(
            c.yellow(`Failed to remove ${targetPath} after ${RM_ATTEMPTS} attempts: ${msg} — renaming aside\r\n`)
          );
        }
      }
    }

    // Rename-aside fallback. Uses the parent dir + a timestamped name so even
    // if multiple broken venvs accumulate, each gets a unique sidestepped path.
    const parent = path.dirname(targetPath);
    const base = path.basename(targetPath);
    const ts = Date.now();
    const sideStepped = path.join(parent, `${base}.broken.${ts}`);
    try {
      await fs.rename(targetPath, sideStepped);
      this.log.info(c.gray(`Renamed unremovable venv to ${sideStepped}\r\n`));
    } catch (renameErr) {
      // If even rename fails the parent is probably not writable or the path
      // is under a reparse point we can't traverse. Surface it loudly — uv
      // venv will fail next and the error context will point here.
      this.log.error(
        c.red(
          `Could not remove or rename ${targetPath}: ${(renameErr as Error).message}\r\n` +
            `The install will likely fail. Close any running Omni Code processes and try again.\r\n`
        )
      );
    }
  };

  // Preflight: read HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled.
  // Returns true if set to 1, false if set to 0, null if it can't be read.
  // A `false` result means deep site-packages paths will break during
  // `uv pip install omni-code` with a cryptic "path too long" error. We can't
  // enable it ourselves (requires admin), but surfacing the state lets users
  // and us correlate the failure to its root cause.
  private checkLongPathsEnabled = async (): Promise<boolean | null> => {
    if (process.platform !== 'win32') {
      return null;
    }
    try {
      const { stdout } = await execFileAsync('reg', [
        'query',
        'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem',
        '/v',
        'LongPathsEnabled',
      ]);
      const match = stdout.match(/LongPathsEnabled\s+REG_DWORD\s+0x([0-9a-f]+)/i);
      if (!match) {
        return null;
      }
      return parseInt(match[1], 16) === 1;
    } catch {
      return null;
    }
  };

  // Preflight: ensure there's enough free space in the runtime dir for
  // managed Python (~200MB) + omni-code + its transitive deps + a venv
  // copy of python (~80MB with --link-mode=copy). 1GB is a safe floor
  // for the cold-install case.
  private checkDiskSpace = async (runtimeDir: string): Promise<{ freeBytes: number } | null> => {
    try {
      const stats = await fs.statfs(runtimeDir);
      return { freeBytes: stats.bavail * stats.bsize };
    } catch {
      return null;
    }
  };

  // Preflight: check that the two network endpoints uv will hit during
  // install are reachable. Short timeout — we don't want to add more than
  // a couple seconds to the happy path. A failure here turns a downstream
  // "uv python install: connection refused" into a distinctive "network
  // unreachable (check VPN/proxy/firewall)" error.
  private checkNetworkReachability = async (): Promise<{ ok: boolean; failedUrl?: string; error?: string }> => {
    const urls = [
      // uv downloads managed Python from this host.
      'https://astral.sh/',
      // omni-code is published to this private index.
      'https://pypi.fury.io/ericmichael/',
    ];
    for (const url of urls) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
          const resp = await net.fetch(url, { signal: controller.signal, method: 'HEAD' });
          // 2xx/3xx/4xx all prove reachability; we only care about hard failures.
          if (resp.status >= 500) {
            return { ok: false, failedUrl: url, error: `HTTP ${resp.status}` };
          }
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        return { ok: false, failedUrl: url, error: (err as Error).message };
      }
    }
    return { ok: true };
  };

  // Best-effort cleanup of old .venv.broken.<ts> sidesteps left behind by
  // removeOrRenameAside. Runs once per install start. Silent on failure.
  private sweepBrokenVenvs = async (venvPath: string): Promise<void> => {
    try {
      const parent = path.dirname(venvPath);
      const base = path.basename(venvPath);
      const entries = await fs.readdir(parent);
      const broken = entries.filter((e) => e.startsWith(`${base}.broken.`));
      for (const entry of broken) {
        await fs.rm(path.join(parent, entry), { recursive: true, force: true }).catch(() => undefined);
      }
    } catch {
      // parent may not exist yet — nothing to sweep
    }
  };

  private cleanVenvDir = async (venvPath: string, force: boolean): Promise<void> => {
    if (force) {
      if (await pathExists(venvPath)) {
        await this.removeOrRenameAside(venvPath);
      }
      return;
    }

    const activatePath = path.join(venvPath, process.platform === 'win32' ? 'Scripts' : 'bin', 'activate');
    const isValidVenv = await isFile(activatePath);
    if (!isValidVenv && (await pathExists(venvPath))) {
      await this.removeOrRenameAside(venvPath);
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

      // Sweep any .venv.broken.<ts> directories left behind by a prior
      // install that had to rename-aside an unremovable venv.
      await this.sweepBrokenVenvs(getOmniVenvPath());

      // Preflight checks — fast, no side effects, turn downstream cryptic
      // failures into up-front distinctive errors.

      const diskSpace = await this.checkDiskSpace(getOmniRuntimeDir());
      if (diskSpace !== null) {
        const MIN_FREE_BYTES = 1024 * 1024 * 1024; // 1 GB
        const freeMB = Math.floor(diskSpace.freeBytes / (1024 * 1024));
        this.log.info(c.gray(`Free disk space in runtime dir: ${freeMB} MB\r\n`));
        if (diskSpace.freeBytes < MIN_FREE_BYTES) {
          this.log.error(c.red(`Insufficient disk space: ${freeMB} MB free, need at least 1024 MB\r\n`));
          this.updateStatus({
            type: 'error',
            error: {
              message: `Insufficient disk space in ${getOmniRuntimeDir()}: ${freeMB} MB free, need at least 1024 MB`,
              context: { freeBytes: diskSpace.freeBytes },
            },
          });
          return;
        }
      }

      if (process.platform === 'win32') {
        const longPaths = await this.checkLongPathsEnabled();
        if (longPaths === true) {
          this.log.info(c.gray('Windows LongPathsEnabled: yes\r\n'));
        } else if (longPaths === false) {
          // Warn but don't fail — some installs squeak through under MAX_PATH.
          // If omni-code install later fails with ENAMETOOLONG, this warning
          // is the breadcrumb that explains why.
          this.log.warn(
            c.yellow(
              'Windows long paths are NOT enabled. Deep Python package paths may fail.\r\n' +
                'To enable: run as admin, `reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f`\r\n' +
                'See https://learn.microsoft.com/windows/win32/fileio/maximum-file-path-limitation\r\n'
            )
          );
        } else {
          this.log.info(c.gray('Windows LongPathsEnabled: unknown (could not read registry)\r\n'));
        }
      }

      this.log.info(c.cyan('Checking network reachability...\r\n'));
      const reach = await this.checkNetworkReachability();
      if (!reach.ok) {
        this.log.error(c.red(`Network unreachable: ${reach.failedUrl} (${reach.error})\r\n`));
        this.updateStatus({
          type: 'error',
          error: {
            message: `Network unreachable: cannot reach ${reach.failedUrl} (${reach.error}). Check your VPN, proxy, or firewall.`,
            context: { failedUrl: reach.failedUrl, error: reach.error },
          },
        });
        return;
      }
      this.log.info(c.gray('Network: reachable\r\n'));

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
