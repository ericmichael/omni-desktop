import type { WebSocket } from 'ws';

import type { IpcRendererEvents } from '@/shared/types';

type InvokeMessage = {
  type: 'invoke';
  id: number;
  channel: string;
  args: unknown[];
};

type Handler = (...args: unknown[]) => unknown | Promise<unknown>;

type PersistentSession = {
  sessionId: string;
  ws: WebSocket | null;
  handlers: Map<string, Handler>;
  cleanup?: () => Promise<void>;
  sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
};

type EventInterceptor = (channel: string, args: unknown[]) => void;
type ResultWrapper = (result: unknown, args: unknown[]) => unknown;

/**
 * WebSocket handler that bridges JSON-RPC-like messages to handler functions,
 * mirroring Electron's ipc.handle() / sendToWindow() pattern.
 *
 * Supports two layers of handlers:
 * - Global handlers: shared across all clients (store, util, config)
 * - Per-session handlers: created per session, survive WebSocket reconnections
 *
 * Sessions persist until server restart. When a client disconnects and reconnects
 * with the same session ID, it reattaches to its existing managers/containers.
 */
export class WsHandler {
  private globalHandlers = new Map<string, Handler>();
  /** Active WebSocket → session ID mapping (for message routing) */
  private wsSessions = new Map<WebSocket, PersistentSession>();
  /** Session ID → persistent session (survives disconnections) */
  private persistentSessions = new Map<string, PersistentSession>();
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
    for (const session of this.wsSessions.values()) {
      if (session.ws && session.ws.readyState === 1 /* WebSocket.OPEN */) {
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
   *
   * If a sessionId is provided and a persistent session exists for it, the WebSocket
   * is reattached to the existing session (preserving managers/containers).
   * Otherwise a new session is created via the onConnect callback.
   */
  addClient(
    ws: WebSocket,
    onConnect?: (session: {
      handle: (channel: string, handler: Handler) => void;
      sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
      setCleanup: (cleanup: () => Promise<void>) => void;
    }) => void,
    sessionId?: string
  ): void {
    const existingSession = sessionId ? this.persistentSessions.get(sessionId) : undefined;

    if (existingSession) {
      // Reattach: close stale WS if any, then bind the new one
      if (existingSession.ws) {
        this.wsSessions.delete(existingSession.ws);
      }
      existingSession.ws = ws;
      this.wsSessions.set(ws, existingSession);
      console.log(`[ws-handler] Session ${sessionId} reattached`);
    } else {
      // New session
      const id = sessionId ?? crypto.randomUUID();
      const session: PersistentSession = {
        sessionId: id,
        ws,
        handlers: new Map(),
        sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => {
          // Always send to the session's current WS (follows reattachment)
          if (session.ws && session.ws.readyState === 1) {
            this.sendTo(session.ws, channel, ...args);
          }
        },
      };
      this.wsSessions.set(ws, session);
      this.persistentSessions.set(id, session);

      if (onConnect) {
        onConnect({
          handle: (channel, handler) => {
            session.handlers.set(channel, handler);
          },
          sendToWindow: session.sendToWindow,
          setCleanup: (cleanup) => {
            session.cleanup = cleanup;
          },
        });
      }
      console.log(`[ws-handler] New session ${id} created`);
    }

    ws.on('message', (raw) => {
      void this.handleMessage(ws, raw);
    });

    ws.on('close', () => {
      const session = this.wsSessions.get(ws);
      if (session) {
        // Only detach the WS — do NOT cleanup managers.
        // The session stays alive in persistentSessions for reconnection.
        if (session.ws === ws) {
          session.ws = null;
        }
        this.wsSessions.delete(ws);
        console.log(`[ws-handler] Session ${session.sessionId} detached (WS closed)`);
      }
    });
  }

  /**
   * Clean up all persistent sessions. Called on server shutdown.
   */
  async cleanupAllSessions(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.persistentSessions.values()]
        .filter((s) => s.cleanup)
        .map((s) => s.cleanup!())
    );
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason);
    if (errors.length > 0) {
      console.error('Error cleaning up sessions:', errors);
    }
    this.persistentSessions.clear();
    this.wsSessions.clear();
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
    const session = this.wsSessions.get(ws);
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
