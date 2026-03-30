/**
 * XState v5 machine for JSON-RPC WebSocket client lifecycle.
 *
 * Manages: connection, reconnection with exponential backoff,
 * per-call timeouts, and pending-queue limits.
 *
 * This is a pure machine definition — no DOM or Node imports.
 * The actual WebSocket is injected via the `actors` option at creation time.
 */
import { type ActorRefFrom, assign, fromCallback, fromPromise, setup } from 'xstate';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RPC_CALL_TIMEOUT_MS = 30_000;
export const WS_CONNECT_TIMEOUT_MS = 10_000;
export const MAX_PENDING_CALLS = 100;
export const INITIAL_RECONNECT_DELAY_MS = 500;
export const MAX_RECONNECT_DELAY_MS = 10_000;
export const MAX_RECONNECT_ATTEMPTS = 20;

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

type JSONRPCRequest = {
  jsonrpc: '2.0';
  id: RPCCallId;
  method: string;
  params?: Record<string, unknown>;
};

type JSONRPCResponse = {
  jsonrpc: '2.0';
  id: RPCCallId;
  result?: unknown;
  error?: { code?: number; message: string; data?: unknown };
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
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type RPCClientEvent =
  | { type: 'CONNECT' }
  | { type: 'DISCONNECT' }
  | { type: 'WS_OPEN' }
  | { type: 'WS_CLOSE'; reason?: string }
  | { type: 'WS_ERROR'; error: string }
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
    canReconnect: ({ context }) => context.reconnectAttempt < MAX_RECONNECT_ATTEMPTS,
    hasReachedMaxAttempts: ({ context }) => context.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS,
  },
  actions: {
    incrementReconnect: assign({
      reconnectAttempt: ({ context }) => context.reconnectAttempt + 1,
      reconnectDelay: ({ context }) =>
        Math.min(MAX_RECONNECT_DELAY_MS, Math.round(context.reconnectDelay * 1.5)),
    }),
    resetReconnect: assign({
      reconnectAttempt: 0,
      reconnectDelay: INITIAL_RECONNECT_DELAY_MS,
    }),
    setError: assign({
      error: (_, params: { error: string }) => params.error,
    }),
    clearError: assign({ error: null }),
    incrementPending: assign({
      pendingCount: ({ context }) => context.pendingCount + 1,
    }),
    decrementPending: assign({
      pendingCount: ({ context }) => Math.max(0, context.pendingCount - 1),
    }),
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
        WS_ERROR: { target: 'reconnecting' },
        WS_CLOSE: { target: 'reconnecting' },
        DISCONNECT: 'disconnected',
      },
      after: {
        [WS_CONNECT_TIMEOUT_MS]: { target: 'reconnecting' },
      },
    },

    connected: {
      on: {
        WS_CLOSE: 'reconnecting',
        WS_ERROR: 'reconnecting',
        DISCONNECT: { target: 'disconnected' },
        CALL_STARTED: { actions: 'incrementPending' },
        CALL_SETTLED: { actions: 'decrementPending' },
      },
    },

    reconnecting: {
      always: [
        {
          guard: 'hasReachedMaxAttempts',
          target: 'disconnected',
          actions: assign({ error: 'Max reconnect attempts reached' }),
        },
      ],
      entry: 'incrementReconnect',
      after: {
        reconnectDelay: {
          target: 'connecting',
        },
      },
      on: {
        DISCONNECT: 'disconnected',
        RETRY: { target: 'connecting', actions: 'resetReconnect' },
      },
    },
  },
});

export type RPCClientActor = ActorRefFrom<typeof rpcClientMachine>;
