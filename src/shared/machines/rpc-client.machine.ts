/**
 * XState v5 machine for JSON-RPC WebSocket client lifecycle.
 *
 * Manages: connection, reconnection with exponential backoff,
 * per-call timeouts, and pending-queue limits.
 *
 * This is a pure machine definition — no DOM or Node imports.
 * The actual WebSocket is injected via the `actors` option at creation time.
 */
import { type ActorRefFrom, assign, setup } from 'xstate';

import { classifyCloseCode, DEFAULT_LIFECYCLE_POLICY, reconnectDelayMs } from '@/shared/lifecycle';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RPC_CALL_TIMEOUT_MS = DEFAULT_LIFECYCLE_POLICY.rpcTimeoutMs;
export const WS_CONNECT_TIMEOUT_MS = DEFAULT_LIFECYCLE_POLICY.connectTimeoutMs;
export const MAX_PENDING_CALLS = 100;
export const INITIAL_RECONNECT_DELAY_MS = DEFAULT_LIFECYCLE_POLICY.reconnectInitialDelayMs;
export const MAX_RECONNECT_DELAY_MS = DEFAULT_LIFECYCLE_POLICY.reconnectMaxDelayMs;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RPCCallId = number;

export type PendingCall = {
  id: RPCCallId;
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type JSONRPCNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
};

export type ServerEvent = JSONRPCNotification;

// ---------------------------------------------------------------------------
// Machine input & context
// ---------------------------------------------------------------------------

export type RPCClientInput = {
  url: string;
  token?: string;
};

export type RPCClientContext = {
  url: string;
  token: string | undefined;
  reconnectAttempt: number;
  reconnectDelay: number;
  nextCallId: number;
  /** Pending RPC calls — managed externally via the class wrapper. */
  pendingCount: number;
  error: string | null;
  /** Whether the last failure is terminal and requires explicit user action. */
  permanent: boolean;
  closeCode: number | undefined;
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type RPCClientEvent =
  | { type: 'CONNECT' }
  | { type: 'DISCONNECT' }
  | { type: 'WS_OPEN' }
  | { type: 'WS_CLOSE'; code?: number; reason?: string }
  | { type: 'WS_ERROR'; error: string; permanent?: boolean }
  | { type: 'CALL_STARTED' }
  | { type: 'CALL_SETTLED' }
  | { type: 'RETRY' };

// ---------------------------------------------------------------------------
// Machine definition
// ---------------------------------------------------------------------------

export const rpcClientMachine = setup({
  types: {
    context: {} as RPCClientContext,
    events: {} as RPCClientEvent,
    input: {} as RPCClientInput,
  },
  delays: {
    reconnectDelay: ({ context }: { context: RPCClientContext }) => context.reconnectDelay,
  },
  guards: {
    isPermanentFailure: ({ event }) =>
      (event.type === 'WS_CLOSE' && classifyCloseCode(event.code) === 'permanent') ||
      (event.type === 'WS_ERROR' && event.permanent === true),
  },
  actions: {
    incrementReconnect: assign({
      reconnectAttempt: ({ context }) => context.reconnectAttempt + 1,
      reconnectDelay: ({ context }) =>
        Math.round(reconnectDelayMs(DEFAULT_LIFECYCLE_POLICY, context.reconnectAttempt + 1)),
    }),
    resetReconnect: assign({
      reconnectAttempt: 0,
      reconnectDelay: INITIAL_RECONNECT_DELAY_MS,
    }),
    setError: assign({
      error: (_, params: { error: string }) => params.error,
    }),
    clearError: assign({ error: null, permanent: false, closeCode: undefined }),
    setPermanentFailure: assign({
      error: ({ event }) => {
        if (event.type === 'WS_CLOSE') {
          return event.reason || 'Connection closed permanently';
        }
        if (event.type === 'WS_ERROR') {
          return event.error;
        }
        return 'Connection closed permanently';
      },
      permanent: true,
      closeCode: ({ event }) => (event.type === 'WS_CLOSE' ? event.code : undefined),
    }),
    incrementPending: assign({
      pendingCount: ({ context }) => context.pendingCount + 1,
    }),
    decrementPending: assign({
      pendingCount: ({ context }) => Math.max(0, context.pendingCount - 1),
    }),
    /** No-op — used for idempotent events from stale sockets. */
    noop: () => {},
  },
}).createMachine({
  id: 'rpcClient',
  initial: 'disconnected',
  context: ({ input }) => ({
    url: input.url,
    token: input.token,
    reconnectAttempt: 0,
    reconnectDelay: INITIAL_RECONNECT_DELAY_MS,
    nextCallId: 0,
    pendingCount: 0,
    error: null,
    permanent: false,
    closeCode: undefined,
  }),
  states: {
    disconnected: {
      on: {
        CONNECT: { target: 'connecting', actions: 'clearError' },
      },
    },

    connecting: {
      on: {
        WS_OPEN: { target: 'connected', actions: 'resetReconnect' },
        WS_ERROR: [
          { guard: 'isPermanentFailure', target: 'disconnected', actions: 'setPermanentFailure' },
          { target: 'reconnecting' },
        ],
        WS_CLOSE: [
          { guard: 'isPermanentFailure', target: 'disconnected', actions: 'setPermanentFailure' },
          { target: 'reconnecting' },
        ],
        // initialize is a regular correlated JSON-RPC call, made while the
        // transport is open but before application readiness.
        CALL_STARTED: { actions: 'incrementPending' },
        CALL_SETTLED: { actions: 'decrementPending' },
      },
      after: {
        [WS_CONNECT_TIMEOUT_MS]: { target: 'reconnecting' },
      },
    },

    connected: {
      on: {
        WS_CLOSE: [
          { guard: 'isPermanentFailure', target: 'disconnected', actions: 'setPermanentFailure' },
          { target: 'reconnecting' },
        ],
        WS_ERROR: [
          { guard: 'isPermanentFailure', target: 'disconnected', actions: 'setPermanentFailure' },
          { target: 'reconnecting' },
        ],
        CALL_STARTED: { actions: 'incrementPending' },
        CALL_SETTLED: { actions: 'decrementPending' },
      },
    },

    reconnecting: {
      // Transient failures NEVER park the machine permanently. The backend
      // is a local/embedded process that can be gone for minutes (serve
      // restart, dev rebuild, a busy boot pushing `initialize` past its
      // deadline) and must be re-reached the moment it returns — a capped
      // backoff retries forever. Giving up after N attempts left columns
      // showing "Connecting…" eternally while a healthy server sat one
      // dial away; only genuinely permanent failures (auth-class close
      // codes, explicit `permanent` errors) reach `disconnected`, via the
      // isPermanentFailure guard on WS_CLOSE / WS_ERROR.
      entry: 'incrementReconnect',
      after: {
        reconnectDelay: {
          target: 'connecting',
        },
      },
      on: {
        RETRY: { target: 'connecting', actions: 'resetReconnect' },
      },
    },
  },
  on: {
    // DISCONNECT is idempotent: valid from every state including disconnected
    // (where it's a no-op self-transition). Lifting it to root lets the caller
    // fire disconnect() unconditionally without the drop-event warning.
    DISCONNECT: '.disconnected',
    // WS_OPEN / WS_CLOSE may arrive from stale sockets after this.ws has
    // been replaced by a newer connect() attempt. State-level handlers
    // still win for the meaningful transitions (WS_CLOSE in connected →
    // reconnecting, WS_OPEN in connecting → connected). The root-level
    // no-ops here only catch events from abandoned sockets so they don't
    // show up as dropped events or mis-transition the machine.
    WS_OPEN: { actions: 'noop' },
    WS_CLOSE: { actions: 'noop' },
    WS_ERROR: { actions: 'noop' },
  },
});

export type RPCClientActor = ActorRefFrom<typeof rpcClientMachine>;
