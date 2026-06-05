/**
 * Cross-session control registry.
 *
 * Each open code column mounts its own omniagents-ui `App` with a private
 * `RPCClient` + chat-session machine. The headless global orchestrator needs to
 * reach *into* those columns — send a message, decide a pending approval, cancel
 * a run — without owning them. Each column registers a small imperative
 * controller here keyed by its `tabId`; the `column_*` client tools resolve a
 * `tab_id` to a controller and drive it.
 *
 * Mirrors the `$liveApps` / voice-mic registries: a plain module-level map the
 * renderer writes on mount and the client-tool handler reads.
 */

import type { MessageItem } from '@/shared/chat-types';

/**
 * Stable, monotonic id for a transcript entry — survives the only two mutations
 * the conversation undergoes that break array indices:
 *   - an approval being decided (its entry is removed, shifting later indices)
 *   - a tool call transitioning `called` → `result` (the item object is replaced)
 * Cursors are assigned in append order, so they're also monotonically increasing
 * along the conversation. A caller polls incrementally with `after: <cursor>`.
 */
export type Cursor = number;

/** Minimal structured signal about the latest transcript entry (for the sweep). */
export type LastEntrySignal = {
  cursor: Cursor;
  kind: 'message' | 'tool' | 'approval' | 'artifact';
  role?: 'user' | 'assistant' | 'system';
  tool?: string;
  status?: 'called' | 'result';
};

/** Snapshot of a column's agent run state, for `list_workspace`. */
export type ColumnRunState = {
  /** A run is currently in flight. */
  running: boolean;
  /** The active run id, if any. */
  runId?: string;
  /** Approvals the agent is blocked on (empty when not awaiting). */
  awaitingApproval: { requestId: string; kind: 'function' | 'mcp'; tool?: string }[];
  /**
   * Transcript shape — total entry count, the high-water `latestCursor` (so a
   * poller can tell at a glance whether it's caught up), and a pointer at the
   * newest entry.
   */
  transcript: { total: number; latestCursor: Cursor | null; last?: LastEntrySignal };
};

/**
 * One transcript entry. `cursor` is its stable monotonic id (use it to poll
 * `after` it, or to `column_read_entry`); `index` is its live array position.
 * `truncated` maps any field that was capped to its FULL length, so loss is
 * visible and quantified — never a silent `…`.
 */
export type TranscriptEntry = { cursor: Cursor; index: number } & (
  | { kind: 'message'; role: 'user' | 'assistant' | 'system'; text: string; truncated?: Record<string, number> }
  | {
      kind: 'tool';
      tool: string;
      status: 'called' | 'result';
      input?: string;
      output?: string;
      truncated?: Record<string, number>;
    }
  | { kind: 'approval'; requestId: string; tool: string; args?: string; truncated?: Record<string, number> }
  | { kind: 'artifact'; title?: string; artifactId?: string }
);

/**
 * A bounded, cursor-addressable window over a column's transcript. Entries are
 * always chronological (ascending cursor). `latestCursor` is the conversation's
 * high-water mark — when it equals the cursor you last saw, you're caught up.
 */
export type TranscriptPage = {
  total: number;
  latestCursor: Cursor | null;
  entries: TranscriptEntry[];
  /** More entries exist beyond this window in the direction being paged. */
  hasMore: boolean;
};

/** Full, untruncated view of a single entry's text fields, addressed by cursor. */
export type FullEntry = { cursor: Cursor; index: number; total: number } & (
  | { kind: 'message'; role: 'user' | 'assistant' | 'system'; text: string }
  | { kind: 'tool'; tool: string; status: 'called' | 'result'; input?: string; output?: string }
  | { kind: 'approval'; requestId: string; tool: string; args?: string }
  | { kind: 'artifact'; title?: string; content?: string }
);

/** Imperative handle a column exposes so others can drive its agent. */
export type SessionController = {
  /** Start a run with `text`, as if the user typed it in that column. */
  sendMessage: (text: string) => void | Promise<unknown>;
  /** Resolve a pending tool-call approval. */
  decideApproval: (requestId: string, decision: 'approve' | 'reject') => void | Promise<unknown>;
  /** Interrupt the in-flight run. */
  stopRun: () => void | Promise<unknown>;
  /** Current run state (read live each call). */
  getState: () => ColumnRunState;
  /**
   * A bounded, cursor-addressable window. `after` polls forward for new entries
   * (incremental); `before` pages backward through history; neither = the tail.
   */
  getTranscript: (opts?: { after?: Cursor; before?: Cursor; limit?: number }) => TranscriptPage;
  /** Full, untruncated single entry by cursor, or null if it no longer exists. */
  getEntry: (cursor: Cursor) => FullEntry | null;
  /**
   * Push a notification into this session (assistant-role, batched, wakes the
   * next turn). Routes to omni-code's `notify` server function. Used to make a
   * headless orchestrator push-driven on cross-session events.
   */
  notify: (content: string, source: string) => Promise<unknown>;
  /** Start a fresh conversation (mints a new session id, no sandbox restart). */
  newSession: () => void;
};

/**
 * Assigns stable, monotonic cursors to conversation items. Tool items key on
 * `call_id` (stable across `called`→`result`); approvals on `request_id`;
 * everything else on object identity (chat/artifact items are never replaced).
 * Stateful — one assigner lives per column controller, so cursors persist across
 * reads and survive removals.
 */
export function createCursorAssigner(): { assign: (items: readonly MessageItem[]) => Cursor[] } {
  let next = 1;
  const byKey = new Map<string, Cursor>();
  const byObj = new WeakMap<object, Cursor>();
  const keyOf = (it: MessageItem): string | null => {
    if (it.type === 'tool' && it.call_id) {
      return `t:${it.call_id}`;
    }
    if (it.type === 'approval') {
      return `a:${it.request_id}`;
    }
    if (it.type === 'artifact' && it.artifact_id) {
      return `f:${it.artifact_id}`;
    }
    return null;
  };
  return {
    assign: (items) =>
      items.map((it) => {
        const k = keyOf(it);
        if (k !== null) {
          const existing = byKey.get(k);
          if (existing !== undefined) {
            return existing;
          }
          const c = next++;
          byKey.set(k, c);
          return c;
        }
        const existing = byObj.get(it);
        if (existing !== undefined) {
          return existing;
        }
        const c = next++;
        byObj.set(it, c);
        return c;
      }),
  };
}

/** Per-field cap for the paged view — generous, and always quantified when hit. */
const FIELD_CAP = 2000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Cap a field; record its full length in `truncated` when cut. */
const capField = (s: string | undefined, key: string, truncated: Record<string, number>): string | undefined => {
  if (s === undefined) {
    return undefined;
  }
  if (s.length > FIELD_CAP) {
    truncated[key] = s.length;
    return s.slice(0, FIELD_CAP);
  }
  return s;
};

const mapEntry = (it: MessageItem, cursor: Cursor, index: number): TranscriptEntry => {
  const t: Record<string, number> = {};
  let entry: TranscriptEntry;
  switch (it.type) {
    case 'chat':
      entry = { cursor, index, kind: 'message', role: it.role, text: capField(it.content, 'text', t) ?? '' };
      break;
    case 'tool':
      entry = {
        cursor,
        index,
        kind: 'tool',
        tool: it.tool,
        status: it.status,
        input: capField(it.input, 'input', t),
        output: capField(it.output, 'output', t),
      };
      break;
    case 'approval':
      entry = {
        cursor,
        index,
        kind: 'approval',
        requestId: it.request_id,
        tool: it.tool,
        args: capField(it.argumentsText, 'args', t),
      };
      break;
    case 'artifact':
      return { cursor, index, kind: 'artifact', title: it.title, artifactId: it.artifact_id };
  }
  return Object.keys(t).length > 0 ? { ...entry, truncated: t } : entry;
};

/**
 * A bounded, cursor-addressable window over the conversation. `cursors[i]` is
 * the stable id of `items[i]` (see `createCursorAssigner`). `after` polls
 * forward for entries newer than a cursor (incremental); `before` pages backward
 * through history; neither returns the tail. Entries are always chronological.
 */
export function transcriptPage(
  items: readonly MessageItem[],
  cursors: readonly Cursor[],
  opts?: { after?: Cursor; before?: Cursor; limit?: number }
): TranscriptPage {
  const total = items.length;
  const limit = Math.max(1, Math.min(opts?.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const latestCursor = total > 0 ? (cursors[total - 1] ?? null) : null;
  const all = items.map((it, i) => mapEntry(it, cursors[i] ?? 0, i));

  let window: TranscriptEntry[];
  let hasMore: boolean;
  if (opts?.after !== undefined) {
    const after = opts.after;
    const matching = all.filter((e) => e.cursor > after);
    window = matching.slice(0, limit);
    hasMore = matching.length > limit;
  } else if (opts?.before !== undefined) {
    const before = opts.before;
    const matching = all.filter((e) => e.cursor < before);
    window = matching.slice(-limit);
    hasMore = matching.length > limit;
  } else {
    window = all.slice(-limit);
    hasMore = all.length > limit;
  }
  return { total, latestCursor, entries: window, hasMore };
}

/** Full, untruncated single entry by cursor. */
export function fullEntry(items: readonly MessageItem[], cursors: readonly Cursor[], cursor: Cursor): FullEntry | null {
  const index = cursors.indexOf(cursor);
  const it = index >= 0 ? items[index] : undefined;
  if (!it) {
    return null;
  }
  const total = items.length;
  switch (it.type) {
    case 'chat':
      return { cursor, index, total, kind: 'message', role: it.role, text: it.content };
    case 'tool':
      return {
        cursor,
        index,
        total,
        kind: 'tool',
        tool: it.tool,
        status: it.status,
        input: it.input,
        output: it.output,
      };
    case 'approval':
      return {
        cursor,
        index,
        total,
        kind: 'approval',
        requestId: it.request_id,
        tool: it.tool,
        args: it.argumentsText,
      };
    case 'artifact':
      return { cursor, index, total, kind: 'artifact', title: it.title, content: it.content };
  }
}

/** Structured pointer at the newest entry — for `list_workspace`, no pre-digesting. */
export function lastEntrySignal(
  items: readonly MessageItem[],
  cursors: readonly Cursor[]
): LastEntrySignal | undefined {
  const index = items.length - 1;
  const it = items[index];
  if (!it) {
    return undefined;
  }
  const cursor = cursors[index] ?? 0;
  switch (it.type) {
    case 'chat':
      return { cursor, kind: 'message', role: it.role };
    case 'tool':
      return { cursor, kind: 'tool', tool: it.tool, status: it.status };
    case 'approval':
      return { cursor, kind: 'approval', tool: it.tool };
    case 'artifact':
      return { cursor, kind: 'artifact' };
  }
}

const registry = new Map<string, SessionController>();

/** Register a column's controller. Returns an unregister fn for cleanup. */
export function registerSessionController(tabId: string, controller: SessionController): () => void {
  registry.set(tabId, controller);
  return () => {
    if (registry.get(tabId) === controller) {
      registry.delete(tabId);
    }
  };
}

/** Look up a column's controller by tabId. */
export function getSessionController(tabId: string): SessionController | undefined {
  return registry.get(tabId);
}

/** Snapshot every registered column's run state (for `list_workspace`). */
export function listSessionRunStates(): Record<string, ColumnRunState> {
  const out: Record<string, ColumnRunState> = {};
  for (const [tabId, controller] of registry.entries()) {
    try {
      out[tabId] = controller.getState();
    } catch {
      out[tabId] = { running: false, awaitingApproval: [], transcript: { total: 0, latestCursor: null } };
    }
  }
  return out;
}

// ─── Column run-end events ──────────────────────────────────────────────────
// A push channel so consumers (the orchestrator watcher) can react the moment a
// column's run finishes, instead of polling `list_workspace`. The column's App
// emits via `emitColumnRunEnd` (threaded through `onRunEnd`); the launcher fans
// out to listeners.

export type ColumnRunEndInfo = { runId?: string; reason?: string };
type RunEndListener = (tabId: string, info: ColumnRunEndInfo) => void;
type RunStartedListener = (tabId: string, runId: string) => void;

const runEndListeners = new Set<RunEndListener>();
const runStartedListeners = new Set<RunStartedListener>();

/** Subscribe to column run-end events. Returns an unsubscribe fn. */
export function onColumnRunEnd(listener: RunEndListener): () => void {
  runEndListeners.add(listener);
  return () => {
    runEndListeners.delete(listener);
  };
}

/** Emit a column run-end event to all listeners (best-effort; never throws). */
export function emitColumnRunEnd(tabId: string, info: ColumnRunEndInfo): void {
  for (const listener of runEndListeners) {
    try {
      listener(tabId, info);
    } catch {
      /* a misbehaving listener must not break the emit */
    }
  }
}

/** Subscribe to column run-started events. Returns an unsubscribe fn. */
export function onColumnRunStarted(listener: RunStartedListener): () => void {
  runStartedListeners.add(listener);
  return () => {
    runStartedListeners.delete(listener);
  };
}

/** Emit a column run-started event to all listeners (best-effort; never throws). */
export function emitColumnRunStarted(tabId: string, runId: string): void {
  for (const listener of runStartedListeners) {
    try {
      listener(tabId, runId);
    } catch {
      /* a misbehaving listener must not break the emit */
    }
  }
}
