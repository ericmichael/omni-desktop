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

// Tools whose user-visible side-effect is painted entirely by client-
// side handlers (notify -> Notifications panel, escalate -> banner,
// goal_complete -> goal state). Their tool_called / tool_result events
// still flow through the agent's history so the LLM sees them, but we
// suppress the transcript row so the docked panel / banner is the
// only render.
const HIDDEN_TOOLS = new Set(['notify', 'escalate', 'goal_complete']);

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
          // prompt: forwarded so the machine can append the originating
          // turn when RUN_STARTED arrives from idle (queued / background-
          // triggered runs). For runs originated by local submit(), the
          // optimistic append already happened and the machine's
          // idempotency check skips the duplicate.
          // prompt_role: tells the machine which role the appended turn
          // should carry — notification batches (worker / bash-job
          // completions) arrive as "assistant" so the wakeup reads as
          // the agent observing its own background activity rather than
          // a fake user message.
          prompt: typeof p?.prompt === 'string' ? p.prompt : undefined,
          prompt_role: typeof p?.prompt_role === 'string' ? p.prompt_role : undefined,
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
        const tool = String(p?.tool ?? '');
        if (HIDDEN_TOOLS.has(tool)) {
          return;
        }
        actor.send({
          type: 'TOOL_CALLED',
          call_id: String(p?.call_id ?? ''),
          tool,
          input: typeof p?.input === 'string' ? p.input : JSON.stringify(p?.input),
          run_id: typeof p?.run_id === 'string' ? p.run_id : undefined,
          session_id: typeof p?.session_id === 'string' ? p.session_id : undefined,
        });
      }),

      client.on('tool_result', (p: any) => {
        const callId = String(p?.call_id ?? '');
        const tool = String(p?.tool ?? '');
        if (HIDDEN_TOOLS.has(tool)) {
          return;
        }
        const output = typeof p?.output === 'string' ? p.output : JSON.stringify(p?.output);
        const metadata = p?.metadata;
        actor.send({
          type: 'TOOL_RESULT',
          call_id: callId,
          tool,
          output,
          metadata,
          run_id: typeof p?.run_id === 'string' ? p.run_id : undefined,
          session_id: typeof p?.session_id === 'string' ? p.session_id : undefined,
        });
        // MCP-Apps: if omniagents attached an ``mcp_ui`` payload, surface
        // it as a standalone artifact in the stream. Tool-card grouping
        // collapses interactive UIs into the activity group; artifacts
        // render full-width with their own framing.
        //
        // Two flavors:
        //   • ``ui.resource`` — inline HTML (mcp-ui demo)
        //   • ``ui.resource_uri`` + ``ui.structured_content`` — shared
        //     renderer fetched via ``mcp.read_resource`` (FastMCP /
        //     Prefab). The McpUiSurface renderer handles both.
        const ui = metadata?.mcp_ui;
        const hasInline = ui?.resource != null;
        const hasResourceUri = typeof ui?.resource_uri === 'string' && ui.resource_uri.length > 0;
        if (ui && (hasInline || hasResourceUri)) {
          actor.send({
            type: 'ADD_ARTIFACT',
            artifact_id: `mcp_ui:${callId || tool}`,
            title: ui.tool_name || tool || 'MCP App',
            content: '',
            mode: 'mcp_ui',
            session_id: typeof p?.session_id === 'string' ? p.session_id : undefined,
            mcp_ui: {
              server_name: String(ui.server_name ?? ''),
              tool_name: String(ui.tool_name ?? tool),
              tool_input: undefined,
              tool_output: output,
              resource: ui.resource,
              resource_uri: hasResourceUri ? ui.resource_uri : undefined,
              structured_content: ui.structured_content,
            },
          });
        }
      }),

      // client_request: route ``ui.set_status`` to the machine. Tool
      // approvals migrated off this channel in omniagents 0.16 — they
      // now ride on the dedicated ``tool_approval_requested`` event
      // (wired below). Artifacts and tool.call stay outside.
      client.on('client_request', (p: any) => {
        const fn = String(p?.function ?? '');

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

      // Tool-approval interruption events (omniagents 0.16+). The server
      // pauses the run on a ``ToolApprovalItem`` and emits
      // ``tool_approval_requested``; we surface it to the state machine
      // and answer back via ``client.toolApprovalResponse``. When
      // another channel responds first, the server broadcasts
      // ``tool_approval_resolved`` so we dismiss the pending card.
      // ``call_id`` is the model-minted tool-call id; the state machine
      // historically uses ``request_id`` for the same role, so we map
      // at the wire boundary rather than touching every machine consumer.
      client.on('tool_approval_requested', (p: any) => {
        const call_id = String(p?.call_id ?? '');
        if (!call_id) {
return;
}
        actor.send({
          type: 'REQUEST_APPROVAL',
          request_id: call_id,
          tool: String(p?.tool_name ?? ''),
          argumentsText: String(p?.arguments ?? ''),
          metadata: p?.metadata,
          session_id: typeof p?.session_id === 'string' ? p.session_id : undefined,
        });
      }),

      client.on('tool_approval_resolved', (p: any) => {
        const call_id = String(p?.call_id ?? '');
        if (call_id) {
          actor.send({ type: 'APPROVAL_RESOLVED', request_id: call_id });
        }
      }),

      // Hosted-MCP approval flow (omniagents 0.16+). Parallel to the
      // function-tool path but keyed by ``request_id`` (the model's
      // ``McpApprovalRequest.id``) and identifies the MCP server via
      // ``server_label``. There is no ``always_approve`` affordance on
      // this path — the server intentionally omits it for MCP.
      client.on('mcp_approval_requested', (p: any) => {
        const request_id = String(p?.request_id ?? '');
        if (!request_id) {
return;
}
        actor.send({
          type: 'REQUEST_APPROVAL',
          request_id,
          tool: String(p?.tool_name ?? ''),
          argumentsText: String(p?.arguments ?? ''),
          metadata: p?.metadata,
          session_id: typeof p?.session_id === 'string' ? p.session_id : undefined,
          kind: 'mcp',
          server_label: typeof p?.server_label === 'string' ? p.server_label : undefined,
        });
      }),

      client.on('mcp_approval_resolved', (p: any) => {
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
  const stagedContext = useSelector(actor, (s) => s.context.stagedContext);
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
    (
      text: string,
      attachments?: Attachment[],
      stagedContext?: ReadonlyArray<{ source: string; text: string }>,
    ) => {
      actor.send({ type: 'SUBMIT', text, attachments, stagedContext });
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
   * Stage content for inclusion in the next user turn (MCP-Apps
   * ``ui/update-model-context``). ``source`` keys per-view so re-stages
   * from the same source replace the prior entry. Pass empty text to
   * clear a specific source.
   */
  const stageContext = useCallback(
    (source: string, text: string) => {
      actor.send({ type: 'STAGE_CONTEXT', source, text });
    },
    [actor],
  );

  /** Drop all staged context entries. Called automatically on submit. */
  const clearStagedContext = useCallback(() => {
    actor.send({ type: 'CLEAR_STAGED_CONTEXT' });
  }, [actor]);

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
    stagedContext,
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
    stageContext,
    clearStagedContext,
  };
}

export type UseChatSessionReturn = ReturnType<typeof useChatSession>;
