import type { ChildProcess } from 'node:child_process';
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { IpcListener } from '@electron-toolkit/typed-ipc/main';
import c from 'ansi-colors';
import { ipcMain } from 'electron';
import { shellEnvSync } from 'shell-env';
import { assert } from 'tsafe';

import { DEFAULT_ENV } from '@/lib/pty-utils';
import { SimpleLogger } from '@/lib/simple-logger';
import { getOmniCliPath, getOmniConfigDir, isDevelopment, isDirectory, isFile, pathExists } from '@/main/util';
import type {
  IpcEvents,
  IpcRendererEvents,
  LogEntry,
  NetworkConfig,
  SandboxProcessStatus,
  SandboxVariant,
  WithTimestamp,
} from '@/shared/types';

const execFileAsync = promisify(execFile);

/**
 * Patterns in Docker stderr that indicate a port conflict.
 */
const PORT_CONFLICT_PATTERNS = [
  /port is already allocated/i,
  /address already in use/i,
  /bind: address already in use/i,
  /port \d+ is in use/i,
];

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

const toSandboxStatusData = (
  payload: SandboxJsonPayload
): Extract<SandboxProcessStatus, { type: 'running' }>['data'] => {
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

type StartArg = {
  workspaceDir: string;
  sandboxVariant: SandboxVariant;
};

export type FetchFn = typeof globalThis.fetch;

export class SandboxManager {
  private status: WithTimestamp<SandboxProcessStatus>;
  private ipcLogger: (entry: WithTimestamp<LogEntry>) => void;
  private ipcRawOutput: (data: string) => void;
  private onStatusChange: (status: WithTimestamp<SandboxProcessStatus>) => void;
  private log: SimpleLogger;
  private childProcess: ChildProcess | null;
  private jsonBuffer: string;
  private jsonEmitted: boolean;
  private lastStartArg: StartArg | null;
  private stderrBuffer: string;
  private fetchFn: FetchFn;

  constructor(arg: {
    ipcLogger: SandboxManager['ipcLogger'];
    ipcRawOutput: SandboxManager['ipcRawOutput'];
    onStatusChange: SandboxManager['onStatusChange'];
    fetchFn?: FetchFn;
  }) {
    this.ipcLogger = arg.ipcLogger;
    this.ipcRawOutput = arg.ipcRawOutput;
    this.onStatusChange = arg.onStatusChange;
    this.fetchFn = arg.fetchFn ?? globalThis.fetch;
    this.childProcess = null;
    this.status = { type: 'uninitialized', timestamp: Date.now() };
    this.log = new SimpleLogger((entry) => {
      this.ipcRawOutput(entry.message);
      console[entry.level](entry.message);
    });
    this.jsonBuffer = '';
    this.jsonEmitted = false;
    this.lastStartArg = null;
    this.stderrBuffer = '';
  }

  getStatus = (): WithTimestamp<SandboxProcessStatus> => {
    return this.status;
  };

  updateStatus = (status: SandboxProcessStatus): void => {
    this.status = { ...status, timestamp: Date.now() };
    this.onStatusChange(this.status);
  };

  resizePty = (_cols: number, _rows: number): void => {};

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
    this.log.info(c.cyan('Waiting for services to accept connections...\r\n'));
    void this.waitForServices(data);
  };

  private waitForServices = async (data: Extract<SandboxProcessStatus, { type: 'running' }>['data']): Promise<void> => {
    const urls = [data.sandboxUrl, data.uiUrl, data.codeServerUrl, data.noVncUrl].filter((u): u is string =>
      Boolean(u)
    );

    const checkUrl = async (url: string): Promise<boolean> => {
      try {
        const response = await this.fetchFn(url, { method: 'GET' });
        return response.status < 500;
      } catch {
        return false;
      }
    };

    for (let attempt = 0; attempt < 30; attempt++) {
      if (this.status.type === 'stopping' || this.status.type === 'exiting') {
        return;
      }

      const results = await Promise.all(urls.map(checkUrl));
      if (results.every(Boolean)) {
        break;
      }

      await new Promise<void>((r) => {
        setTimeout(r, 1000);
      });
    }

    if (this.status.type === 'stopping' || this.status.type === 'exiting') {
      return;
    }

    this.updateStatus({ type: 'running', data });
    this.log.info(c.green.bold('Sandbox started\r\n'));
  };

  private handleStdout = (data: Buffer): void => {
    const str = data.toString();
    this.ipcRawOutput(str);
    process.stdout.write(str);

    if (this.jsonEmitted) {
      return;
    }

    this.jsonBuffer += str;
    const lines = this.jsonBuffer.split(/\r?\n/);
    this.jsonBuffer = lines.pop() ?? '';
    for (const line of lines) {
      this.tryParseJson(line);
    }
  };

  private handleStderr = (data: Buffer): void => {
    const str = data.toString();
    this.stderrBuffer += str;
    this.ipcRawOutput(str);
    process.stderr.write(str);
  };

  private detectPortConflict = (): boolean => {
    return PORT_CONFLICT_PATTERNS.some((pattern) => pattern.test(this.stderrBuffer));
  };

  start = async (arg: StartArg, options?: { rebuild?: boolean }) => {
    if (this.status.type === 'starting' || this.status.type === 'running') {
      return;
    }

    this.lastStartArg = arg;
    this.updateStatus({ type: 'starting' });

    const env = { ...process.env, ...DEFAULT_ENV, ...shellEnvSync() } as Record<string, string>;

    const dockerCheck = await (async () => {
      try {
        await execFileAsync('docker', ['version'], { encoding: 'utf8', timeout: 10_000, env });
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

    const omniCliPath = getOmniCliPath();

    if (!(await pathExists(omniCliPath))) {
      this.updateStatus({ type: 'error', error: { message: 'Omni runtime is not installed' } });
      return;
    }

    if (this.childProcess) {
      await this.killProcess();
    }

    this.jsonBuffer = '';
    this.jsonEmitted = false;
    this.stderrBuffer = '';

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

    const omniConfigDir = getOmniConfigDir();

    const envFilePath = join(omniConfigDir, '.env');
    if (await isFile(envFilePath)) {
      args.push('--env-file', envFilePath);
    }

    try {
      const networkJson = await readFile(join(omniConfigDir, 'network.json'), 'utf-8');
      const networkConfig = JSON.parse(networkJson) as NetworkConfig;
      if (networkConfig.enabled) {
        // allowlist is pre-expanded at save time; fall back to old allowedHosts for transition
        const hosts = networkConfig.allowlist ?? (networkConfig as Record<string, unknown>)['allowedHosts'] ?? [];
        const allHosts = hosts as string[];
        if (allHosts.length > 0) {
          args.push('--network-allowlist', allHosts.join(','));
        }
      }
    } catch {
      // network.json missing or invalid — no isolation applied
    }

    args.push('--enable-code-server', '--code-server-port', '0');
    args.push('--enable-vnc', '--vnc-port', '0');

    const dockerfileName = arg.sandboxVariant === 'work' ? 'Dockerfile.work' : 'Dockerfile';
    if (isDevelopment()) {
      const dockerfilePath = resolve(__dirname, '../../docker/sandbox', dockerfileName);
      args.push('--dockerfile', dockerfilePath);
    } else {
      const imageSuffix = arg.sandboxVariant === 'work' ? '-work' : '';
      args.push('--image', `ghcr.io/ericmichael/omni-code-sandbox${imageSuffix}:latest`);
    }

    if (arg.sandboxVariant === 'work') {
      args.push('--persist-volume', 'omni-azure:/home/user/.azure');
      args.push('--persist-volume', 'omni-gitconfig:/home/user/.gitconfig');
      args.push('--persist-volume', 'omni-ssh:/home/user/.ssh');
      args.push('--persist-volume', 'omni-npm:/home/user/.npmrc');
    }

    if (options?.rebuild) {
      args.push('--rebuild', '--no-cache');
    }

    this.log.info(c.cyan('Starting sandbox...\r\n'));
    this.log.info(`> ${omniCliPath} ${args.join(' ')}\r\n`);

    try {
      const child = spawn(omniCliPath, args, {
        cwd: arg.workspaceDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.childProcess = child;

      child.stdout.on('data', this.handleStdout);
      child.stderr.on('data', this.handleStderr);

      child.on('error', (error: Error) => {
        if (this.childProcess && this.childProcess !== child) {
          return;
        }
        this.childProcess = null;
        this.updateStatus({ type: 'error', error: { message: error.message } });
      });

      child.on('close', (exitCode, signal) => {
        if (this.childProcess && this.childProcess !== child) {
          return;
        }
        this.childProcess = null;

        if (this.status.type === 'exiting' || this.status.type === 'stopping') {
          this.updateStatus({ type: 'exited' });
          return;
        }

        if (exitCode === 0) {
          this.updateStatus({ type: 'exited' });
          return;
        }

        if (this.detectPortConflict()) {
          this.updateStatus({
            type: 'error',
            error: {
              message:
                'A port required by the sandbox is already in use. Stop conflicting services or containers and try again.',
            },
          });
          return;
        }

        const reason = signal ? `signal ${signal}` : `code ${exitCode}`;
        this.updateStatus({ type: 'error', error: { message: `Sandbox exited (${reason})` } });
      });
    } catch (error) {
      this.childProcess = null;
      this.updateStatus({ type: 'error', error: { message: (error as Error).message } });
    }
  };

  private killProcess = (timeout = 10_000): Promise<void> => {
    const child = this.childProcess;
    if (!child || child.exitCode !== null) {
      this.childProcess = null;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const onExit = (): void => {
        clearTimeout(timer);
        this.childProcess = null;
        resolve();
      };

      child.once('close', onExit);

      child.kill('SIGTERM');

      const timer = setTimeout(() => {
        child.removeListener('close', onExit);
        child.kill('SIGKILL');
        this.childProcess = null;
        resolve();
      }, timeout);
    });
  };

  stop = async (): Promise<void> => {
    if (!this.childProcess) {
      return;
    }

    this.updateStatus({ type: 'stopping' });
    await this.killProcess();
    this.updateStatus({ type: 'exited' });
  };

  rebuild = async (fallbackArg: StartArg): Promise<void> => {
    const arg = this.lastStartArg ?? fallbackArg;
    await this.stop();
    await this.start(arg, { rebuild: true });
  };

  exit = async (): Promise<void> => {
    this.updateStatus({ type: 'exiting' });
    await this.stop();
  };
}

export const createSandboxManager = (arg: {
  ipc: IpcListener<IpcEvents>;
  sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
  getStoreData: () => Pick<StartArg, 'workspaceDir' | 'sandboxVariant'>;
  fetchFn?: FetchFn;
}) => {
  const { ipc, sendToWindow, getStoreData, fetchFn } = arg;

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
    fetchFn,
  });

  ipc.handle('sandbox-process:start', (_, startArg) => {
    sandboxManager.start(startArg);
  });
  ipc.handle('sandbox-process:stop', async () => {
    await sandboxManager.stop();
  });
  ipc.handle('sandbox-process:rebuild', async () => {
    await sandboxManager.rebuild(getStoreData());
  });
  ipc.handle('sandbox-process:resize', (_, cols, rows) => {
    sandboxManager.resizePty(cols, rows);
  });

  const cleanupSandboxManager = async () => {
    await sandboxManager.exit();
    ipcMain.removeHandler('sandbox-process:start');
    ipcMain.removeHandler('sandbox-process:stop');
    ipcMain.removeHandler('sandbox-process:rebuild');
    ipcMain.removeHandler('sandbox-process:resize');
  };

  return [sandboxManager, cleanupSandboxManager] as const;
};
