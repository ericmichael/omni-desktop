/**
 * Boot orchestrator for the chat feature.
 *
 * Composes the three independent lifecycles that must line up before a
 * user can interact with the agent:
 *
 *   server → RPC connection → bootstrap → session load → ready
 *
 * Each dependency is modeled as a distinct state. The only way to reach
 * `ready` is to pass through every prior state. If any upstream dependency
 * drops (WS closes, server crashes), the machine unwinds back to
 * `awaitingConnection` and resumes from there — cancelling any in-flight
 * operations via XState's invoker teardown. No imperative `cancelled`
 * flags, no stale fetches producing HISTORY_ERROR after unmount.
 *
 * The hook layer (useChatBoot) provides real implementations of the
 * invokers via `machine.provide({ actors: ... })`. This file is pure —
 * no React, no RPC client, no IPC. Stubs for tests.
 */
import {
  assign,
  type ActorRefFrom,
  fromCallback,
  setup,
  type SnapshotFrom,
} from 'xstate';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChatBootPhase =
  | 'awaitingConnection'
  | 'bootstrapping'
  | 'loadingSession'
  | 'ready'
  | 'bootstrapError'
  | 'sessionError';

/** Capabilities learned during the bootstrap step. */
export type ChatBootCapabilities = {
  agentName: string;
  welcomeText?: string;
  voiceEnabled: boolean;
  workspaceSupported: boolean;
  workspacePath?: string;
};

export type ChatBootContext = {
  /** Session id to load. `undefined` means "new chat — skip history load". */
  sessionId: string | undefined;
  /** Capabilities resolved during bootstrapping. */
  capabilities: ChatBootCapabilities | null;
  /** Last error from bootstrap or session load. */
  error: string | null;
  /**
   * Has the machine reached `ready` at least once? On reconnect we skip
   * the session-load step because chat-session context survives the
   * connection drop — nothing to reload client-side.
   */
  hasBooted: boolean;
};

export type ChatBootInput = {
  sessionId: string | undefined;
};

export type ChatBootEvent =
  // Server / RPC lifecycle signals (from the hook-provided invokers)
  | { type: 'RPC_CONNECTED' }
  | { type: 'RPC_DISCONNECTED' }
  // Bootstrap step signals
  | { type: 'BOOTSTRAP_OK'; capabilities: ChatBootCapabilities }
  | { type: 'BOOTSTRAP_FAILED'; error: string }
  // Session load signals
  | { type: 'SESSION_LOADED' }
  | { type: 'SESSION_ERROR'; error: string }
  // External controls
  | { type: 'RETRY' }
  | { type: 'SET_SESSION_ID'; sessionId: string | undefined };

// ---------------------------------------------------------------------------
// Machine
// ---------------------------------------------------------------------------

export const chatBootMachine = setup({
  types: {
    context: {} as ChatBootContext,
    events: {} as ChatBootEvent,
    input: {} as ChatBootInput,
  },

  guards: {
    // On the initial boot, we always run loadingSession — even for "new
    // chat" where sessionId is undefined, because the chat-session machine
    // needs NEW_SESSION to reach ready.idle and unblock user input.
    // On reconnect (hasBooted=true), chat-session already has its state,
    // so we skip loadingSession and go straight to ready.
    isInitialBoot: ({ context }) => !context.hasBooted,
  },

  actions: {
    setCapabilities: assign({
      capabilities: ({ event }) =>
        (event as Extract<ChatBootEvent, { type: 'BOOTSTRAP_OK' }>).capabilities,
      error: null,
    }),
    setError: assign({
      error: ({ event }) =>
        (event as Extract<ChatBootEvent, { type: 'BOOTSTRAP_FAILED' | 'SESSION_ERROR' }>).error,
    }),
    clearError: assign({ error: null }),
    markBooted: assign({ hasBooted: true }),
    setSessionId: assign({
      sessionId: ({ event }) =>
        (event as Extract<ChatBootEvent, { type: 'SET_SESSION_ID' }>).sessionId,
    }),
  },

  actors: {
    // Placeholders — hook layer provides real implementations.
    waitForConnection: fromCallback<ChatBootEvent>(() => () => {}),
    bootstrap: fromCallback<ChatBootEvent>(() => () => {}),
    loadSession: fromCallback<ChatBootEvent>(() => () => {}),
  },
}).createMachine({
  id: 'chatBoot',
  initial: 'awaitingConnection',
  context: ({ input }) => ({
    sessionId: input.sessionId,
    capabilities: null,
    error: null,
    hasBooted: false,
  }),

  // SET_SESSION_ID can arrive from any state — useful if the caller learns
  // the session id after mount (e.g. parsed from a ?session= query param
  // that isn't available synchronously).
  on: {
    SET_SESSION_ID: { actions: 'setSessionId' },
    // Disconnect at any post-connection state unwinds to awaitingConnection.
    // Declared at root so the invoker in the current state is torn down
    // cleanly — no stale fetch writing HISTORY_ERROR to the chat machine
    // after the WS has closed.
    RPC_DISCONNECTED: { target: '.awaitingConnection' },
  },

  states: {
    awaitingConnection: {
      invoke: { src: 'waitForConnection' },
      on: {
        RPC_CONNECTED: { target: 'bootstrapping' },
      },
    },

    bootstrapping: {
      invoke: { src: 'bootstrap' },
      on: {
        BOOTSTRAP_OK: [
          // Initial boot: always go through loadingSession. Even for "new
          // chat" (sessionId undefined) we still need to transition the
          // chat-session machine out of `initializing` via NEW_SESSION so
          // the input is actually usable.
          {
            guard: 'isInitialBoot',
            target: 'loadingSession',
            actions: 'setCapabilities',
          },
          // Reconnect after initial boot: chat-session context is still
          // live, nothing to reload, go straight back to ready.
          {
            target: 'ready',
            actions: ['setCapabilities', 'markBooted'],
          },
        ],
        BOOTSTRAP_FAILED: {
          target: 'bootstrapError',
          actions: 'setError',
        },
      },
    },

    loadingSession: {
      invoke: { src: 'loadSession' },
      on: {
        SESSION_LOADED: {
          target: 'ready',
          actions: 'markBooted',
        },
        SESSION_ERROR: {
          target: 'sessionError',
          actions: 'setError',
        },
      },
    },

    ready: {
      // Terminal-ish: the user can interact. Disconnects unwind via root `on`.
    },

    bootstrapError: {
      on: {
        RETRY: { target: 'bootstrapping', actions: 'clearError' },
      },
    },

    sessionError: {
      on: {
        RETRY: { target: 'loadingSession', actions: 'clearError' },
      },
    },
  },
});

export type ChatBootActor = ActorRefFrom<typeof chatBootMachine>;
export type ChatBootSnapshot = SnapshotFrom<typeof chatBootMachine>;

/** Whether the chat input can be safely enabled. */
export function isBootReady(phase: ChatBootPhase): boolean {
  return phase === 'ready';
}
