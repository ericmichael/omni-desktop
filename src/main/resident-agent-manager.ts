/**
 * Resident agents — main-process manager (docs/resident-agents-plan.md).
 *
 * Owns the roster's runtime: per-agent event queues, WAKE_NOW delivery
 * with digest ride-alongs, the DM round budget, the run-concurrency
 * gate, park/unpark on the normal AgentProcess lifecycle, and the
 * nightly reflection ritual. All pure logic lives in
 * `src/lib/resident-agent.ts`; this file is the I/O shell.
 *
 * Durable data (roster, memories, channels, message log, alarms) lives in
 * projects-db (docs/residents-in-projects-db-plan.md), mirrored here in a
 * write-through in-memory cache (the ProjectManager idiom): reads are
 * synchronous against the cache, every mutation updates the cache first and
 * persists through a serialized chain. The manager is the id authority for
 * message/alarm rows (threading needs ids synchronously). Runtime state
 * (cursors, budgets, morning-beat bookkeeping) stays out of the DB.
 *
 * Wire contract per agent: one persistent WebSocket to its `omni serve`
 * (the "watcher") used for `session.ensure`, `enqueue_message`
 * (assistant-role wakeups — the same pipeline omniagents' notification
 * flusher uses), run lifecycle events, and auto-declining approval
 * requests (headless runs get the safe tool set; anything needing
 * approval is declined with an explanation and surfaced to the UI).
 */

import { rmSync } from 'node:fs';
import path from 'node:path';

import type Store from 'electron-store';
import { fromIso, type IProjectsRepo, residentId, toIso } from 'omni-projects-db';
import { WebSocket as WsWebSocket } from 'ws';

import {
  advanceThread,
  channelIdFromName,
  dayKey,
  daySessionId,
  DEFAULT_TEAM_HANDBOOK,
  type DigestRow,
  dmChannelId,
  dmParticipants,
  isWakeNow,
  memberChannelIds,
  memoryKey,
  mentionsAgent,
  nextThreadDelivery,
  renderIdentityInstructions,
  renderReflectPrompt,
  renderWakeupPing,
  RESERVED_CHANNEL_IDS,
  type ResidentEvent,
  residentHandle,
  residentProcessId,
  SPEECH_TOOL_NAMES,
  speechClientTools,
  SYSTEM_CHANNEL,
  TEAM_CHANNEL,
  type ThreadState,
  type ThreadUrge,
  unreadRowsFor,
  USER_PARTICIPANT,
} from '@/lib/resident-agent';
import {
  residentAgentToRow,
  residentAlarmToRow,
  residentChannelDefToRow,
  residentMemoryToRow,
  residentMessageToRow,
  rowToResidentAgent,
  rowToResidentAlarm,
  rowToResidentChannelDef,
  rowToResidentMemory,
  rowToResidentMessage,
} from '@/main/db-store-bridge';
import type { ProcessManager } from '@/main/process-manager';
import { getDefaultWorkspaceDir } from '@/main/util';
import type { IIpcListener } from '@/shared/ipc-listener';
import type {
  IpcRendererEvents,
  ResidentAgent,
  ResidentAgentInput,
  ResidentAgentRuntime,
  ResidentAgentUpdate,
  ResidentAlarm,
  ResidentChannelDef,
  ResidentChannelMessage,
  ResidentMemoryEntry,
  StoreData,
} from '@/shared/types';

/** Mount name the agent's private home rides under when a project is assigned. */
const HOME_MOUNT = 'home';

/**
 * UI/cache tail size ONLY — the newest rows mirrored into the renderer
 * snapshot and used for digest reads. The DB log itself is unbounded: it is
 * the team's communication record, kept like ticket comments are.
 */
const CHANNEL_LOG_TAIL = 500;
/** Per-day episodic lines feeding nightly reflection. Sized for a working
 *  day, not a chat session. */
const EPISODIC_CAP = 2000;
const DELIVERY_DEBOUNCE_MS = 1500;
const START_TIMEOUT_MS = 180_000;
/**
 * Upper bound on how long a delivery waits for run_end. There is no global
 * concurrency gate (agents run like any other agent surface — the provider
 * is the limiter); this wait only serializes the agent's OWN lane, and the
 * cap is sized for real engineering runs (hours, not chat turns). Hitting
 * it is a quiet move-on, never a failure signal — it exists so a hung serve
 * socket can't wedge an agent's delivery chain forever.
 */
const RUN_END_WAIT_MS = 2 * 60 * 60_000;
/** Reflection over a full working day is a real run, not a chat turn.
 *  Memory writes land via tools DURING the run, so even a timeout only
 *  affects the day-roll bookkeeping — but don't cut a busy day short. */
const REFLECT_TIMEOUT_MS = 15 * 60_000;
const PARK_IDLE_MS = 10 * 60_000;
const DAY_TICK_MS = 5 * 60_000;
/** Unread digest older than this triggers ONE catch-up wakeup — the game's
 *  eventual-delivery guarantee (lull heartbeat) at a work cadence. The
 *  cursor advances on delivery, so it is one wake per backlog, not polling. */
const STALE_DIGEST_MS = 4 * 60 * 60_000;
/** Max speech tool calls per run. A loop guard, not a conversation pacer —
 *  sized so a working agent can report status, answer threads, and DM the
 *  user in one long run without hitting it. Enforced in the tool fulfiller,
 *  so the agent gets the corrective "enough said" as the tool result
 *  mid-run and adapts within the same turn. */
const MAX_POSTS_PER_TURN = 10;
/** Local hour after which the daily morning beat (`day_start`) fires. */
const MORNING_HOUR = 8;
const ALARM_TICK_MS = 60_000;
/** Self-set alarm guards: bounded horizon, bounded open count. */
const ALARM_MAX_MINUTES = 7 * 24 * 60;
const MAX_OPEN_ALARMS = 10;

type ResidentStore = Pick<Store<StoreData>, 'get' | 'set'>;
type SendToWindow = <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;

// ---------------------------------------------------------------------------
// Watcher — one persistent JSON-RPC WS per running resident agent
// ---------------------------------------------------------------------------

type RunEndInfo = { finalText: string; endReason?: string };

class ResidentWatcher {
  private ws: WsWebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private attached = new Set<string>();
  private closed = false;
  /** session_id of the run currently streaming (from run_started). */
  private activeRunSession: string | null = null;
  private activeRunText: string[] = [];
  /** One waiter per session for "the next run on this session ended". */
  private runWaiters = new Map<string, { fire: (info: RunEndInfo) => void; fail: (err: Error) => void }>();

  constructor(
    private readonly wsUrl: string,
    private readonly callbacks: {
      onRunStarted: (sessionId: string | null) => void;
      onRunEnd: (sessionId: string | null, info: RunEndInfo) => void;
      /** Fulfill a speech tool call; the returned object is the tool result
       *  the running agent sees (corrective `Error: …` messages included). */
      onSpeechTool: (tool: string, args: Record<string, unknown>) => Record<string, unknown>;
      onClosed: () => void;
    }
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WsWebSocket(this.wsUrl);
      this.ws = ws;
      const failTimer = setTimeout(() => reject(new Error('watcher connect timed out')), 30_000);
      ws.once('open', () => {
        clearTimeout(failTimer);
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(failTimer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      ws.on('message', (raw) => this.onMessage(String(raw)));
      ws.on('close', () => {
        for (const [, p] of this.pending) {
          p.reject(new Error('watcher socket closed'));
        }
        this.pending.clear();
        this.attached.clear();
        // Run waiters must fail too — a waiter left dangling would wedge its
        // agent's delivery lane until the run-end wait cap expires.
        for (const [, waiter] of this.runWaiters) {
          waiter.fail(new Error('watcher socket closed'));
        }
        this.runWaiters.clear();
        if (!this.closed) {
          this.callbacks.onClosed();
        }
      });
    });
  }

  private onMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof msg.id === 'number' && ('result' in msg || 'error' in msg)) {
      const p = this.pending.get(msg.id);
      if (!p) {
        return;
      }
      this.pending.delete(msg.id);
      if (msg.error && typeof msg.error === 'object') {
        p.reject(new Error(String((msg.error as Record<string, unknown>).message ?? 'rpc error')));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    const method = typeof msg.method === 'string' ? msg.method : '';
    const params = (msg.params ?? {}) as Record<string, unknown>;
    if (method === 'run_started') {
      this.activeRunSession = typeof params.session_id === 'string' ? params.session_id : null;
      this.activeRunText = [];
      this.callbacks.onRunStarted(this.activeRunSession);
    } else if (method === 'message_output') {
      if (typeof params.content === 'string' && params.content.trim()) {
        this.activeRunText.push(params.content);
      }
    } else if (method === 'run_end') {
      const session = this.activeRunSession;
      const info: RunEndInfo = {
        finalText: this.activeRunText.join('\n').trim(),
        ...(typeof params.end_reason === 'string' ? { endReason: params.end_reason } : {}),
      };
      this.activeRunSession = null;
      this.activeRunText = [];
      if (session) {
        const waiter = this.runWaiters.get(session);
        if (waiter) {
          this.runWaiters.delete(session);
          waiter.fire(info);
        }
      }
      this.callbacks.onRunEnd(session, info);
    } else if (method === 'client_request') {
      // The speech tools' fulfillment path: declared client tools fire a
      // generic `tool.call` request, broadcast to every attached channel.
      // The watcher is the SINGLE fulfiller (the embedded session view
      // passes a swallow-handler so it never nacks). Non-speech requests
      // are ignored — the renderer's own handlers (notify, artifacts, …)
      // arrive under distinct function names anyway.
      const fn = typeof params.function === 'string' ? params.function : '';
      const requestId = typeof params.request_id === 'string' ? params.request_id : '';
      if (fn !== 'tool.call' || !requestId) {
        return;
      }
      const call = (params.args ?? {}) as Record<string, unknown>;
      const toolName = typeof call.tool === 'string' ? call.tool : '';
      if (!SPEECH_TOOL_NAMES.includes(toolName)) {
        return;
      }
      const toolArgs = (call.arguments ?? {}) as Record<string, unknown>;
      const res = this.callbacks.onSpeechTool(toolName, toolArgs);
      void this.call('client_response', { request_id: requestId, ok: true, result: res }).catch(() => {});
    } else if (method === 'tool_approval_requested') {
      // Residents are working agents (autopilot semantics): approvals are
      // auto-granted, same as a ticket autopilot run. The human gate is the
      // PR / design review, not per-tool prompts.
      const callId = typeof params.call_id === 'string' ? params.call_id : '';
      if (callId) {
        void this.call('tool_approval_response', {
          call_id: callId,
          decision: 'approve',
          always_approve: true,
        }).catch(() => {});
      }
    } else if (method === 'mcp_approval_requested') {
      const requestId = typeof params.request_id === 'string' ? params.request_id : '';
      if (requestId) {
        void this.call('mcp_approval_response', {
          request_id: requestId,
          decision: 'approve',
        }).catch(() => {});
      }
    }
  }

  call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WsWebSocket.OPEN) {
      return Promise.reject(new Error('watcher socket not open'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /** Attach this channel to a session so its run events reach us, and
   *  set the session variables: the speech client tools
   *  (`variables.client_tools` is connection-scoped — re-declared on
   *  every watcher connect) and the identity `additional_instructions`
   *  the instruction template renders into the system prompt. */
  async ensureSession(sessionId: string, workspaceRoot: string, variables: Record<string, unknown>): Promise<void> {
    if (this.attached.has(sessionId)) {
      return;
    }
    await this.call('server_call', {
      function: 'session.ensure',
      args: {
        session_id: sessionId,
        workspace_root: workspaceRoot,
        variables,
      },
      session_id: sessionId,
    });
    this.attached.add(sessionId);
  }

  /** Re-send session variables to every attached session — identity
   *  (persona/memory/roster) changed mid-connection. `session.ensure`
   *  with a `variables` payload replaces the stored set wholesale, so
   *  the caller always passes the complete variable object. */
  async refreshSessions(variables: Record<string, unknown>): Promise<void> {
    for (const sessionId of [...this.attached]) {
      await this.call('server_call', {
        function: 'session.ensure',
        args: { session_id: sessionId, variables },
        session_id: sessionId,
      });
    }
  }

  /** Resolves with the final text of the next run that ends on `sessionId`. */
  waitForRunEnd(sessionId: string, timeoutMs: number): Promise<RunEndInfo> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.runWaiters.delete(sessionId);
        reject(new Error('run did not end in time'));
      }, timeoutMs);
      this.runWaiters.set(sessionId, {
        fire: (info) => {
          clearTimeout(timer);
          resolve(info);
        },
        fail: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  close(): void {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}

// ---------------------------------------------------------------------------
// Per-agent runtime state (in-memory; durable data lives in the store)
// ---------------------------------------------------------------------------

type AgentRuntime = {
  pending: ResidentEvent[];
  pendingUrge: ThreadUrge | undefined;
  /** Speech tool calls executed in the current run (per-turn budget). */
  speechCount: number;
  state: ResidentAgentRuntime['state'];
  thinking: boolean;
  lastWakeupAt: number | null;
  lastReason: string | null;
  /** Day key of the session pings currently target. */
  day: string | null;
  /** Day key of a dispatched-but-not-yet-delivered morning beat. In-memory
   *  dedup only — the durable delivered mark (`residentMorningBeats`) is
   *  written by deliver() after the ping is actually enqueued. */
  beatQueuedDay: string | null;
  decisions: number;
  cursor: number;
  episodic: string[];
  watcher: ResidentWatcher | null;
  deliverTimer: ReturnType<typeof setTimeout> | null;
  parkTimer: ReturnType<typeof setTimeout> | null;
  /** Serve-level resume handles captured from the last running status. */
  containerId: string | null;
  /** Serialize deliver/reflect/park per agent. */
  chain: Promise<void>;
};

export class ResidentAgentManager {
  private store: ResidentStore;
  private repo: IProjectsRepo;
  private processManager: ProcessManager;
  private sendToWindow: SendToWindow;
  private now: () => number;
  private runtimes = new Map<string, AgentRuntime>();
  private threads = new Map<string, ThreadState>();
  private threadTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private dayTimer: ReturnType<typeof setInterval> | null = null;
  private alarmTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  /**
   * Write-through cache of the durable data in projects-db. Hydrated once
   * in the constructor (after the one-shot store→db migration), mutated
   * synchronously on every write, persisted via {@link enqueuePersist}.
   * `log` holds the newest `CHANNEL_LOG_TAIL` rows (the snapshot tail).
   */
  private data: {
    agents: ResidentAgent[];
    memories: Record<string, ResidentMemoryEntry[]>;
    log: ResidentChannelMessage[];
    channelDefs: ResidentChannelDef[];
    alarms: Record<string, ResidentAlarm[]>;
    /** Shared team handbook body (handbook-first: rides every identity render). */
    handbook: string;
  } = { agents: [], memories: {}, log: [], channelDefs: [], alarms: {}, handbook: '' };

  /** Monotonic id authorities, seeded from the DB at hydrate. */
  private nextMessageId = 1;
  private nextAlarmId = 1;

  /** Serialized write-through persistence chain (the ProjectManager idiom). */
  private persistChain: Promise<void> = Promise.resolve();

  /** Resolves once the store→db migration + cache hydration completes.
   *  IPC handlers await this; never rejects (a failed hydrate logs and
   *  leaves an empty cache rather than wedging every handler). */
  readonly whenReady: Promise<void>;

  constructor(deps: {
    store: ResidentStore;
    /** Durable-data backend (SQLite locally, tenant-scoped Postgres in cloud). */
    repo: IProjectsRepo;
    processManager: ProcessManager;
    sendToWindow: SendToWindow;
    /**
     * Full store snapshot for `store:changed` broadcasts. REQUIRED for live
     * UI updates: when the SQLite project DB is active, MainProcessManager
     * suppresses the automatic `onDidAnyChange` broadcast, so every manager
     * that writes store keys must broadcast its own writes (the
     * ScheduledTaskManager idiom). Server mode's wrapper intercepts the
     * channel and substitutes the tenant snapshot regardless.
     */
    getSnapshot?: () => StoreData | undefined;
    now?: () => number;
  }) {
    this.store = deps.store;
    this.repo = deps.repo;
    this.processManager = deps.processManager;
    this.sendToWindow = deps.sendToWindow;
    this.getSnapshot = deps.getSnapshot;
    this.now = deps.now ?? Date.now;
    this.whenReady = this.hydrate().catch((err) => {
      console.error('[resident] hydrate failed:', err);
    });
  }

  private getSnapshot?: () => StoreData | undefined;

  /** Broadcast after every persisted write — see the constructor note. */
  private notifyStoreChanged(): void {
    if (this.getSnapshot) {
      const snapshot = this.getSnapshot();
      // Never ship undefined: the renderer treats it as "reset to defaults".
      if (snapshot) {
        this.sendToWindow('store:changed', snapshot);
      }
      return;
    }
    // No snapshot provider (server mode): the tenant wrapper intercepts the
    // channel and substitutes its own snapshot, so the payload is moot.
    this.sendToWindow('store:changed', undefined);
  }

  /**
   * The five durable-data keys of the renderer's store snapshot, served from
   * the cache (never from the host store — the fold cleared those keys).
   * Both entry points spread this over the ProjectManager snapshot.
   */
  getDurableSnapshot = (): Pick<
    StoreData,
    'residentAgents' | 'residentMemories' | 'residentChannels' | 'residentChannelDefs' | 'residentAlarms'
  > => ({
    residentAgents: this.data.agents,
    residentMemories: this.data.memories,
    residentChannels: this.data.log,
    residentChannelDefs: this.data.channelDefs,
    residentAlarms: this.data.alarms,
  });

  /** Serialize a durable write; broadcast the fresh snapshot once it lands. */
  private enqueuePersist(task: () => Promise<void>): void {
    this.persistChain = this.persistChain
      .then(task)
      .then(() => this.notifyStoreChanged())
      .catch((err) => {
        console.error('[resident] persist failed:', (err as Error).message);
      });
  }

  /** One-shot store→db migration, then cache hydration from the repo. */
  private async hydrate(): Promise<void> {
    await this.migrateStoreToDb();
    const [agentRows, defRows, messageRows, alarmRows] = await Promise.all([
      this.repo.listResidents(),
      this.repo.listResidentChannels(),
      this.repo.listResidentMessages(CHANNEL_LOG_TAIL),
      this.repo.listResidentAlarms(),
    ]);
    this.data.agents = agentRows.map(rowToResidentAgent);
    this.data.channelDefs = defRows.map(rowToResidentChannelDef);
    this.data.log = messageRows.map(rowToResidentMessage);
    const memories: Record<string, ResidentMemoryEntry[]> = {};
    for (const agent of this.data.agents) {
      const rows = await this.repo.listResidentMemories(agent.id);
      if (rows.length > 0) {
        memories[agent.id] = rows.map(rowToResidentMemory);
      }
    }
    this.data.memories = memories;
    const alarms: Record<string, ResidentAlarm[]> = {};
    for (const row of alarmRows) {
      (alarms[row.agent_id] ??= []).push(rowToResidentAlarm(row));
      this.nextAlarmId = Math.max(this.nextAlarmId, row.id + 1);
    }
    this.data.alarms = alarms;
    this.nextMessageId = this.data.log.reduce((max, m) => Math.max(max, m.id), 0) + 1;

    // Team handbook: seed the shared rules document on first boot; after
    // that the DB row is the source of truth (user edits via the Agents tab,
    // agents via the update_handbook MCP tool).
    const handbook = await this.repo.getTeamHandbook();
    if (handbook === undefined) {
      await this.repo.setTeamHandbook(DEFAULT_TEAM_HANDBOOK, null, toIso(this.now()));
      this.data.handbook = DEFAULT_TEAM_HANDBOOK;
    } else {
      this.data.handbook = handbook.body;
    }
  }

  /**
   * Re-read the handbook before building identity instructions — agents
   * edit it through the MCP subprocess, which this manager's cache can't
   * see. "Fresh on every wake" is the handbook's delivery contract.
   */
  private async refreshHandbook(): Promise<void> {
    try {
      const row = await this.repo.getTeamHandbook();
      this.data.handbook = row?.body ?? '';
    } catch {
      // Keep the cached copy — a read blip must not blank the rules.
    }
  }

  /**
   * One-shot migration of the pre-fold electron-store keys into projects-db.
   * Handles the two legacy store shapes on the way through (single
   * `projectId`, memories keyed `{id, text}`) and materializes the old
   * implicit morning-hour default (absent → 8). Idempotent: the keys are
   * cleared after the move, so a second run finds nothing.
   */
  private async migrateStoreToDb(): Promise<void> {
    type LegacyAgent = ResidentAgent & { projectId?: string; morningHour?: number | null };
    type LegacyMemory = ResidentMemoryEntry & { id?: number };
    const agents = (this.store.get('residentAgents') ?? []) as LegacyAgent[];
    const memories = this.store.get('residentMemories') ?? {};
    const log = this.store.get('residentChannels') ?? [];
    const defs = this.store.get('residentChannelDefs') ?? [];
    const alarms = this.store.get('residentAlarms') ?? {};
    if (agents.length === 0 && log.length === 0 && defs.length === 0) {
      return;
    }
    const rosterIds = new Set<string>();
    for (const legacy of agents) {
      const { projectId, ...rest } = legacy;
      const projectIds = rest.projectIds?.length ? rest.projectIds : projectId ? [projectId] : undefined;
      const agent: ResidentAgent = {
        ...rest,
        ...(projectIds ? { projectIds } : {}),
        morningHour: legacy.morningHour === undefined ? MORNING_HOUR : legacy.morningHour,
      };
      rosterIds.add(agent.id);
      await this.repo.upsertResident(residentAgentToRow(agent));
    }
    for (const [agentId, entries] of Object.entries(memories)) {
      if (!rosterIds.has(agentId)) {
        continue; // orphaned memories of a deleted agent — FK would reject
      }
      const seen = new Set<string>();
      const rows = (entries as LegacyMemory[]).map((entry) => {
        if (entry.key && entry.id === undefined) {
          seen.add(entry.key);
          return residentMemoryToRow(agentId, entry);
        }
        const base = memoryKey(entry.text.split(/\s+/).slice(0, 5).join(' ')) || `memory-${entry.id ?? 1}`;
        let key = base;
        for (let n = 2; seen.has(key); n++) {
          key = `${base}-${n}`;
        }
        seen.add(key);
        return residentMemoryToRow(agentId, { key, text: entry.text, at: entry.at });
      });
      await this.repo.setResidentMemories(agentId, rows);
    }
    for (const def of defs) {
      await this.repo.upsertResidentChannel(residentChannelDefToRow(def));
    }
    for (const msg of log) {
      await this.repo.appendResidentMessage(residentMessageToRow(msg));
    }
    let alarmId = 0;
    for (const [agentId, list] of Object.entries(alarms)) {
      if (!rosterIds.has(agentId)) {
        continue;
      }
      for (const alarm of list) {
        alarmId += 1;
        await this.repo.addResidentAlarm(residentAlarmToRow(agentId, { ...alarm, id: alarmId }));
      }
    }
    this.store.set('residentAgents', []);
    this.store.set('residentMemories', {});
    this.store.set('residentChannels', []);
    this.store.set('residentChannelDefs', []);
    this.store.set('residentAlarms', {});
    console.log(
      `[resident] migrated store→db: ${agents.length} agents, ${log.length} messages, ${defs.length} channels`
    );
  }

  start(): void {
    void this.whenReady.then(() => {
      if (!this.disposed) {
        this.startAfterHydrate();
      }
    });
  }

  private startAfterHydrate(): void {
    // One-shot cleanup: identity used to be written to `<home>/AGENTS.md`.
    // Stale copies would keep being surfaced by omni-code's discovery walk
    // beside the fresh session-variable instructions — remove the
    // launcher-written files. (In-container copies frozen in old snapshots
    // age out when those containers/snapshots do.)
    for (const agent of this.roster()) {
      try {
        rmSync(path.join(this.agentHome(agent.id), 'AGENTS.md'), { force: true });
      } catch {
        /* best-effort */
      }
    }
    // Boot cursors at the channel tail — a restart must not re-deliver
    // the whole stored backlog as "unread". Morning beats are NOT
    // suppressed on boot: the delivered-day record persists in
    // `residentMorningBeats`, so a mid-day restart re-fires nothing, and
    // a beat the closed app owed catches up (marked late) on the first
    // day tick — the agent reads the clock and adjusts.
    const tail = this.channelLog().reduce((max, m) => Math.max(max, m.id), 0);
    for (const agent of this.roster()) {
      this.runtime(agent.id).cursor = tail;
    }
    if (!this.dayTimer) {
      // Midnight catch for agents that are running but idle. Parked agents
      // reflect on their next unpark instead — no wakeup just for the clock.
      this.dayTimer = setInterval(() => {
        for (const agent of this.roster()) {
          const rt = this.runtime(agent.id);
          if (rt.state !== 'parked' && rt.day && rt.day !== dayKey(this.now())) {
            this.enqueueChain(agent.id, () => this.reflectIfDayRolled(agent.id));
          }
          this.sweepMorningBeat(agent);
          this.sweepStaleDigest(agent);
        }
      }, DAY_TICK_MS);
      this.dayTimer.unref?.();
    }
    if (!this.alarmTimer) {
      // Self-set alarms need finer granularity than the 5-min day tick.
      this.alarmTimer = setInterval(() => this.sweepAlarms(), ALARM_TICK_MS);
      this.alarmTimer.unref?.();
    }
    // Owed wakeups must not wait for the first interval tick — setInterval
    // never fires at t=0, so without this a user opening the app at 11:47
    // stares at a roster that owes an 8:00 morning beat for five more
    // minutes. Sweep once NOW; the run gate bounds any pile-up.
    for (const agent of this.roster()) {
      this.sweepMorningBeat(agent);
      this.sweepStaleDigest(agent);
    }
    this.sweepAlarms();
    this.broadcastStatus();
  }

  /**
   * The morning beat — the game's 06:00 `day_start`, one wakeup per agent
   * per day at the first tick past the morning hour. Gives the day a
   * planning beat: memories arrive (first-of-day ping), overnight digests
   * ride along, and the agent decides what today is for. The delivered-day
   * record is PERSISTED: a restart re-fires nothing, and a beat missed
   * while the app was closed catches up on the next tick that day — the
   * event line says it's late so the agent plans the shortened day.
   */
  private sweepMorningBeat(agent: ResidentAgent): void {
    const now = new Date(this.now());
    const today = dayKey(this.now());
    // Per-agent hour; `null` opts this agent out of the beat entirely.
    const hour = agent.morningHour;
    if (!agent.enabled || hour === null || now.getHours() < hour) {
      return;
    }
    const beats = this.store.get('residentMorningBeats') ?? {};
    if (beats[agent.id] === today) {
      return;
    }
    // Dispatch-level dedup only. The durable delivered mark is written by
    // deliver() AFTER the ping is enqueued — marking here would consume the
    // day's beat even when the delivery pipeline (debounce → sandbox boot →
    // enqueue) is interrupted by an app quit/restart, silently losing the
    // beat for the whole day with no failure recorded anywhere. An
    // interrupted beat now re-dispatches on the next tick or the next boot.
    const rt = this.runtime(agent.id);
    if (rt.beatQueuedDay === today || rt.pending.some((e) => e.kind === 'day_start')) {
      return;
    }
    rt.beatQueuedDay = today;
    // Fired in a later hour than configured = the app was closed (or the
    // agent was created mid-day on an earlier day) — tell the agent.
    const late = now.getHours() > hour;
    const clock = `${`${now.getHours()}`.padStart(2, '0')}:${`${now.getMinutes()}`.padStart(2, '0')}`;
    this.dispatchEvent(agent.id, {
      kind: 'day_start',
      ...(late
        ? {
            detail:
              `a new working day begins — late start: your ${hour}:00 morning beat ` +
              `waited for the app to open (it is now ${clock}); plan for the shortened day`,
          }
        : {}),
    });
  }

  /** Fire due self-set alarms as WAKE_NOW `scheduled` events (one-shot). */
  private sweepAlarms(): void {
    if (this.disposed) {
      return;
    }
    const nowMs = this.now();
    const next: StoreData['residentAlarms'] = {};
    const dueIds: number[] = [];
    for (const [agentId, alarms] of Object.entries(this.data.alarms)) {
      const due = alarms.filter((a) => a.at <= nowMs);
      next[agentId] = alarms.filter((a) => a.at > nowMs);
      for (const alarm of due) {
        dueIds.push(alarm.id);
        this.dispatchEvent(agentId, { kind: 'scheduled', text: alarm.note });
      }
    }
    if (dueIds.length > 0) {
      this.data.alarms = next;
      this.enqueuePersist(async () => {
        for (const id of dueIds) {
          await this.repo.deleteResidentAlarm(id);
        }
      });
    }
  }

  // ------------------------------------------------------------------ roster

  private roster(): ResidentAgent[] {
    return this.data.agents;
  }

  private agent(agentId: string): ResidentAgent | undefined {
    return this.roster().find((a) => a.id === agentId);
  }

  private channelLog(): ResidentChannelMessage[] {
    return this.data.log;
  }

  private memoriesOf(agentId: string): ResidentMemoryEntry[] {
    return this.data.memories[agentId] ?? [];
  }

  /** Roster member addressed by `@handle` (handle follows the current name). */
  private agentByHandle(handle: string): ResidentAgent | undefined {
    return this.roster().find((a) => residentHandle(a.name) === handle);
  }

  /** Handles are the addressing layer — they must be unique and unreserved.
   *  Throws with the reason; `excludeId` skips self on rename. */
  private assertHandleFree(name: string, excludeId?: string): void {
    const handle = residentHandle(name);
    if (RESERVED_CHANNEL_IDS.includes(handle)) {
      throw new Error(`"@${handle}" is reserved — pick another name.`);
    }
    const taken = this.roster().find((a) => a.id !== excludeId && residentHandle(a.name) === handle);
    if (taken) {
      throw new Error(
        `"@${handle}" is already ${taken.name}'s address — agents need distinct names (the DM address follows the name).`
      );
    }
  }

  create = (input: ResidentAgentInput): ResidentAgent => {
    const name = input.name.trim();
    this.assertHandleFree(name);
    const agent: ResidentAgent = {
      // Opaque durable identity — the @address derives from the name and
      // follows renames; nothing durable keys on the display name.
      id: residentId(),
      name: name || 'Agent',
      role: input.role.trim(),
      personaText: input.personaText,
      // Default to a container: an autonomous wakeup-driven process should
      // not inherit `host` (no isolation) unless the user picks it.
      profileName: input.profileName ?? 'devbox',
      ...(input.projectIds?.length ? { projectIds: [...new Set(input.projectIds)] } : {}),
      morningHour: input.morningHour === undefined ? MORNING_HOUR : input.morningHour,
      enabled: true,
      createdAt: this.now(),
    };
    this.data.agents = [...this.roster(), agent];
    this.enqueuePersist(() => this.repo.upsertResident(residentAgentToRow(agent)));
    const rt = this.runtime(agent.id);
    rt.cursor = this.channelLog().reduce((max, m) => Math.max(max, m.id), 0);
    // First morning beat is tomorrow — a just-created agent needs no
    // same-day "catch-up"; the user is right there.
    this.store.set('residentMorningBeats', {
      ...(this.store.get('residentMorningBeats') ?? {}),
      [agent.id]: dayKey(this.now()),
    });
    this.broadcastStatus();
    return agent;
  };

  update = (agentId: string, patch: ResidentAgentUpdate): ResidentAgent => {
    const roster = this.roster();
    const idx = roster.findIndex((a) => a.id === agentId);
    const existing = roster[idx];
    if (idx < 0 || !existing) {
      throw new Error(`Unknown resident agent: ${agentId}`);
    }
    if (
      patch.morningHour !== undefined &&
      patch.morningHour !== null &&
      (!Number.isInteger(patch.morningHour) || patch.morningHour < 0 || patch.morningHour > 23)
    ) {
      throw new Error('morningHour must be an hour from 0 to 23, or null to disable the morning beat.');
    }
    // Renames are free — the @address follows the name — but the new
    // address must stay unique and unreserved.
    if (patch.name !== undefined) {
      this.assertHandleFree(patch.name.trim(), agentId);
    }
    const updated: ResidentAgent = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.role !== undefined ? { role: patch.role } : {}),
      ...(patch.personaText !== undefined ? { personaText: patch.personaText } : {}),
      ...(patch.profileName !== undefined ? { profileName: patch.profileName } : {}),
      ...(patch.morningHour !== undefined ? { morningHour: patch.morningHour } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    };
    // `[]` unscopes; a non-empty list rescopes; undefined leaves it alone.
    if (patch.projectIds !== undefined) {
      if (patch.projectIds.length === 0) {
        delete updated.projectIds;
      } else {
        updated.projectIds = [...new Set(patch.projectIds)];
      }
    }
    const next = [...roster];
    next[idx] = updated;
    this.data.agents = next;
    this.enqueuePersist(() => this.repo.upsertResident(residentAgentToRow(updated)));
    this.refreshIdentity(agentId);
    // A different project scope or sandbox means different mounts/backend:
    // park so the next wakeup starts fresh, and drop the warm-reattach
    // handle — the old container was built for the old configuration.
    const sameScope = (a: string[] | undefined, b: string[] | undefined): boolean => {
      const setA = new Set(a ?? []);
      const setB = new Set(b ?? []);
      return setA.size === setB.size && [...setA].every((id) => setB.has(id));
    };
    const reconfigured =
      (patch.projectIds !== undefined && !sameScope(patch.projectIds, existing.projectIds)) ||
      (patch.profileName !== undefined && patch.profileName !== existing.profileName);
    if (reconfigured) {
      this.runtime(agentId).containerId = null;
    }
    if (patch.enabled === false || reconfigured) {
      this.enqueueChain(agentId, () => this.park(agentId, { skipReflection: true }));
    }
    this.broadcastStatus();
    return updated;
  };

  delete = (agentId: string): void => {
    // Park on the chain, then drop the runtime entry from within the same
    // task. Deleting it synchronously here would make the queued park
    // lazily re-create a fresh runtime — a zombie map entry whose
    // `watcher` field no longer points at the real watcher to close.
    this.enqueueChain(agentId, async () => {
      await this.park(agentId, { skipReflection: true });
      this.runtimes.delete(agentId);
    });
    this.data.agents = this.roster().filter((a) => a.id !== agentId);
    const memories = { ...this.data.memories };
    delete memories[agentId];
    this.data.memories = memories;
    const alarms = { ...this.data.alarms };
    delete alarms[agentId];
    this.data.alarms = alarms;
    const beats = { ...(this.store.get('residentMorningBeats') ?? {}) };
    delete beats[agentId];
    this.store.set('residentMorningBeats', beats);
    // Prune the agent's DM threads — orphaned rows would linger unreachable
    // once no view can address the participant. #team history stays: it is
    // the shared record. Channel ids are derived from the participant set
    // (not scanned from the cache) so rows older than the cached tail are
    // pruned from the DB too.
    const dmChannels = new Set<string>(
      [USER_PARTICIPANT, ...this.roster().map((a) => a.id)].map((other) => dmChannelId(agentId, other))
    );
    this.data.log = this.channelLog().filter((m) => {
      const pair = dmParticipants(m.channel);
      return !pair || !pair.includes(agentId);
    });
    this.enqueuePersist(async () => {
      // DB-side: the resident row cascades memories + alarms; DM rows are
      // pruned per channel (the log has no FK — it is the shared record).
      await this.repo.deleteResident(agentId);
      for (const channel of dmChannels) {
        await this.repo.deleteResidentMessagesForChannel(channel);
      }
    });
    this.broadcastStatus();
  };

  setMemories = (agentId: string, memories: ResidentMemoryEntry[]): void => {
    this.data.memories = { ...this.data.memories, [agentId]: memories };
    this.enqueuePersist(() =>
      this.repo.setResidentMemories(
        agentId,
        memories.map((m) => residentMemoryToRow(agentId, m))
      )
    );
    this.refreshIdentity(agentId);
  };

  // ---------------------------------------------------------------- channels

  /** User posts to `team` or a `dm:*` channel; events route per the plan. */
  private channelDefs(): ResidentChannelDef[] {
    return this.data.channelDefs;
  }

  /** Every named channel (the user's view — the user is in all of them). */
  private namedChannels(): string[] {
    return [TEAM_CHANNEL, ...this.channelDefs().map((c) => c.id)];
  }

  /** Named channels `agentId` belongs to — team + defs whose member list
   *  includes it (absent list = open). Drives wakes, digests, and speech. */
  private memberChannelsOf(agentId: string): string[] {
    return memberChannelIds(this.channelDefs(), agentId);
  }

  post = (channel: string, text: string, replyTo?: number): void => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    if (this.namedChannels().includes(channel)) {
      // Threading: normalize the reply target to its root; an id that isn't
      // in this channel is a stale UI reference — refuse rather than
      // mis-thread silently.
      const root = replyTo !== undefined ? this.resolveThreadRoot(channel, replyTo) : null;
      if (replyTo !== undefined && !root) {
        throw new Error(`Cannot reply: message ${replyTo} is not in #${channel}.`);
      }
      // Participants BEFORE the append — the poster's own message must not
      // make everyone a participant of everything.
      const participants = root ? this.threadParticipantAgents(root.rootId) : new Set<string>();
      const msg = this.appendMessage(channel, USER_PARTICIPANT, 'You', trimmed, root?.rootId);
      // Slack membership: only agents IN the channel are woken by a post.
      const members = this.roster().filter((a) => a.enabled && this.memberChannelsOf(a.id).includes(channel));
      for (const agent of members) {
        // A human's channel post is a deliberate attempt to talk (the game's
        // village_chat rule, uniform across channels): mentions wake as
        // direct address; thread participants wake as answered-in-thread;
        // everything else wakes with bias-to-silence wording in the ping.
        const kind = mentionsAgent(trimmed, agent)
          ? 'mention'
          : root && participants.has(agent.id)
            ? 'thread_reply'
            : 'channel_user';
        this.dispatchEvent(agent.id, {
          kind,
          from: USER_PARTICIPANT,
          text: trimmed,
          channel,
          messageId: msg.id,
          ...(kind === 'thread_reply' && root?.rootExcerpt ? { rootText: root.rootExcerpt } : {}),
        });
      }
      return;
    }
    const pair = dmParticipants(channel);
    const target = pair?.find((p) => p !== USER_PARTICIPANT);
    if (target && this.agent(target)) {
      // DM channels are flat — they are threads by construction; `replyTo`
      // is meaningless here and deliberately ignored.
      this.appendMessage(channel, USER_PARTICIPANT, 'You', trimmed);
      this.dispatchEvent(target, { kind: 'dm', from: USER_PARTICIPANT, text: trimmed });
    }
  };

  createChannel = (name: string, description?: string): ResidentChannelDef => {
    const id = channelIdFromName(name);
    if (
      RESERVED_CHANNEL_IDS.includes(id) ||
      id.startsWith('dm:') ||
      this.agentByHandle(id) ||
      this.namedChannels().includes(id)
    ) {
      throw new Error(`Channel id "${id}" is taken or reserved.`);
    }
    const def: ResidentChannelDef = {
      id,
      ...(description?.trim() ? { description: description.trim() } : {}),
      createdAt: this.now(),
    };
    this.data.channelDefs = [...this.channelDefs(), def];
    this.enqueuePersist(() => this.repo.upsertResidentChannel(residentChannelDefToRow(def)));
    return def;
  };

  updateChannel = (channelId: string, patch: { description?: string }): ResidentChannelDef => {
    if (channelId === TEAM_CHANNEL || channelId === SYSTEM_CHANNEL) {
      throw new Error(`#${channelId} is built-in and cannot be edited.`);
    }
    const defs = this.channelDefs();
    const idx = defs.findIndex((c) => c.id === channelId);
    if (idx < 0) {
      throw new Error(`Unknown channel: #${channelId}`);
    }
    const trimmed = patch.description?.trim();
    const { description: _dropped, ...rest } = defs[idx]!;
    const updated: ResidentChannelDef = trimmed ? { ...defs[idx]!, description: trimmed } : rest;
    const next = [...defs];
    next[idx] = updated;
    this.data.channelDefs = next;
    this.enqueuePersist(() => this.repo.upsertResidentChannel(residentChannelDefToRow(updated)));
    return updated;
  };

  deleteChannel = (channelId: string): void => {
    if (channelId === TEAM_CHANNEL || channelId === SYSTEM_CHANNEL) {
      throw new Error(`#${channelId} is built-in and cannot be deleted.`);
    }
    this.data.channelDefs = this.channelDefs().filter((c) => c.id !== channelId);
    this.data.log = this.channelLog().filter((m) => m.channel !== channelId);
    // Repo-side, deleteResidentChannel prunes the channel's log rows too.
    this.enqueuePersist(() => this.repo.deleteResidentChannel(channelId));
  };

  setChannelMembers = (channelId: string, members: string[] | null): void => {
    const defs = this.channelDefs();
    const idx = defs.findIndex((c) => c.id === channelId);
    if (idx < 0) {
      throw new Error(`Unknown channel: #${channelId}`);
    }
    const next = [...defs];
    if (members === null) {
      // Restore the open state: absent member list = every agent, including
      // ones created later, belongs.
      const { members: _dropped, ...rest } = defs[idx]!;
      next[idx] = rest;
    } else {
      const rosterIds = new Set(this.roster().map((a) => a.id));
      const cleaned = [...new Set(members)].filter((id) => rosterIds.has(id));
      next[idx] = { ...defs[idx]!, members: cleaned };
    }
    this.data.channelDefs = next;
    const updated = next[idx]!;
    this.enqueuePersist(() => this.repo.upsertResidentChannel(residentChannelDefToRow(updated)));
  };

  wake = (agentId: string): void => {
    this.dispatchEvent(agentId, { kind: 'wake' });
  };

  /**
   * A ticket was assigned to this resident (`assignTicket` chokepoint in
   * ProjectManager, routed here by the entry points when the assignee parses
   * as `agent:<id>`). WAKE_NOW: direct delegation is direct address. The
   * event is a delta — the agent pulls the full ticket via `get_ticket`.
   */
  deliverAssignment = (agentId: string, ticket: { id: string; title: string; projectLabel?: string }): void => {
    this.dispatchEvent(agentId, {
      kind: 'assignment',
      detail:
        `you were assigned ticket ${ticket.id} — "${ticket.title}"` +
        `${ticket.projectLabel ? ` in ${ticket.projectLabel}` : ''}; ` +
        `read it with get_ticket and take it from there`,
    });
  };

  /**
   * Wake the process (if parked) and hand the renderer what it needs to
   * mount the real session UI: the current day-session id + serve uiUrl.
   * Main ensures the session and attaches its watcher FIRST so thinking
   * state and park re-arming cover the user's direct runs, and so the
   * session exists with a workspace_root before the renderer app boots.
   * Serialized on the agent's chain so it can't race a park/reflect.
   */
  ensureSession = (agentId: string): Promise<{ sessionId: string; uiUrl: string }> => {
    // Fast path: the agent is MID-RUN. The delivery task holds the chain for
    // the whole run, so queuing behind it would block the session view until
    // the run ends — exactly when the user most wants to watch. A thinking
    // agent already has a live process, an attached watcher, and today's
    // session ensured (delivery did all three before triggering the run), so
    // the handles can be returned immediately.
    const running = this.runtime(agentId);
    if (running.thinking && running.watcher && running.day === dayKey(this.now())) {
      const status = this.processManager.getStatus(residentProcessId(agentId));
      if (status.type === 'running' && status.data.uiUrl) {
        if (running.parkTimer) {
          clearTimeout(running.parkTimer);
          running.parkTimer = null;
        }
        return Promise.resolve({ sessionId: daySessionId(agentId, running.day), uiUrl: status.data.uiUrl });
      }
    }
    return this.chained(agentId, async () => {
      const rt = this.runtime(agentId);
      if (rt.parkTimer) {
        // The user is about to look at this agent — don't park under them.
        // Re-armed on the next run end.
        clearTimeout(rt.parkTimer);
        rt.parkTimer = null;
      }
      await this.reflectIfDayRolled(agentId);
      await this.refreshHandbook();
      const wsUrl = await this.ensureRunning(agentId);
      const key = dayKey(this.now());
      rt.day = rt.day ?? key;
      const sessionId = daySessionId(agentId, key);
      const watcher = await this.ensureWatcher(agentId, wsUrl);
      await watcher.ensureSession(sessionId, this.agentHome(agentId), this.sessionVariables(agentId));
      if (rt.state === 'starting' || rt.state === 'parked') {
        rt.state = 'idle';
      }
      this.broadcastStatus();
      const status = this.processManager.getStatus(residentProcessId(agentId));
      if (status.type !== 'running' || !status.data.uiUrl) {
        throw new Error('agent process has no uiUrl');
      }
      return { sessionId, uiUrl: status.data.uiUrl };
    });
  };

  getStatus = (): Record<string, ResidentAgentRuntime> => {
    const out: Record<string, ResidentAgentRuntime> = {};
    for (const agent of this.roster()) {
      const rt = this.runtime(agent.id);
      out[agent.id] = {
        state: rt.state,
        lastWakeupAt: rt.lastWakeupAt,
        lastReason: rt.lastReason,
        day: rt.day,
        pendingCount: rt.pending.length,
        decisions: rt.decisions,
      };
    }
    return out;
  };

  private appendMessage(
    channel: string,
    from: string,
    fromName: string,
    text: string,
    replyTo?: number
  ): ResidentChannelMessage {
    const msg: ResidentChannelMessage = {
      id: this.nextMessageId++,
      channel,
      from,
      fromName,
      text,
      at: this.now(),
      ...(replyTo !== undefined ? { replyTo } : {}),
    };
    // Only the in-memory tail is bounded (UI mirror size); the DB keeps
    // every row — the log is the team's record, like ticket comments.
    const next = [...this.channelLog(), msg];
    this.data.log = next.length > CHANNEL_LOG_TAIL ? next.slice(-CHANNEL_LOG_TAIL) : next;
    this.enqueuePersist(() => this.repo.appendResidentMessage(residentMessageToRow(msg)));
    return msg;
  }

  // ---------------------------------------------------------------- threads

  /**
   * Resolve a reply target to its thread root — replying to a reply threads
   * under the same root, so threads stay one level deep. Returns null when
   * the target doesn't exist in this channel (the caller surfaces the
   * corrective error). A root pruned from the bounded log is still a valid
   * anchor id (its surviving replies keep grouping); it just has no excerpt.
   */
  private resolveThreadRoot(channel: string, targetId: number): { rootId: number; rootExcerpt?: string } | null {
    const log = this.channelLog();
    const target = log.find((m) => m.id === targetId && m.channel === channel);
    if (!target) {
      return null;
    }
    const rootId = target.replyTo ?? target.id;
    const rootText = rootId === target.id ? target.text : log.find((m) => m.id === rootId)?.text;
    return { rootId, ...(rootText ? { rootExcerpt: rootText.slice(0, 60) } : {}) };
  }

  /** Roster agents who authored the thread's root or any reply in it. */
  private threadParticipantAgents(rootId: number): Set<string> {
    const ids = new Set<string>();
    for (const m of this.channelLog()) {
      if ((m.id === rootId || m.replyTo === rootId) && this.agent(m.from)) {
        ids.add(m.from);
      }
    }
    return ids;
  }

  // ------------------------------------------------------------ event intake

  /** Queue an event; WAKE_NOW kinds schedule a (debounced) delivery. */
  dispatchEvent(agentId: string, event: ResidentEvent, urge?: ThreadUrge): void {
    const agent = this.agent(agentId);
    if (!agent || !agent.enabled || this.disposed) {
      return;
    }
    const rt = this.runtime(agentId);
    rt.pending.push(event);
    if (urge) {
      rt.pendingUrge = urge;
    }
    this.episodic(rt, `event ${event.kind}${event.from ? ` from ${event.from}` : ''}`);
    if (isWakeNow(event)) {
      this.scheduleDelivery(agentId);
    }
    this.broadcastStatus();
  }

  private scheduleDelivery(agentId: string): void {
    const rt = this.runtime(agentId);
    if (rt.deliverTimer) {
      return; // a batch window is already open; this event joins it
    }
    rt.deliverTimer = setTimeout(() => {
      rt.deliverTimer = null;
      this.enqueueChain(agentId, () => this.deliver(agentId));
    }, DELIVERY_DEBOUNCE_MS);
    rt.deliverTimer.unref?.();
  }

  // -------------------------------------------------------------- delivery

  private async deliver(agentId: string): Promise<void> {
    const agent = this.agent(agentId);
    const rt = this.runtime(agentId);
    if (!agent || !agent.enabled || this.disposed) {
      rt.pending = [];
      return;
    }
    if (!rt.pending.some(isWakeNow)) {
      return; // digest-only backlog waits for the next real wakeup
    }
    await this.reflectIfDayRolled(agentId);
    await this.refreshHandbook();
    // Hoisted: the catch must know whether a consumed batch held a morning
    // beat so an undelivered beat can re-dispatch on the next sweep.
    let events: ResidentEvent[] = [];
    try {
      const wsUrl = await this.ensureRunning(agentId);
      const nowMs = this.now();
      const key = dayKey(nowMs);
      rt.day = key;
      const sessionId = daySessionId(agentId, key);
      const watcher = await this.ensureWatcher(agentId, wsUrl);
      await watcher.ensureSession(sessionId, this.agentHome(agentId), this.sessionVariables(agentId));

      events = rt.pending;
      const urge = rt.pendingUrge;
      rt.pending = [];
      rt.pendingUrge = undefined;
      const { rows, nextCursor, dropped } = unreadRowsFor(
        this.channelLog(),
        agentId,
        rt.cursor,
        nowMs,
        this.memberChannelsOf(agentId)
      );
      rt.cursor = nextCursor;
      const deduped = this.dropRowsAlreadyInEvents(rows, events);
      // What the agent READ goes into its day record too — reflection must
      // be able to recall gossip it merely skimmed (the game logs digest
      // rows into episodic at digest time).
      for (const row of deduped) {
        this.episodic(rt, `[${row.channel}] ${row.from}: "${row.text.slice(0, 150)}"`);
      }
      const ping = renderWakeupPing({
        nowMs,
        agent,
        events,
        digest: deduped,
        roster: this.roster(),
        ...(urge ? { threadUrge: urge } : {}),
        ...(dropped > 0 ? { droppedRows: dropped } : {}),
        channels: this.memberChannelsOf(agentId),
        appointments: this.appointmentsOf(agentId),
      });

      rt.thinking = true;
      rt.state = 'thinking';
      rt.lastWakeupAt = nowMs;
      rt.lastReason = events[0]?.kind ?? 'wakeup';
      rt.decisions += 1;
      this.broadcastStatus();

      const runEnd = watcher.waitForRunEnd(sessionId, RUN_END_WAIT_MS);
      await watcher.call('enqueue_message', {
        session_id: sessionId,
        content: ping,
        role: 'assistant',
        trigger_run: true,
        source: 'resident:wakeup',
        // Additive: speech tools never hit the approval path on this run.
        safe_tool_overrides: { safe_tool_names: [...SPEECH_TOOL_NAMES] },
      });
      // The ping is durably in the session store once the enqueue acks —
      // NOW the day's morning beat counts as delivered. Writing it any
      // earlier loses the beat to an app restart mid-pipeline.
      if (events.some((e) => e.kind === 'day_start')) {
        this.store.set('residentMorningBeats', {
          ...(this.store.get('residentMorningBeats') ?? {}),
          [agentId]: dayKey(nowMs),
        });
        this.notifyStoreChanged();
      }
      // Speech happens mid-run through the client tools; awaiting the run
      // end only serializes THIS agent's lane (one turn at a time — events
      // arriving mid-run batch into the next ping). A run outliving the wait
      // cap (or a dropped socket) is NOT a failure — run-end state
      // transitions ride the watcher callbacks either way.
      await runEnd.catch((err: Error) => {
        console.warn(`[resident] ${agentId} run-end wait ended early:`, err.message);
      });
    } catch (err) {
      this.attention(agentId, `wakeup delivery failed: ${(err as Error).message}`);
      // An undelivered beat must retry: drop the dispatch dedup so the next
      // sweep re-queues it. Harmless if the enqueue DID land (the persisted
      // mark above short-circuits the sweep before the dedup is consulted).
      if (events.some((e) => e.kind === 'day_start')) {
        rt.beatQueuedDay = null;
      }
    } finally {
      const rt2 = this.runtime(agentId);
      rt2.thinking = false;
      rt2.state = rt2.state === 'parked' ? 'parked' : 'idle';
      this.armParkTimer(agentId);
      this.broadcastStatus();
      // Events that queued while thinking deliver as the next batch.
      if (rt2.pending.some(isWakeNow)) {
        this.scheduleDelivery(agentId);
      }
    }
  }

  /** Rows whose text already arrived as a WAKE_NOW event line would render twice. */
  private dropRowsAlreadyInEvents(rows: DigestRow[], events: ResidentEvent[]): DigestRow[] {
    const inBatch = new Set(events.filter((e) => e.text).map((e) => `${e.from ?? ''}|${e.text ?? ''}`));
    return rows.filter((r) => !inBatch.has(`${r.from === 'You' ? USER_PARTICIPANT : r.from.toLowerCase()}|${r.text}`));
  }

  // ------------------------------------------------------- agent speech out

  /**
   * Fulfill one speech tool call, mid-run, on behalf of `agentId` — the
   * game's say/whisper semantics: invalid input never acts and returns a
   * corrective `Error: …` message the model retries on within the same
   * run; the per-turn budget pushes back in the moment ("enough said").
   * Identity is implicit and unforgeable: the call arrived on this
   * agent's own watcher channel.
   */
  /** Pending alarms rendered for the ping ("14:30 (2026-07-23) — note"). */
  private appointmentsOf(agentId: string): string[] {
    const mine = this.data.alarms[agentId] ?? [];
    return [...mine]
      .sort((a, b) => a.at - b.at)
      .map((a) => {
        const d = new Date(a.at);
        const clock = `${`${d.getHours()}`.padStart(2, '0')}:${`${d.getMinutes()}`.padStart(2, '0')}`;
        return `${clock} (${dayKey(a.at)}) — ${a.note}`;
      });
  }

  private handleSpeechTool(agentId: string, tool: string, args: Record<string, unknown>): Record<string, unknown> {
    const agent = this.agent(agentId);
    const rt = this.runtime(agentId);
    if (!agent) {
      return { message: 'Error: unknown agent.' };
    }
    if (tool === 'schedule') {
      // Not speech — a note to future-you. Exempt from the per-turn speech
      // budget, bounded by horizon and open-alarm count instead.
      const minutes = typeof args.minutes === 'number' ? Math.round(args.minutes) : NaN;
      const note = typeof args.note === 'string' ? args.note.trim() : '';
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > ALARM_MAX_MINUTES) {
        return { message: `Error: 'minutes' must be an integer from 1 to ${ALARM_MAX_MINUTES} (one week).` };
      }
      if (!note) {
        return { message: "Error: 'note' must be a non-empty string — future-you needs to know why it woke up." };
      }
      const mine = this.data.alarms[agentId] ?? [];
      if (mine.length >= MAX_OPEN_ALARMS) {
        return {
          message:
            `Error: you already have ${MAX_OPEN_ALARMS} pending reminders — that is the cap. ` +
            `They will fire in due course; do not re-schedule what is already scheduled.`,
        };
      }
      const at = this.now() + minutes * 60_000;
      const alarm: ResidentAlarm = { id: this.nextAlarmId++, at, note: note.slice(0, 500), createdAt: this.now() };
      this.data.alarms = { ...this.data.alarms, [agentId]: [...mine, alarm] };
      this.enqueuePersist(() => this.repo.addResidentAlarm(residentAlarmToRow(agentId, alarm)));
      this.episodic(rt, `I scheduled a reminder in ${minutes}m: "${note.slice(0, 100)}"`);
      const when = new Date(at);
      const clock = `${`${when.getHours()}`.padStart(2, '0')}:${`${when.getMinutes()}`.padStart(2, '0')}`;
      return { message: `Scheduled — you'll be woken around ${clock} (${dayKey(at)}) with your note.` };
    }
    if (tool === 'remember') {
      // Not speech — durable memory upsert, keyed like a KV store. Same
      // key overwrites, so refining beats duplicating. No count cap: the
      // distillation pressure is key-dedup + nightly curation, not quota.
      const key = memoryKey(typeof args.key === 'string' ? args.key : '');
      const memText = typeof args.text === 'string' ? args.text.trim() : '';
      if (!key) {
        return { message: 'Error: \'key\' must be a short slug (letters/numbers/dashes), e.g. "deploy-window".' };
      }
      if (!memText) {
        return { message: "Error: 'text' must be a non-empty one-line fact." };
      }
      const mine = this.memoriesOf(agentId);
      const existing = mine.find((m) => m.key === key);
      const entry: ResidentMemoryEntry = { key, text: memText, at: this.now() };
      this.setMemories(agentId, existing ? mine.map((m) => (m.key === key ? entry : m)) : [...mine, entry]);
      this.episodic(rt, `I ${existing ? 'updated' : 'saved'} memory [${key}]: "${memText.slice(0, 100)}"`);
      return { message: existing ? `Updated memory [${key}].` : `Remembered [${key}].` };
    }
    if (tool === 'forget') {
      const key = memoryKey(typeof args.key === 'string' ? args.key : '');
      const mine = this.memoriesOf(agentId);
      if (!key || !mine.some((m) => m.key === key)) {
        return {
          message: `Error: no memory with key '${key || String(args.key ?? '')}'. Your memories are listed as [key] lines in your instructions.`,
        };
      }
      this.setMemories(
        agentId,
        mine.filter((m) => m.key !== key)
      );
      this.episodic(rt, `I forgot memory [${key}]`);
      return { message: `Forgot [${key}].` };
    }
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text) {
      return { message: "Error: 'text' must be a non-empty string." };
    }
    if (rt.speechCount >= MAX_POSTS_PER_TURN) {
      return {
        message:
          `Error: you've already sent ${MAX_POSTS_PER_TURN} messages this turn — ` +
          `enough said; get on with the work.`,
      };
    }
    if (tool === 'post_channel') {
      const channel = typeof args.channel === 'string' ? args.channel.trim().replace(/^#/, '').toLowerCase() : '';
      // Slack membership: an agent can only post to channels it belongs to,
      // and the corrective error lists ITS channels, not the world's.
      const channels = this.memberChannelsOf(agentId);
      if (!channels.includes(channel)) {
        return {
          message: `Error: '#${channel}' is not one of your channels. Your channels: ${channels
            .map((c) => `#${c}`)
            .join(', ')}.`,
        };
      }
      // Threading: validate reply_to before acting (invalid input never
      // acts); normalize to the root so reply-to-a-reply threads correctly.
      let root: { rootId: number; rootExcerpt?: string } | null = null;
      if (args.reply_to !== undefined) {
        const replyTo = typeof args.reply_to === 'number' ? Math.round(args.reply_to) : NaN;
        if (!Number.isFinite(replyTo)) {
          return { message: "Error: 'reply_to' must be a message id — the [N] shown in your wakeups." };
        }
        root = this.resolveThreadRoot(channel, replyTo);
        if (!root) {
          return {
            message:
              `Error: reply_to ${replyTo}: no such message in #${channel}. ` +
              `Reply ids are the [N] markers in your wakeups; post without reply_to to start fresh.`,
          };
        }
      }
      // Participants BEFORE the append — this reply must not count its own
      // author into the thread it is joining.
      const participants = root ? this.threadParticipantAgents(root.rootId) : new Set<string>();
      rt.speechCount += 1;
      this.episodic(
        rt,
        root
          ? `I replied in a #${channel} thread [${root.rootId}]: "${text.slice(0, 150)}"`
          : `I posted to #${channel}: "${text.slice(0, 150)}"`
      );
      const msg = this.appendMessage(channel, agentId, agent.name, text, root?.rootId);
      // Plain agent posts never wake anyone — pure digest (the game's rule),
      // delivered only to the channel's members. A threaded reply is the
      // exception: the thread's participants were ANSWERED, so they wake —
      // through the thread round budget, which bounds agent↔agent
      // ping-pong exactly like the DM budget does.
      const members = this.roster().filter(
        (a) => a.enabled && a.id !== agentId && this.memberChannelsOf(a.id).includes(channel)
      );
      const wokenByThread = new Set<string>();
      if (root) {
        const recipients = members.filter((a) => participants.has(a.id)).map((a) => a.id);
        for (const id of recipients) {
          wokenByThread.add(id);
        }
        if (recipients.length > 0) {
          this.deliverThreadReply(channel, root, agent.name, text, msg.id, recipients);
        }
      }
      for (const other of members.filter((a) => !wokenByThread.has(a.id))) {
        this.dispatchEvent(other.id, { kind: 'channel_post', from: agent.name, text, channel, messageId: msg.id });
      }
      return { message: root ? `Replied in the #${channel} thread [${root.rootId}].` : `Posted to #${channel}.` };
    }
    if (tool === 'dm') {
      const to = typeof args.to === 'string' ? args.to.trim().toLowerCase().replace(/^@/, '') : '';
      if (to === USER_PARTICIPANT) {
        rt.speechCount += 1;
        this.episodic(rt, `I messaged the user: "${text.slice(0, 150)}"`);
        this.appendMessage(dmChannelId(agentId, USER_PARTICIPANT), agentId, agent.name, text);
        return { message: 'Sent to the user.' };
      }
      // Agents address each other by @handle (the name-derived address);
      // the opaque id is accepted too so nothing breaks mid-rename.
      const target = this.agentByHandle(to) ?? this.agent(to);
      if (target && target.id !== agentId) {
        rt.speechCount += 1;
        this.episodic(rt, `I messaged ${target.name}: "${text.slice(0, 150)}"`);
        this.appendMessage(dmChannelId(agentId, target.id), agentId, agent.name, text);
        this.deliverAgentDm(agentId, target.id, text);
        return { message: `Sent to ${target.name}.` };
      }
      const valid = [
        USER_PARTICIPANT,
        ...this.roster()
          .filter((a) => a.id !== agentId)
          .map((a) => residentHandle(a.name)),
      ];
      return { message: `Error: unknown recipient '${to}'. Valid recipients: ${valid.join(', ')}.` };
    }
    return { message: `Error: unknown speech tool '${tool}'.` };
  }

  /** Agent→agent DM: the round budget decides now / delayed slot / pen-pal. */
  private deliverAgentDm(fromId: string, toId: string, text: string): void {
    const pairKey = dmChannelId(fromId, toId);
    const nowMs = this.now();
    const delivery = nextThreadDelivery(this.threads.get(pairKey), nowMs);
    if (delivery.mode === 'digest') {
      return; // pen-pal mail: the row is in the log; nobody wakes
    }
    const fire = (): void => {
      this.threadTimers.delete(pairKey);
      this.threads.set(pairKey, advanceThread(this.threads.get(pairKey), this.now()));
      this.dispatchEvent(toId, { kind: 'dm', from: fromId, text }, delivery.urge);
    };
    if (delivery.mode === 'now') {
      fire();
      return;
    }
    // One pending slot per pair; messages sent meanwhile land together as
    // digest rows in the same wakeup.
    if (this.threadTimers.has(pairKey)) {
      return;
    }
    const timer = setTimeout(fire, delivery.delayMs);
    timer.unref?.();
    this.threadTimers.set(pairKey, timer);
  }

  /**
   * Agent reply in a channel thread → wake the thread's participants,
   * paced by the same round budget as DMs but keyed per THREAD (the
   * conversation is the thread, shared by its participants): early
   * replies land now, a long exchange batches and winds down, and past
   * the pen-pal point rows ride digests without waking anyone.
   */
  private deliverThreadReply(
    channel: string,
    root: { rootId: number; rootExcerpt?: string },
    fromName: string,
    text: string,
    messageId: number,
    recipientIds: string[]
  ): void {
    const threadKey = `thread:${channel}:${root.rootId}`;
    const delivery = nextThreadDelivery(this.threads.get(threadKey), this.now());
    if (delivery.mode === 'digest') {
      return; // pen-pal mail: the row is in the log; nobody wakes
    }
    const fire = (): void => {
      this.threadTimers.delete(threadKey);
      this.threads.set(threadKey, advanceThread(this.threads.get(threadKey), this.now()));
      for (const toId of recipientIds) {
        this.dispatchEvent(
          toId,
          {
            kind: 'thread_reply',
            from: fromName,
            text,
            channel,
            messageId,
            ...(root.rootExcerpt ? { rootText: root.rootExcerpt } : {}),
          },
          delivery.urge
        );
      }
    };
    if (delivery.mode === 'now') {
      fire();
      return;
    }
    // One pending slot per thread; replies sent meanwhile land together as
    // digest rows in the same wakeup.
    if (this.threadTimers.has(threadKey)) {
      return;
    }
    const timer = setTimeout(fire, delivery.delayMs);
    timer.unref?.();
    this.threadTimers.set(threadKey, timer);
  }

  // ------------------------------------------------------------- reflection

  private async reflectIfDayRolled(agentId: string): Promise<void> {
    const rt = this.runtime(agentId);
    const today = dayKey(this.now());
    if (!rt.day || rt.day === today) {
      return;
    }
    const agent = this.agent(agentId);
    if (!agent) {
      return;
    }
    const oldDay = rt.day;
    rt.state = 'reflecting';
    this.broadcastStatus();
    try {
      const wsUrl = await this.ensureRunning(agentId);
      const watcher = await this.ensureWatcher(agentId, wsUrl);
      const sessionId = daySessionId(agentId, oldDay);
      await watcher.ensureSession(sessionId, this.agentHome(agentId), this.sessionVariables(agentId));
      // Memory writes happen through the remember/forget client tools
      // DURING this run — the run end only gates the day rollover.
      const prompt = renderReflectPrompt({
        day: oldDay,
        agentName: agent.name,
        episodic: rt.episodic,
        durable: this.memoriesOf(agentId).map((m) => ({ key: m.key, text: m.text })),
      });
      const runEnd = watcher.waitForRunEnd(sessionId, REFLECT_TIMEOUT_MS);
      await watcher.call('enqueue_message', {
        session_id: sessionId,
        content: prompt,
        role: 'user',
        trigger_run: true,
        source: 'resident:reflect',
      });
      await runEnd;
    } catch (err) {
      this.attention(agentId, `nightly reflection failed: ${(err as Error).message}`);
    } finally {
      // The old day is over either way; a failed reflection must not wedge
      // the agent in yesterday (recall carries continuity, as in the game).
      rt.day = today;
      rt.episodic = [];
      rt.state = 'idle';
      this.broadcastStatus();
    }
  }

  // ------------------------------------------------------------- lifecycle

  private agentHome(agentId: string): string {
    const root = this.store.get('workspaceDir') || getDefaultWorkspaceDir();
    return path.join(root, 'Agents', agentId);
  }

  /** The complete session-variable set for this agent's sessions: the
   *  speech client tools plus the identity `additional_instructions`
   *  the instruction template renders into the system prompt. Always
   *  sent whole — `session.ensure` with a `variables` payload replaces
   *  the stored set rather than merging. */
  private sessionVariables(agentId: string): Record<string, unknown> {
    return {
      client_tools: speechClientTools(this.memberChannelsOf(agentId)),
      additional_instructions: this.identityInstructions(agentId),
    };
  }

  /** Persona + durable memory + roster + mount map, rendered for the
   *  system prompt. Mount names are the declared base names; the launch
   *  path only suffixes on collision, so the map is accurate in the
   *  common case and the agent can `ls /workspace` for the rare
   *  suffixed one. */
  private identityInstructions(agentId: string): string {
    const agent = this.agent(agentId);
    if (!agent) {
      return '';
    }
    const allProjects = this.store.get('projects') ?? [];
    const scoped = (agent.projectIds ?? [])
      .map((id) => allProjects.find((p) => p.id === id))
      .filter((p): p is NonNullable<typeof p> => Boolean(p))
      .map((p) => ({ label: p.label, mountNames: p.sources.map((s) => s.mountName) }));
    return renderIdentityInstructions(
      agent,
      this.memoriesOf(agentId),
      this.roster(),
      scoped.length > 0 ? { projects: scoped, homeMount: HOME_MOUNT } : undefined,
      this.data.handbook
    );
  }

  // ---------------------------------------------------------------- handbook

  getHandbook = async (): Promise<{ body: string; updatedAt: number; updatedBy: string | null } | null> => {
    const row = await this.repo.getTeamHandbook();
    if (!row) {
      return null;
    }
    this.data.handbook = row.body;
    return { body: row.body, updatedAt: fromIso(row.updated_at), updatedBy: row.updated_by };
  };

  /** User edit from the Agents tab (agents edit via the MCP tool instead). */
  setHandbook = (body: string): void => {
    this.data.handbook = body;
    this.enqueuePersist(() => this.repo.setTeamHandbook(body, null, toIso(this.now())));
    // No activity row per save: the editor autosaves as you type, and the
    // handbook row itself carries updated_at/updated_by for the audit trail.
    // Live sessions pick the new rules up immediately; parked agents on wake.
    for (const [agentId, rt] of this.runtimes) {
      if (rt.watcher) {
        this.refreshIdentity(agentId);
      }
    }
  };

  /** Push fresh identity to any live watcher sessions (persona / memory /
   *  scope edits that land mid-connection). Parked agents pick the new
   *  identity up on their next wake's `ensureSession`. */
  private refreshIdentity(agentId: string): void {
    const watcher = this.runtimes.get(agentId)?.watcher;
    if (!watcher) {
      return;
    }
    void watcher.refreshSessions(this.sessionVariables(agentId)).catch((err: Error) => {
      this.attention(agentId, `identity refresh failed: ${err.message}`);
    });
  }

  private async ensureRunning(agentId: string): Promise<string> {
    const agent = this.agent(agentId);
    if (!agent) {
      throw new Error(`Unknown resident agent: ${agentId}`);
    }
    const pid = residentProcessId(agentId);
    const rt = this.runtime(agentId);
    const current = this.processManager.getStatus(pid);
    if (current.type === 'running' && current.data.wsUrl) {
      return current.data.wsUrl;
    }
    if (current.type !== 'starting' && current.type !== 'connecting') {
      rt.state = 'starting';
      this.broadcastStatus();
      await this.processManager.start(pid, {
        workspaceDir: this.agentHome(agentId),
        // Stable serve session id = the agent's workspace/snapshot identity.
        // Day chat sessions are created on top via session.ensure.
        sessionId: `resident-${agentId}`,
        // Scoped agents launch INTO their projects: the union of every
        // scoped project's sources mounts (credentials resolve per source
        // exactly like a project launch). The private home rides along as
        // the `home` mount so the agent's own files travel with it
        // (identity rides the session variables, not the filesystem). `projectId` is deliberately NOT set — the
        // per-project profile layer and PR container matching are
        // single-project concepts that don't apply here.
        ...(agent.projectIds?.length
          ? {
              projectIds: agent.projectIds,
              extraSources: [{ mountName: HOME_MOUNT, workspaceDir: this.agentHome(agentId) }],
            }
          : {}),
        ...(agent.profileName ? { profileNameOverride: agent.profileName } : {}),
        ...(rt.containerId ? { containerId: rt.containerId } : {}),
      });
    }
    const deadline = this.now() + START_TIMEOUT_MS;
    for (;;) {
      const status = this.processManager.getStatus(pid);
      if (status.type === 'running' && status.data.wsUrl) {
        rt.containerId = status.data.containerId ?? null;
        return status.data.wsUrl;
      }
      // `error` is terminal — waiting the full start timeout on a spawn that
      // already failed just delays the attention message by three minutes.
      if (status.type === 'error') {
        throw new Error(`agent process failed to start: ${status.error.message}`);
      }
      if (status.type === 'exited' || this.now() > deadline) {
        throw new Error(`agent process did not reach running (${status.type})`);
      }
      await sleep(1000);
    }
  }

  private async ensureWatcher(agentId: string, wsUrl: string): Promise<ResidentWatcher> {
    const rt = this.runtime(agentId);
    if (rt.watcher) {
      return rt.watcher;
    }
    const watcher = new ResidentWatcher(wsUrl, {
      onRunStarted: () => {
        rt.thinking = true;
        rt.speechCount = 0; // the per-turn budget resets every run
        if (rt.state === 'idle') {
          rt.state = 'thinking';
        }
        this.broadcastStatus();
      },
      onSpeechTool: (tool, toolArgs) => this.handleSpeechTool(agentId, tool, toolArgs),
      onRunEnd: () => {
        rt.thinking = false;
        if (rt.state === 'thinking') {
          rt.state = 'idle';
        }
        // Covers user-driven runs too (session opened from the UI): each
        // run end pushes the idle-park horizon out another window.
        this.armParkTimer(agentId);
        this.broadcastStatus();
      },
      onClosed: () => {
        if (rt.watcher === watcher) {
          rt.watcher = null;
        }
      },
    });
    await watcher.connect();
    rt.watcher = watcher;
    return watcher;
  }

  private armParkTimer(agentId: string): void {
    const rt = this.runtime(agentId);
    if (rt.parkTimer) {
      clearTimeout(rt.parkTimer);
    }
    rt.parkTimer = setTimeout(() => {
      rt.parkTimer = null;
      this.enqueueChain(agentId, async () => {
        const r = this.runtime(agentId);
        if (r.pending.length > 0 || r.thinking) {
          return;
        }
        await this.park(agentId);
      });
    }, PARK_IDLE_MS);
    rt.parkTimer.unref?.();
  }

  private async park(agentId: string, opts?: { skipReflection?: boolean }): Promise<void> {
    const rt = this.runtime(agentId);
    if (!opts?.skipReflection) {
      // Reflect before a park that crosses the day boundary, so a parked
      // agent never wakes owing yesterday's ritual mid-task.
      await this.reflectIfDayRolled(agentId).catch(() => {});
    }
    rt.watcher?.close();
    rt.watcher = null;
    if (rt.parkTimer) {
      clearTimeout(rt.parkTimer);
      rt.parkTimer = null;
    }
    const pid = residentProcessId(agentId);
    const status = this.processManager.getStatus(pid);
    if (status.type !== 'uninitialized' && status.type !== 'exited') {
      await this.processManager.stop(pid).catch(() => {});
    }
    rt.thinking = false;
    rt.state = 'parked';
    this.broadcastStatus();
  }

  // ------------------------------------------------------------- utilities

  private runtime(agentId: string): AgentRuntime {
    let rt = this.runtimes.get(agentId);
    if (!rt) {
      rt = {
        pending: [],
        pendingUrge: undefined,
        speechCount: 0,
        state: 'parked',
        thinking: false,
        lastWakeupAt: null,
        lastReason: null,
        day: null,
        beatQueuedDay: null,
        decisions: 0,
        cursor: 0,
        episodic: [],
        watcher: null,
        deliverTimer: null,
        parkTimer: null,
        containerId: null,
        chain: Promise.resolve(),
      };
      this.runtimes.set(agentId, rt);
    }
    return rt;
  }

  private enqueueChain(agentId: string, task: () => Promise<void>): void {
    const rt = this.runtime(agentId);
    rt.chain = rt.chain.then(task).catch((err) => {
      console.warn(`[resident] ${agentId} task failed:`, (err as Error).message);
    });
  }

  /** Like enqueueChain, but returns the task's result to the caller
   *  (IPC handlers that need a value back from the serialized lane). */
  private chained<T>(agentId: string, task: () => Promise<T>): Promise<T> {
    const rt = this.runtime(agentId);
    const result = rt.chain.then(task);
    rt.chain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private episodic(rt: AgentRuntime, line: string): void {
    rt.episodic.push(line);
    if (rt.episodic.length > EPISODIC_CAP) {
      rt.episodic = rt.episodic.slice(-EPISODIC_CAP);
    }
  }

  private attention(agentId: string, message: string): void {
    console.warn(`[resident] ${agentId}: ${message}`);
    this.sendToWindow('resident:attention', { agentId, message, at: this.now() });
    // The town-crier rule: incidents also land in the channel log as system
    // rows, so the Activity feed is the complete record — a missed toast is
    // not a lost event. The `system` channel is user-facing only: agents
    // never see it in digests (it is neither #team nor one of their DMs).
    this.appendMessage(SYSTEM_CHANNEL, SYSTEM_CHANNEL, 'System', message);
  }

  /**
   * The eventual-delivery guarantee: an enabled agent with visible unread
   * digest rows older than `STALE_DIGEST_MS` gets ONE catch-up wakeup.
   * Delivery advances the cursor, which clears the condition — one wake
   * per backlog, never polling. Wakes parked agents by design.
   */
  private sweepStaleDigest(agent: ResidentAgent): void {
    const rt = this.runtime(agent.id);
    if (!agent.enabled || rt.thinking || rt.deliverTimer || rt.pending.length > 0) {
      return;
    }
    const nowMs = this.now();
    const { rows, dropped } = unreadRowsFor(
      this.channelLog(),
      agent.id,
      rt.cursor,
      nowMs,
      this.memberChannelsOf(agent.id)
    );
    if (rows.length === 0 && dropped === 0) {
      return;
    }
    const staleMin = STALE_DIGEST_MS / 60_000;
    const oldest = Math.max(...rows.map((r) => r.agoMin));
    if (dropped > 0 || oldest >= staleMin) {
      this.dispatchEvent(agent.id, { kind: 'catch_up' });
    }
  }

  private broadcastStatus(): void {
    this.sendToWindow('resident:status', this.getStatus());
  }

  cleanup = async (): Promise<void> => {
    this.disposed = true;
    if (this.dayTimer) {
      clearInterval(this.dayTimer);
      this.dayTimer = null;
    }
    if (this.alarmTimer) {
      clearInterval(this.alarmTimer);
      this.alarmTimer = null;
    }
    for (const timer of this.threadTimers.values()) {
      clearTimeout(timer);
    }
    this.threadTimers.clear();
    for (const [agentId, rt] of this.runtimes) {
      if (rt.deliverTimer) {
        clearTimeout(rt.deliverTimer);
      }
      if (rt.parkTimer) {
        clearTimeout(rt.parkTimer);
      }
      rt.watcher?.close();
      rt.watcher = null;
      void agentId;
    }
    // Flush pending durable writes so a quit can't lose acknowledged
    // messages/memories that were still queued on the persist chain.
    await this.persistChain;
    // Processes themselves are stopped by ProcessManager.cleanup().
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

// ---------------------------------------------------------------------------
// IPC registration
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
export function registerResidentHandlers(
  ipc: IIpcListener,
  resolve: (event: unknown) => ResidentAgentManager
): string[] {
  const channels: string[] = [];
  const h = (ch: string, fn: (m: ResidentAgentManager, ...args: any[]) => unknown): void => {
    ipc.handle(ch, async (event: unknown, ...args: any[]) => {
      const m = resolve(event);
      // Handlers read/write the durable cache — never act before hydration.
      await m.whenReady;
      return fn(m, ...args);
    });
    channels.push(ch);
  };
  h('resident:create', (m, input) => m.create(input));
  h('resident:update', (m, agentId, patch) => m.update(agentId, patch));
  h('resident:delete', (m, agentId) => m.delete(agentId));
  h('resident:post', (m, channel, text, replyTo) => m.post(channel, text, replyTo));
  h('resident:create-channel', (m, name, description) => m.createChannel(name, description));
  h('resident:update-channel', (m, channelId, patch) => m.updateChannel(channelId, patch));
  h('resident:delete-channel', (m, channelId) => m.deleteChannel(channelId));
  h('resident:set-channel-members', (m, channelId, members) => m.setChannelMembers(channelId, members));
  h('resident:wake', (m, agentId) => m.wake(agentId));
  h('resident:get-status', (m) => m.getStatus());
  h('resident:ensure-session', (m, agentId) => m.ensureSession(agentId));
  h('resident:set-memories', (m, agentId, memories) => m.setMemories(agentId, memories));
  h('resident:get-handbook', (m) => m.getHandbook());
  h('resident:set-handbook', (m, body) => m.setHandbook(body));
  return channels;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
