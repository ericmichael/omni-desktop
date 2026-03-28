import type { FleetSessionMessage, FleetTicketId, FleetTokenUsage } from '@/shared/types';
import type { TicketPhase } from '@/shared/ticket-phase';
import { isValidTransition, isActivePhase, isStreamingPhase } from '@/shared/ticket-phase';

// --- Constants ---

const WS_CONNECT_TIMEOUT_MS = 15_000;
const RPC_TIMEOUT_MS = 30_000;
const SAFE_TOOL_OVERRIDES = { safe_tool_patterns: ['.*'] };

// --- JSON-RPC types ---

type RpcRequest = {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params: Record<string, unknown>;
};

type RpcResponse = {
  id?: string;
  result?: Record<string, unknown>;
  error?: { message?: string; code?: number };
};

type RpcNotification = {
  method?: string;
  params?: Record<string, unknown>;
};

// --- Callback types ---

export type ClientFunctionResponder = (ok: boolean, result?: Record<string, unknown>) => void;

export type TicketMachineCallbacks = {
  onPhaseChange: (ticketId: FleetTicketId, phase: TicketPhase) => void;
  onMessage: (ticketId: FleetTicketId, msg: FleetSessionMessage) => void;
  onRunEnd: (ticketId: FleetTicketId, reason: string) => void;
  onTokenUsage?: (ticketId: FleetTicketId, usage: FleetTokenUsage) => void;
  onClientRequest?: (
    ticketId: FleetTicketId,
    functionName: string,
    args: Record<string, unknown>,
    respond: ClientFunctionResponder
  ) => void;
};

// --- RPC ID counter ---

let rpcIdCounter = 0;
const nextRpcId = (): string => String(++rpcIdCounter);

/**
 * TicketMachine — single source of truth for a ticket's supervisor lifecycle.
 *
 * Owns:
 * - Phase state with enforced transitions
 * - WebSocket connection and JSON-RPC communication
 * - Session and run IDs
 * - Last activity timestamp (for stall detection)
 * - Retry timer and attempt/turn counters
 * - Async mutex to serialize operations
 *
 * Does NOT own:
 * - SandboxManager (passed in after provisioning)
 * - Ticket CRUD, pipeline logic, prompt building (FleetManager)
 */
export class TicketMachine {
  readonly ticketId: FleetTicketId;

  private phase: TicketPhase = 'idle';
  private wsUrl: string = '';
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private runId: string | null = null;
  private pendingRpc = new Map<string, { resolve: (v: RpcResponse) => void; reject: (e: Error) => void }>();
  private messageIdCounter = 0;

  // Retry/continuation state
  retryAttempt = 0;
  continuationTurn = 0;
  retryTimer: ReturnType<typeof setTimeout> | null = null;

  // Stall detection
  lastActivity: number = Date.now();

  // Callbacks
  private callbacks: TicketMachineCallbacks;

  // Async operation mutex
  private opLock: Promise<void> = Promise.resolve();

  constructor(ticketId: FleetTicketId, callbacks: TicketMachineCallbacks) {
    this.ticketId = ticketId;
    this.callbacks = callbacks;
  }

  // --- Public getters ---

  getPhase(): TicketPhase {
    return this.phase;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getRunId(): string | null {
    return this.runId;
  }

  isActive(): boolean {
    return isActivePhase(this.phase);
  }

  isStreaming(): boolean {
    return isStreamingPhase(this.phase);
  }

  // --- Phase transitions ---

  /**
   * Transition to a new phase. Throws if the transition is invalid.
   * Broadcasts the phase change to the callback.
   */
  transition(to: TicketPhase): void {
    if (this.phase === to) return;
    if (!isValidTransition(this.phase, to)) {
      console.warn(
        `[TicketMachine] Invalid transition for ${this.ticketId}: ${this.phase} → ${to}. Ignoring.`
      );
      return;
    }
    const from = this.phase;
    this.phase = to;
    console.log(`[TicketMachine] ${this.ticketId}: ${from} → ${to}`);
    this.callbacks.onPhaseChange(this.ticketId, to);
  }

  /**
   * Force-set phase without transition validation (for recovery/reset only).
   */
  forcePhase(phase: TicketPhase): void {
    this.phase = phase;
    this.callbacks.onPhaseChange(this.ticketId, phase);
  }

  // --- Serialized operations ---

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opLock.then(fn, fn);
    this.opLock = next.then(
      () => {},
      () => {}
    );
    return next;
  }

  // --- WebSocket management ---

  setWsUrl(url: string): void {
    this.wsUrl = url;
  }

  /**
   * Connect the WebSocket. Transitions to 'connecting'.
   * Called internally by provision flow or when starting a run.
   */
  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.phase === 'idle' || this.phase === 'error' || this.phase === 'completed') {
        reject(new Error(`Cannot connect in phase ${this.phase}`));
        return;
      }

      this.closeWs();

      const ws = new WebSocket(this.wsUrl);
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          ws.close();
          reject(new Error('WebSocket connect timeout'));
        }
      }, WS_CONNECT_TIMEOUT_MS);

      ws.addEventListener('open', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.ws = ws;
          resolve();
        }
      });

      ws.addEventListener('message', (event) => {
        this.handleMessage(String(event.data));
      });

      ws.addEventListener('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`WebSocket error: ${(err as ErrorEvent).message ?? 'unknown'}`));
        }
      });

      ws.addEventListener('close', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('WebSocket closed before connection'));
        }
        for (const [id, pending] of this.pendingRpc) {
          pending.reject(new Error('WebSocket closed'));
          this.pendingRpc.delete(id);
        }
      });
    });
  }

  private closeWs(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore
      }
      this.ws = null;
    }
  }

  private async ensureWs(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }
  }

  // --- JSON-RPC ---

  private sendRpc(method: string, params: Record<string, unknown>): Promise<RpcResponse> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const id = nextRpcId();
      const request: RpcRequest = { jsonrpc: '2.0', id, method, params };

      const timer = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error(`RPC ${method} timed out`));
      }, RPC_TIMEOUT_MS);

      this.pendingRpc.set(id, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.ws.send(JSON.stringify(request));
    });
  }

  private handleMessage(data: string): void {
    try {
      const parsed = JSON.parse(data) as RpcResponse & RpcNotification;

      // RPC response (has id)
      if (parsed.id) {
        const pending = this.pendingRpc.get(parsed.id);
        if (pending) {
          this.pendingRpc.delete(parsed.id);
          pending.resolve(parsed as RpcResponse);
        }
        return;
      }

      // Notification: run_end
      if (parsed.method === 'run_end') {
        const reason = (parsed.params?.end_reason as string) ?? 'completed';
        this.runId = null;
        // Don't set phase here — let FleetManager decide what comes next
        // (continue, retry, complete, or error) via the onRunEnd callback
        this.callbacks.onRunEnd(this.ticketId, reason);
        return;
      }

      // Notification: message_output
      if (parsed.method === 'message_output') {
        const params = parsed.params as {
          content?: string;
          role?: string;
          tool_name?: string;
          usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
        } | undefined;
        if (params && params.content != null) {
          this.recordActivity();
          const role = params.role === 'user' ? 'user' : 'assistant';
          const msg: FleetSessionMessage = {
            id: ++this.messageIdCounter,
            role: params.tool_name ? 'tool_call' : role,
            content: params.content,
            toolName: params.tool_name,
            createdAt: new Date().toISOString(),
          };
          this.callbacks.onMessage(this.ticketId, msg);
        }
        if (params?.usage && this.callbacks.onTokenUsage) {
          this.callbacks.onTokenUsage(this.ticketId, {
            inputTokens: params.usage.input_tokens ?? 0,
            outputTokens: params.usage.output_tokens ?? 0,
            totalTokens: params.usage.total_tokens ?? 0,
          });
        }
      }

      // Notification: token_usage
      if (parsed.method === 'token_usage' || parsed.method === 'thread/tokenUsage/updated') {
        const params = parsed.params as {
          input_tokens?: number;
          output_tokens?: number;
          total_tokens?: number;
          total_token_usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
        } | undefined;
        if (params && this.callbacks.onTokenUsage) {
          const usage = params.total_token_usage ?? params;
          this.callbacks.onTokenUsage(this.ticketId, {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            totalTokens: usage.total_tokens ?? 0,
          });
        }
      }

      // Notification: client_request (agent calling a client function)
      if (parsed.method === 'client_request') {
        const params = parsed.params as {
          function?: string;
          request_id?: string;
          args?: Record<string, unknown>;
        } | undefined;
        if (params?.function && params?.request_id && this.callbacks.onClientRequest) {
          const requestId = params.request_id;
          const respond: ClientFunctionResponder = (ok, result) => {
            void this.sendRpc('client_response', { request_id: requestId, ok, result }).catch(() => {});
          };
          this.callbacks.onClientRequest(this.ticketId, params.function, params.args ?? {}, respond);
        }
      }
    } catch {
      // Ignore unparseable messages
    }
  }

  // --- Core operations (all serialized) ---

  /**
   * Create a session via session.ensure RPC.
   * Transitions: connecting → session_creating → ready
   */
  createSession(variables?: Record<string, unknown>): Promise<string> {
    return this.serialize(async () => {
      this.transition('connecting');
      await this.ensureWs();

      this.transition('session_creating');
      const args: Record<string, unknown> = {
        safe_tool_overrides: SAFE_TOOL_OVERRIDES,
      };
      if (variables) {
        args.variables = variables;
      }

      const response = await this.sendRpc('server_call', {
        function: 'session.ensure',
        args,
      });

      if (response.error) {
        this.transition('error');
        throw new Error(response.error.message ?? 'session.ensure RPC error');
      }

      const result = response.result as { session_id?: string } | undefined;
      if (!result?.session_id) {
        this.transition('error');
        throw new Error('No session_id in session.ensure response');
      }

      this.sessionId = result.session_id;
      this.runId = null;

      this.transition('ready');

      return this.sessionId;
    });
  }

  /**
   * Start a new run. Connects WS if needed and sends start_run RPC.
   * Transitions: (current) → running
   */
  startRun(
    prompt: string,
    opts?: { sessionId?: string; variables?: Record<string, unknown> }
  ): Promise<{ sessionId: string; runId: string }> {
    return this.serialize(async () => {
      // Allow starting from ready, continuing, retrying, or awaiting_input
      if (this.phase === 'ready' || this.phase === 'continuing' || this.phase === 'retrying' || this.phase === 'awaiting_input') {
        this.transition('running');
      } else if (this.phase !== 'running') {
        throw new Error(`Cannot start run in phase ${this.phase}`);
      }

      await this.ensureWs();

      const params: Record<string, unknown> = {
        prompt,
        safe_tool_overrides: SAFE_TOOL_OVERRIDES,
      };
      if (opts?.sessionId) {
        params.session_id = opts.sessionId;
      }
      if (opts?.variables) {
        params.variables = opts.variables;
      }

      const response = await this.sendRpc('start_run', params);

      if (response.error) {
        this.transition('error');
        throw new Error(response.error.message ?? 'start_run RPC error');
      }

      const result = response.result as { session_id?: string; run_id?: string } | undefined;
      if (!result?.session_id) {
        this.transition('error');
        throw new Error('No session_id in start_run response');
      }

      this.sessionId = result.session_id;
      this.runId = result.run_id ?? result.session_id;
      this.recordActivity();

      return { sessionId: this.sessionId, runId: this.runId };
    });
  }

  /**
   * Send a user message into a running session.
   */
  async sendMessage(message: string): Promise<void> {
    if (this.phase === 'running' && this.runId) {
      await this.ensureWs();
      const response = await this.sendRpc('send_user_message', {
        run_id: this.runId,
        content: message,
      });
      if (response.error) {
        console.warn(`[TicketMachine] send_user_message error: ${response.error.message}`);
      }
    }
  }

  /**
   * Stop the current run. Transitions to idle.
   */
  async stop(): Promise<void> {
    this.cancelRetryTimer();

    if (this.runId && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        await this.sendRpc('stop_run', { run_id: this.runId });
      } catch {
        // Ignore stop errors
      }
    }

    this.runId = null;
    if (this.phase !== 'idle') {
      this.transition('idle');
    }
  }

  /**
   * Full cleanup — stop run, close WebSocket.
   * Does NOT dispose the sandbox (FleetManager owns that).
   */
  async dispose(): Promise<void> {
    this.cancelRetryTimer();

    if (this.runId && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        await this.sendRpc('stop_run', { run_id: this.runId });
      } catch {
        // Ignore
      }
    }

    this.runId = null;
    this.closeWs();

    if (this.phase !== 'idle') {
      this.forcePhase('idle');
    }
  }

  // --- Retry timer management ---

  scheduleRetryTimer(delayMs: number, callback: () => void): void {
    this.cancelRetryTimer();
    this.transition('retrying');
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      callback();
    }, delayMs);
  }

  cancelRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  // --- Activity tracking ---

  recordActivity(): void {
    this.lastActivity = Date.now();
  }

  getLastActivity(): number {
    return this.lastActivity;
  }

  // --- State for continuation/retry ---

  resetCounters(): void {
    this.retryAttempt = 0;
    this.continuationTurn = 0;
  }
}
