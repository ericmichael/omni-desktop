import { atom, map } from 'nanostores';

import type { ChatItemMetadata, MessageItem } from '@/shared/chat-types';
import { appendAssistantMessage, applyToolResult, HIDDEN_TOOLS, upsertToolCall } from '@/shared/transcript-items';

import type { TaskSummary } from './canonical-plan-tasks';

/**
 * Per-session background-activity state: everything a session spawned that
 * runs outside the visible turn — subagents (background workers, agent-tool
 * runs) and background bash jobs.
 *
 * Published by the embedded chat app (which owns the RPC connection and
 * receives ``ui.subagents.update`` / ``ui.subagent.event`` /
 * ``ui.bash_jobs.update``). This store is the single source of truth for
 * that data: the chat app's pill row and the Agents sidecar app both read
 * it back, so they cannot disagree. Keyed by sessionId because deck columns
 * and sidecar bodies identify a conversation by session, not by React
 * ancestry.

 */

/** Mirror of the server's unified subagent snapshot entry
 *  (``omniagents.core.runtime.subagents``): background workers and
 *  agent-tool runs share the shape, discriminated by ``kind``. */
export type SubagentSummary = {
  subagent_id: string;
  kind: 'worker' | 'agent_tool';
  /** Agent name, for agent_tool runs. */
  agent?: string;
  /** Present on worker entries only — the id ``workers.kill`` accepts. */
  worker_id?: string;
  status: 'running' | 'completed' | 'cancelled' | 'error';
  task: string;
  parent_session_id: string | null;
  session_id: string;
  run_id: string;
  result: string | null;
  error: string | null;
  isolation: string | null;
  started_at: number | null;
  finished_at: number | null;
  wall_time_ms: number | null;
};

/** Mirror of a ``bash_jobs.*`` snapshot entry (omni-code background bash). */
export type BashJobSummary = {
  job_id: string;
  pid: number;
  command: string;
  running: boolean;
  exit_code: number | null;
  wall_time_ms: number;
  started_at?: number;
  log_path?: string;
  cwd?: string;
};

export type WorkersKillResult = {
  ok: boolean;
  status?: string;
  snapshot?: unknown[];
  error?: string;
  message?: string;
};

export type BashJobsKillResult = {
  ok: boolean;
  signal_sent?: 'none' | 'SIGTERM' | 'SIGKILL';
  job?: BashJobSummary;
  snapshot?: BashJobSummary[];
  error?: string;
};

export type BashJobsTailResult = {
  ok: boolean;
  text?: string;
  total_lines?: number;
  job?: BashJobSummary;
  error?: string;
  message?: string;
};

export type SessionActivity = {
  subagents: SubagentSummary[];
  jobs: BashJobSummary[];
};

const EMPTY: SessionActivity = { subagents: [], jobs: [] };

export const $activityBySession = map<Record<string, SessionActivity>>({});

/** Legacy ``ui.workers.update`` entries (pinned older servers) carry no
 *  ``subagent_id``/``kind``; the unified bus always sets both. */
export function normalizeSubagentSnapshot(snapshot: unknown[]): SubagentSummary[] {
  return snapshot
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    .map((entry): SubagentSummary => {
      const workerId = typeof entry.worker_id === 'string' ? entry.worker_id : undefined;
      return {
        ...(entry as unknown as SubagentSummary),
        subagent_id: typeof entry.subagent_id === 'string' ? entry.subagent_id : (workerId ?? ''),
        kind: entry.kind === 'agent_tool' ? 'agent_tool' : 'worker',
        worker_id: workerId,
      };
    })
    .filter((entry) => entry.subagent_id !== '');
}

export function publishSubagentsSnapshot(sessionId: string, subagents: SubagentSummary[]): void {
  const prev = $activityBySession.get()[sessionId] ?? EMPTY;
  $activityBySession.setKey(sessionId, { ...prev, subagents });
  pruneSubagentTranscripts(sessionId, new Set(subagents.map((s) => s.subagent_id)));
}

/** Fold a workers-only snapshot (``workers.kill`` response) into the
 *  session's unified list, preserving agent-tool entries until the next
 *  bus broadcast replaces them. */
export function mergeWorkersSnapshot(sessionId: string, workers: SubagentSummary[]): void {
  const prev = $activityBySession.get()[sessionId] ?? EMPTY;
  publishSubagentsSnapshot(sessionId, [...prev.subagents.filter((s) => s.kind === 'agent_tool'), ...workers]);
}

export function publishBashJobs(sessionId: string, jobs: BashJobSummary[]): void {
  const prev = $activityBySession.get()[sessionId] ?? EMPTY;
  $activityBySession.setKey(sessionId, { ...prev, jobs });
}

// ---------------------------------------------------------------------------
// Nested transcripts. An agent-tool run (``explore`` and friends) executes
// inside the parent's turn and owns no session, so there is no thread for the
// read-only viewer to mount — the only record of what it did is the narrative
// beats the subagent bus relays as ``ui.subagent.event``. Those beats carry
// the SAME payload shape the parent's own run emits (one server-side mapper,
// ``bridge.stream_event_payload``), so folding them through the shared
// transcript reducer yields real transcript items: the Agents detail page
// renders a nested run with the same MessageList a worker's thread gets.
//
// Live-only by construction. Workers persist because their session is
// journaled; these buffers live as long as the run stays in the snapshot and
// are dropped when the server ages it out of its ended tail.
// ---------------------------------------------------------------------------

/** Items per subagent, keyed sessionId -> subagentId. Separate from
 *  ``$activityBySession`` on purpose: beats arrive per tool call, and only
 *  the Agents surface reads them — splitting the maps keeps that firehose
 *  from re-rendering the chat column on every step. */
export const $subagentTranscriptsBySession = map<Record<string, Record<string, MessageItem[]>>>({});

/** Bounds one run's buffer. An explorer chews through reads and searches;
 *  the detail page needs the shape of the run, not an unbounded log. */
const TRANSCRIPT_CAP = 500;

const capped = (items: MessageItem[]): MessageItem[] =>
  items.length > TRANSCRIPT_CAP ? items.slice(items.length - TRANSCRIPT_CAP) : items;

/**
 * Fold one relayed beat into the subagent's transcript. ``method`` and
 * ``params`` are the bus envelope's fields — the same method names and
 * payloads the parent session's own stream uses.
 *
 * Every item is stamped with the subagent id as its run id (for agent-tool
 * runs ``run_id === subagent_id === the outer call_id``), so activity
 * grouping folds the whole nested run into ONE chain-of-thought block and
 * the trailing message lands as its answer.
 */
export function publishSubagentEvent(
  sessionId: string,
  subagentId: string,
  method: string,
  params: Record<string, unknown>
): void {
  const tool = typeof params.tool === 'string' ? params.tool : '';
  if ((method === 'tool_called' || method === 'tool_result') && HIDDEN_TOOLS.has(tool)) {
    return;
  }
  const bySession = $subagentTranscriptsBySession.get()[sessionId] ?? {};
  const items = bySession[subagentId] ?? [];
  let next: MessageItem[];
  if (method === 'message_output') {
    const content = typeof params.content === 'string' ? params.content : '';
    if (!content) {
      return;
    }
    next = appendAssistantMessage(items, content, subagentId);
  } else if (method === 'tool_called') {
    next = upsertToolCall(
      items,
      {
        call_id: String(params.call_id ?? ''),
        tool,
        input: typeof params.input === 'string' ? params.input : JSON.stringify(params.input ?? ''),
        metadata: params.metadata as ChatItemMetadata | undefined,
      },
      subagentId
    );
  } else if (method === 'tool_result') {
    next = applyToolResult(
      items,
      {
        call_id: String(params.call_id ?? ''),
        tool,
        output: typeof params.output === 'string' ? params.output : JSON.stringify(params.output ?? ''),
        metadata: params.metadata as ChatItemMetadata | undefined,
      },
      subagentId
    );
  } else {
    // run_started / run_end / run_status carry lifecycle, which the snapshot
    // already reports (status dot, elapsed clock, result). Nothing to append.
    return;
  }
  if (next === items) {
    return;
  }
  $subagentTranscriptsBySession.setKey(sessionId, { ...bySession, [subagentId]: capped(next) });
}

/** Drop buffers for runs the snapshot no longer carries — the server keeps
 *  only a bounded ended tail, and a transcript for a run nothing can open is
 *  dead weight. */
function pruneSubagentTranscripts(sessionId: string, live: ReadonlySet<string>): void {
  const bySession = $subagentTranscriptsBySession.get()[sessionId];
  if (!bySession) {
    return;
  }
  const ids = Object.keys(bySession);
  if (!ids.some((id) => !live.has(id))) {
    return;
  }
  const kept: Record<string, MessageItem[]> = {};
  for (const id of ids) {
    const buf = bySession[id];
    if (live.has(id) && buf) {
      kept[id] = buf;
    }
  }
  $subagentTranscriptsBySession.setKey(sessionId, kept);
}

// ---------------------------------------------------------------------------
// Actions. Stop/tail need the session's RPC client, which only the embedded
// chat app holds. It registers per-session callbacks; consumers subscribe
// via the map (so a surface mounted before the chat app registers becomes
// functional the moment registration lands) or look them up at click time.
// ---------------------------------------------------------------------------

export type ActivityActions = {
  killWorker: (workerId: string) => Promise<WorkersKillResult>;
  killJob: (jobId: string) => Promise<BashJobsKillResult>;
  tailJob: (jobId: string, lines?: number) => Promise<BashJobsTailResult>;
  /** Read another session's main plan (a worker's own plan, by the worker's
   *  session id) over this session's RPC connection, projected into the
   *  Tasks popover's row shape. Null when the worker has no plan. */
  getWorkerPlan: (workerSessionId: string) => Promise<TaskSummary[] | null>;
};

export const $activityActionsBySession = map<Record<string, ActivityActions | undefined>>({});

export function registerActivityActions(sessionId: string, actions: ActivityActions | null): void {
  $activityActionsBySession.setKey(sessionId, actions ?? undefined);
}

export function getActivityActions(sessionId: string): ActivityActions | undefined {
  return $activityActionsBySession.get()[sessionId];
}

// ---------------------------------------------------------------------------
// Deep links. A pill popover row targets one item's detail page in the
// Agents sidecar app: the caller opens the app, then requests focus; the
// surface consumes (and clears) the request when it sees its session.
// ---------------------------------------------------------------------------

/** Selection id namespaces — subagents and jobs may share raw ids. */
export function subagentItemId(subagentId: string): string {
  return `subagent:${subagentId}`;
}

export function jobItemId(jobId: string): string {
  return `job:${jobId}`;
}

export const $activityFocus = atom<{ sessionId: string; itemId: string } | null>(null);

export function requestActivityFocus(sessionId: string, itemId: string): void {
  $activityFocus.set({ sessionId, itemId });
}

export function clearActivityFocus(): void {
  $activityFocus.set(null);
}
