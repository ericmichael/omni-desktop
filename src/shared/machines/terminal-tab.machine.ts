/**
 * XState v5 machine for a single terminal tab connection lifecycle.
 *
 * Manages: session ensure → terminal.create RPC → WebSocket connect → heartbeat.
 * Each terminal tab gets its own machine instance.
 *
 * Pure definition — no DOM or WebSocket imports. All side effects are
 * driven by the component reacting to machine state.
 */
import { type ActorRefFrom, assign, setup } from 'xstate';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SESSION_TIMEOUT_MS = 15_000;
export const TERMINAL_CREATE_TIMEOUT_MS = 30_000;
export const WS_CONNECT_TIMEOUT_MS = 10_000;
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TerminalTabContext = {
  tabId: string;
  sessionId: string | null;
  terminalId: string | null;
  terminalToken: string | null;
  terminalPath: string | null;
  cwd: string | null;
  error: string | null;
  exitCode: number | null;
};

export type TerminalTabEvent =
  | { type: 'CONNECT' }
  | { type: 'SESSION_OK'; sessionId: string }
  | { type: 'SESSION_ERROR'; error: string }
  | { type: 'TERMINAL_CREATED'; terminalId: string; token: string; path: string; cwd?: string; sessionId?: string }
  | { type: 'TERMINAL_CREATE_ERROR'; error: string }
  | { type: 'WS_OPEN' }
  | { type: 'WS_ERROR'; error: string }
  | { type: 'WS_CLOSE' }
  | { type: 'EXIT'; code?: number }
  | { type: 'HEARTBEAT_PONG' }
  | { type: 'RETRY' }
  | { type: 'CLOSE' };

export type TerminalTabInput = {
  tabId: string;
};

// ---------------------------------------------------------------------------
// Machine definition
// ---------------------------------------------------------------------------

export const terminalTabMachine = setup({
  types: {
    context: {} as TerminalTabContext,
    events: {} as TerminalTabEvent,
    input: {} as TerminalTabInput,
  },
  actions: {
    setSession: assign({
      sessionId: (_, params: { sessionId: string }) => params.sessionId,
    }),
    setTerminalInfo: assign(
      ({ context }, params: { terminalId: string; token: string; path: string; cwd?: string; sessionId?: string }) => ({
        terminalId: params.terminalId,
        terminalToken: params.token,
        terminalPath: params.path,
        cwd: params.cwd ?? null,
        sessionId: params.sessionId ?? context.sessionId,
      })
    ),
    setError: assign({
      error: (_, params: { error: string }) => params.error,
    }),
    setExitCode: assign({
      exitCode: (_, params: { code?: number }) => params.code ?? null,
    }),
    clearConnectionState: assign({
      sessionId: null,
      terminalId: null,
      terminalToken: null,
      terminalPath: null,
      cwd: null,
      error: null,
      exitCode: null,
    }),
    clearError: assign({ error: null }),
  },
}).createMachine({
  id: 'terminalTab',
  initial: 'disconnected',
  context: ({ input }) => ({
    tabId: input.tabId,
    sessionId: null,
    terminalId: null,
    terminalToken: null,
    terminalPath: null,
    cwd: null,
    error: null,
    exitCode: null,
  }),
  states: {
    disconnected: {
      on: {
        CONNECT: { target: 'ensuringSession', actions: 'clearError' },
        CLOSE: 'closed',
      },
    },

    ensuringSession: {
      on: {
        SESSION_OK: {
          target: 'creatingTerminal',
          actions: {
            type: 'setSession',
            params: ({ event }) => ({ sessionId: event.sessionId }),
          },
        },
        SESSION_ERROR: {
          target: 'error',
          actions: {
            type: 'setError',
            params: ({ event }) => ({ error: event.error }),
          },
        },
        CLOSE: 'closed',
      },
      after: {
        [SESSION_TIMEOUT_MS]: {
          target: 'error',
          actions: {
            type: 'setError',
            params: { error: `Session ensure timed out after ${SESSION_TIMEOUT_MS}ms` },
          },
        },
      },
    },

    creatingTerminal: {
      on: {
        TERMINAL_CREATED: {
          target: 'connectingWs',
          actions: {
            type: 'setTerminalInfo',
            params: ({ event }) => ({
              terminalId: event.terminalId,
              token: event.token,
              path: event.path,
              cwd: event.cwd,
              sessionId: event.sessionId,
            }),
          },
        },
        TERMINAL_CREATE_ERROR: {
          target: 'error',
          actions: {
            type: 'setError',
            params: ({ event }) => ({ error: event.error }),
          },
        },
        CLOSE: 'closed',
      },
      after: {
        [TERMINAL_CREATE_TIMEOUT_MS]: {
          target: 'error',
          actions: {
            type: 'setError',
            params: { error: `terminal.create timed out after ${TERMINAL_CREATE_TIMEOUT_MS}ms` },
          },
        },
      },
    },

    connectingWs: {
      on: {
        WS_OPEN: 'connected',
        WS_ERROR: {
          target: 'error',
          actions: {
            type: 'setError',
            params: ({ event }) => ({ error: event.error }),
          },
        },
        WS_CLOSE: {
          target: 'error',
          actions: {
            type: 'setError',
            params: { error: 'WebSocket closed before connecting' },
          },
        },
        CLOSE: 'closed',
      },
      after: {
        [WS_CONNECT_TIMEOUT_MS]: {
          target: 'error',
          actions: {
            type: 'setError',
            params: { error: `WebSocket connect timed out after ${WS_CONNECT_TIMEOUT_MS}ms` },
          },
        },
      },
    },

    connected: {
      on: {
        EXIT: {
          target: 'exited',
          actions: {
            type: 'setExitCode',
            params: ({ event }) => ({ code: event.code }),
          },
        },
        WS_CLOSE: 'disconnected',
        WS_ERROR: {
          target: 'disconnected',
          actions: 'clearConnectionState',
        },
        CLOSE: 'closed',
      },
    },

    exited: {
      type: 'final',
    },

    error: {
      on: {
        RETRY: { target: 'disconnected', actions: 'clearConnectionState' },
        CLOSE: 'closed',
      },
    },

    closed: {
      type: 'final',
    },
  },
});

export type TerminalTabActor = ActorRefFrom<typeof terminalTabMachine>;

// ---------------------------------------------------------------------------
// Selector helpers
// ---------------------------------------------------------------------------

export type TerminalConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'exited' | 'error' | 'closed';

export function getTerminalConnectionStatus(stateValue: string): TerminalConnectionStatus {
  switch (stateValue) {
    case 'disconnected':
      return 'disconnected';
    case 'ensuringSession':
    case 'creatingTerminal':
    case 'connectingWs':
      return 'connecting';
    case 'connected':
      return 'connected';
    case 'exited':
      return 'exited';
    case 'error':
      return 'error';
    case 'closed':
      return 'closed';
    default:
      return 'disconnected';
  }
}
