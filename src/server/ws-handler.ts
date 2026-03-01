import type { WebSocket } from 'ws';

import type { IpcRendererEvents } from '@/shared/types';

type InvokeMessage = {
  type: 'invoke';
  id: number;
  channel: string;
  args: unknown[];
};

type Handler = (...args: unknown[]) => unknown | Promise<unknown>;

/**
 * WebSocket handler that bridges JSON-RPC-like messages to handler functions,
 * mirroring Electron's ipc.handle() / sendToWindow() pattern.
 */
export class WsHandler {
  private handlers = new Map<string, Handler>();
  private clients = new Set<WebSocket>();

  /**
   * Register a handler for a channel (mirrors ipc.handle()).
   * The handler receives only the event args (no Electron event first arg).
   */
  handle(channel: string, handler: Handler): void {
    this.handlers.set(channel, handler);
  }

  /**
   * Remove a handler for a channel.
   */
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  /**
   * Send an event to all connected clients (mirrors sendToWindow()).
   */
  sendToClient<T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]): void {
    const message = JSON.stringify({ type: 'event', channel, args });
    for (const client of this.clients) {
      if (client.readyState === 1 /* WebSocket.OPEN */) {
        client.send(message);
      }
    }
  }

  /**
   * Register a new WebSocket client connection.
   */
  addClient(ws: WebSocket): void {
    this.clients.add(ws);

    ws.on('message', (raw) => {
      void this.handleMessage(ws, raw);
    });

    ws.on('close', () => {
      this.clients.delete(ws);
    });
  }

  private async handleMessage(ws: WebSocket, raw: unknown): Promise<void> {
    let msg: InvokeMessage;
    try {
      msg = JSON.parse(String(raw)) as InvokeMessage;
    } catch {
      return;
    }

    if (msg.type !== 'invoke' || typeof msg.id !== 'number' || typeof msg.channel !== 'string') {
      return;
    }

    const handler = this.handlers.get(msg.channel);
    if (!handler) {
      ws.send(JSON.stringify({ type: 'response', id: msg.id, error: `No handler for channel: ${msg.channel}` }));
      return;
    }

    try {
      const result = await handler(...(msg.args ?? []));
      ws.send(JSON.stringify({ type: 'response', id: msg.id, result }));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      ws.send(JSON.stringify({ type: 'response', id: msg.id, error }));
    }
  }
}
