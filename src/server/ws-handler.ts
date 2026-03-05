import type { WebSocket } from 'ws';

import type { IpcRendererEvents } from '@/shared/types';

type InvokeMessage = {
  type: 'invoke';
  id: number;
  channel: string;
  args: unknown[];
};

type Handler = (...args: unknown[]) => unknown | Promise<unknown>;

type ClientSession = {
  ws: WebSocket;
  handlers: Map<string, Handler>;
  cleanup?: () => Promise<void>;
};

type EventInterceptor = (channel: string, args: unknown[]) => void;
type ResultWrapper = (result: unknown, args: unknown[]) => unknown;

/**
 * WebSocket handler that bridges JSON-RPC-like messages to handler functions,
 * mirroring Electron's ipc.handle() / sendToWindow() pattern.
 *
 * Supports two layers of handlers:
 * - Global handlers: shared across all clients (store, util, config)
 * - Per-session handlers: created per WebSocket connection (terminal, sandbox, etc.)
 */
export class WsHandler {
  private globalHandlers = new Map<string, Handler>();
  private sessions = new Map<WebSocket, ClientSession>();
  private eventInterceptors: EventInterceptor[] = [];
  private resultWrappers = new Map<string, ResultWrapper>();

  /**
   * Register a global handler for a channel (shared across all clients).
   */
  handle(channel: string, handler: Handler): void {
    this.globalHandlers.set(channel, handler);
  }

  /**
   * Remove a global handler for a channel.
   */
  removeHandler(channel: string): void {
    this.globalHandlers.delete(channel);
  }

  /**
   * Register an interceptor that runs before any event is sent (via sendTo or sendToAll).
   * The interceptor can mutate the args array in-place to transform event data.
   */
  addEventInterceptor(interceptor: EventInterceptor): void {
    this.eventInterceptors.push(interceptor);
  }

  /**
   * Register a wrapper that transforms the result of a handler for a given channel.
   * Applies to both global and per-session handlers.
   */
  addResultWrapper(channel: string, wrapper: ResultWrapper): void {
    this.resultWrappers.set(channel, wrapper);
  }

  private runEventInterceptors(channel: string, args: unknown[]): void {
    for (const interceptor of this.eventInterceptors) {
      interceptor(channel, args);
    }
  }

  /**
   * Send an event to all connected clients.
   */
  sendToAll<T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]): void {
    this.runEventInterceptors(channel, args);
    const message = JSON.stringify({ type: 'event', channel, args });
    for (const session of this.sessions.values()) {
      if (session.ws.readyState === 1 /* WebSocket.OPEN */) {
        session.ws.send(message);
      }
    }
  }

  /**
   * Send an event to a specific client.
   */
  sendTo<T extends keyof IpcRendererEvents>(ws: WebSocket, channel: T, ...args: IpcRendererEvents[T]): void {
    this.runEventInterceptors(channel, args);
    if (ws.readyState === 1 /* WebSocket.OPEN */) {
      ws.send(JSON.stringify({ type: 'event', channel, args }));
    }
  }

  /**
   * Keep backward compat — sendToClient now broadcasts to all.
   */
  sendToClient<T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]): void {
    this.sendToAll(channel, ...args);
  }

  /**
   * Register a new WebSocket client connection.
   * The onConnect callback receives per-session utilities for registering
   * handlers and sending events scoped to this client.
   */
  addClient(
    ws: WebSocket,
    onConnect?: (session: {
      handle: (channel: string, handler: Handler) => void;
      sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
      setCleanup: (cleanup: () => Promise<void>) => void;
    }) => void
  ): void {
    const session: ClientSession = {
      ws,
      handlers: new Map(),
    };
    this.sessions.set(ws, session);

    if (onConnect) {
      onConnect({
        handle: (channel, handler) => {
          session.handlers.set(channel, handler);
        },
        sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => {
          this.sendTo(ws, channel, ...args);
        },
        setCleanup: (cleanup) => {
          session.cleanup = cleanup;
        },
      });
    }

    ws.on('message', (raw) => {
      void this.handleMessage(ws, raw);
    });

    ws.on('close', () => {
      const s = this.sessions.get(ws);
      if (s?.cleanup) {
        void s.cleanup();
      }
      this.sessions.delete(ws);
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

    // Check per-session handlers first, then fall back to global handlers
    const session = this.sessions.get(ws);
    const handler = session?.handlers.get(msg.channel) ?? this.globalHandlers.get(msg.channel);

    if (!handler) {
      ws.send(JSON.stringify({ type: 'response', id: msg.id, error: `No handler for channel: ${msg.channel}` }));
      return;
    }

    try {
      let result = await handler(...(msg.args ?? []));
      const wrapper = this.resultWrappers.get(msg.channel);
      if (wrapper) {
        result = wrapper(result, msg.args ?? []);
      }
      ws.send(JSON.stringify({ type: 'response', id: msg.id, result }));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      ws.send(JSON.stringify({ type: 'response', id: msg.id, error }));
    }
  }
}
