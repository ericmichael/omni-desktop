import type { IpcListener } from '@electron-toolkit/typed-ipc/main';
import { ipcMain } from 'electron';

import { AgentProcess, type FetchFn } from '@/main/agent-process';
import type { ChatProcessStatus, IpcEvents, IpcRendererEvents, LogEntry, WithTimestamp } from '@/shared/types';

/**
 * ChatManager — thin wrapper around AgentProcess in 'local' mode.
 * Maintains the same public API for backward compatibility.
 */
export class ChatManager {
  private agent: AgentProcess;

  constructor(arg: {
    ipcLogger: (entry: WithTimestamp<LogEntry>) => void;
    ipcRawOutput: (data: string) => void;
    onStatusChange: (status: WithTimestamp<ChatProcessStatus>) => void;
    fetchFn?: FetchFn;
  }) {
    this.agent = new AgentProcess({
      mode: 'local',
      ipcLogger: arg.ipcLogger,
      ipcRawOutput: arg.ipcRawOutput,
      onStatusChange: arg.onStatusChange,
      fetchFn: arg.fetchFn,
    });
  }

  getStatus = (): WithTimestamp<ChatProcessStatus> => this.agent.getStatus();

  start = async (arg: { workspaceDir: string }): Promise<void> => {
    await this.agent.start({ workspaceDir: arg.workspaceDir });
  };

  stop = async (): Promise<void> => {
    await this.agent.stop();
  };

  exit = async (): Promise<void> => {
    await this.agent.exit();
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
