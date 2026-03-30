import type { ChildProcess } from 'node:child_process';
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import c from 'ansi-colors';
import { shellEnvSync } from 'shell-env';
import { assert } from 'tsafe';
import { WebSocket as WsWebSocket } from 'ws';

import { DEFAULT_ENV } from '@/lib/pty-utils';
import { OMNI_CODE_VERSION } from '@/lib/omni-version';
import { SimpleLogger } from '@/lib/simple-logger';
import {
  getOmniCliPath,
  getOmniConfigDir,
  getSandboxDockerfilePath,
  isDevelopment,
  isDirectory,
  isFile,
  pathExists,
} from '@/main/util';
import type {
  AgentProcessData,
  AgentProcessStatus,
  LogEntry,
  NetworkConfig,
  SandboxVariant,
  WithTimestamp,
} from '@/shared/types';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentProcessMode = 'local' | 'sandbox';

export type AgentProcessStartArg = {
  workspaceDir: string;
  sandboxVariant?: SandboxVariant;
  sandboxConfig?: { image?: string; dockerfile?: string } | null;
};

export type FetchFn = typeof globalThis.fetch;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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

const sandboxPayloadToData = (payload: SandboxJsonPayload): AgentProcessData => {
  assert(payload.ui_url, 'Missing ui_url');
  assert(payload.ports.ui, 'Missing ui port');
  return {
    uiUrl: payload.ui_url,
    wsUrl: payload.ws_url,
    sandboxUrl: payload.sandbox_url,
    codeServerUrl: payload.code_server_url ?? undefined,
    noVncUrl: payload.novnc_url ?? undefined,
    containerId: payload.container_id ?? undefined,
    containerName: payload.container_name ?? undefined,
    port: payload.ports.ui,
  };
};

// ---------------------------------------------------------------------------
// AgentProcess
// ---------------------------------------------------------------------------

export class AgentProcess {
  readonly mode: AgentProcessMode;

  private status: WithTimestamp<AgentProcessStatus>;
  private ipcRawOutput: (data: string) => void;
  private onStatusChange: (status: WithTimestamp<AgentProcessStatus>) => void;
  private log: SimpleLogger;
  private childProcess: ChildProcess | null = null;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private jsonEmitted = false;
  private lastStartArg: AgentProcessStartArg | null = null;
  private fetchFn: FetchFn;

  constructor(opts: {
    mode: AgentProcessMode;
    ipcLogger?: (entry: WithTimestamp<LogEntry>) => void;
    ipcRawOutput: (data: string) => void;
    onStatusChange: (status: WithTimestamp<AgentProcessStatus>) => void;
    fetchFn?: FetchFn;
  }) {
    this.mode = opts.mode;
    this.ipcRawOutput = opts.ipcRawOutput;
    this.onStatusChange = opts.onStatusChange;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
    this.status = { type: 'uninitialized', timestamp: Date.now() };
    this.log = new SimpleLogger((entry) => {
      this.ipcRawOutput(entry.message);
      console[entry.level](entry.message);
    });
  }

  // --- Public API ---

  getStatus = (): WithTimestamp<AgentProcessStatus> => this.status;

  start = async (arg: AgentProcessStartArg, options?: { rebuild?: boolean }): Promise<void> => {
    if (this.status.type === 'starting' || this.status.type === 'connecting' || this.status.type === 'running') {
      return;
    }

    this.lastStartArg = arg;
    this.updateStatus({ type: 'starting' });

    const env = { ...process.env, ...DEFAULT_ENV, ...shellEnvSync() } as Record<string, string>;

    // Pre-flight checks
    if (this.mode === 'sandbox') {
      const dockerOk = await this.checkDocker(env);
      if (!dockerOk) return;
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

    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.jsonEmitted = false;

    const args =
      this.mode === 'sandbox'
        ? await this.buildSandboxArgs(arg, options)
        : await this.buildLocalArgs();

    const label = this.mode === 'sandbox' ? 'sandbox' : 'agent';
    this.log.info(c.cyan(`Starting ${label}...\r\n`));
    this.log.info(`> ${omniCliPath} ${args.join(' ')}\r\n`);

    // In local mode we know the port upfront — start readiness polling immediately
    if (this.mode === 'local') {
      const portMatch = args.find((a, i) => i > 0 && args[i - 1] === '--port');
      const port = portMatch ? parseInt(portMatch, 10) : 8000;
      const uiUrl = `http://127.0.0.1:${port}`;
      const wsUrl = `ws://127.0.0.1:${port}/ws`;
      const data: AgentProcessData = { uiUrl, wsUrl, port };
      this.jsonEmitted = true;
      this.updateStatus({ type: 'connecting', data });
      void this.waitForReady(data);
    }

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
        if (this.childProcess && this.childProcess !== child) return;
        this.childProcess = null;
        this.updateStatus({ type: 'error', error: { message: error.message } });
      });

      child.on('close', (exitCode, signal) => {
        if (this.childProcess && this.childProcess !== child) return;
        this.childProcess = null;

        if (this.status.type === 'exiting' || this.status.type === 'stopping') {
          this.updateStatus({ type: 'exited' });
          return;
        }
        if (exitCode === 0) {
          this.updateStatus({ type: 'exited' });
          return;
        }
        if (this.mode === 'sandbox' && this.detectPortConflict()) {
          this.updateStatus({
            type: 'error',
            error: {
              message: 'A port required by the sandbox is already in use. Stop conflicting services or containers and try again.',
            },
          });
          return;
        }

        const reason = signal ? `signal ${signal}` : `code ${exitCode}`;
        this.updateStatus({ type: 'error', error: { message: `Process exited (${reason})` } });
      });
    } catch (error) {
      this.childProcess = null;
      this.updateStatus({ type: 'error', error: { message: (error as Error).message } });
    }
  };

  stop = async (): Promise<void> => {
    if (!this.childProcess) {
      if (this.mode === 'sandbox') {
        const env = { ...process.env, ...DEFAULT_ENV, ...shellEnvSync() } as Record<string, string>;
        await this.stopActiveContainer(env);
      }
      return;
    }

    this.updateStatus({ type: 'stopping' });
    const env = { ...process.env, ...DEFAULT_ENV, ...shellEnvSync() } as Record<string, string>;
    await this.killProcess();
    if (this.mode === 'sandbox') {
      await this.stopActiveContainer(env);
    }
    this.updateStatus({ type: 'exited' });
  };

  rebuild = async (fallbackArg: AgentProcessStartArg): Promise<void> => {
    const arg = this.lastStartArg ?? fallbackArg;
    await this.stop();
    await this.start(arg, { rebuild: true });
  };

  exit = async (): Promise<void> => {
    this.updateStatus({ type: 'exiting' });
    await this.stop();
  };

  resizePty = (_cols: number, _rows: number): void => {};

  // --- Internals ---

  private isStopping = (): boolean => {
    const t = this.status.type;
    return t === 'stopping' || t === 'exiting';
  };

  private updateStatus = (status: AgentProcessStatus): void => {
    this.status = { ...status, timestamp: Date.now() };
    this.onStatusChange(this.status);
  };

  // -- Argument builders --

  private buildLocalArgs = async (): Promise<string[]> => {
    const port = await this.pickAvailablePort();
    return ['--mode', 'server', '--host', '127.0.0.1', '--port', String(port)];
  };

  /** Pick an available TCP port by briefly binding to port 0. */
  private pickAvailablePort = (): Promise<number> => {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as import('node:net').AddressInfo;
        const port = addr.port;
        server.close(() => resolve(port));
      });
      server.on('error', reject);
    });
  };

  private buildSandboxArgs = async (
    arg: AgentProcessStartArg,
    options?: { rebuild?: boolean }
  ): Promise<string[]> => {
    const variant = arg.sandboxVariant ?? 'work';
    const args: string[] = [
      'sandbox', '--mode', 'server',
      '--ui', 'local', '--ui-host', '0.0.0.0', '--ui-port', '0',
      '--port', '0',
      '--workspace', arg.workspaceDir,
      '--output', 'json',
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
        const hosts = networkConfig.allowlist ?? (networkConfig as Record<string, unknown>)['allowedHosts'] ?? [];
        const allHosts = hosts as string[];
        if (allHosts.length > 0) {
          args.push('--network-allowlist', allHosts.join(','));
        }
      }
    } catch {
      // network.json missing or invalid
    }

    args.push('--enable-code-server', '--code-server-port', '0');
    args.push('--enable-vnc', '--vnc-port', '0');

    if (arg.sandboxConfig?.image) {
      args.push('--image', arg.sandboxConfig.image);
    } else if (arg.sandboxConfig?.dockerfile) {
      args.push('--dockerfile', resolve(arg.workspaceDir, arg.sandboxConfig.dockerfile));
      args.push('--build-arg', `OMNI_CODE_VERSION=${OMNI_CODE_VERSION}`);
    } else {
      const dockerfilePath = getSandboxDockerfilePath(variant);
      const shouldUseDockerfile = options?.rebuild || isDevelopment();
      if (shouldUseDockerfile) {
        args.push('--dockerfile', dockerfilePath);
        args.push('--build-arg', `OMNI_CODE_VERSION=${OMNI_CODE_VERSION}`);
      } else {
        const imageSuffix = variant === 'work' ? '-work' : '';
        args.push('--image', `ghcr.io/ericmichael/omni-code-sandbox${imageSuffix}:latest`);
      }
    }

    args.push('--persist-volume', 'omni-gh:/home/user/.config/gh');

    if (variant === 'work') {
      args.push('--persist-volume', 'omni-azure:/home/user/.azure');
      args.push('--persist-volume', 'omni-gitconfig:/home/user/.gitconfig.d');
      args.push('--persist-volume', 'omni-ssh:/home/user/.ssh');
      args.push('--persist-volume', 'omni-npm:/home/user/.npmrc');
    }

    if (options?.rebuild) {
      args.push('--rebuild');
    }

    return args;
  };

  // -- Stdout/stderr handling --

  private handleStdout = (data: Buffer): void => {
    const str = data.toString();
    this.ipcRawOutput(str);
    process.stdout.write(str);

    if (this.jsonEmitted) return;

    this.stdoutBuffer += str;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      this.tryParseStdoutLine(line);
    }
  };

  private handleStderr = (data: Buffer): void => {
    const str = data.toString();
    this.stderrBuffer += str;
    this.ipcRawOutput(str);
    process.stderr.write(str);
  };

  private tryParseStdoutLine = (line: string): void => {
    if (this.jsonEmitted) return;

    const trimmed = line.trim();

    // Try JSON first (sandbox mode outputs structured JSON, web mode outputs {"url", "port"})
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return;
      }

      if (this.mode === 'sandbox') {
        if (!('sandbox_url' in parsed) || !('ui_url' in parsed)) return;
        const data = sandboxPayloadToData(parsed as unknown as SandboxJsonPayload);
        this.jsonEmitted = true;
        this.updateStatus({ type: 'connecting', data });
        this.log.info(c.cyan('Waiting for services to accept connections...\r\n'));
        void this.waitForReady(data);
      } else {
        if (typeof parsed.url !== 'string' || typeof parsed.port !== 'number') return;
        const data: AgentProcessData = { uiUrl: parsed.url as string, port: parsed.port as number };
        this.jsonEmitted = true;
        this.updateStatus({ type: 'connecting', data });
        this.log.info(c.cyan('Waiting for agent to accept connections...\r\n'));
        void this.waitForReady(data);
      }
      return;
    }
  };

  // -- Readiness polling --

  private waitForReady = async (data: AgentProcessData): Promise<void> => {
    const maxAttempts = this.mode === 'sandbox' ? 120 : 30;

    const checkHttp = async (url: string): Promise<boolean> => {
      try {
        const response = await this.fetchFn(url, { method: 'GET' });
        return response.status < 500;
      } catch {
        return false;
      }
    };

    const checkWs = async (url: string): Promise<boolean> => {
      try {
        return await new Promise<boolean>((resolve) => {
          let settled = false;
          const socket = new WsWebSocket(url);
          const finish = (result: boolean): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { socket.close(); } catch {}
            resolve(result);
          };
          const timer = setTimeout(() => finish(false), 2_000);
          socket.on('open', () => finish(true));
          socket.on('error', () => finish(false));
          socket.on('close', () => finish(false));
        });
      } catch {
        return false;
      }
    };

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (this.isStopping()) return;

      const httpOk = await checkHttp(data.uiUrl);
      const wsOk = data.wsUrl ? await checkWs(data.wsUrl) : true;

      if (httpOk && wsOk) {
        if (this.isStopping()) return;
        this.updateStatus({ type: 'running', data });
        const label = this.mode === 'sandbox' ? 'Sandbox' : 'Agent';
        this.log.info(c.green.bold(`${label} started\r\n`));
        return;
      }

      await new Promise<void>((r) => setTimeout(r, 1000));
    }

    if (this.isStopping()) return;

    // Timeout
    if (this.mode === 'sandbox') {
      const env = { ...process.env, ...DEFAULT_ENV } as Record<string, string>;
      void this.stopActiveContainer(env);
    }
    this.updateStatus({
      type: 'error',
      error: { message: `Services did not become ready within ${maxAttempts} seconds.` },
    });
  };

  // -- Process management --

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

  // -- Docker helpers (sandbox mode only) --

  private checkDocker = async (env: Record<string, string>): Promise<boolean> => {
    try {
      await execFileAsync('docker', ['version'], { encoding: 'utf8', timeout: 10_000, env });
      return true;
    } catch {
      this.updateStatus({
        type: 'error',
        error: { message: 'Docker is not available. Install Docker Desktop / docker-ce and ensure it is running.' },
      });
      return false;
    }
  };

  private getActiveContainerRef = (): string | null => {
    if (this.status.type !== 'running' && this.status.type !== 'connecting') return null;
    return this.status.data.containerName ?? this.status.data.containerId ?? null;
  };

  private stopActiveContainer = async (env: Record<string, string>): Promise<void> => {
    const containerRef = this.getActiveContainerRef();
    if (!containerRef) return;
    try {
      await execFileAsync('docker', ['stop', containerRef], { encoding: 'utf8', timeout: 15_000, env });
    } catch {
      // ignore cleanup failures
    }
  };

  private detectPortConflict = (): boolean => {
    return PORT_CONFLICT_PATTERNS.some((pattern) => pattern.test(this.stderrBuffer));
  };
}
