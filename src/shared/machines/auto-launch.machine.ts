/**
 * XState v5 machine for auto-launching a sandbox/process.
 *
 * Side effects are driven by invoked actors (fromCallback), not React useEffect.
 * Placeholder actors are defined in setup() — real implementations are injected
 * at creation time via the `actors` option on createActor/useActorRef.
 *
 * Pure definition — no React, no IPC imports.
 */
import { type ActorRefFrom, assign, fromCallback, setup } from 'xstate';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutoLaunchPhase =
  | 'idle'
  | 'checking'
  | 'installing'
  | 'ready'
  | 'configChecking'
  | 'starting'
  | 'running'
  | 'error';

export type AutoLaunchContext = {
  error: string | null;
  hasLaunched: boolean;
};

export type AutoLaunchEvent =
  | { type: 'LAUNCH' }
  | { type: 'RUNTIME_READY' }
  | { type: 'RUNTIME_OUTDATED' }
  | { type: 'RUNTIME_CHECK_FAILED'; error: string }
  | { type: 'INSTALL_COMPLETED' }
  | { type: 'INSTALL_FAILED'; error: string }
  | { type: 'INSTALL_CANCELLED' }
  | { type: 'CONFIG_OK' }
  | { type: 'CONFIG_MISSING' }
  | { type: 'CONFIG_CHECK_FAILED'; error: string }
  | { type: 'PROCESS_STARTED' }
  | { type: 'SANDBOX_RUNNING' }
  | { type: 'SANDBOX_ERROR'; error: string }
  | { type: 'SANDBOX_EXITED' }
  | { type: 'RETRY' }
  | { type: 'RELAUNCH' }
  | { type: 'RESET' };

// ---------------------------------------------------------------------------
// Machine definition
// ---------------------------------------------------------------------------

export const autoLaunchMachine = setup({
  types: {
    context: {} as AutoLaunchContext,
    events: {} as AutoLaunchEvent,
  },
  actors: {
    /** Check if the Omni runtime is installed and up-to-date. */
    checkRuntime: fromCallback<AutoLaunchEvent>(({ sendBack }) => {
      sendBack({ type: 'RUNTIME_CHECK_FAILED', error: 'checkRuntime actor not provided' });
    }),
    /** Watch external install status until completed/failed/cancelled. */
    watchInstallStatus: fromCallback<AutoLaunchEvent>(() => () => {}),
    /** Check config (models.json) and start the sandbox/process. */
    checkConfigAndStart: fromCallback<AutoLaunchEvent>(({ sendBack }) => {
      sendBack({ type: 'CONFIG_MISSING' });
    }),
    /** Watch external process status for state changes. */
    watchProcessStatus: fromCallback<AutoLaunchEvent>(() => () => {}),
  },
  actions: {
    setError: assign({
      error: (_, params: { error: string }) => params.error,
    }),
    clearError: assign({ error: null }),
    markLaunched: assign({ hasLaunched: true }),
    clearLaunched: assign({ hasLaunched: false }),
  },
  guards: {
    hasAlreadyLaunched: ({ context }) => context.hasLaunched,
  },
}).createMachine({
  id: 'autoLaunch',
  initial: 'idle',
  context: {
    error: null,
    hasLaunched: false,
  },
  states: {
    idle: {
      on: {
        LAUNCH: { target: 'checking', actions: 'clearError' },
        RESET: { actions: ['clearError', 'clearLaunched'] },
      },
    },

    checking: {
      invoke: { src: 'checkRuntime' },
      on: {
        RUNTIME_READY: 'ready',
        RUNTIME_OUTDATED: 'installing',
        RUNTIME_CHECK_FAILED: {
          target: 'error',
          actions: {
            type: 'setError',
            params: ({ event }) => ({ error: event.error }),
          },
        },
        RESET: { target: 'idle', actions: ['clearError', 'clearLaunched'] },
      },
    },

    installing: {
      invoke: { src: 'watchInstallStatus' },
      on: {
        INSTALL_COMPLETED: 'ready',
        INSTALL_FAILED: {
          target: 'error',
          actions: {
            type: 'setError',
            params: ({ event }) => ({ error: event.error }),
          },
        },
        INSTALL_CANCELLED: 'idle',
        RESET: { target: 'idle', actions: ['clearError', 'clearLaunched'] },
      },
    },

    ready: {
      always: [
        {
          guard: 'hasAlreadyLaunched',
          target: 'idle',
        },
      ],
      invoke: { src: 'checkConfigAndStart' },
      on: {
        CONFIG_OK: { target: 'starting', actions: 'markLaunched' },
        CONFIG_MISSING: 'idle',
        CONFIG_CHECK_FAILED: {
          target: 'starting',
          actions: 'markLaunched',
          // Proceed anyway on config check failure, matching existing behavior
        },
        RESET: { target: 'idle', actions: ['clearError', 'clearLaunched'] },
      },
    },

    starting: {
      invoke: { src: 'watchProcessStatus' },
      on: {
        SANDBOX_RUNNING: 'running',
        SANDBOX_ERROR: {
          target: 'error',
          actions: {
            type: 'setError',
            params: ({ event }) => ({ error: event.error }),
          },
        },
        SANDBOX_EXITED: 'idle',
        RESET: { target: 'idle', actions: ['clearError', 'clearLaunched'] },
      },
    },

    running: {
      invoke: { src: 'watchProcessStatus' },
      on: {
        SANDBOX_EXITED: 'idle',
        SANDBOX_ERROR: 'idle',
        RESET: { target: 'idle', actions: ['clearError', 'clearLaunched'] },
      },
    },

    error: {
      on: {
        RETRY: { target: 'checking', actions: 'clearError' },
        RELAUNCH: { target: 'ready', actions: ['clearError', 'clearLaunched'] },
        RESET: { target: 'idle', actions: ['clearError', 'clearLaunched'] },
      },
    },
  },
});

export type AutoLaunchActor = ActorRefFrom<typeof autoLaunchMachine>;
