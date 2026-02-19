import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { IpcListener } from '@electron-toolkit/typed-ipc/main';
import c from 'ansi-colors';
import { ipcMain } from 'electron';
import { shellEnvSync } from 'shell-env';
import { assert } from 'tsafe';

import { CommandRunner } from '@/lib/command-runner';
import { DEFAULT_ENV } from '@/lib/pty-utils';
import { SimpleLogger } from '@/lib/simple-logger';
import { getOmniCliPath, getOmniPythonPath, isDirectory, isFile, pathExists } from '@/main/util';
import type { IpcEvents, IpcRendererEvents, LogEntry, SandboxProcessStatus, WithTimestamp } from '@/shared/types';

const execFileAsync = promisify(execFile);

type SandboxJsonPayload = {
  sandbox_url: string;
  ws_url: string;
  ui_url: string | null;
  code_server_url: string | null;
  novnc_url: string | null;
  container_id: string | null;
  container_name: string | null;
  ports: {
    sandbox: number;
    ui: number | null;
    code_server: number | null;
    vnc: number | null;
  };
};

const toSandboxStatusData = (payload: SandboxJsonPayload): Extract<SandboxProcessStatus, { type: 'running' }>['data'] => {
  assert(payload.ui_url, 'Missing ui_url');
  assert(payload.ports.ui, 'Missing ui port');

  return {
    sandboxUrl: payload.sandbox_url,
    wsUrl: payload.ws_url,
    uiUrl: payload.ui_url,
    codeServerUrl: payload.code_server_url ?? undefined,
    noVncUrl: payload.novnc_url ?? undefined,
    containerId: payload.container_id ?? undefined,
    containerName: payload.container_name ?? undefined,
    ports: {
      sandbox: payload.ports.sandbox,
      ui: payload.ports.ui,
      codeServer: payload.ports.code_server ?? undefined,
      vnc: payload.ports.vnc ?? undefined,
    },
  };
};

export class SandboxManager {
  private status: WithTimestamp<SandboxProcessStatus>;
  private ipcLogger: (entry: WithTimestamp<LogEntry>) => void;
  private ipcRawOutput: (data: string) => void;
  private onStatusChange: (status: WithTimestamp<SandboxProcessStatus>) => void;
  private log: SimpleLogger;
  private commandRunner: CommandRunner;
  private cols: number | undefined;
  private rows: number | undefined;
  private jsonBuffer: string;
  private jsonEmitted: boolean;

  constructor(arg: {
    ipcLogger: SandboxManager['ipcLogger'];
    ipcRawOutput: SandboxManager['ipcRawOutput'];
    onStatusChange: SandboxManager['onStatusChange'];
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
    this.cols = undefined;
    this.rows = undefined;
    this.jsonBuffer = '';
    this.jsonEmitted = false;
  }

  getStatus = (): WithTimestamp<SandboxProcessStatus> => {
    return this.status;
  };

  updateStatus = (status: SandboxProcessStatus): void => {
    this.status = { ...status, timestamp: Date.now() };
    this.onStatusChange(this.status);
  };

  resizePty = (cols: number, rows: number): void => {
    this.cols = cols;
    this.rows = rows;
    this.commandRunner.resize(cols, rows);
  };

  private tryParseJson = (line: string): void => {
    if (this.jsonEmitted) {
      return;
    }

    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
      return;
    }

    const parsedResult = (() => {
      try {
        return JSON.parse(trimmed) as SandboxJsonPayload;
      } catch {
        return null;
      }
    })();

    if (!parsedResult) {
      return;
    }

    if (!('sandbox_url' in parsedResult) || !('ui_url' in parsedResult)) {
      return;
    }

    const data = toSandboxStatusData(parsedResult);
    this.jsonEmitted = true;
    this.updateStatus({ type: 'running', data });
    this.log.info(c.green.bold('Sandbox started\r\n'));
  };

  private handleData = (data: string): void => {
    this.ipcRawOutput(data);
    process.stdout.write(data);

    if (this.jsonEmitted) {
      return;
    }

    this.jsonBuffer += data;
    const lines = this.jsonBuffer.split(/\r?\n/);
    this.jsonBuffer = lines.pop() ?? '';
    for (const line of lines) {
      this.tryParseJson(line);
    }
  };

  private resolveWorkDockerfilePath = async (): Promise<string> => {
    const pythonPath = getOmniPythonPath();
    const script = [
      'import omni_code',
      'import pathlib',
      'print(pathlib.Path(omni_code.__file__).resolve().parent / "sandbox" / "Dockerfile.work")',
    ].join('; ');
    const { stdout } = await execFileAsync(pythonPath, ['-c', script], { encoding: 'utf8' });
    return stdout.trim();
  };

  start = async (arg: {
    workspaceDir: string;
    envFilePath?: string;
    enableCodeServer: boolean;
    enableVnc: boolean;
    useWorkDockerfile: boolean;
  }) => {
    this.updateStatus({ type: 'starting' });

    const dockerCheck = await (async () => {
      try {
        await execFileAsync('docker', ['version'], { encoding: 'utf8', timeout: 10_000 });
        return true;
      } catch {
        return false;
      }
    })();

    if (!dockerCheck) {
      this.updateStatus({
        type: 'error',
        error: { message: 'Docker is not available. Install Docker Desktop / docker-ce and ensure it is running.' },
      });
      return;
    }

    if (!(await isDirectory(arg.workspaceDir))) {
      this.updateStatus({ type: 'error', error: { message: `Workspace directory not found: ${arg.workspaceDir}` } });
      return;
    }

    if (arg.envFilePath && !(await isFile(arg.envFilePath))) {
      this.updateStatus({ type: 'error', error: { message: `Env file not found: ${arg.envFilePath}` } });
      return;
    }

    const omniCliPath = getOmniCliPath();

    if (!(await pathExists(omniCliPath))) {
      this.updateStatus({ type: 'error', error: { message: 'Omni runtime is not installed' } });
      return;
    }

    if (this.commandRunner.isRunning()) {
      await this.commandRunner.kill();
    }

    this.jsonBuffer = '';
    this.jsonEmitted = false;

    const args: string[] = [
      'sandbox',
      '--mode',
      'server',
      '--ui',
      'local',
      '--ui-host',
      '0.0.0.0',
      '--ui-port',
      '0',
      '--port',
      '0',
      '--workspace',
      arg.workspaceDir,
      '--output',
      'json',
    ];

    if (arg.envFilePath) {
      args.push('--env-file', arg.envFilePath);
    }

    if (arg.enableCodeServer) {
      args.push('--enable-code-server', '--code-server-port', '0');
    }

    if (arg.enableVnc) {
      args.push('--enable-vnc', '--vnc-port', '0');
    }

    if (arg.useWorkDockerfile) {
      try {
        const dockerfilePath = await this.resolveWorkDockerfilePath();
        args.push('--dockerfile', dockerfilePath);
      } catch (error) {
        this.log.warn(c.yellow(`Failed to resolve Dockerfile.work: ${(error as Error).message}\r\n`));
      }
    }

    this.log.info(c.cyan('Starting sandbox...\r\n'));
    this.log.info(`> ${omniCliPath} ${args.join(' ')}\r\n`);

    const env = { ...process.env, ...DEFAULT_ENV, ...shellEnvSync() } as Record<string, string>;

    this.commandRunner
      .runCommand(
        omniCliPath,
        args,
        {
          cwd: arg.workspaceDir,
          env,
          rows: this.rows,
          cols: this.cols,
        },
        {
          onData: this.handleData,
          onExit: (exitCode, signal) => {
            if (this.status.type === 'exiting' || this.status.type === 'stopping') {
              this.updateStatus({ type: 'exited' });
              return;
            }

            if (exitCode === 0) {
              this.updateStatus({ type: 'exited' });
              return;
            }

            const reason = signal ? `signal ${signal}` : `code ${exitCode}`;
            this.updateStatus({ type: 'error', error: { message: `Sandbox exited (${reason})` } });
          },
        }
      )
      .catch((error: Error) => {
        this.updateStatus({ type: 'error', error: { message: error.message } });
      });
  };

  stop = async (): Promise<void> => {
    if (!this.commandRunner.isRunning()) {
      return;
    }

    this.updateStatus({ type: 'stopping' });
    await this.commandRunner.kill(10_000);
    this.updateStatus({ type: 'exited' });
  };

  exit = async (): Promise<void> => {
    this.updateStatus({ type: 'exiting' });
    await this.stop();
  };
}

export const createSandboxManager = (arg: {
  ipc: IpcListener<IpcEvents>;
  sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
}) => {
  const { ipc, sendToWindow } = arg;

  const sandboxManager = new SandboxManager({
    ipcLogger: (entry) => {
      sendToWindow('sandbox-process:log', entry);
    },
    ipcRawOutput: (data) => {
      sendToWindow('sandbox-process:raw-output', data);
    },
    onStatusChange: (status) => {
      sendToWindow('sandbox-process:status', status);
    },
  });

  ipc.handle('sandbox-process:start', (_, startArg) => {
    sandboxManager.start(startArg);
  });
  ipc.handle('sandbox-process:stop', async () => {
    await sandboxManager.stop();
  });
  ipc.handle('sandbox-process:resize', (_, cols, rows) => {
    sandboxManager.resizePty(cols, rows);
  });

  const cleanupSandboxManager = async () => {
    await sandboxManager.exit();
    ipcMain.removeHandler('sandbox-process:start');
    ipcMain.removeHandler('sandbox-process:stop');
    ipcMain.removeHandler('sandbox-process:resize');
  };

  return [sandboxManager, cleanupSandboxManager] as const;
};
