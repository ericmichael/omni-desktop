/**
 * React hook that wraps the chat-session XState machine.
 *
 * Wires RPC client events → machine events and exposes fine-grained
 * selectors + action methods for the component layer.
 */
import { useActorRef, useSelector } from '@xstate/react';
import { useCallback, useEffect } from 'react';

import { uuidv4 } from '@/lib/uuid';

import { rehydrateHistory } from '@/lib/rehydrate-history';
import type { RPCClient } from '@/renderer/omniagents-ui/rpc/client';
import type { Attachment, MessageItem } from '@/shared/chat-types';
import {
  chatSessionMachine,
  type ChatSessionPhase,
  isThinking,
} from '@/shared/machines/chat-session.machine';
import { createMachineLogger } from '@/shared/machines/machine-logger';

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Flatten the hierarchical machine state value into a single phase string.
 * Top-level states (`initializing`, `initError`) pass through as-is; nested
 * `ready.*` states are unwrapped to their sub-state name.
 */
function flattenPhase(value: unknown): ChatSessionPhase {
  if (typeof value === 'string') {
    return value as ChatSessionPhase;
  }
  if (value && typeof value === 'object' && 'ready' in value) {
    const inner = (value as { ready?: unknown }).ready;
    if (typeof inner === 'string') {
      return inner as ChatSessionPhase;
    }
  }
  return 'initializing';
}

export function useChatSession(client: RPCClient) {
  const actor = useActorRef(chatSessionMachine, {
    inspect: createMachineLogger('chatSession'),
  });

  // --- Wire RPC events → machine events (thin adapter, no logic) ---
  useEffect(() => {
    const offs = [
      client.on('message_output', (p: any) => {
        const content = String(p?.content ?? '');
        if (!content) {
return;
}
        actor.send({
          type: 'MESSAGE_OUTPUT',
          content,
          session_id: typeof p?.session_id === 'string' ? p.session_id : undefined,
        });
      }),

      client.on('run_started', (p: any) => {
        actor.send({
          type: 'RUN_STARTED',
          run_id: String(p?.run_id ?? ''),
          session_id: typeof p?.session_id === 'string' ? p.session_id : undefined,
        });
      }),

      client.on('run_end', (p: any) => {
        actor.send({
          type: 'RUN_END',
          session_id: typeof p?.session_id === 'string' ? p.session_id : undefined,
        });
      }),

      client.on('run_status', (p: any) => {
        const msg = [p?.status, p?.message].filter(Boolean).join(': ');
        actor.send({
          type: 'RUN_STATUS',
          text: msg,
          session_id: typeof p?.session_id === 'string' ? p.session_id : undefined,
        });
      }),

      client.on('token', (p: any) => {
        actor.send({
          type: 'TOKEN',
          session_id: typeof p?.session_id === 'string' ? p.session_id : undefined,
        });
      }),

      client.on('tool_called', (p: any) => {
        actor.send({
          type: 'TOOL_CALLED',
          call_id: String(p?.call_id ?? ''),
          tool: String(p?.tool ?? ''),
          input: typeof p?.input === 'string' ? p.input : JSON.stringify(p?.input),
          run_id: typeof p?.run_id === 'string' ? p.run_id : undefined,
          session_id: typeof p?.session_id === 'string' ? p.session_id : undefined,
        });
      }),

      client.on('tool_result', (p: any) => {
        actor.send({
          type: 'TOOL_RESULT',
          call_id: String(p?.call_id ?? ''),
          tool: String(p?.tool ?? ''),
          output: typeof p?.output === 'string' ? p.output : JSON.stringify(p?.output),
          metadata: p?.metadata,
          run_id: typeof p?.run_id === 'string' ? p.run_id : undefined,
          session_id: typeof p?.session_id === 'string' ? p.session_id : undefined,
        });
      }),

      // client_request: only route approval + set_status to the machine.
      // Artifacts and tool.call stay outside (separate concerns).
      client.on('client_request', (p: any) => {
        const fn = String(p?.function ?? '');

        if (fn === 'ui.request_tool_approval') {
          const args = p?.args || {};
          const request_id = String(p?.request_id ?? '');
          if (!request_id) {
return;
}
          actor.send({
            type: 'REQUEST_APPROVAL',
            request_id,
            tool: String(args?.tool ?? ''),
            argumentsText: String(args?.arguments ?? ''),
            metadata: args?.metadata,
            session_id: typeof p?.session_id === 'string' ? p.session_id : undefined,
          });
          return;
        }

        if (fn === 'ui.set_status') {
          const request_id = String(p?.request_id ?? '');
          const args = p?.args || {};
          actor.send({
            type: 'SET_STATUS',
            text: typeof args?.text === 'string' ? args.text : undefined,
            showSpinner: typeof args?.show_spinner === 'boolean' ? !!args.show_spinner : true,
            session_id: typeof p?.session_id === 'string' ? p.session_id : undefined,
          });
          // Still need to ACK — handled outside the machine
          if (request_id) {
            client.clientResponse(request_id, true, { ack: true }).catch(() => {});
          }
          return;
        }
      }),

      client.on('client_request_resolved', (p: any) => {
        const request_id = String(p?.request_id ?? '');
        if (request_id) {
          actor.send({ type: 'APPROVAL_RESOLVED', request_id });
        }
      }),
    ];

    return () => offs.forEach((off) => off());
  }, [client, actor]);

  // --- Fine-grained selectors ---
  const sessionId = useSelector(actor, (s) => s.context.sessionId);
  const runId = useSelector(actor, (s) => s.context.runId);
  const items = useSelector(actor, (s) => s.context.items);
  const preamble = useSelector(actor, (s) => s.context.preamble);
  const status = useSelector(actor, (s) => s.context.status);
  const statusSpinner = useSelector(actor, (s) => s.context.statusSpinner);
  const statusItalic = useSelector(actor, (s) => s.context.statusItalic);
  const toolStatus = useSelector(actor, (s) => s.context.toolStatus);
  // Hierarchical snapshot value: either a string (initializing, initError)
  // or { ready: 'idle' | 'starting' | ... }. Flatten to a single union.
  const phase = useSelector(actor, (s) => flattenPhase(s.value));
  const thinking = useSelector(actor, (s) => isThinking(flattenPhase(s.value)));

  // --- Action methods ---

  /**
   * Send SUBMIT to the machine. The caller must still call
   * `client.startRun()` using the `sessionId` from the hook's state — the
   * machine no longer accepts a sessionId here because it's already bound
   * to the session via the prior loadSession() call.
   */
  const submit = useCallback(
    (text: string, attachments?: Attachment[]) => {
      actor.send({ type: 'SUBMIT', text, attachments });
    },
    [actor],
  );

  /** Report that client.startRun() failed. */
  const submitError = useCallback(
    (error: string) => {
      actor.send({ type: 'SUBMIT_ERROR', error });
    },
    [actor],
  );

  /** Send STOP to the machine. Caller is responsible for calling client.stopRun(). */
  const stop = useCallback(() => {
    actor.send({ type: 'STOP' });
  }, [actor]);

  /** Select a session (loads history externally). */
  const selectSession = useCallback(
    (id: string) => {
      actor.send({ type: 'SELECT_SESSION', id });
    },
    [actor],
  );

  /** Report that history was loaded for the selected session. */
  const historyLoaded = useCallback(
    (items: any[]) => {
      actor.send({ type: 'HISTORY_LOADED', items });
    },
    [actor],
  );

  /** Report that history loading failed. */
  const historyError = useCallback(
    (error: string) => {
      actor.send({ type: 'HISTORY_ERROR', error });
    },
    [actor],
  );

  /** Start a new session (clears state, sets new sessionId). */
  const newSession = useCallback(
    (sessionId: string) => {
      actor.send({ type: 'NEW_SESSION', sessionId });
    },
    [actor],
  );

  /** Respond to a tool approval request. Caller is responsible for calling client.clientResponse(). */
  const approvalDecided = useCallback(
    (request_id: string, value: 'yes' | 'always' | 'no') => {
      actor.send({ type: 'APPROVAL_DECIDED', request_id, value });
    },
    [actor],
  );


  /** Append an assistant response message (e.g. slash command result). */
  const appendResponse = useCallback(
    (content: string) => {
      actor.send({ type: 'APPEND_RESPONSE', content });
    },
    [actor],
  );

  /** Add or update an inline artifact in the conversation stream. */
  const addArtifact = useCallback(
    (args: { artifact_id?: string; title: string; content: string; mode?: string; session_id?: string }) => {
      actor.send({ type: 'ADD_ARTIFACT', ...args });
    },
    [actor],
  );

  /** Set session ID without resetting state (e.g. external session assignment). */
  const setSessionId = useCallback(
    (sessionId: string) => {
      actor.send({ type: 'SET_SESSION_ID', sessionId });
    },
    [actor],
  );

  /**
   * High-level: load a session end-to-end. This is the ONE call every
   * consumer should use. It owns the choreography that used to be
   * repeated imperatively at every call site:
   *
   *   SELECT_SESSION → fetch history → HISTORY_LOADED / HISTORY_ERROR
   *
   * Passing `undefined` (or omitting the id) starts a fresh session.
   *
   * Forgetting a step in the imperative version was the root cause of the
   * mount-rehydration bug; this API makes that mistake impossible.
   */
  const loadSession = useCallback(
    async (id: string | undefined): Promise<string> => {
      if (!id) {
        // Fresh session — mint the UUID exactly once, here. This is the
        // ONLY place in the client that generates a session id; every
        // other caller (mount effect, "new chat" button, etc.) flows
        // through loadSession so we can't drift.
        const newId = uuidv4();
        actor.send({ type: 'NEW_SESSION', sessionId: newId });
        return newId;
      }
      actor.send({ type: 'SELECT_SESSION', id });
      const profile =
        typeof localStorage !== 'undefined' && localStorage.getItem('debug:profile') === '1';
      try {
        const t0 = profile ? performance.now() : 0;
        const raw = await client.getSessionHistory(id);
        const tFetched = profile ? performance.now() : 0;
        const msgs = rehydrateHistory(raw as Record<string, unknown>[]) as MessageItem[];
        if (profile) {
          const tEnd = performance.now();
          const rawLen = Array.isArray(raw) ? raw.length : 0;

          console.log(
            `[profile] loadSession session=${id} fetch_ms=${(tFetched - t0).toFixed(1)} ` +
              `rehydrate_ms=${(tEnd - tFetched).toFixed(1)} total_ms=${(tEnd - t0).toFixed(1)} ` +
              `raw_items=${rawLen} rehydrated_items=${msgs.length}`,
          );
        }
        actor.send({ type: 'HISTORY_LOADED', items: msgs });
      } catch (err) {
        actor.send({ type: 'HISTORY_ERROR', error: String((err as Error)?.message || err) });
      }
      return id;
    },
    [actor, client],
  );

  return {
    // Actor (for advanced usage / subscriptions)
    actor,
    // State
    sessionId,
    runId,
    items,
    preamble,
    status,
    statusSpinner,
    statusItalic,
    toolStatus,
    phase,
    thinking,
    // High-level action
    loadSession,
    // Low-level actions (prefer loadSession where possible)
    submit,
    submitError,
    stop,
    selectSession,
    historyLoaded,
    historyError,
    newSession,
    approvalDecided,
    appendResponse,
    addArtifact,
    setSessionId,
  };
}

export type UseChatSessionReturn = ReturnType<typeof useChatSession>;
