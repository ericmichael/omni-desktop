import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';

import type { IpcListener } from '@electron-toolkit/typed-ipc/main';
import c from 'ansi-colors';
import { ipcMain } from 'electron';
import { shellEnvSync } from 'shell-env';

import { DEFAULT_ENV } from '@/lib/pty-utils';
import { SimpleLogger } from '@/lib/simple-logger';
import type { FetchFn } from '@/main/sandbox-manager';
import { getOmniCliPath, isDirectory, pathExists } from '@/main/util';
import type { ChatProcessStatus, IpcEvents, IpcRendererEvents, LogEntry, WithTimestamp } from '@/shared/types';

export class ChatManager {
  private status: WithTimestamp<ChatProcessStatus>;
  private ipcLogger: (entry: WithTimestamp<LogEntry>) => void;
  private ipcRawOutput: (data: string) => void;
  private onStatusChange: (status: WithTimestamp<ChatProcessStatus>) => void;
  private log: SimpleLogger;
  private childProcess: ChildProcess | null;
  private urlEmitted: boolean;
  private stdoutBuffer: string;
  private fetchFn: FetchFn;

  constructor(arg: {
    ipcLogger: ChatManager['ipcLogger'];
    ipcRawOutput: ChatManager['ipcRawOutput'];
    onStatusChange: ChatManager['onStatusChange'];
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
    this.urlEmitted = false;
    this.stdoutBuffer = '';
  }

  getStatus = (): WithTimestamp<ChatProcessStatus> => {
    return this.status;
  };

  private updateStatus = (status: ChatProcessStatus): void => {
    this.status = { ...status, timestamp: Date.now() };
    this.onStatusChange(this.status);
  };

  /**
   * Parses stdout looking for a JSON line with url/port from `--output json`.
   * Expected format: {"url": "http://...", "port": 1234}
   */
  private tryParseJson = (line: string): void => {
    if (this.urlEmitted) {
      return;
    }

    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
      return;
    }

    let parsed: { url?: string; port?: number };
    try {
      parsed = JSON.parse(trimmed) as { url?: string; port?: number };
    } catch {
      return;
    }

    if (typeof parsed.url !== 'string' || typeof parsed.port !== 'number') {
      return;
    }

    this.urlEmitted = true;
    this.log.info(c.cyan('Waiting for web UI to accept connections...\r\n'));
    void this.waitForReady(parsed.url, parsed.port);
  };

  private waitForReady = async (uiUrl: string, port: number): Promise<void> => {
    const checkUrl = async (): Promise<boolean> => {
      try {
        const response = await this.fetchFn(uiUrl, { method: 'GET' });
        return response.status < 500;
      } catch {
        return false;
      }
    };

    for (let attempt = 0; attempt < 30; attempt++) {
      if (this.status.type === 'stopping' || this.status.type === 'exiting') {
        return;
      }

      if (await checkUrl()) {
        break;
      }

      await new Promise<void>((r) => {
        setTimeout(r, 1000);
      });
    }

    if (this.status.type === 'stopping' || this.status.type === 'exiting') {
      return;
    }

    this.updateStatus({ type: 'running', data: { uiUrl, port } });
    this.log.info(c.green.bold('Chat web UI started\r\n'));
  };

  private handleStdout = (data: Buffer): void => {
    const str = data.toString();
    this.ipcRawOutput(str);
    process.stdout.write(str);

    if (this.urlEmitted) {
      return;
    }

    this.stdoutBuffer += str;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      this.tryParseJson(line);
    }
  };

  private handleStderr = (data: Buffer): void => {
    const str = data.toString();
    this.ipcRawOutput(str);
    process.stderr.write(str);
  };

  start = async (arg: { workspaceDir: string }) => {
    if (this.status.type === 'starting' || this.status.type === 'running') {
      return;
    }

    this.updateStatus({ type: 'starting' });

    const env = {
      ...process.env,
      ...DEFAULT_ENV,
      ...shellEnvSync(),
    } as Record<string, string>;

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
    this.urlEmitted = false;

    const args: string[] = ['--embedded', '--mode', 'web', '--host', '127.0.0.1', '--output', 'json'];

    this.log.info(c.cyan('Starting chat web UI...\r\n'));
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

        const reason = signal ? `signal ${signal}` : `code ${exitCode}`;
        this.updateStatus({ type: 'error', error: { message: `Chat process exited (${reason})` } });
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

  exit = async (): Promise<void> => {
    this.updateStatus({ type: 'exiting' });
    await this.stop();
  };
}

export const createChatManager = (arg: {
  ipc: IpcListener<IpcEvents>;
  sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
  fetchFn?: FetchFn;
}) => {
  const { ipc, sendToWindow, fetchFn } = arg;

  const chatManager = new ChatManager({
    ipcLogger: (entry) => {
      sendToWindow('chat-process:log', entry);
    },
    ipcRawOutput: (data) => {
      sendToWindow('chat-process:raw-output', data);
    },
    onStatusChange: (status) => {
      sendToWindow('chat-process:status', status);
    },
    fetchFn,
  });

  ipc.handle('chat-process:start', (_, startArg) => {
    chatManager.start(startArg);
  });
  ipc.handle('chat-process:stop', async () => {
    await chatManager.stop();
  });

  const cleanupChatManager = async () => {
    await chatManager.exit();
    ipcMain.removeHandler('chat-process:start');
    ipcMain.removeHandler('chat-process:stop');
  };

  return [chatManager, cleanupChatManager] as const;
};
