import type { WebSocket } from 'ws';

import { uuidv4 } from '@/lib/uuid';
import type { IpcRendererEvents } from '@/shared/types';

type InvokeMessage = {
  type: 'invoke';
  id: number;
  channel: string;
  args: unknown[];
};

type ReverseResponseMessage = {
  type: 'reverse-response';
  id: number;
  result?: unknown;
  error?: string;
};

/** All client→server frames the dispatcher recognises. */
type InboundMessage = InvokeMessage | ReverseResponseMessage;

/** Default timeout for cloud→client reverse RPCs. Long enough to cover the
 *  slowest expected operation (sandbox start = ~25 s in the worst case for a
 *  cold image pull), short enough that a hung Electron doesn't wedge the
 *  cloud forever. Callers may override per-call. */
const DEFAULT_REVERSE_TIMEOUT_MS = 30_000;

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
 *
 * `ws` is the active WebSocket the invoke came in on — used by handlers that
 * need to bind a per-WS resource to the caller (e.g. `machine:register`
 * tracks which WS to dispatch reverse-RPCs to). `null` only inside cleanup
 * or when the underlying session is reattaching mid-flight.
 */
export type HandlerContext = {
  /** Data-scope key. In teams/cloud this is the active team id; else the principal/DEFAULT_TENANT. */
  tenantId: string;
  /** Authenticated identity. Equals tenantId in single-user/local mode; the EasyAuth principal in cloud. */
  principalId: string;
  /** EasyAuth display name resolved at connect time (cloud only) — how a
   *  named principal signs chat-v1 posts. Null when the IdP offered none. */
  displayName?: string | null;
  sessionId: string;
  ws: WebSocket | null;
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
  /** EasyAuth display name captured at connect (cloud only). */
  displayName?: string | null;
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
  expiry?: ReturnType<typeof setTimeout>;
};

export type DeliveryScope = { tenantId: string; principalId?: string };
type EventInterceptor = (channel: string, args: unknown[], scope?: DeliveryScope) => void;
type ResultWrapper = (result: unknown, args: unknown[], scope: DeliveryScope) => unknown;

/**
 * WebSocket handler that bridges JSON-RPC-like messages to handler functions,
 * mirroring Electron's ipc.handle() / sendToWindow() pattern.
 *
 * Supports two layers of handlers:
 * - Global handlers: shared across all clients (store, util, config)
 * - Per-session handlers: created per session, survive WebSocket reconnections
 *
 * Sessions survive a bounded reconnect grace period. When a client reconnects
 * with the same session ID, it reattaches to its existing managers/containers.
 */
type PendingReverse = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  /** Cancel the timeout when the response arrives. */
  cancel: () => void;
};

export class WsHandler {
  private globalHandlers = new Map<string, CtxHandler>();
  /** Active WebSocket → session ID mapping (for message routing) */
  private wsSessions = new Map<WebSocket, PersistentSession>();
  /** `${tenantId}\0${sessionId}` → persistent session (survives disconnections) */
  private persistentSessions = new Map<string, PersistentSession>();
  private eventInterceptors: EventInterceptor[] = [];
  private resultWrappers = new Map<string, ResultWrapper>();
  /** Per-WS pending reverse-RPC requests, keyed by the monotonic id we sent. */
  private pendingReverse = new WeakMap<WebSocket, Map<number, PendingReverse>>();
  /** Monotonic id source for outbound reverse-invokes. Per-WS would be neater
   *  but a single counter is fine — collisions matter only within one WS
   *  pending map, and the id space (Number.MAX_SAFE_INTEGER) is huge. */
  private nextReverseId = 1;
  private cleanupJobs = new Set<Promise<void>>();

  constructor(private readonly reconnectGraceMs = 60_000) {}

  private authorize?: (teamId: string, principalId: string) => Promise<boolean>;
  private outbound = new WeakMap<WebSocket, Promise<void>>();

  /** Teams mode installs a fresh membership check, never a cached grant. */
  setAuthorizer(authorize: (teamId: string, principalId: string) => Promise<boolean>): void {
    this.authorize = authorize;
  }

  async checkAccess(ws: WebSocket): Promise<boolean> {
    const session = this.wsSessions.get(ws);
    if (!session || session.ws !== ws || ws.readyState !== 1) {
      return false;
    }
    if (!this.authorize) {
      return true;
    }
    let allowed: boolean;
    try {
      allowed = await this.authorize(session.tenantId, session.principalId);
    } catch (error) {
      console.error('Session authorization unavailable:', error);
      ws.close(1011, 'Authorization unavailable');
      return false;
    }
    if (this.wsSessions.get(ws) !== session || session.ws !== ws || ws.readyState !== 1) {
      return false;
    }
    if (!allowed) {
      this.wsSessions.delete(ws);
      const key = `${session.tenantId}::${session.principalId}::${session.sessionId}`;
      if (this.persistentSessions.get(key) === session) {
        this.persistentSessions.delete(key);
      }
      clearTimeout(session.expiry);
      session.ws = null;
      this.cleanupSession(session);
      ws.close(4403, 'Team membership revoked');
    }
    return allowed;
  }

  /** Preserve per-socket event order while checking access before delivery. */
  private sendFrame(ws: WebSocket, message: string): void {
    if (!this.authorize) {
      if (ws.readyState === 1) {
        ws.send(message);
      }
      return;
    }
    const next = (this.outbound.get(ws) ?? Promise.resolve())
      .then(async () => {
        if (await this.checkAccess(ws)) {
          ws.send(message);
        }
      })
      .catch((error: unknown) => console.error('Socket delivery failed:', error));
    this.outbound.set(ws, next);
  }

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

  private runEventInterceptors(channel: string, args: unknown[], scope?: DeliveryScope): void {
    for (const interceptor of this.eventInterceptors) {
      interceptor(channel, args, scope);
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
        this.sendFrame(session.ws, message);
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
    this.runEventInterceptors(channel, wireArgs, { tenantId });
    const message = JSON.stringify({ type: 'event', channel, args: wireArgs });
    for (const session of this.wsSessions.values()) {
      if (session.tenantId === tenantId && session.ws && session.ws.readyState === 1 /* WebSocket.OPEN */) {
        this.sendFrame(session.ws, message);
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
    this.runEventInterceptors(channel, wireArgs, { tenantId: teamId, principalId });
    const message = JSON.stringify({ type: 'event', channel, args: wireArgs });
    for (const session of this.wsSessions.values()) {
      if (
        session.tenantId === teamId &&
        session.principalId === principalId &&
        session.ws &&
        session.ws.readyState === 1 /* WebSocket.OPEN */
      ) {
        this.sendFrame(session.ws, message);
      }
    }
  }

  /**
   * Send an event to a specific client.
   */
  sendTo<T extends keyof IpcRendererEvents>(ws: WebSocket, channel: T, ...args: IpcRendererEvents[T]): void {
    const wireArgs = structuredClone(args);
    this.runEventInterceptors(channel, wireArgs, this.wsSessions.get(ws));
    if (ws.readyState === 1 /* WebSocket.OPEN */) {
      this.sendFrame(ws, JSON.stringify({ type: 'event', channel, args: wireArgs }));
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
    principalId: string = tenantId,
    displayName?: string | null
  ): void {
    // Persistent sessions are keyed by tenant + principal + client sessionId so a
    // client can only ever reattach to its OWN (team, principal) session — a
    // guessed/reused sessionId resolves to a different key and starts fresh
    // instead of hijacking. Two members of one team don't collide, and one
    // principal switching teams gets a distinct session. Ids never contain "::".
    const persistentKey = sessionId ? `${tenantId}::${principalId}::${sessionId}` : undefined;
    const existingSession = persistentKey ? this.persistentSessions.get(persistentKey) : undefined;

    if (existingSession) {
      clearTimeout(existingSession.expiry);
      existingSession.expiry = undefined;
      // Reattach: close stale WS if any, then bind the new one
      if (existingSession.ws) {
        this.wsSessions.delete(existingSession.ws);
        existingSession.ws.close(1000, 'Session reattached');
      }
      existingSession.ws = ws;
      existingSession.ready = ready;
      if (displayName !== undefined) {
        existingSession.displayName = displayName;
      }
      this.wsSessions.set(ws, existingSession);
      console.log(`[ws-handler] Session ${existingSession.sessionId} reattached (tenant ${tenantId})`);
    } else {
      // New session
      const id = sessionId ?? uuidv4();
      const session: PersistentSession = {
        sessionId: id,
        tenantId,
        principalId,
        ...(displayName !== undefined ? { displayName } : {}),
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
        void gate
          .then(() => this.handleMessage(ws, raw))
          .catch((error: unknown) => {
            console.error('Session initialization failed:', error);
            ws.close(1011, 'Session initialization failed');
          });
      } else {
        void this.handleMessage(ws, raw);
      }
    });

    ws.on('close', () => {
      // Reject every in-flight reverse-RPC bound to this WS so the cloud
      // dispatcher fails fast instead of waiting on the configured timeout.
      const pending = this.pendingReverse.get(ws);
      if (pending) {
        for (const [, p] of pending) {
          p.cancel();
          p.reject(new Error('ws-closed'));
        }
        pending.clear();
        this.pendingReverse.delete(ws);
      }
      const session = this.wsSessions.get(ws);
      if (session) {
        // Preserve document resources briefly for a socket reconnect. A new
        // document has its own ID and must not retain these resources forever.
        if (session.ws === ws) {
          session.ws = null;
          const key = `${session.tenantId}::${session.principalId}::${session.sessionId}`;
          session.expiry = setTimeout(() => {
            if (session.ws || this.persistentSessions.get(key) !== session) {
              return;
            }
            this.persistentSessions.delete(key);
            this.cleanupSession(session);
          }, this.reconnectGraceMs);
          session.expiry.unref();
        }
        this.wsSessions.delete(ws);
        console.log(`[ws-handler] Session ${session.sessionId} detached (WS closed)`);
      }
    });
  }

  /**
   * Send a cloud→client reverse-invoke and resolve with the client's
   * reverse-response. Rejects on timeout, WS close mid-flight, or a non-`ok`
   * reverse-response error.
   *
   * Auth: the WS was already authenticated upstream (signed runtime token),
   * so the caller is responsible for verifying that `ws` is the right
   * machine's WS BEFORE invoking — e.g. through `MachineRegistry.getActiveWs`.
   */
  invokeOnWs<T = unknown>(
    ws: WebSocket,
    channel: string,
    args: unknown[],
    opts: { timeoutMs?: number } = {}
  ): Promise<T> {
    if (this.authorize) {
      return this.checkAccess(ws).then((allowed) => {
        if (!allowed) {
          throw new Error('Socket authorization denied');
        }
        return this.invokeAuthorized<T>(ws, channel, args, opts);
      });
    }
    return this.invokeAuthorized<T>(ws, channel, args, opts);
  }

  private invokeAuthorized<T>(
    ws: WebSocket,
    channel: string,
    args: unknown[],
    opts: { timeoutMs?: number }
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (ws.readyState !== 1 /* OPEN */) {
        reject(new Error('ws-not-open'));
        return;
      }
      const id = this.nextReverseId++;
      let map = this.pendingReverse.get(ws);
      if (!map) {
        map = new Map();
        this.pendingReverse.set(ws, map);
      }
      const timer = setTimeout(() => {
        const m = this.pendingReverse.get(ws);
        if (m?.delete(id)) {
          reject(new Error(`reverse-rpc timeout (${channel})`));
        }
      }, opts.timeoutMs ?? DEFAULT_REVERSE_TIMEOUT_MS);
      const pending: PendingReverse = {
        resolve: (v) => resolve(v as T),
        reject,
        cancel: () => clearTimeout(timer),
      };
      map.set(id, pending);
      try {
        ws.send(JSON.stringify({ type: 'reverse-invoke', id, channel, args }));
      } catch (err) {
        // Synchronous send-throw — clean up and surface.
        map.delete(id);
        pending.cancel();
        reject(err as Error);
      }
    });
  }

  /**
   * Clean up all persistent sessions. Called on server shutdown.
   */
  private cleanupSession(session: PersistentSession): void {
    const job = Promise.resolve()
      .then(() => session.cleanup?.())
      .catch((error: unknown) => {
        console.error('Error cleaning up session:', error);
      });
    this.cleanupJobs.add(job);
    void job.then(() => this.cleanupJobs.delete(job));
  }

  async cleanupAllSessions(): Promise<void> {
    const sessions = [...this.persistentSessions.values()];
    for (const session of sessions) {
      clearTimeout(session.expiry);
    }
    this.persistentSessions.clear();
    this.wsSessions.clear();
    for (const session of sessions) {
      this.cleanupSession(session);
    }
    await Promise.all(this.cleanupJobs);
  }

  private async handleMessage(ws: WebSocket, raw: unknown): Promise<void> {
    let msg: InboundMessage;
    try {
      msg = JSON.parse(String(raw)) as InboundMessage;
    } catch {
      return;
    }

    if (this.authorize && !(await this.checkAccess(ws))) {
      return;
    }

    // Client→cloud responses to a previously-sent reverse-invoke. Route to the
    // pending map and resolve / reject the awaiter.
    if (msg.type === 'reverse-response') {
      if (typeof msg.id !== 'number') {
        return;
      }
      const map = this.pendingReverse.get(ws);
      const pending = map?.get(msg.id);
      if (!pending) {
        return;
      } // late / unknown id — drop silently
      map!.delete(msg.id);
      pending.cancel();
      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (msg.type !== 'invoke' || typeof msg.id !== 'number' || typeof msg.channel !== 'string') {
      return;
    }

    // Check per-session handlers first, then fall back to global handlers
    const session = this.wsSessions.get(ws);
    // Replaced/closed sockets must never fall back to the local tenant. This
    // also rejects messages whose readiness gate completed after detachment.
    if (!session || session.ws !== ws) {
      return;
    }
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
      ...(session?.displayName !== undefined ? { displayName: session.displayName } : {}),
      sessionId: session?.sessionId ?? '',
      ws,
      sendToWindow: session?.sendToWindow ?? (() => {}),
    };

    try {
      let result = await handler(ctx, ...(msg.args ?? []));
      // Revocation may have happened while an asynchronous handler was running.
      // Leaving/deleting a team may acknowledge its own successful revocation;
      // those responses contain membership summaries, not the former team's data.
      const revokesSelf = msg.channel === 'team:leave' || msg.channel === 'team:delete';
      if (this.authorize && !revokesSelf && !(await this.checkAccess(ws))) {
        return;
      }
      const wrapper = this.resultWrappers.get(msg.channel);
      if (wrapper) {
        result = wrapper(structuredClone(result), msg.args ?? [], ctx);
      }
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'response', id: msg.id, result }));
      }
      if (this.authorize && revokesSelf) {
        void this.checkAccess(ws);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (this.authorize && !(await this.checkAccess(ws))) {
        return;
      }
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'response', id: msg.id, error }));
      }
    }
  }
}
