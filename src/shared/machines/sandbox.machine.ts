/**
 * XState v5 machine for sandbox container lifecycle.
 *
 * Tracks the state of a Docker sandbox from start to exit.
 * Used by SandboxManager in the main process to enforce valid transitions
 * and by the renderer to derive UI state from IPC events.
 *
 * Pure definition — no Node, Docker, or child_process imports.
 */
import { type ActorRefFrom, assign, setup } from 'xstate';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SERVICE_READINESS_TIMEOUT_MS = 120_000;
export const STOP_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SandboxMachineState =
  | 'idle'
  | 'starting'
  | 'spawning'
  | 'waitingForJson'
  | 'connecting'
  | 'running'
  | 'stopping'
  | 'exited'
  | 'error';

export type SandboxMachineContext = {
  error: string | null;
  startedAt: number | null;
};

export type SandboxMachineEvent =
  | { type: 'START' }
  | { type: 'PROCESS_SPAWNED' }
  | { type: 'JSON_PARSED' }
  | { type: 'SERVICES_READY' }
  | { type: 'SERVICES_TIMEOUT' }
  | { type: 'PROCESS_ERROR'; error: string }
  | { type: 'PROCESS_EXITED' }
  | { type: 'STOP' }
  | { type: 'FORCE_EXITED' }
  | { type: 'RETRY' }
  | { type: 'DISMISS' };

// ---------------------------------------------------------------------------
// Machine definition
// ---------------------------------------------------------------------------

export const sandboxMachine = setup({
  types: {
    context: {} as SandboxMachineContext,
    events: {} as SandboxMachineEvent,
  },
  actions: {
    setError: assign({
      error: (_, params: { error: string }) => params.error,
    }),
    clearError: assign({ error: null }),
    markStarted: assign({ startedAt: () => Date.now() }),
    clearStarted: assign({ startedAt: null }),
  },
}).createMachine({
  id: 'sandbox',
  initial: 'idle',
  context: {
    error: null,
    startedAt: null,
  },
  states: {
    idle: {
      on: {
        START: { target: 'starting', actions: ['clearError', 'markStarted'] },
      },
    },

    starting: {
      on: {
        PROCESS_SPAWNED: 'spawning',
        PROCESS_ERROR: {
          target: 'error',
          actions: {
            type: 'setError',
            params: ({ event }) => ({ error: event.error }),
          },
        },
        STOP: 'idle',
      },
    },

    spawning: {
      on: {
        JSON_PARSED: 'connecting',
        PROCESS_ERROR: {
          target: 'error',
          actions: {
            type: 'setError',
            params: ({ event }) => ({ error: event.error }),
          },
        },
        PROCESS_EXITED: {
          target: 'error',
          actions: {
            type: 'setError',
            params: { error: 'Process exited unexpectedly during startup' },
          },
        },
        STOP: { target: 'stopping' },
      },
    },

    connecting: {
      on: {
        SERVICES_READY: 'running',
        SERVICES_TIMEOUT: {
          target: 'error',
          actions: {
            type: 'setError',
            params: { error: `Services did not become ready within ${SERVICE_READINESS_TIMEOUT_MS / 1000}s` },
          },
        },
        PROCESS_ERROR: {
          target: 'error',
          actions: {
            type: 'setError',
            params: ({ event }) => ({ error: event.error }),
          },
        },
        PROCESS_EXITED: {
          target: 'error',
          actions: {
            type: 'setError',
            params: { error: 'Process exited while waiting for services' },
          },
        },
        STOP: { target: 'stopping' },
      },
      after: {
        [SERVICE_READINESS_TIMEOUT_MS]: {
          target: 'error',
          actions: {
            type: 'setError',
            params: { error: `Services did not become ready within ${SERVICE_READINESS_TIMEOUT_MS / 1000}s` },
          },
        },
      },
    },

    running: {
      on: {
        STOP: 'stopping',
        PROCESS_EXITED: 'exited',
        PROCESS_ERROR: {
          target: 'error',
          actions: {
            type: 'setError',
            params: ({ event }) => ({ error: event.error }),
          },
        },
      },
    },

    stopping: {
      on: {
        PROCESS_EXITED: 'exited',
        FORCE_EXITED: 'exited',
      },
      after: {
        [STOP_TIMEOUT_MS]: 'exited',
      },
    },

    exited: {
      on: {
        START: { target: 'starting', actions: ['clearError', 'markStarted'] },
      },
    },

    error: {
      on: {
        RETRY: { target: 'starting', actions: ['clearError', 'markStarted'] },
        DISMISS: { target: 'idle', actions: 'clearError' },
        START: { target: 'starting', actions: ['clearError', 'markStarted'] },
      },
    },
  },
});

export type SandboxMachineActor = ActorRefFrom<typeof sandboxMachine>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map machine state to SandboxProcessStatus type for IPC compatibility. */
export function mapMachineStateToStatusType(
  state: SandboxMachineState
): 'uninitialized' | 'starting' | 'connecting' | 'running' | 'stopping' | 'exiting' | 'exited' | 'error' {
  switch (state) {
    case 'idle':
      return 'uninitialized';
    case 'starting':
    case 'spawning':
    case 'waitingForJson':
      return 'starting';
    case 'connecting':
      return 'connecting';
    case 'running':
      return 'running';
    case 'stopping':
      return 'stopping';
    case 'exited':
      return 'exited';
    case 'error':
      return 'error';
    default:
      return 'uninitialized';
  }
}
