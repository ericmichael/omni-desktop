/**
 * Standard connection-lifecycle policy shared by all maintained OmniAgents
 * GUI clients, ported into the launcher for its own WebSocket transports.
 *
 * Source of truth: `omniagents/rpc/lifecycle.py` and its byte-identical
 * TypeScript twins at `omniagents/backends/web/ui/src/rpc/lifecycle.ts` and
 * `omniagents/backends/ink/tui/src/rpc/lifecycle.ts` (omniagents PR #293).
 * This file is a launcher-style port (formatting only) — the policy values,
 * classification tables, and backoff math must match the upstream module.
 * If a default changes upstream, change it here too.
 *
 * See `omniagents/rpc/protocol.md` §"Connection Lifecycle" for the normative
 * policy, including idempotency guidance for retries.
 */

export type FailureClass = 'retryable' | 'permanent' | 'indeterminate';

export interface LifecyclePolicy {
  /** Max time (ms) to establish transport + finish the initialize handshake. */
  connectTimeoutMs: number;
  /** Default deadline (ms) for a single JSON-RPC round trip. */
  rpcTimeoutMs: number;
  /** WebSocket ping cadence (ms). */
  pingIntervalMs: number;
  /** How long (ms) to wait for the pong before declaring the link dead. */
  pingTimeoutMs: number;
  /** First reconnect delay (ms). */
  reconnectInitialDelayMs: number;
  /** Exponential multiplier applied per attempt. */
  reconnectMultiplier: number;
  /** Ceiling (ms) on the per-attempt delay. */
  reconnectMaxDelayMs: number;
  /** Symmetric jitter fraction applied to each delay (0.1 = ±10%). */
  reconnectJitter: number;
  /** Give up (permanent failure) after this many consecutive failures. */
  reconnectMaxAttempts: number;
}

export const DEFAULT_LIFECYCLE_POLICY: LifecyclePolicy = {
  connectTimeoutMs: 10000,
  rpcTimeoutMs: 60000,
  pingIntervalMs: 20000,
  pingTimeoutMs: 10000,
  reconnectInitialDelayMs: 500,
  reconnectMultiplier: 2.0,
  reconnectMaxDelayMs: 30000,
  reconnectJitter: 0.1,
  reconnectMaxAttempts: 10,
};

/**
 * JSON-RPC error codes a client must NEVER retry: resending the same
 * request will fail the same way. Covers malformed/invalid requests and the
 * typed handshake errors of the GUI protocol initialize flow.
 */
export const PERMANENT_RPC_ERROR_CODES: ReadonlySet<number> = new Set([
  -32700, // ParseError
  -32600, // InvalidRequest
  -32601, // MethodNotFound
  -32602, // InvalidParams
  -32010, // InitializationRequired
  -32011, // AlreadyInitialized
  -32012, // ProtocolVersionMismatch
  -32013, // CapabilityMismatch
]);

/**
 * JSON-RPC error codes signalling a transient condition. Retry is safe for
 * idempotent methods (honor `data.retry_after_ms` when present).
 */
export const RETRYABLE_RPC_ERROR_CODES: ReadonlySet<number> = new Set([
  -32020, // TransportOverloaded
]);

/** Close code: no/invalid credentials. Terminal — obtain new credentials. */
export const WS_CLOSE_UNAUTHENTICATED = 4401;

/** Close code: authenticated but not permitted to use the resource. */
export const WS_CLOSE_FORBIDDEN = 4403;

/**
 * WebSocket close codes that must terminate the connection permanently
 * (no reconnect). 4401/4403 are the server's authentication and
 * authorization rejections and 4404 its feature-not-available rejection —
 * all deterministic, so retrying loops forever without ever succeeding.
 */
export const PERMANENT_CLOSE_CODES: ReadonlySet<number> = new Set([
  1002, // protocol error
  1003, // unsupported data
  1008, // policy violation
  4400, // bad request (reserved)
  4401, // authentication required / credentials rejected
  4403, // authorization failed
  4404, // feature not available on this server
]);

/**
 * Classify a JSON-RPC error code for retry purposes. `indeterminate` codes
 * (e.g. -32603 InternalError, application codes) must be surfaced to the
 * caller rather than auto-retried.
 */
export function classifyRpcErrorCode(code: number): FailureClass {
  if (PERMANENT_RPC_ERROR_CODES.has(code)) {
    return 'permanent';
  }
  if (RETRYABLE_RPC_ERROR_CODES.has(code)) {
    return 'retryable';
  }
  return 'indeterminate';
}

/**
 * Classify a WebSocket close code. Any 44xx application close code is
 * permanent — that range is reserved for deterministic server rejections
 * (auth, missing feature). Everything else (1000/1001/1006/1011/1012/1013,
 * or no code) is retryable: the next attempt may land on a healthy server.
 */
export function classifyCloseCode(code: number | null | undefined): FailureClass {
  if (code == null) {
    return 'retryable';
  }
  if (PERMANENT_CLOSE_CODES.has(code) || (code >= 4400 && code <= 4499)) {
    return 'permanent';
  }
  return 'retryable';
}

/**
 * Delay (ms) before reconnect attempt `attempt` (1-based): exponential
 * backoff with a ceiling and symmetric jitter,
 * `min(initial * multiplier**(attempt-1), max) * (1 ± jitter)`.
 */
export function reconnectDelayMs(policy: LifecyclePolicy, attempt: number, random: () => number = Math.random): number {
  const n = attempt < 1 ? 1 : attempt;
  let base = policy.reconnectInitialDelayMs * Math.pow(policy.reconnectMultiplier, n - 1);
  base = Math.min(base, policy.reconnectMaxDelayMs);
  if (policy.reconnectJitter <= 0) {
    return base;
  }
  const spread = policy.reconnectJitter * base;
  return base - spread + random() * 2 * spread;
}

/**
 * The connection closed while (or before) a call was outstanding. Every
 * pending call is rejected with this error when the connection is lost —
 * no promise may remain unresolved after a disconnect.
 */
export class ConnectionClosedError extends Error {
  /** True when the close is terminal and the client will not reconnect. */
  readonly permanent: boolean;
  readonly closeCode?: number;
  readonly reason?: string;

  constructor(message = 'Connection closed', opts: { permanent?: boolean; closeCode?: number; reason?: string } = {}) {
    super(message);
    this.name = 'ConnectionClosedError';
    this.permanent = opts.permanent ?? false;
    this.closeCode = opts.closeCode;
    this.reason = opts.reason;
  }
}

/** A JSON-RPC call did not complete within its deadline. */
export class RpcTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`RPC call '${method}' timed out after ${timeoutMs}ms`);
    this.name = 'RpcTimeoutError';
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

/** A JSON-RPC call was aborted by its AbortSignal before completing. */
export class RpcAbortError extends Error {
  readonly method: string;

  constructor(method: string) {
    super(`RPC call '${method}' was aborted`);
    this.name = 'RpcAbortError';
    this.method = method;
  }
}

/** Connection state reported to UIs so they can distinguish retryable from terminal failures. */
export type ConnectionState =
  | { state: 'connecting' }
  | { state: 'connected' }
  | { state: 'reconnecting'; attempt: number; delayMs: number }
  | { state: 'closed'; permanent: boolean; closeCode?: number; reason?: string };

export interface ReconnectDecision {
  retry: boolean;
  delayMs: number;
  attempt: number;
  permanent: boolean;
}

/**
 * Pure state machine driving policy-compliant reconnect loops. Owns nothing
 * but counters — callers perform the actual connect and scheduling. Resume
 * semantics after a successful reconnect are intentionally out of scope
 * (pluggable by the caller).
 */
export class ReconnectController {
  private attemptCount = 0;

  constructor(
    private readonly policy: LifecyclePolicy = DEFAULT_LIFECYCLE_POLICY,
    private readonly random: () => number = Math.random
  ) {}

  get attempts(): number {
    return this.attemptCount;
  }

  /** Reset the failure counter after a healthy connection. */
  recordSuccess(): void {
    this.attemptCount = 0;
  }

  /** Register a failed attempt and decide whether to retry. */
  recordFailure(opts: { permanent?: boolean } = {}): ReconnectDecision {
    this.attemptCount += 1;
    const exhausted = this.attemptCount >= this.policy.reconnectMaxAttempts;
    if (opts.permanent || exhausted) {
      return { retry: false, delayMs: 0, attempt: this.attemptCount, permanent: true };
    }
    return {
      retry: true,
      delayMs: reconnectDelayMs(this.policy, this.attemptCount, this.random),
      attempt: this.attemptCount,
      permanent: false,
    };
  }
}
