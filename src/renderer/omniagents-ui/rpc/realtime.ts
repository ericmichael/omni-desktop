import { withConnectTicket } from '@/renderer/omniagents-ui/rpc/ws-ticket';
import {
  classifyCloseCode,
  ConnectionClosedError,
  DEFAULT_LIFECYCLE_POLICY,
  type LifecyclePolicy,
  ReconnectController,
  RpcAbortError,
  RpcTimeoutError,
} from '@/shared/lifecycle';
import { OmniagentsRpcError } from '@/shared/omniagents-rpc';

type JSONRPCId = number | string;

type JSONRPCRequest = {
  jsonrpc: '2.0';
  id: JSONRPCId;
  method: string;
  params?: Record<string, unknown>;
};

type JSONRPCResponse = {
  jsonrpc: '2.0';
  id: JSONRPCId;
  result?: unknown;
  error?: { code?: number; message: string; data?: unknown };
};

type JSONRPCNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
};

export type RealtimeEventPayload = Record<string, unknown> | undefined;
type Listener = (payload: RealtimeEventPayload) => void;

export type RealtimeRequestOptions = {
  /** Per-call deadline. Omit for the policy default; null disables it. */
  timeoutMs?: number | null;
  /** Abort a long-running call without closing the realtime connection. */
  signal?: AbortSignal;
};

type PendingEntry = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

/**
 * JSON-RPC client for the realtime/voice channel.
 *
 * Realtime uses the same lifecycle contract as the main GUI connection:
 * whole-attempt connect deadlines, bounded RPC calls, structured close
 * errors, permanent close classification, and the standard jittered
 * reconnect budget.
 */
export class RealtimeRPCClient {
  private ws: WebSocket | null = null;
  private readonly reconnectController: ReconnectController;
  private nextId = 0;
  private pending = new Map<JSONRPCId, PendingEntry>();
  private listeners = new Map<string, Set<Listener>>();
  private closedByUser = false;
  private reconnecting = false;
  private generation = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private rejectReconnectWait: ((error: Error) => void) | null = null;

  constructor(
    private readonly url: string,
    private readonly token?: string,
    private readonly debug: boolean = false,
    private readonly policy: LifecyclePolicy = DEFAULT_LIFECYCLE_POLICY,
    random: () => number = Math.random
  ) {
    this.reconnectController = new ReconnectController(policy, random);
  }

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }
    this.closedByUser = false;
    this.reconnectController.recordSuccess();
    const generation = ++this.generation;
    await this.connectWithRetries(generation);
  }

  private async connectWithRetries(generation: number): Promise<void> {
    while (!this.closedByUser && generation === this.generation) {
      try {
        await this.connectOnce(generation);
        return;
      } catch (error) {
        if (this.closedByUser || generation !== this.generation) {
          throw new ConnectionClosedError('Connection closed by client', { permanent: true });
        }
        const closeError =
          error instanceof ConnectionClosedError
            ? error
            : new ConnectionClosedError((error as Error).message || 'Connection failed');
        const decision = this.reconnectController.recordFailure({ permanent: closeError.permanent });
        if (!decision.retry) {
          throw new ConnectionClosedError(closeError.message, {
            permanent: true,
            closeCode: closeError.closeCode,
            reason: closeError.reason,
          });
        }
        if (this.debug) {
          console.log(`[rpc] reconnecting in ${Math.round(decision.delayMs)}ms (attempt ${decision.attempt})`);
        }
        await this.waitForReconnect(decision.delayMs, generation);
      }
    }
    throw new ConnectionClosedError('Connection closed by client', { permanent: true });
  }

  private waitForReconnect(delayMs: number, generation: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.rejectReconnectWait = reject;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.rejectReconnectWait = null;
        if (this.closedByUser || generation !== this.generation) {
          reject(new ConnectionClosedError('Connection closed by client', { permanent: true }));
        } else {
          resolve();
        }
      }, delayMs);
    });
  }

  private async connectOnce(generation: number): Promise<void> {
    const deadline = Date.now() + this.policy.connectTimeoutMs;
    let wsUrl: string;
    try {
      wsUrl = await this.withDeadline(
        withConnectTicket(this.url, this.token),
        this.policy.connectTimeoutMs,
        new RpcTimeoutError('connect', this.policy.connectTimeoutMs)
      );
    } catch (error) {
      // Ticket exchange failures are credential failures and deterministic.
      // A deadline remains retryable because the credential was not rejected.
      if (error instanceof RpcTimeoutError) {
        throw error;
      }
      throw new ConnectionClosedError((error as Error).message || 'Authentication failed', { permanent: true });
    }

    if (this.closedByUser || generation !== this.generation) {
      throw new ConnectionClosedError('Connection closed by client', { permanent: true });
    }

    if (this.debug) {
      // Deliberately log the base URL, never the one-time ticket URL.
      console.log('[rpc] connect', this.url);
    }
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    const remainingMs = Math.max(1, deadline - Date.now());

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        ws.onopen = null;
        ws.onerror = null;
        ws.onclose = null;
        if (error) {
          if (this.ws === ws) {
            this.ws = null;
          }
          try {
            ws.close();
          } catch {}
          reject(error);
          return;
        }
        this.attachOpenSocket(ws, generation);
        this.reconnectController.recordSuccess();
        resolve();
      };
      const timer = setTimeout(() => {
        finish(new ConnectionClosedError(`Connect timed out after ${this.policy.connectTimeoutMs}ms`));
      }, remainingMs);
      ws.onopen = () => {
        if (this.debug) {
          console.log('[rpc] open');
        }
        finish();
      };
      ws.onerror = (event) => {
        if (this.debug) {
          console.error('[rpc] error', event);
        }
        finish(new ConnectionClosedError('WebSocket error'));
      };
      ws.onclose = (event) => {
        const permanent = classifyCloseCode(event.code) === 'permanent';
        const reason = event.reason || (permanent ? 'Connection rejected' : 'Connection closed during connect');
        finish(
          new ConnectionClosedError(reason, {
            permanent,
            closeCode: event.code,
            reason: event.reason,
          })
        );
      };
    });
  }

  private attachOpenSocket(ws: WebSocket, generation: number): void {
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string) as JSONRPCResponse | JSONRPCNotification;
        if (this.debug) {
          console.log('[rpc] recv', message);
        }
        if ('id' in message) {
          const pending = this.pending.get(message.id);
          if (!pending) {
            return;
          }
          this.pending.delete(message.id);
          pending.cleanup();
          if (message.error) {
            pending.reject(
              new OmniagentsRpcError({
                code: message.error.code ?? -32603,
                message: message.error.message,
                data: message.error.data,
              })
            );
          } else {
            pending.resolve(message.result);
          }
        } else {
          this.emit(message.method, message.params);
        }
      } catch (error) {
        if (this.debug) {
          console.error('[rpc] parse error', error);
        }
      }
    };
    ws.onerror = () => {
      // Browser WebSockets report the actionable close code through onclose.
    };
    ws.onclose = (event) => {
      if (this.ws !== ws || generation !== this.generation) {
        return;
      }
      this.ws = null;
      const error = new ConnectionClosedError(event.reason || 'Connection closed', {
        permanent: this.closedByUser || classifyCloseCode(event.code) === 'permanent',
        closeCode: event.code,
        reason: event.reason,
      });
      if (this.debug) {
        console.log('[rpc] close', event.code, event.reason);
      }
      this.rejectAllPending(error);
      if (!this.closedByUser && !error.permanent) {
        void this.reconnectAfterClose(generation);
      }
    };
  }

  private async reconnectAfterClose(generation: number): Promise<void> {
    if (this.reconnecting) {
      return;
    }
    this.reconnecting = true;
    try {
      // A live connection was lost, so the first reconnect is delayed too;
      // attempt 1 uses the canonical 500ms (plus configured jitter).
      const decision = this.reconnectController.recordFailure();
      if (!decision.retry) {
        return;
      }
      if (this.debug) {
        console.log(`[rpc] reconnecting in ${Math.round(decision.delayMs)}ms (attempt ${decision.attempt})`);
      }
      await this.waitForReconnect(decision.delayMs, generation);
      await this.connectWithRetries(generation);
      if (this.debug) {
        console.log('[rpc] reconnected');
      }
    } catch (error) {
      if (this.debug && !this.closedByUser) {
        console.error('[rpc] reconnect stopped', error);
      }
    } finally {
      this.reconnecting = false;
    }
  }

  private withDeadline<T>(promise: Promise<T>, timeoutMs: number, error: Error): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(error), timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (reason) => {
          clearTimeout(timer);
          reject(reason);
        }
      );
    });
  }

  private rejectAllPending(error: ConnectionClosedError): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      entry.cleanup();
      entry.reject(error);
    }
  }

  disconnect(): void {
    this.closedByUser = true;
    this.generation += 1;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectReconnectWait?.(new ConnectionClosedError('Connection closed by client', { permanent: true }));
    this.rejectReconnectWait = null;
    this.rejectAllPending(new ConnectionClosedError('Connection closed by client', { permanent: true }));
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      try {
        ws.close();
      } catch {}
    }
  }

  on(event: string, handler: Listener): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    const set = this.listeners.get(event)!;
    set.add(handler);
    return () => set.delete(handler);
  }

  private emit(event: string, payload: RealtimeEventPayload): void {
    const set = this.listeners.get(event);
    if (!set) {
      return;
    }
    for (const fn of set) {
      try {
        fn(payload);
      } catch {}
    }
  }

  request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options: RealtimeRequestOptions = {}
  ): Promise<T> {
    return this.call<T>(method, params, options);
  }

  private call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options: RealtimeRequestOptions = {}
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new ConnectionClosedError('WebSocket not connected', { permanent: this.closedByUser });
    }
    if (options.signal?.aborted) {
      throw new RpcAbortError(method);
    }
    const id = ++this.nextId;
    const request: JSONRPCRequest = { jsonrpc: '2.0', id, method, params };
    const timeoutMs = options.timeoutMs === undefined ? this.policy.rpcTimeoutMs : options.timeoutMs;
    const response = new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onAbort = (): void => {
        this.pending.delete(id);
        cleanup();
        reject(new RpcAbortError(method));
      };
      const cleanup = (): void => {
        if (timer !== null) {
          clearTimeout(timer);
        }
        options.signal?.removeEventListener('abort', onAbort);
      };
      if (timeoutMs !== null) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          cleanup();
          reject(new RpcTimeoutError(method, timeoutMs));
        }, timeoutMs);
      }
      options.signal?.addEventListener('abort', onAbort);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, cleanup });
    });
    try {
      this.ws.send(JSON.stringify(request));
    } catch (error) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      pending?.cleanup();
      pending?.reject(error as Error);
    }
    return response;
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new ConnectionClosedError('WebSocket not connected', { permanent: this.closedByUser });
    }
    const message: JSONRPCNotification = { jsonrpc: '2.0', method };
    if (params) {
      message.params = params;
    }
    if (this.debug) {
      console.log('[rpc] notify', method, params);
    }
    this.ws.send(JSON.stringify(message));
  }

  async capabilities(): Promise<{ enabled: boolean; kind?: string; agent_name?: string | null }> {
    return this.call('capabilities');
  }

  async startSession(sessionId?: string): Promise<{ session_id: string; run_id: string }> {
    const params: Record<string, unknown> = {};
    if (sessionId) {
      params.session_id = sessionId;
    }
    return this.call('start_session', params);
  }

  async stopSession(sessionId: string): Promise<boolean> {
    return this.call('stop_session', { session_id: sessionId });
  }

  async sendAudio(sessionId: string, audioBase64: string, commit?: boolean): Promise<boolean> {
    const params: Record<string, unknown> = { session_id: sessionId, audio_base64: audioBase64 };
    if (commit) {
      params.commit = true;
    }
    try {
      this.notify('send_audio', params);
      return true;
    } catch {
      return false;
    }
  }

  async sendText(sessionId: string, text: string): Promise<boolean> {
    return this.call('send_text', { session_id: sessionId, text });
  }

  async interrupt(sessionId: string): Promise<boolean> {
    return this.call('interrupt', { session_id: sessionId });
  }

  async clientResponse(requestId: string, ok: boolean, result?: Record<string, unknown>): Promise<boolean> {
    return this.call('client_response', { request_id: requestId, ok, result });
  }

  async toolApprovalResponse(
    callId: string,
    decision: 'approve' | 'reject',
    alwaysApprove: boolean = false,
    rejectionMessage?: string
  ): Promise<boolean> {
    const params: Record<string, unknown> = { call_id: callId, decision };
    if (alwaysApprove) {
      params.always_approve = true;
    }
    if (rejectionMessage) {
      params.rejection_message = rejectionMessage;
    }
    return this.call('tool_approval_response', params);
  }

  async mcpApprovalResponse(
    requestId: string,
    decision: 'approve' | 'reject',
    rejectionMessage?: string
  ): Promise<boolean> {
    const params: Record<string, unknown> = { request_id: requestId, decision };
    if (rejectionMessage) {
      params.rejection_message = rejectionMessage;
    }
    return this.call('mcp_approval_response', params);
  }
}
