/**
 * Transcript item construction — the pure `(items, event) → items` core
 * shared by every stream that produces a transcript.
 *
 * Two callers today: the chat-session machine (the visible session's own
 * run) and the subagent transcript store (a nested agent-tool run relayed
 * over ``ui.subagent.event``). Both consume payloads produced by the same
 * server-side mapper (``omniagents.core.runtime.bridge.stream_event_payload``),
 * so they must build items identically — a nested explorer run has to read
 * exactly like the session's own machinery, not like a second dialect.
 *
 * Pure — no React, no IPC, no DOM, no XState.
 */
import type { ChatItemMetadata, ChatMessage, MessageItem, ToolItem } from '@/shared/chat-types';

/** Tools whose calls are machinery for another surface, never transcript
 *  rows: ``notify`` feeds the notifications panel, ``escalate`` the
 *  escalation banner, ``goal_complete`` the goal state. */
export const HIDDEN_TOOLS: ReadonlySet<string> = new Set(['notify', 'escalate', 'goal_complete']);

/** The ``tool_called`` payload's transcript-bearing fields. */
export type ToolCalledFields = {
  call_id: string;
  tool: string;
  input?: string;
  metadata?: ChatItemMetadata;
  server_label?: string;
  tool_label?: string;
};

/** The ``tool_result`` payload's transcript-bearing fields. */
export type ToolResultFields = {
  call_id: string;
  tool: string;
  output?: string;
  metadata?: ChatItemMetadata;
  server_label?: string;
  tool_label?: string;
};

/**
 * Live narration lands in the transcript IMMEDIATELY as a normal assistant
 * message, stamped with the run identity. Live items carry no canonical
 * envelope, so the runId stamp is what lets activity grouping fold the
 * narration into the run's chain the moment later machinery from the same
 * run arrives — matching what a reload rebuilds from canonical history
 * (agent_message items with a turn_id).
 *
 * Prefer provider message identity, including when canonical persistence
 * arrives first. Older ID-less producers retain the (runId, content) fallback.
 */
export function appendAssistantMessage(
  items: MessageItem[],
  content: string,
  runId: string | undefined,
  messageId?: string
): MessageItem[] {
  const dup = items.some(
    (it) =>
      it.type === 'chat' &&
      it.role === 'assistant' &&
      (messageId ? it.message_id === messageId : it.runId === runId && it.content === content)
  );
  if (dup) {
    return items;
  }
  const msg: ChatMessage = {
    type: 'chat',
    role: 'assistant',
    content,
    runId,
    ...(messageId ? { message_id: messageId } : {}),
  };
  return [...items, msg];
}

/**
 * Upsert by run + call_id: a live tool_called can arrive after the same call was
 * already rehydrated from the canonical transcript (late attach, post-resync
 * replay) — appending blindly would duplicate it.
 */
export function upsertToolCall(items: MessageItem[], e: ToolCalledFields, runId: string | undefined): MessageItem[] {
  const item: ToolItem = {
    type: 'tool',
    tool: e.tool,
    server_label: e.server_label,
    tool_label: e.tool_label,
    input: e.input,
    call_id: e.call_id,
    status: 'called',
    metadata: e.metadata,
    runId,
  };
  const idx = items.findIndex((it) => it.type === 'tool' && it.call_id === e.call_id && it.runId === runId);
  if (idx >= 0 && (items[idx] as ToolItem).status === 'result') {
    return items;
  }
  const next = idx >= 0 ? items.slice() : [...items, item];
  if (idx >= 0) {
    next[idx] = { ...(next[idx] as ToolItem), ...item };
  }
  return next;
}

/**
 * Settle the call's row with its output. A result whose call was never seen
 * (dropped beat, late attach) still renders — it becomes a settled row on
 * its own rather than vanishing.
 */
export function applyToolResult(items: MessageItem[], e: ToolResultFields, runId: string | undefined): MessageItem[] {
  const idx = items.findIndex((it) => it.type === 'tool' && it.call_id === e.call_id && it.runId === runId);
  const next = items.slice();
  if (idx >= 0) {
    const prev = next[idx] as ToolItem;
    if (prev.status === 'result') {
      return items;
    }
    next[idx] = {
      ...prev,
      output: e.output,
      status: 'result',
      metadata: e.metadata,
      server_label: e.server_label ?? prev.server_label,
      tool_label: e.tool_label ?? prev.tool_label,
    };
  } else {
    next.push({
      type: 'tool',
      tool: e.tool,
      server_label: e.server_label,
      tool_label: e.tool_label,
      output: e.output,
      call_id: e.call_id,
      status: 'result',
      metadata: e.metadata,
      runId,
    });
  }
  return next;
}
