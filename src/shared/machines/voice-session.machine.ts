/**
 * XState v5 machine for a hosted realtime voice session.
 *
 * Pure definition — no React, IPC, DOM, or WebAudio imports. The renderer
 * adapter (`@/renderer/services/realtime-voice`) owns the RealtimeRPCClient,
 * mic capture, and playback; it performs the side effects and reports what
 * actually happened as events. The machine owns session phase, mute state,
 * the live transcript (MessageItem-shaped, rendered by the real
 * MessageList), and tool activity.
 *
 * Live-state contract (kills the modal's stuck-THINKING bug):
 *  - attending  — session open, waiting on the user
 *  - responding — model turn in flight, no audio playing yet
 *  - speaking   — audio actually playing (adapter-reported, not inferred)
 * `responding` exits on TURN_ENDED (a no-audio turn still ends), `speaking`
 * exits on PLAYBACK_IDLE / AUDIO_INTERRUPTED / INTERRUPT.
 */
import { assign, setup, type SnapshotFrom } from 'xstate';

import type { ChatMessage, MessageItem, ToolItem } from '@/shared/chat-types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Flattened view of the machine for UI rendering. */
export type VoiceSessionPhase =
  | 'closed'
  | 'connecting'
  | 'starting'
  | 'attending'
  | 'responding'
  | 'speaking'
  | 'stopping'
  | 'error';

/** Orb visual state, derived from phase + mute + tool activity. */
export type VoiceOrbState = 'idle' | 'listening' | 'thinking' | 'speaking';

export type VoiceSessionContext = {
  /** Session id requested on OPEN, replaced by the server-minted id on start. */
  sessionId: string | undefined;
  runId: string | undefined;
  muted: boolean;
  /** Wall-clock start, stamped by the adapter on SESSION_STARTED (machine never calls Date.now()). */
  startedAt: number | undefined;
  /** Live transcript + tool activity, MessageList-renderable. */
  items: MessageItem[];
  /** Identity key per item index (`item:<item_id>` / `tool:<call_id>`), undefined for anonymous items. */
  itemKeys: (string | undefined)[];
  /** items index by identity key — the inverse of `itemKeys`, rebuilt on every reorder. */
  itemIndexByKey: Record<string, number>;
  /** Model-history position per identity key; see `applyHistoryOrder`. */
  itemRank: Record<string, number>;
  /** Name of the currently running tool, for the dock status line. */
  activeTool: string | undefined;
  error: string | undefined;
};

export type VoiceSessionEvent =
  // Adapter-relayed user intents (the adapter performs the side effect first)
  | { type: 'OPEN'; sessionId?: string }
  | { type: 'CLOSE' }
  | { type: 'TOGGLE_MUTE' }
  | { type: 'INTERRUPT' }
  | { type: 'SEND_TEXT'; text: string }
  // Connection lifecycle (from adapter)
  | { type: 'CONNECTED' }
  | { type: 'CONNECT_ERROR'; message: string }
  | { type: 'SESSION_STARTED'; sessionId: string; runId: string; at: number }
  | { type: 'STOPPED' }
  | { type: 'DISCONNECTED'; message?: string }
  // Server events (mapped 1:1 from realtime_event notifications)
  | { type: 'TURN_STARTED' }
  | { type: 'RESPONSE_START' }
  | { type: 'TURN_ENDED' }
  | { type: 'TRANSCRIPT_DELTA'; itemId: string; delta: string }
  | { type: 'TRANSCRIPT_FINAL'; itemId: string; role: 'user' | 'assistant'; text: string }
  /** The model's ordered item ids (realtime_history_updated) — authoritative over arrival order. */
  | { type: 'HISTORY_ORDER'; itemIds: string[] }
  | { type: 'TOOL_START'; callId: string; tool: string; input?: string }
  | { type: 'TOOL_END'; callId: string; tool: string; output?: string }
  | { type: 'SERVER_ERROR'; message: string }
  // Playback reality (from the adapter's playback tracker)
  | { type: 'PLAYBACK_ACTIVE' }
  | { type: 'PLAYBACK_IDLE' }
  | { type: 'AUDIO_INTERRUPTED' };

const INITIAL_CONTEXT: VoiceSessionContext = {
  sessionId: undefined,
  runId: undefined,
  muted: false,
  startedAt: undefined,
  items: [],
  itemKeys: [],
  itemIndexByKey: {},
  itemRank: {},
  activeTool: undefined,
  error: undefined,
};

// ---------------------------------------------------------------------------
// Item reducers (pure helpers)
// ---------------------------------------------------------------------------

type ItemsSlice = Pick<VoiceSessionContext, 'items' | 'itemKeys' | 'itemIndexByKey' | 'itemRank'>;

/** Rebuild the key→index map for a freshly ordered item list. */
function reindex(ctx: ItemsSlice, items: MessageItem[], itemKeys: (string | undefined)[]): ItemsSlice {
  const itemIndexByKey: Record<string, number> = {};
  itemKeys.forEach((key, index) => {
    if (key !== undefined) {
      itemIndexByKey[key] = index;
    }
  });
  return { ...ctx, items, itemKeys, itemIndexByKey };
}

/** Append one item under `key` (undefined = anonymous), then settle the order. */
function appendItem(ctx: ItemsSlice, item: MessageItem, key?: string): ItemsSlice {
  return applyHistoryOrder(reindex(ctx, [...ctx.items, item], [...ctx.itemKeys, key]));
}

/**
 * Re-order the transcript into the model's own item order.
 *
 * The realtime API transcribes the user's audio asynchronously, so the
 * assistant's first delta normally lands BEFORE the transcript of the
 * utterance that caused it: appended in arrival order, the answer renders
 * above the question until the canonical reload on close fixes it.
 * `realtime_history_updated` carries the model's ordered item ids and fires
 * when transcription completes — exactly the moment arrival order goes
 * wrong — so that ranking, not arrival, decides position.
 *
 * Items the history never names (tool cards, typed messages) have no rank
 * of their own; each inherits the rank of the item it followed so it stays
 * attached to that message rather than drifting to one end, and equal ranks
 * keep arrival order, which makes the sort stable.
 */
function applyHistoryOrder(ctx: ItemsSlice): ItemsSlice {
  if (!ctx.items.length) {
    return ctx;
  }
  let inherited = -1;
  const decorated = ctx.items.map((item, index) => {
    const key = ctx.itemKeys[index];
    const own = key === undefined ? undefined : ctx.itemRank[key];
    if (own !== undefined) {
      inherited = own;
    }
    return { item, key, index, rank: own ?? inherited };
  });
  const sorted = [...decorated].sort((a, b) => a.rank - b.rank || a.index - b.index);
  if (sorted.every((d, i) => d.index === i)) {
    return ctx; // already in order — keep identities stable for React
  }
  return reindex(
    ctx,
    sorted.map((d) => d.item),
    sorted.map((d) => d.key)
  );
}

function upsertTranscriptDelta(ctx: ItemsSlice, itemId: string, delta: string): ItemsSlice {
  const key = `item:${itemId || 'anon'}`;
  const index = ctx.itemIndexByKey[key];
  if (index !== undefined) {
    const existing = ctx.items[index];
    if (existing?.type === 'chat') {
      const items = [...ctx.items];
      items[index] = { ...existing, content: existing.content + delta };
      return { ...ctx, items };
    }
  }
  const msg: ChatMessage = { type: 'chat', role: 'assistant', content: delta, item_id: itemId || undefined };
  return appendItem(ctx, msg, key);
}

function upsertTranscriptFinal(ctx: ItemsSlice, itemId: string, role: 'user' | 'assistant', text: string): ItemsSlice {
  if (!text) {
    return ctx;
  }
  const key = `item:${itemId || 'anon'}`;
  const index = itemId ? ctx.itemIndexByKey[key] : undefined;
  if (index !== undefined) {
    const existing = ctx.items[index];
    if (existing?.type === 'chat') {
      // Final replaces delta-built text (server contract: authoritative).
      const items = [...ctx.items];
      items[index] = { ...existing, role, content: text };
      return { ...ctx, items };
    }
  }
  const msg: ChatMessage = { type: 'chat', role, content: text, item_id: itemId || undefined };
  return appendItem(ctx, msg, itemId ? key : undefined);
}

function upsertToolStart(ctx: ItemsSlice, callId: string, tool: string, input?: string): ItemsSlice {
  const key = `tool:${callId || tool}`;
  const index = ctx.itemIndexByKey[key];
  if (index !== undefined) {
    return ctx; // duplicate start (reconnect replay)
  }
  const item: ToolItem = { type: 'tool', call_id: callId || undefined, tool, input, status: 'called' };
  return appendItem(ctx, item, key);
}

function upsertToolEnd(ctx: ItemsSlice, callId: string, tool: string, output?: string): ItemsSlice {
  // realtime_tool_end may arrive without a call_id — fall back to the last
  // still-running tool item with the same name, then to any running one.
  let index: number | undefined = callId ? ctx.itemIndexByKey[`tool:${callId}`] : undefined;
  if (index === undefined) {
    for (let i = ctx.items.length - 1; i >= 0; i--) {
      const it = ctx.items[i];
      if (it?.type === 'tool' && it.status === 'called' && (it.tool === tool || !tool)) {
        index = i;
        break;
      }
    }
  }
  if (index === undefined) {
    const item: ToolItem = { type: 'tool', call_id: callId || undefined, tool, output, status: 'result' };
    return appendItem(ctx, item, callId ? `tool:${callId}` : undefined);
  }
  const existing = ctx.items[index];
  if (existing?.type !== 'tool') {
    return ctx;
  }
  const items = [...ctx.items];
  items[index] = { ...existing, status: 'result', output };
  return { ...ctx, items };
}

// ---------------------------------------------------------------------------
// Machine
// ---------------------------------------------------------------------------

export const voiceSessionMachine = setup({
  types: {
    context: {} as VoiceSessionContext,
    events: {} as VoiceSessionEvent,
  },

  actions: {
    resetForOpen: assign(({ event }) => ({
      ...INITIAL_CONTEXT,
      sessionId: (event as Extract<VoiceSessionEvent, { type: 'OPEN' }>).sessionId,
    })),

    setStarted: assign(({ event }) => {
      const e = event as Extract<VoiceSessionEvent, { type: 'SESSION_STARTED' }>;
      return { sessionId: e.sessionId, runId: e.runId, startedAt: e.at, error: undefined };
    }),

    setConnectError: assign(({ event }) => ({
      error: (event as Extract<VoiceSessionEvent, { type: 'CONNECT_ERROR' }>).message,
    })),

    setDisconnected: assign(({ event }) => ({
      error: (event as Extract<VoiceSessionEvent, { type: 'DISCONNECTED' }>).message ?? 'Voice connection lost',
    })),

    setServerError: assign(({ event }) => ({
      error: (event as Extract<VoiceSessionEvent, { type: 'SERVER_ERROR' }>).message,
    })),

    toggleMute: assign(({ context }) => ({ muted: !context.muted })),

    clearOnClose: assign(() => ({ ...INITIAL_CONTEXT })),

    appendSentText: assign(({ context, event }) => {
      const e = event as Extract<VoiceSessionEvent, { type: 'SEND_TEXT' }>;
      const text = e.text.trim();
      if (!text) {
        return {};
      }
      const msg: ChatMessage = { type: 'chat', role: 'user', content: text };
      return appendItem(context, msg);
    }),

    applyTranscriptDelta: assign(({ context, event }) => {
      const e = event as Extract<VoiceSessionEvent, { type: 'TRANSCRIPT_DELTA' }>;
      return upsertTranscriptDelta(context, e.itemId, e.delta);
    }),

    applyTranscriptFinal: assign(({ context, event }) => {
      const e = event as Extract<VoiceSessionEvent, { type: 'TRANSCRIPT_FINAL' }>;
      return upsertTranscriptFinal(context, e.itemId, e.role, e.text);
    }),

    applyHistoryOrder: assign(({ context, event }) => {
      const e = event as Extract<VoiceSessionEvent, { type: 'HISTORY_ORDER' }>;
      const itemRank: Record<string, number> = {};
      e.itemIds.forEach((id, index) => {
        if (id) {
          itemRank[`item:${id}`] = index;
        }
      });
      return applyHistoryOrder({ ...context, itemRank });
    }),

    applyToolStart: assign(({ context, event }) => {
      const e = event as Extract<VoiceSessionEvent, { type: 'TOOL_START' }>;
      return { ...upsertToolStart(context, e.callId, e.tool, e.input), activeTool: e.tool };
    }),

    applyToolEnd: assign(({ context, event }) => {
      const e = event as Extract<VoiceSessionEvent, { type: 'TOOL_END' }>;
      return { ...upsertToolEnd(context, e.callId, e.tool, e.output), activeTool: undefined };
    }),
  },
}).createMachine({
  id: 'voiceSession',
  context: INITIAL_CONTEXT,

  initial: 'closed',

  // Transcript, tool, and mute events apply in every non-closed state — a
  // late final after TURN_ENDED still lands, and mute is always togglable.
  on: {
    TRANSCRIPT_DELTA: { actions: 'applyTranscriptDelta' },
    TRANSCRIPT_FINAL: { actions: 'applyTranscriptFinal' },
    HISTORY_ORDER: { actions: 'applyHistoryOrder' },
    TOOL_START: { actions: 'applyToolStart' },
    TOOL_END: { actions: 'applyToolEnd' },
    TOGGLE_MUTE: { actions: 'toggleMute' },
    SEND_TEXT: { actions: 'appendSentText' },
    SERVER_ERROR: { actions: 'setServerError' },
  },

  states: {
    closed: {
      entry: 'clearOnClose',
      on: {
        OPEN: { target: 'connecting', actions: 'resetForOpen' },
      },
    },

    connecting: {
      on: {
        CONNECTED: 'starting',
        CONNECT_ERROR: { target: 'error', actions: 'setConnectError' },
        CLOSE: 'stopping',
      },
    },

    starting: {
      on: {
        SESSION_STARTED: { target: 'live', actions: 'setStarted' },
        CONNECT_ERROR: { target: 'error', actions: 'setConnectError' },
        DISCONNECTED: { target: 'error', actions: 'setDisconnected' },
        CLOSE: 'stopping',
      },
    },

    live: {
      initial: 'attending',
      on: {
        CLOSE: 'stopping',
        DISCONNECTED: { target: 'error', actions: 'setDisconnected' },
      },
      states: {
        attending: {
          on: {
            TURN_STARTED: 'responding',
            RESPONSE_START: 'responding',
            PLAYBACK_ACTIVE: 'speaking',
          },
        },
        responding: {
          on: {
            PLAYBACK_ACTIVE: 'speaking',
            TURN_ENDED: 'attending',
          },
        },
        speaking: {
          on: {
            PLAYBACK_IDLE: 'attending',
            AUDIO_INTERRUPTED: 'attending',
            INTERRUPT: 'attending',
          },
        },
      },
    },

    stopping: {
      on: {
        STOPPED: 'closed',
        DISCONNECTED: 'closed',
      },
    },

    error: {
      on: {
        CLOSE: 'stopping',
        OPEN: { target: 'connecting', actions: 'resetForOpen' },
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

type VoiceSnapshot = SnapshotFrom<typeof voiceSessionMachine>;

export function voicePhase(snapshot: VoiceSnapshot): VoiceSessionPhase {
  if (snapshot.matches('closed')) {
    return 'closed';
  }
  if (snapshot.matches('connecting')) {
    return 'connecting';
  }
  if (snapshot.matches('starting')) {
    return 'starting';
  }
  if (snapshot.matches({ live: 'responding' })) {
    return 'responding';
  }
  if (snapshot.matches({ live: 'speaking' })) {
    return 'speaking';
  }
  if (snapshot.matches({ live: 'attending' })) {
    return 'attending';
  }
  if (snapshot.matches('stopping')) {
    return 'stopping';
  }
  return 'error';
}

/** True in every state where the session is (or is becoming) active — the dock renders. */
export function voiceActive(snapshot: VoiceSnapshot): boolean {
  return !snapshot.matches('closed');
}

/** Orb visual state derived from phase + mute (never stored separately). */
export function voiceOrbState(snapshot: VoiceSnapshot): VoiceOrbState {
  const phase = voicePhase(snapshot);
  if (phase === 'responding') {
    return 'thinking';
  }
  if (phase === 'speaking') {
    return 'speaking';
  }
  if (phase === 'attending' && !snapshot.context.muted) {
    return 'listening';
  }
  return 'idle';
}
