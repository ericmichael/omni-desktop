import type { WebSocket } from 'ws';

import type { IpcRendererEvents } from '@/shared/types';

type InvokeMessage = {
  type: 'invoke';
  id: number;
  channel: string;
  args: unknown[];
};

/**
 * Fallback tenant for connections with no authenticated identity — i.e.
 * loopback / Tailscale / dev where EasyAuth isn't in front of the server.
 * Single-tenant mode collapses every connection onto this id, so behaviour
 * is identical to the pre-tenancy server.
 */
export const DEFAULT_TENANT = 'local';

/**
 * Per-invoke context handed to ctx-aware handlers. Carries the authenticated
 * tenant so a shared (global) handler can scope reads/writes and route events
 * back to only the caller's tenant via {@link WsHandler.sendToTenant}.
 * Server-mode managers receive this object in the Electron `event` slot.
 */
export type HandlerContext = {
  /** Data-scope key. In teams/cloud this is the active team id; else the principal/DEFAULT_TENANT. */
  tenantId: string;
  /** Authenticated identity. Equals tenantId in single-user/local mode; the EasyAuth principal in cloud. */
  principalId: string;
  sessionId: string;
  sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
};

/** Raw handler — receives wire args only (public {@link WsHandler.handle}). */
type Handler = (...args: unknown[]) => unknown | Promise<unknown>;
/** Ctx-aware handler — receives the {@link HandlerContext} as its first arg. */
type CtxHandler = (ctx: HandlerContext, ...args: unknown[]) => unknown | Promise<unknown>;

type PersistentSession = {
  sessionId: string;
  /** Data-scope key (active team id in cloud; else principal/DEFAULT_TENANT). */
  tenantId: string;
  /** Authenticated identity (EasyAuth principal; equals tenantId in single-user mode). */
  principalId: string;
  ws: WebSocket | null;
  handlers: Map<string, CtxHandler>;
  cleanup?: () => Promise<void>;
  sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
  /**
   * Resolves once the session's tenant is fully initialized. Invoke dispatch
   * waits on it so a message can't run against an unhydrated tenant — but the
   * `message` LISTENER is still attached synchronously, so nothing is dropped
   * while we wait.
   */
  ready?: Promise<void>;
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
  private globalHandlers = new Map<string, CtxHandler>();
  /** Active WebSocket → session ID mapping (for message routing) */
  private wsSessions = new Map<WebSocket, PersistentSession>();
  /** `${tenantId}\0${sessionId}` → persistent session (survives disconnections) */
  private persistentSessions = new Map<string, PersistentSession>();
  private eventInterceptors: EventInterceptor[] = [];
  private resultWrappers = new Map<string, ResultWrapper>();

  /**
   * Register a global handler for a channel (shared across all clients).
   * The handler receives wire args only; the per-invoke {@link HandlerContext}
   * is discarded. Used by tests and any caller that doesn't need the tenant.
   */
  handle(channel: string, handler: Handler): void {
    this.globalHandlers.set(channel, (_ctx, ...args) => handler(...args));
  }

  /**
   * Register a ctx-aware global handler. The handler receives the
   * {@link HandlerContext} (tenant + session) as its first argument, then the
   * wire args. {@link ServerIpcAdapter} uses this so managers get the context
   * in the Electron `event` slot.
   */
  handleCtx(channel: string, handler: CtxHandler): void {
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
   * Interceptors receive a structuredClone of the args, so mutations never affect
   * the caller's original objects (e.g. SandboxManager status used by readiness checks).
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
    const wireArgs = structuredClone(args);
    this.runEventInterceptors(channel, wireArgs);
    const message = JSON.stringify({ type: 'event', channel, args: wireArgs });
    for (const session of this.wsSessions.values()) {
      if (session.ws && session.ws.readyState === 1 /* WebSocket.OPEN */) {
        session.ws.send(message);
      }
    }
  }

  /**
   * Send an event to every connected client belonging to `tenantId`.
   * The tenant-scoped replacement for {@link sendToAll}: same fan-out, but
   * connections authenticated as a different tenant never receive the event.
   * Same-tenant multi-device (e.g. desktop + phone of one user) still both
   * receive it, so cross-device sync is preserved.
   */
  sendToTenant<T extends keyof IpcRendererEvents>(tenantId: string, channel: T, ...args: IpcRendererEvents[T]): void {
    const wireArgs = structuredClone(args);
    this.runEventInterceptors(channel, wireArgs);
    const message = JSON.stringify({ type: 'event', channel, args: wireArgs });
    for (const session of this.wsSessions.values()) {
      if (session.tenantId === tenantId && session.ws && session.ws.readyState === 1 /* WebSocket.OPEN */) {
        session.ws.send(message);
      }
    }
  }

  /**
   * Send an event to only one principal's sessions within a team. Used for
   * user-scoped store keys (codeTabs, activeTicketId, …) so one member's
   * personal/UI state never leaks to the rest of the team via `store:changed`.
   */
  sendToPrincipalInTeam<T extends keyof IpcRendererEvents>(
    teamId: string,
    principalId: string,
    channel: T,
    ...args: IpcRendererEvents[T]
  ): void {
    const wireArgs = structuredClone(args);
    this.runEventInterceptors(channel, wireArgs);
    const message = JSON.stringify({ type: 'event', channel, args: wireArgs });
    for (const session of this.wsSessions.values()) {
      if (
        session.tenantId === teamId &&
        session.principalId === principalId &&
        session.ws &&
        session.ws.readyState === 1 /* WebSocket.OPEN */
      ) {
        session.ws.send(message);
      }
    }
  }

  /**
   * Send an event to a specific client.
   */
  sendTo<T extends keyof IpcRendererEvents>(ws: WebSocket, channel: T, ...args: IpcRendererEvents[T]): void {
    const wireArgs = structuredClone(args);
    this.runEventInterceptors(channel, wireArgs);
    if (ws.readyState === 1 /* WebSocket.OPEN */) {
      ws.send(JSON.stringify({ type: 'event', channel, args: wireArgs }));
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
      handle: (channel: string, handler: CtxHandler) => void;
      sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
      setCleanup: (cleanup: () => Promise<void>) => void;
    }) => void,
    sessionId?: string,
    tenantId: string = DEFAULT_TENANT,
    ready?: Promise<void>,
    principalId: string = tenantId
  ): void {
    // Persistent sessions are keyed by tenant + principal + client sessionId so a
    // client can only ever reattach to its OWN (team, principal) session — a
    // guessed/reused sessionId resolves to a different key and starts fresh
    // instead of hijacking. Two members of one team don't collide, and one
    // principal switching teams gets a distinct session. Ids never contain "::".
    const persistentKey = sessionId ? `${tenantId}::${principalId}::${sessionId}` : undefined;
    const existingSession = persistentKey ? this.persistentSessions.get(persistentKey) : undefined;

    if (existingSession) {
      // Reattach: close stale WS if any, then bind the new one
      if (existingSession.ws) {
        this.wsSessions.delete(existingSession.ws);
      }
      existingSession.ws = ws;
      existingSession.ready = ready;
      this.wsSessions.set(ws, existingSession);
      console.log(`[ws-handler] Session ${existingSession.sessionId} reattached (tenant ${tenantId})`);
    } else {
      // New session
      const id = sessionId ?? crypto.randomUUID();
      const session: PersistentSession = {
        sessionId: id,
        tenantId,
        principalId,
        ws,
        handlers: new Map(),
        ready,
        sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => {
          // Always send to the session's current WS (follows reattachment)
          if (session.ws && session.ws.readyState === 1) {
            this.sendTo(session.ws, channel, ...args);
          }
        },
      };
      this.wsSessions.set(ws, session);
      this.persistentSessions.set(`${tenantId}::${principalId}::${id}`, session);

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
      console.log(`[ws-handler] New session ${id} created (tenant ${tenantId})`);
    }

    ws.on('message', (raw) => {
      // Gate dispatch on tenant readiness (preserves arrival order via the
      // microtask queue once resolved). The listener itself is attached
      // synchronously, so messages that arrive during init are not dropped.
      const gate = this.wsSessions.get(ws)?.ready;
      if (gate) {
        void gate.then(() => this.handleMessage(ws, raw));
      } else {
        void this.handleMessage(ws, raw);
      }
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
      [...this.persistentSessions.values()].filter((s) => s.cleanup).map((s) => s.cleanup!())
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

    // Per-invoke context — carries the authenticated tenant so global handlers
    // can scope their work and route events back to only this caller's tenant.
    const ctx: HandlerContext = {
      tenantId: session?.tenantId ?? DEFAULT_TENANT,
      principalId: session?.principalId ?? session?.tenantId ?? DEFAULT_TENANT,
      sessionId: session?.sessionId ?? '',
      sendToWindow: session?.sendToWindow ?? (() => {}),
    };

    try {
      let result = await handler(ctx, ...(msg.args ?? []));
      const wrapper = this.resultWrappers.get(msg.channel);
      if (wrapper) {
        result = wrapper(structuredClone(result), msg.args ?? []);
      }
      ws.send(JSON.stringify({ type: 'response', id: msg.id, result }));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      ws.send(JSON.stringify({ type: 'response', id: msg.id, error }));
    }
  }
}
