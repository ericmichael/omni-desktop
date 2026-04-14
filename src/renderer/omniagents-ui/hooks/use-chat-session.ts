/**
 * React hook that wraps the chat-session XState machine.
 *
 * Wires RPC client events → machine events and exposes fine-grained
 * selectors + action methods for the component layer.
 */
import { useActorRef, useSelector } from '@xstate/react';
import { useCallback, useEffect } from 'react';

import type { RPCClient } from '@/renderer/omniagents-ui/rpc/client';
import type { Attachment } from '@/shared/chat-types';
import {
  chatSessionMachine,
  type ChatSessionPhase,
  isThinking,
} from '@/shared/machines/chat-session.machine';
import { createMachineLogger } from '@/shared/machines/machine-logger';

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

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
  const phase = useSelector(actor, (s) => s.value as ChatSessionPhase);
  const thinking = useSelector(actor, (s) => isThinking(s.value as ChatSessionPhase));

  // --- Action methods ---

  /** Send SUBMIT to the machine. Caller is responsible for calling client.startRun(). */
  const submit = useCallback(
    (text: string, sessionId: string, attachments?: Attachment[]) => {
      actor.send({ type: 'SUBMIT', text, sessionId, attachments });
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
    // Actions
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
