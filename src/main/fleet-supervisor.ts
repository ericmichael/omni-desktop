import type { FleetSessionMessage, FleetSupervisorStatus, FleetTokenUsage } from '@/shared/types';

const SAFE_TOOL_OVERRIDES = { safe_tool_patterns: ['.*'] };
const WS_CONNECT_TIMEOUT_MS = 15_000;
const RPC_TIMEOUT_MS = 30_000;

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

export type FleetSupervisorOpts = {
  wsUrl: string;
  onStatusChange: (status: FleetSupervisorStatus) => void;
  onMessage: (msg: FleetSessionMessage) => void;
  onRunEnd: (reason: string) => void;
  onTokenUsage?: (usage: FleetTokenUsage) => void;
};

let rpcIdCounter = 0;
const nextRpcId = (): string => String(++rpcIdCounter);

/**
 * Manages a single supervisor session via WebSocket JSON-RPC.
 * Replaces FleetLoopController with a much simpler model — no iteration loops,
 * no sentinel detection, no nudge logic.
 */
export class FleetSupervisor {
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private runId: string | null = null;
  private status: FleetSupervisorStatus = 'idle';
  private opts: FleetSupervisorOpts;
  private pendingRpc = new Map<string, { resolve: (v: RpcResponse) => void; reject: (e: Error) => void }>();
  private disposed = false;
  private messageIdCounter = 0;

  setWsUrl(url: string): void {
    this.opts.wsUrl = url;
  }

  constructor(opts: FleetSupervisorOpts) {
    this.opts = opts;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getRunId(): string | null {
    return this.runId;
  }

  getStatus(): FleetSupervisorStatus {
    return this.status;
  }

  /**
   * Start a new supervisor run (first time or follow-up).
   * If sessionId is provided, continues an existing session.
   */
  async startRun(
    prompt: string,
    opts?: { sessionId?: string; variables?: Record<string, unknown> }
  ): Promise<{ sessionId: string; runId: string }> {
    if (this.disposed) {
      throw new Error('Supervisor has been disposed');
    }

    this.setStatus('running');

    // Connect WebSocket if not connected
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }

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
      this.setStatus('error');
      throw new Error(response.error.message ?? 'start_run RPC error');
    }

    const result = response.result as { session_id?: string; run_id?: string } | undefined;
    if (!result?.session_id) {
      this.setStatus('error');
      throw new Error('No session_id in start_run response');
    }

    this.sessionId = result.session_id;
    this.runId = result.run_id ?? result.session_id;

    return { sessionId: this.sessionId, runId: this.runId };
  }

  /**
   * Send a user message to the supervisor.
   * If running: uses send_user_message. If waiting: starts a new run continuing the session.
   */
  async sendMessage(message: string): Promise<void> {
    if (this.disposed) {
      throw new Error('Supervisor has been disposed');
    }

    if (this.status === 'idle' || this.status === 'error') {
      // Start a new run continuing the session
      await this.startRun(message, { sessionId: this.sessionId ?? undefined });
      return;
    }

    if (this.status === 'running' && this.runId) {
      // Inject message into running session
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        await this.connect();
      }

      const response = await this.sendRpc('send_user_message', {
        run_id: this.runId,
        content: message,
      });

      if (response.error) {
        console.warn(`send_user_message error: ${response.error.message}`);
      }
    }
  }

  /** Stop the current run. */
  async stop(): Promise<void> {
    if (this.runId && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        await this.sendRpc('stop_run', { run_id: this.runId });
      } catch {
        // Ignore stop errors
      }
    }

    this.runId = null;
    this.setStatus('idle');
  }

  /**
   * Create a new session via server_call → session.ensure (no user message sent).
   * Returns the new session ID and updates internal state.
   */
  async createSession(variables?: Record<string, unknown>): Promise<string> {
    if (this.disposed) {
      throw new Error('Supervisor has been disposed');
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }

    const args: Record<string, unknown> = {};
    if (variables) {
      args.variables = variables;
    }

    const response = await this.sendRpc('server_call', {
      function: 'session.ensure',
      args,
    });

    if (response.error) {
      throw new Error(response.error.message ?? 'session.ensure RPC error');
    }

    const result = response.result as { session_id?: string } | undefined;
    if (!result?.session_id) {
      throw new Error('No session_id in session.ensure response');
    }

    this.sessionId = result.session_id;
    this.runId = null;

    return this.sessionId;
  }

  /** Clean up WebSocket connection. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop();
    this.closeWs();
  }

  // --- Private ---

  private setStatus(status: FleetSupervisorStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.opts.onStatusChange(status);
    }
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('Supervisor disposed'));
        return;
      }

      this.closeWs();

      const ws = new WebSocket(this.opts.wsUrl);
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
        // Reject all pending RPCs
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

      // Notification (no id)
      if (parsed.method === 'run_end') {
        const reason = (parsed.params?.reason as string) ?? 'completed';
        this.runId = null;
        this.setStatus('idle');
        this.opts.onRunEnd(reason);
        return;
      }

      if (parsed.method === 'message_output') {
        const params = parsed.params as {
          content?: string;
          role?: string;
          tool_name?: string;
          usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
        } | undefined;
        if (params && params.content != null) {
          const role = params.role === 'user' ? 'user' : 'assistant';
          const msg: FleetSessionMessage = {
            id: ++this.messageIdCounter,
            role: params.tool_name ? 'tool_call' : role,
            content: params.content,
            toolName: params.tool_name,
            createdAt: new Date().toISOString(),
          };
          this.opts.onMessage(msg);
        }
        // Extract token usage if present
        if (params?.usage && this.opts.onTokenUsage) {
          this.opts.onTokenUsage({
            inputTokens: params.usage.input_tokens ?? 0,
            outputTokens: params.usage.output_tokens ?? 0,
            totalTokens: params.usage.total_tokens ?? 0,
          });
        }
      }

      // Handle token usage updates from dedicated events
      if (parsed.method === 'token_usage' || parsed.method === 'thread/tokenUsage/updated') {
        const params = parsed.params as {
          input_tokens?: number;
          output_tokens?: number;
          total_tokens?: number;
          total_token_usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
        } | undefined;
        if (params && this.opts.onTokenUsage) {
          const usage = params.total_token_usage ?? params;
          this.opts.onTokenUsage({
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            totalTokens: usage.total_tokens ?? 0,
          });
        }
      }
    } catch {
      // Ignore unparseable messages
    }
  }
}
