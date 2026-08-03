import { WebSocket } from 'ws';

import type { JsonRpcError, RpcMethodMap } from '@/generated/omniagents-gui-v1/gui-v1';
import { wsAuthOptions } from '@/lib/ws-auth';
import { initializeMainRpcConnection } from '@/main/omniagents-rpc-handshake';
import { OmniagentsRpcError } from '@/shared/omniagents-rpc';

const DEFAULT_TIMEOUT_MS = 30_000;
const CONTROL_OPERATIONS = [
  'agent_host_register_workspace',
  'agent_host_register_profile',
  'agent_host_bind_thread',
  'agent_host_list_resources',
  'agent_host_materialize_environment',
  'agent_host_stop_environment',
] as const;
type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Trusted main-process channel for AgentHost provisioning operations.
 *
 * The credential passed here is distinct from the renderer's bearer token.
 * It is held only by the launcher main process and resolves to an admin-role
 * principal inside OmniAgents, which is required because workspace
 * registration carries host filesystem paths.
 */
export class AgentHostControlClient {
  private socket: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();

  constructor(
    private readonly wsUrl: string,
    private readonly controlToken: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS
  ) {}

  async call<Method extends keyof RpcMethodMap>(
    method: Method,
    params: RpcMethodMap[Method]['params']
  ): Promise<RpcMethodMap[Method]['result']> {
    const socket = await this.ensureConnected();
    return this.sendRequest(socket, method, params);
  }

  private sendRequest<Method extends keyof RpcMethodMap>(
    socket: WebSocket,
    method: Method,
    params: RpcMethodMap[Method]['params']
  ): Promise<RpcMethodMap[Method]['result']> {
    const id = this.nextId++;
    return new Promise<RpcMethodMap[Method]['result']>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${String(method)} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), (error) => {
        if (!error) {
          return;
        }
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    this.connecting = null;
    this.rejectPending(new Error('AgentHost control connection closed'));
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close();
    }
  }

  private ensureConnected(): Promise<WebSocket> {
    if (this.connecting) {
      return this.connecting;
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      return Promise.resolve(this.socket);
    }
    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(this.wsUrl, wsAuthOptions(this.controlToken));
      this.socket = socket;
      let opened = false;
      const failConnect = (error: Error): void => {
        if (opened) {
          return;
        }
        this.connecting = null;
        reject(error);
      };
      socket.once('open', async () => {
        opened = true;
        try {
          await initializeMainRpcConnection({
            name: 'omni-desktop-agent-host-control',
            capabilities: { experimental_operations: [...CONTROL_OPERATIONS] },
            request: (method, params) => this.sendRequest(socket, method, params),
            notify: (method, params) =>
              new Promise<void>((resolveSend, rejectSend) => {
                socket.send(JSON.stringify({ jsonrpc: '2.0', method, params }), (error) => {
                  if (error) {
                    rejectSend(error);
                  } else {
                    resolveSend();
                  }
                });
              }),
          });
          this.connecting = null;
          resolve(socket);
        } catch (error) {
          this.socket = null;
          this.connecting = null;
          socket.close();
          reject(error as Error);
        }
      });
      socket.on('error', (error) => {
        if (!opened) {
          failConnect(error);
          return;
        }
        this.rejectPending(error);
      });
      socket.on('message', (raw) => this.handleMessage(raw));
      socket.on('close', () => {
        failConnect(new Error('AgentHost control connection closed before it opened'));
        if (this.socket === socket) {
          this.socket = null;
        }
        this.connecting = null;
        this.rejectPending(new Error('AgentHost control connection closed unexpectedly'));
      });
    });
    return this.connecting;
  }

  private handleMessage(raw: unknown): void {
    let message: unknown;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') {
      return;
    }
    const envelope = message as Record<string, unknown>;
    const id = envelope['id'];
    if (typeof id !== 'number') {
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const error = envelope['error'];
    if (error && typeof error === 'object') {
      pending.reject(new OmniagentsRpcError(error as JsonRpcError));
      return;
    }
    pending.resolve(envelope['result']);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
