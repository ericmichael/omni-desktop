import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';

import type { IpcListener } from '@electron-toolkit/typed-ipc/main';
import c from 'ansi-colors';
import { ipcMain, net } from 'electron';
import { shellEnvSync } from 'shell-env';

import { DEFAULT_ENV } from '@/lib/pty-utils';
import { SimpleLogger } from '@/lib/simple-logger';
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

  constructor(arg: {
    ipcLogger: ChatManager['ipcLogger'];
    ipcRawOutput: ChatManager['ipcRawOutput'];
    onStatusChange: ChatManager['onStatusChange'];
  }) {
    this.ipcLogger = arg.ipcLogger;
    this.ipcRawOutput = arg.ipcRawOutput;
    this.onStatusChange = arg.onStatusChange;
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
   * Parses stdout looking for the Gradio/web UI URL pattern.
   * Common patterns:
   *   "Running on local URL:  http://127.0.0.1:7860"
   *   "Running on http://127.0.0.1:7860"
   */
  private tryParseUrl = (line: string): void => {
    if (this.urlEmitted) {
      return;
    }

    const match = line.match(/https?:\/\/[\w.-]+:\d+/);
    if (!match) {
      return;
    }

    const url = match[0];
    const portMatch = url.match(/:(\d+)$/);
    if (!portMatch) {
      return;
    }

    const port = Number(portMatch[1]);
    this.urlEmitted = true;
    this.log.info(c.cyan('Waiting for web UI to accept connections...\r\n'));
    void this.waitForReady(url, port);
  };

  private waitForReady = async (uiUrl: string, port: number): Promise<void> => {
    const checkUrl = async (): Promise<boolean> => {
      try {
        const response = await net.fetch(uiUrl, { method: 'GET' });
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
      this.tryParseUrl(line);
    }
  };

  private handleStderr = (data: Buffer): void => {
    const str = data.toString();
    this.ipcRawOutput(str);
    process.stderr.write(str);

    // Gradio often prints its URL to stderr as well
    if (!this.urlEmitted) {
      const lines = str.split(/\r?\n/);
      for (const line of lines) {
        this.tryParseUrl(line);
      }
    }
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
      // Suppress auto browser open — we embed the UI in a webview
      BROWSER: 'echo',
      GRADIO_ANALYTICS_ENABLED: 'False',
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

    const args: string[] = ['--mode', 'web', '--host', '127.0.0.1'];

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
}) => {
  const { ipc, sendToWindow } = arg;

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
