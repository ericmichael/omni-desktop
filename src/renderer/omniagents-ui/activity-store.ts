import { atom, map } from 'nanostores';

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
 *
 * Snapshots (``$activityBySession``) and the per-subagent event feeds
 * (``$activityEventsBySession``) are separate maps on purpose: events
 * arrive per tool call, and only the Agents surface renders them —
 * splitting the maps keeps that firehose from re-rendering the chat column.
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

/** One relayed subagent transcript event (``ui.subagent.event`` args.params). */
export type SubagentEvent = {
  method: string;
  params: Record<string, unknown>;
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

// Matches the ink TUI's per-subagent buffer cap: enough for a long run's
// narrative, bounded against a chatty worker.
const EVENT_CAP = 200;

export const $activityBySession = map<Record<string, SessionActivity>>({});

/** Ring-capped activity feed per subagent_id, keyed by session. */
export const $activityEventsBySession = map<Record<string, Record<string, SubagentEvent[]>>>({});

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
  // Drop feed buffers for subagents that left the snapshot (workers persist
  // until session end server-side, so this is the ended-agent-tool tail
  // aging out — their transcript went with them).
  const live = new Set(subagents.map((s) => s.subagent_id));
  const prevEvents = $activityEventsBySession.get()[sessionId];
  if (prevEvents && Object.keys(prevEvents).some((id) => !live.has(id))) {
    const events: Record<string, SubagentEvent[]> = {};
    for (const [id, buf] of Object.entries(prevEvents)) {
      if (live.has(id)) {
        events[id] = buf;
      }
    }
    $activityEventsBySession.setKey(sessionId, events);
  }
}

/** Fold a workers-only snapshot (``workers.kill`` response) into the
 *  session's unified list, preserving agent-tool entries until the next
 *  bus broadcast replaces them. */
export function mergeWorkersSnapshot(sessionId: string, workers: SubagentSummary[]): void {
  const prev = $activityBySession.get()[sessionId] ?? EMPTY;
  publishSubagentsSnapshot(sessionId, [...prev.subagents.filter((s) => s.kind === 'agent_tool'), ...workers]);
}

export function publishSubagentEvent(sessionId: string, subagentId: string, event: SubagentEvent): void {
  const prev = $activityEventsBySession.get()[sessionId] ?? {};
  const buf = prev[subagentId] ?? [];
  const next = buf.length >= EVENT_CAP ? [...buf.slice(buf.length - EVENT_CAP + 1), event] : [...buf, event];
  $activityEventsBySession.setKey(sessionId, { ...prev, [subagentId]: next });
}

export function publishBashJobs(sessionId: string, jobs: BashJobSummary[]): void {
  const prev = $activityBySession.get()[sessionId] ?? EMPTY;
  $activityBySession.setKey(sessionId, { ...prev, jobs });
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
