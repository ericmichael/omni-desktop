/**
 * XState v5 machine for chat session state.
 *
 * Manages: session identity, run lifecycle, message items, preamble buffering,
 * tool approval flow, and session-based event filtering.
 *
 * Pure definition — no React, no IPC, no DOM imports.
 * Session filtering reuses the pure guards from `@/lib/session-filter`.
 */
import { type ActorRefFrom, assign, setup,type SnapshotFrom } from 'xstate';

import { acceptLooseEvent, acceptStrictEvent } from '@/lib/session-filter';
import type {
  ApprovalItem,
  ArtifactItem,
  Attachment,
  ChatMessage,
  MessageItem,
  PreambleChunk,
  ToolItem,
} from '@/shared/chat-types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChatSessionPhase =
  | 'idle'
  | 'loadingHistory'
  | 'starting'
  | 'running'
  | 'awaitingApproval'
  | 'stopping';

export type ChatSessionContext = {
  sessionId: string | undefined;
  runId: string | undefined;
  items: MessageItem[];
  preamble: string | undefined;
  preambleBuffer: PreambleChunk[];
  pendingApprovals: Map<string, ApprovalItem>;
  status: string | undefined;
  statusSpinner: boolean;
  statusItalic: boolean;
  toolStatus: string | undefined;
  error: string | undefined;
};

export type ChatSessionEvent =
  // User actions
  | { type: 'SUBMIT'; text: string; sessionId: string; attachments?: Attachment[] }
  | { type: 'SELECT_SESSION'; id: string }
  | { type: 'NEW_SESSION'; sessionId: string }
  | { type: 'STOP' }
  | { type: 'APPROVAL_DECIDED'; request_id: string; value: 'yes' | 'always' | 'no' }
  // Server events
  | { type: 'RUN_STARTED'; run_id: string; session_id?: string }
  | { type: 'RUN_END'; session_id?: string }
  | { type: 'MESSAGE_OUTPUT'; content: string; session_id?: string }
  | {
      type: 'TOOL_CALLED';
      call_id: string;
      tool: string;
      input: string;
      run_id?: string;
      session_id?: string;
    }
  | {
      type: 'TOOL_RESULT';
      call_id: string;
      tool: string;
      output: string;
      metadata?: unknown;
      run_id?: string;
      session_id?: string;
    }
  | { type: 'RUN_STATUS'; text: string; session_id?: string }
  | { type: 'TOKEN'; session_id?: string }
  | {
      type: 'REQUEST_APPROVAL';
      request_id: string;
      tool: string;
      argumentsText?: string;
      metadata?: unknown;
      session_id?: string;
    }
  | { type: 'APPROVAL_RESOLVED'; request_id: string }
  | { type: 'SET_STATUS'; text?: string; showSpinner?: boolean; session_id?: string }
  // History loading
  | { type: 'HISTORY_LOADED'; items: MessageItem[] }
  | { type: 'HISTORY_ERROR'; error: string }
  // Errors
  | { type: 'SUBMIT_ERROR'; error: string }
  // Artifacts
  | {
      type: 'ADD_ARTIFACT';
      artifact_id?: string;
      title: string;
      content: string;
      mode?: string;
      session_id?: string;
    }
  // Direct item manipulation (slash commands, external updates)
  | { type: 'APPEND_RESPONSE'; content: string }
  | { type: 'SET_SESSION_ID'; sessionId: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sessionId(event: { session_id?: string }): string | undefined {
  return event.session_id;
}

function supersede(buffer: PreambleChunk[]): PreambleChunk[] {
  return buffer.map((m) => (m.superseded ? m : { ...m, superseded: true }));
}

const INITIAL_CONTEXT: ChatSessionContext = {
  sessionId: undefined,
  runId: undefined,
  items: [],
  preamble: undefined,
  preambleBuffer: [],
  pendingApprovals: new Map(),
  status: undefined,
  statusSpinner: false,
  statusItalic: false,
  toolStatus: undefined,
  error: undefined,
};

// ---------------------------------------------------------------------------
// Machine definition
// ---------------------------------------------------------------------------

export const chatSessionMachine = setup({
  types: {
    context: {} as ChatSessionContext,
    events: {} as ChatSessionEvent,
  },

  // --- Guards ---
  guards: {
    /** Strict filter — rejects events from other sessions. startingRun = false. */
    acceptStrict: ({ context, event }) =>
      acceptStrictEvent(
        { currentSessionId: context.sessionId, startingRun: false },
        sessionId(event as { session_id?: string }),
      ),

    /** Strict filter — but startingRun = true (used in the `starting` state). */
    acceptStrictOrStarting: ({ context, event }) =>
      acceptStrictEvent(
        { currentSessionId: context.sessionId, startingRun: true },
        sessionId(event as { session_id?: string }),
      ),

    /** Loose filter — only rejects when both sides have IDs that disagree. */
    acceptLoose: ({ context, event }) =>
      acceptLooseEvent(
        { currentSessionId: context.sessionId, startingRun: false },
        sessionId(event as { session_id?: string }),
      ),

    /** True when more than one approval is pending (so removing one still leaves queue non-empty). */
    hasMoreApprovals: ({ context }) => context.pendingApprovals.size > 1,
  },

  // --- Actions ---
  actions: {
    appendUserMessage: assign({
      items: ({ context, event }) => {
        const e = event as Extract<ChatSessionEvent, { type: 'SUBMIT' }>;
        const msg: ChatMessage = { type: 'chat', role: 'user', content: e.text };
        if (e.attachments?.length) {
          msg.attachments = e.attachments;
        }
        return [...context.items, msg];
      },
      sessionId: ({ event }) => (event as Extract<ChatSessionEvent, { type: 'SUBMIT' }>).sessionId,
      preambleBuffer: [],
      preamble: undefined,
      status: undefined,
      statusSpinner: false,
      statusItalic: false,
      toolStatus: undefined,
    }),

    setRunStarted: assign(({ context, event }) => {
      const e = event as Extract<ChatSessionEvent, { type: 'RUN_STARTED' }>;
      return {
        runId: e.run_id,
        sessionId: e.session_id ?? context.sessionId,
        preambleBuffer: [],
        preamble: undefined,
        status: undefined,
        statusSpinner: false,
        statusItalic: false,
        toolStatus: undefined,
      };
    }),

    bufferPreamble: assign(({ context, event }) => {
      const e = event as Extract<ChatSessionEvent, { type: 'MESSAGE_OUTPUT' }>;
      return {
        preambleBuffer: [
          ...context.preambleBuffer,
          { content: e.content, timestamp: Date.now(), superseded: false },
        ],
        preamble: e.content,
        status: undefined,
        statusItalic: false,
      };
    }),

    appendToolItem: assign(({ context, event }) => {
      const e = event as Extract<ChatSessionEvent, { type: 'TOOL_CALLED' }>;
      const item: ToolItem = {
        type: 'tool',
        tool: e.tool,
        input: e.input,
        call_id: e.call_id,
        status: 'called',
        runId: context.runId,
      };
      return {
        items: [...context.items, item],
        preambleBuffer: supersede(context.preambleBuffer),
      };
    }),

    updateToolResult: assign(({ context, event }) => {
      const e = event as Extract<ChatSessionEvent, { type: 'TOOL_RESULT' }>;
      const idx = context.items.findIndex(
        (it) => it.type === 'tool' && (it as ToolItem).call_id === e.call_id,
      );
      const next = context.items.slice();
      if (idx >= 0) {
        next[idx] = {
          ...next[idx],
          output: e.output,
          status: 'result',
          metadata: e.metadata,
        } as ToolItem;
      } else {
        next.push({
          type: 'tool',
          tool: e.tool,
          output: e.output,
          call_id: e.call_id,
          status: 'result',
          metadata: e.metadata,
          runId: context.runId,
        } as ToolItem);
      }
      return {
        items: next,
        preambleBuffer: supersede(context.preambleBuffer),
      };
    }),

    flushPreamble: assign(({ context }) => {
      const nonSuperseded = context.preambleBuffer.filter((m) => !m.superseded);
      const flushed = nonSuperseded.length
        ? [
            ...context.items,
            ...nonSuperseded.map(
              (m): ChatMessage => ({ type: 'chat', role: 'assistant', content: m.content }),
            ),
          ]
        : context.items;
      return {
        items: flushed,
        preambleBuffer: [],
        preamble: undefined,
        toolStatus: undefined,
        statusSpinner: false,
        statusItalic: false,
      };
    }),

    updateRunStatus: assign(({ event }) => {
      const e = event as Extract<ChatSessionEvent, { type: 'RUN_STATUS' }>;
      return { status: e.text, statusSpinner: true, statusItalic: false };
    }),

    setStatusFromServer: assign(({ event }) => {
      const e = event as Extract<ChatSessionEvent, { type: 'SET_STATUS' }>;
      return {
        status: e.text,
        statusSpinner: e.showSpinner ?? true,
        statusItalic: false,
        toolStatus: e.text?.trim() ? e.text : undefined,
      };
    }),

    addApproval: assign(({ context, event }) => {
      const e = event as Extract<ChatSessionEvent, { type: 'REQUEST_APPROVAL' }>;
      const item: ApprovalItem = {
        type: 'approval',
        request_id: e.request_id,
        tool: e.tool,
        argumentsText: e.argumentsText,
        metadata: e.metadata,
        session_id: e.session_id,
      };
      const newPending = new Map(context.pendingApprovals);
      newPending.set(e.request_id, item);
      // Remove any existing approval with same request_id, then append
      const filtered = context.items.filter(
        (it) => !(it.type === 'approval' && (it as ApprovalItem).request_id === e.request_id),
      );
      return { pendingApprovals: newPending, items: [...filtered, item] };
    }),

    removeApproval: assign(({ context, event }) => {
      const e = event as Extract<
        ChatSessionEvent,
        { type: 'APPROVAL_DECIDED' | 'APPROVAL_RESOLVED' }
      >;
      const newPending = new Map(context.pendingApprovals);
      newPending.delete(e.request_id);
      return {
        pendingApprovals: newPending,
        items: context.items.filter(
          (it) => !(it.type === 'approval' && (it as ApprovalItem).request_id === e.request_id),
        ),
      };
    }),

    resetSessionState: assign(({ event }) => {
      const e = event as Extract<ChatSessionEvent, { type: 'SELECT_SESSION' | 'NEW_SESSION' }>;
      const sid = e.type === 'SELECT_SESSION' ? e.id : (e as { sessionId: string }).sessionId;
      return {
        sessionId: sid,
        items: [],
        preamble: undefined,
        preambleBuffer: [],
        status: undefined,
        statusSpinner: false,
        statusItalic: false,
        toolStatus: undefined,
        runId: undefined,
        pendingApprovals: new Map<string, ApprovalItem>(),
        error: undefined,
      };
    }),

    clearRunState: assign({
      runId: undefined,
      status: undefined,
      statusSpinner: false,
      statusItalic: false,
      toolStatus: undefined,
      preamble: undefined,
      preambleBuffer: [],
    }),

    setHistoryItems: assign({
      items: ({ context, event }) => {
        const e = event as Extract<ChatSessionEvent, { type: 'HISTORY_LOADED' }>;
        // Merge any pending approvals that arrived during history loading
        if (context.pendingApprovals.size === 0) {
return e.items;
}
        const approvalItems = [...context.pendingApprovals.values()].filter(
          (a) =>
            !e.items.some(
              (it) => it.type === 'approval' && (it as ApprovalItem).request_id === a.request_id,
            ),
        );
        return approvalItems.length ? [...e.items, ...approvalItems] : e.items;
      },
    }),

    setSubmitError: assign(({ context, event }) => {
      const e = event as Extract<ChatSessionEvent, { type: 'SUBMIT_ERROR' }>;
      return {
        items: [
          ...context.items,
          { type: 'chat' as const, role: 'assistant' as const, content: `Error: ${e.error}` },
        ],
      };
    }),

    markStopping: assign(({ context }) => ({
      preambleBuffer: supersede(context.preambleBuffer),
      preamble: undefined,
    })),

    appendResponse: assign({
      items: ({ context, event }) => {
        const e = event as Extract<ChatSessionEvent, { type: 'APPEND_RESPONSE' }>;
        return [
          ...context.items,
          { type: 'chat' as const, role: 'assistant' as const, content: e.content },
        ];
      },
    }),

    addArtifact: assign(({ context, event }) => {
      const e = event as Extract<ChatSessionEvent, { type: 'ADD_ARTIFACT' }>;
      const entry: ArtifactItem = {
        type: 'artifact',
        artifact_id: e.artifact_id,
        title: e.title,
        content: e.content,
        mode: e.mode,
        session_id: e.session_id,
        updated_at: Date.now(),
      };
      const next = context.items.slice();
      // If artifact_id exists, update in-place; otherwise append
      const idx = e.artifact_id
        ? next.findIndex(
            (it) =>
              it.type === 'artifact' &&
              (it as ArtifactItem).artifact_id === e.artifact_id,
          )
        : -1;
      if (idx >= 0) {
        next[idx] = entry;
      } else {
        next.push(entry);
      }
      return { items: next };
    }),

    setSessionIdOnly: assign({
      sessionId: ({ event }) =>
        (event as Extract<ChatSessionEvent, { type: 'SET_SESSION_ID' }>).sessionId,
    }),
  },
}).createMachine({
  id: 'chatSession',
  initial: 'idle',
  context: { ...INITIAL_CONTEXT },

  // Root-level event handlers — applied from any state unless a state
  // defines its own handler for the same event (state-level wins).
  //
  // These are all idempotent, side-effect-free context mutations that
  // should NEVER be silently dropped just because the machine happened
  // to be in the "wrong" state. XState drops unhandled events without
  // any warning, and we've lost days to that exact class of bug — the
  // approval queue getting stuck, HISTORY_LOADED dropped on mount, etc.
  // The rule: if an event only assigns context, it belongs at root.
  on: {
    SET_SESSION_ID: { actions: 'setSessionIdOnly' },
    HISTORY_LOADED: { actions: 'setHistoryItems' },
    APPEND_RESPONSE: { actions: 'appendResponse' },
    ADD_ARTIFACT: { guard: 'acceptLoose', actions: 'addArtifact' },
    APPROVAL_RESOLVED: { actions: 'removeApproval' },
  },

  states: {
    // ----- Idle: waiting for user action -----
    idle: {
      on: {
        SUBMIT: { target: 'starting', actions: 'appendUserMessage' },
        SELECT_SESSION: { target: 'loadingHistory', actions: 'resetSessionState' },
        NEW_SESSION: { target: 'idle', actions: 'resetSessionState', reenter: true },
        // Mount rehydration path: App sends SET_SESSION_ID then HISTORY_LOADED
        // directly, without going through SELECT_SESSION / loadingHistory.
        HISTORY_LOADED: { actions: 'setHistoryItems' },
        // Late-arriving events from a previous run (session-filtered)
        MESSAGE_OUTPUT: { guard: 'acceptStrict', actions: 'bufferPreamble' },
        APPROVAL_RESOLVED: { actions: 'removeApproval' },
        ADD_ARTIFACT: { guard: 'acceptLoose', actions: 'addArtifact' },
        // Direct manipulation (slash commands, external session updates)
        APPEND_RESPONSE: { actions: 'appendResponse' },
        SET_SESSION_ID: { actions: 'setSessionIdOnly' },
      },
    },

    // ----- Loading history for a selected session -----
    loadingHistory: {
      on: {
        HISTORY_LOADED: { target: 'idle', actions: 'setHistoryItems' },
        HISTORY_ERROR: { target: 'idle' },
      },
    },

    // ----- Starting: startRun called, waiting for run_started -----
    starting: {
      on: {
        RUN_STARTED: {
          guard: 'acceptStrictOrStarting',
          target: 'running',
          actions: 'setRunStarted',
        },
        RUN_END: {
          guard: 'acceptLoose',
          target: 'idle',
          actions: 'flushPreamble',
        },
        MESSAGE_OUTPUT: {
          guard: 'acceptStrictOrStarting',
          actions: 'bufferPreamble',
        },
        TOOL_CALLED: {
          guard: 'acceptStrictOrStarting',
          actions: 'appendToolItem',
        },
        TOOL_RESULT: {
          guard: 'acceptStrictOrStarting',
          actions: 'updateToolResult',
        },
        ADD_ARTIFACT: { guard: 'acceptLoose', actions: 'addArtifact' },
        SUBMIT_ERROR: { target: 'idle', actions: 'setSubmitError' },
      },
    },

    // ----- Running: agent is processing -----
    running: {
      on: {
        MESSAGE_OUTPUT: { guard: 'acceptStrict', actions: 'bufferPreamble' },
        TOOL_CALLED: { guard: 'acceptStrict', actions: 'appendToolItem' },
        TOOL_RESULT: { guard: 'acceptStrict', actions: 'updateToolResult' },
        ADD_ARTIFACT: { guard: 'acceptLoose', actions: 'addArtifact' },
        RUN_STATUS: { guard: 'acceptLoose', actions: 'updateRunStatus' },
        TOKEN: { guard: 'acceptLoose' },
        SET_STATUS: { guard: 'acceptLoose', actions: 'setStatusFromServer' },
        REQUEST_APPROVAL: {
          guard: 'acceptStrict',
          target: 'awaitingApproval',
          actions: 'addApproval',
        },
        RUN_END: {
          guard: 'acceptLoose',
          target: 'idle',
          actions: ['flushPreamble', 'clearRunState'],
        },
        STOP: { target: 'stopping', actions: 'markStopping' },
      },
    },

    // ----- Awaiting approval: thinking paused, waiting for user decision -----
    awaitingApproval: {
      on: {
        APPROVAL_DECIDED: [
          // Stay in awaitingApproval if more approvals are still queued
          { guard: 'hasMoreApprovals', actions: 'removeApproval' },
          { target: 'running', actions: 'removeApproval' },
        ],
        APPROVAL_RESOLVED: { actions: 'removeApproval' },
        RUN_END: {
          guard: 'acceptLoose',
          target: 'idle',
          actions: ['flushPreamble', 'clearRunState'],
        },
        // Additional approvals can arrive while one is pending
        REQUEST_APPROVAL: { guard: 'acceptStrict', actions: 'addApproval' },
        // Events can still flow while awaiting approval
        MESSAGE_OUTPUT: { guard: 'acceptStrict', actions: 'bufferPreamble' },
        TOOL_CALLED: { guard: 'acceptStrict', actions: 'appendToolItem' },
        TOOL_RESULT: { guard: 'acceptStrict', actions: 'updateToolResult' },
        ADD_ARTIFACT: { guard: 'acceptLoose', actions: 'addArtifact' },
        RUN_STATUS: { guard: 'acceptLoose', actions: 'updateRunStatus' },
        SET_STATUS: { guard: 'acceptLoose', actions: 'setStatusFromServer' },
      },
    },

    // ----- Stopping: user requested stop, waiting for run_end -----
    stopping: {
      on: {
        RUN_END: {
          guard: 'acceptLoose',
          target: 'idle',
          actions: ['flushPreamble', 'clearRunState'],
        },
        // Events can still arrive while stopping
        MESSAGE_OUTPUT: { guard: 'acceptStrict', actions: 'bufferPreamble' },
        TOOL_CALLED: { guard: 'acceptStrict', actions: 'appendToolItem' },
        TOOL_RESULT: { guard: 'acceptStrict', actions: 'updateToolResult' },
        ADD_ARTIFACT: { guard: 'acceptLoose', actions: 'addArtifact' },
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Exported actor/snapshot types
// ---------------------------------------------------------------------------

export type ChatSessionActor = ActorRefFrom<typeof chatSessionMachine>;
export type ChatSessionSnapshot = SnapshotFrom<typeof chatSessionMachine>;

// ---------------------------------------------------------------------------
// Derived-state helpers
// ---------------------------------------------------------------------------

/** Whether the machine is in a "thinking" state (agent actively processing). */
export function isThinking(phase: ChatSessionPhase): boolean {
  return phase === 'running' || phase === 'starting' || phase === 'stopping';
}
