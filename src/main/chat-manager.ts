import type { IpcListener } from '@electron-toolkit/typed-ipc/main';
import { ipcMain } from 'electron';

import { AgentProcess, type AgentProcessMode, type AgentProcessStartArg, type FetchFn } from '@/main/agent-process';
import type { PlatformClient } from '@/main/platform-client';
import type {
  ChatProcessStatus,
  IpcEvents,
  IpcRendererEvents,
  LogEntry,
  SandboxBackend,
  SandboxVariant,
  WithTimestamp,
} from '@/shared/types';

export type ChatStoreData = {
  sandboxEnabled: boolean;
  sandboxBackend: SandboxBackend;
  sandboxVariant: SandboxVariant;
};

export type ChatStartArg = {
  workspaceDir: string;
  sandboxVariant?: SandboxVariant;
};

/**
 * ChatManager — unified process manager for the Chat tab.
 * Replaces the legacy SandboxManager. Delegates to AgentProcess which
 * supports local / sandbox (Docker) / podman / vm / platform modes.
 */
export class ChatManager {
  private agent: AgentProcess | null = null;
  private ipcRawOutput: (data: string) => void;
  private onStatusChange: (status: WithTimestamp<ChatProcessStatus>) => void;
  private fetchFn: FetchFn;
  private getStoreData: () => ChatStoreData;
  private lastStartArg: ChatStartArg | null = null;

  /** Set by the platform integration when in enterprise mode. */
  platformClient: PlatformClient | null = null;

  constructor(arg: {
    ipcRawOutput: (data: string) => void;
    onStatusChange: (status: WithTimestamp<ChatProcessStatus>) => void;
    fetchFn?: FetchFn;
    getStoreData?: () => ChatStoreData;
  }) {
    this.ipcRawOutput = arg.ipcRawOutput;
    this.onStatusChange = arg.onStatusChange;
    this.fetchFn = arg.fetchFn ?? globalThis.fetch;
    this.getStoreData = arg.getStoreData ?? (() => ({
      sandboxEnabled: false,
      sandboxBackend: 'docker' as const,
      sandboxVariant: 'work' as const,
    }));
  }

  private resolveMode(): AgentProcessMode {
    if (this.platformClient) return 'platform';
    const { sandboxEnabled, sandboxBackend } = this.getStoreData();
    if (!sandboxEnabled) return 'local';
    if (sandboxBackend === 'vm') return 'vm';
    if (sandboxBackend === 'podman') return 'podman';
    return 'sandbox';
  }

  private ensureAgent(): AgentProcess {
    const mode = this.resolveMode();
    if (this.agent && this.agent.mode === mode) return this.agent;

    // Mode changed — clean up old agent
    if (this.agent) {
      void this.agent.exit();
    }

    this.agent = new AgentProcess({
      mode,
      ipcRawOutput: this.ipcRawOutput,
      onStatusChange: this.onStatusChange,
      fetchFn: this.fetchFn,
      platformClient: this.platformClient ?? undefined,
    });
    return this.agent;
  }

  getStatus = (): WithTimestamp<ChatProcessStatus> => {
    return this.agent?.getStatus() ?? { type: 'uninitialized', timestamp: Date.now() };
  };

  start = async (arg: ChatStartArg): Promise<void> => {
    this.lastStartArg = arg;
    const agent = this.ensureAgent();
    const startArg: AgentProcessStartArg = {
      workspaceDir: arg.workspaceDir,
      sandboxVariant: arg.sandboxVariant ?? this.getStoreData().sandboxVariant,
    };
    await agent.start(startArg);
  };

  stop = async (): Promise<void> => {
    if (!this.agent) return;
    await this.agent.stop();
  };

  rebuild = async (): Promise<void> => {
    if (!this.agent) return;
    const storeData = this.getStoreData();
    const fallbackArg: AgentProcessStartArg = {
      workspaceDir: this.lastStartArg?.workspaceDir ?? '',
      sandboxVariant: this.lastStartArg?.sandboxVariant ?? storeData.sandboxVariant,
    };
    await this.agent.rebuild(fallbackArg);
  };

  resizePty = (cols: number, rows: number): void => {
    this.agent?.resizePty(cols, rows);
  };

  exit = async (): Promise<void> => {
    if (!this.agent) return;
    await this.agent.exit();
  };
}

export const createChatManager = (arg: {
  ipc: IpcListener<IpcEvents>;
  sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
  fetchFn?: FetchFn;
  getStoreData?: () => ChatStoreData;
}) => {
  const { ipc, sendToWindow, fetchFn, getStoreData } = arg;

  const chatManager = new ChatManager({
    ipcRawOutput: (data) => {
      sendToWindow('chat-process:raw-output', data);
    },
    onStatusChange: (status) => {
      sendToWindow('chat-process:status', status);
    },
    fetchFn,
    getStoreData,
  });

  ipc.handle('chat-process:start', (_, startArg) => {
    chatManager.start(startArg);
  });
  ipc.handle('chat-process:stop', async () => {
    await chatManager.stop();
  });
  ipc.handle('chat-process:rebuild', async () => {
    await chatManager.rebuild();
  });
  ipc.handle('chat-process:resize', (_, cols, rows) => {
    chatManager.resizePty(cols, rows);
  });
  ipc.handle('chat-process:get-status', () => {
    return chatManager.getStatus();
  });

  const cleanupChatManager = async () => {
    await chatManager.exit();
    ipcMain.removeHandler('chat-process:start');
    ipcMain.removeHandler('chat-process:stop');
    ipcMain.removeHandler('chat-process:rebuild');
    ipcMain.removeHandler('chat-process:resize');
    ipcMain.removeHandler('chat-process:get-status');
  };

  return [chatManager, cleanupChatManager] as const;
};
