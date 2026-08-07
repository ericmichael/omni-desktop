/**
 * Client-side replay tracking: dedup + gap detection for the sequenced
 * event stream (see omniagents/core/session/event_log.py and the
 * "Durable Sequenced Event Replay" section of omniagents/rpc/protocol.md).
 *
 * Ported from the reference implementation in
 * omniagents/backends/web/ui/src/rpc/replay.ts (identical to the Ink TUI
 * copy) at the same commit the generated protocol contract is pinned to —
 * see src/generated/omniagents-gui-v1/provenance.json. Two additions over
 * the reference:
 *
 * - `SessionReplayCoordinator.resumeAll()` — the reconnect hook Omni
 *   Desktop uses to proactively backfill cursors after the RPC client
 *   re-establishes its connection.
 * - Tracker pruning on a `-32030` resync-required resume failure — a
 *   cursor the server can never serve again (stream epoch changed, or the
 *   session was deleted) is dropped so subsequent `resumeAll()` passes
 *   stop re-resuming it. Without this, resuming a deleted session would
 *   re-materialize it server-side (`resume_session` → `get_or_create`)
 *   on every reconnect, forever.
 *
 * Every replayable server notification carries a replay envelope:
 * `session_id`, `stream_id` (event-stream epoch) and `seq` (per-session
 * monotonic sequence id). Feeding each notification through
 * `ReplayTracker.observe` yields:
 *
 * - `deliver`        — new event, apply it (cursor advanced)
 * - `duplicate`      — already applied; drop so no duplicate UI items
 * - `gap`            — earlier events were missed; hold this event and
 *                      backfill via `resume_session`, then `applyResume`
 * - `stream_changed` — the server's stream epoch changed (journal reset /
 *                      missing history); full resync via
 *                      `get_session_history` is required
 *
 * Events without an integer `seq` (e.g. `token` deltas) are transient and
 * always deliver without moving the cursor.
 */

/**
 * JSON-RPC error code for "resync required" (protocol.md § Durable
 * Sequenced Event Replay): the cursor cannot be served — stream epoch
 * changed, cursor below the compaction floor, or ahead of the stream.
 */
export const RESYNC_REQUIRED_CODE = -32030;

export type ReplayObservation = 'deliver' | 'duplicate' | 'gap' | 'stream_changed';

export type ReplayedEvent = { method: string; params: Record<string, unknown> };

export type ResumeResult = {
  session_id?: string;
  stream_id?: string;
  first_seq?: number;
  last_seq?: number;
  events?: ReplayedEvent[];
};

export class ReplayTracker {
  streamId: string | null = null;
  lastSeq = 0;
  gapCount = 0;

  observe(params: Record<string, unknown> | undefined): ReplayObservation {
    const seq = params?.seq;
    if (typeof seq !== 'number' || !Number.isInteger(seq)) {
      return 'deliver';
    }
    const streamId = params?.stream_id;
    if (typeof streamId === 'string' && streamId !== this.streamId) {
      if (this.streamId === null) {
        // First sequenced event observed: adopt the stream from here.
        this.streamId = streamId;
        this.lastSeq = seq;
        return 'deliver';
      }
      this.streamId = streamId;
      this.lastSeq = seq;
      return 'stream_changed';
    }
    if (seq <= this.lastSeq) {
      return 'duplicate';
    }
    if (this.lastSeq > 0 && seq > this.lastSeq + 1) {
      // Cursor NOT advanced: backfill via resume_session + applyResume,
      // or opt out by delivering and calling forceAdvance(seq).
      this.gapCount += 1;
      return 'gap';
    }
    this.lastSeq = seq;
    return 'deliver';
  }

  /** Advance without backfilling (deliver-anyway consumers). */
  forceAdvance(seq: number): void {
    if (Number.isInteger(seq)) {
      this.lastSeq = Math.max(this.lastSeq, seq);
    }
  }

  /** Replace the cursor after an authoritative full-state resync. */
  reset(streamId: string | null = null, lastSeq = 0): void {
    this.streamId = streamId;
    this.lastSeq = Number.isInteger(lastSeq) && lastSeq >= 0 ? lastSeq : 0;
    this.gapCount = 0;
  }

  /**
   * Apply a `resume_session` result. Returns the events to deliver, in
   * order, with already-applied sequences skipped. Tolerates
   * non-contiguous seq inside the replay window (server-side compaction of
   * superseded snapshots) and adopts the advertised `last_seq`.
   */
  applyResume(result: ResumeResult): ReplayedEvent[] {
    if (typeof result.stream_id === 'string') {
      this.streamId = result.stream_id;
    }
    const deliver: ReplayedEvent[] = [];
    for (const entry of result.events ?? []) {
      if (!entry || typeof entry.method !== 'string') {
        continue;
      }
      const params = entry.params ?? {};
      const seq = params.seq;
      if (typeof seq === 'number' && Number.isInteger(seq)) {
        if (seq <= this.lastSeq) {
          continue;
        }
        this.lastSeq = seq;
      }
      deliver.push({ method: entry.method, params });
    }
    if (typeof result.last_seq === 'number' && Number.isInteger(result.last_seq)) {
      this.lastSeq = Math.max(this.lastSeq, result.last_seq);
    }
    return deliver;
  }
}

/**
 * Per-session tracker registry + resume orchestration used by the RPC
 * client. Duplicates are dropped synchronously; on a gap the triggering
 * event is buffered while `resume_session` backfills; on `stream_changed`
 * (or a `-32030` resync-required error from the server) the
 * `onResyncRequired` callback fires and the host app must refetch
 * authoritative state (`get_session_history`).
 */
export class SessionReplayCoordinator {
  private trackers = new Map<string, ReplayTracker>();
  private registered = new Set<string>();
  private resuming = new Set<string>();
  private pendingRetry = new Set<string>();
  private needsResync = new Set<string>();
  private buffered = new Map<string, ReplayedEvent[]>();
  /** Server-provided cursor from the last ``-32030`` error data, adopted by
   *  ``completeResync`` when the host has no better cursor. */
  private resyncCursors = new Map<string, { streamId: string; lastSeq: number }>();

  constructor(
    private resume: (sessionId: string, streamId: string | null, afterSeq: number) => Promise<ResumeResult>,
    private deliver: (method: string, params: Record<string, unknown>) => void,
    public onResyncRequired: (sessionId: string) => void = () => {}
  ) {}

  tracker(sessionId: string): ReplayTracker {
    let tracker = this.trackers.get(sessionId);
    if (!tracker) {
      tracker = new ReplayTracker();
      this.trackers.set(sessionId, tracker);
    }
    return tracker;
  }

  /**
   * Register a session selected by the UI even when it has not emitted a
   * sequenced event yet. Reconnect recovery must attach these cursorless
   * sessions with ``resume_session(after_seq=0)`` or externally-triggered
   * activity can be missed indefinitely.
   */
  registerSession(sessionId: string): ReplayTracker {
    this.registered.add(sessionId);
    return this.tracker(sessionId);
  }

  /** Stop reconnect recovery for a session the UI no longer owns. */
  unregisterSession(sessionId: string): void {
    this.registered.delete(sessionId);
    this.trackers.delete(sessionId);
    this.pendingRetry.delete(sessionId);
    this.needsResync.delete(sessionId);
    this.buffered.delete(sessionId);
    this.resyncCursors.delete(sessionId);
  }

  /**
   * Seed a fresh cursor after the host has refetched authoritative state.
   * When the host passes no epoch, adopt the cursor the server named in
   * its ``-32030`` error data (``stream_id`` + ``retained_last_seq``) —
   * the server's contract is "refetch authoritative state and resume from
   * the returned last_seq". Leaving the session cursorless instead made
   * the next ``resumeAll`` send another cursorless resume, which the
   * server rejects with ``-32030`` again: an infinite resync loop that
   * reset the transcript on every cycle.
   */
  completeResync(sessionId: string, streamId: string | null = null, lastSeq = 0): void {
    const adopted = streamId === null ? this.resyncCursors.get(sessionId) : undefined;
    this.resyncCursors.delete(sessionId);
    const tracker = this.tracker(sessionId);
    if (adopted) {
      tracker.reset(adopted.streamId, adopted.lastSeq);
    } else {
      tracker.reset(streamId, lastSeq);
    }
    this.needsResync.delete(sessionId);
    this.pendingRetry.delete(sessionId);
    this.buffered.delete(sessionId);
  }

  /**
   * Quarantine a session after an out-of-band replay failure (for example
   * ``ack_events`` returning ``-32030``). No further sequenced events are
   * delivered until the host reloads authoritative state and calls
   * ``completeResync``.
   */
  requireResync(sessionId: string): void {
    if (this.needsResync.has(sessionId)) {
      return;
    }
    this.needsResync.add(sessionId);
    this.pendingRetry.delete(sessionId);
    this.buffered.delete(sessionId);
    this.onResyncRequired(sessionId);
  }

  /**
   * Route one incoming notification. Returns true when the event was
   * handled here (dropped or deferred); false when the caller should
   * deliver it normally.
   */
  handle(method: string, params: Record<string, unknown> | undefined): boolean {
    const sessionId = params?.session_id;
    const seq = params?.seq;
    if (typeof sessionId !== 'string' || typeof seq !== 'number') {
      return false;
    }
    if (this.needsResync.has(sessionId)) {
      return true;
    }
    const tracker = this.tracker(sessionId);
    if (this.resuming.has(sessionId)) {
      // Hold live events while a backfill is in flight; they are flushed
      // (with dedup) once the resume result has been applied.
      this.buffered.get(sessionId)!.push({ method, params: params! });
      return true;
    }
    const observation = tracker.observe(params);
    if (observation === 'deliver') {
      return false;
    }
    if (observation === 'duplicate') {
      return true;
    }
    if (observation === 'stream_changed') {
      this.requireResync(sessionId);
      return true;
    }
    // gap: buffer the triggering event and backfill.
    this.buffered.set(sessionId, [{ method, params: params! }]);
    this.resuming.add(sessionId);
    void this.runResume(sessionId, tracker);
    return true;
  }

  /**
   * Proactively backfill every session we hold a cursor for. Called by
   * the RPC client right after (re)establishing its connection:
   * `resume_session` both replays the events missed while disconnected
   * and re-registers the new channel for live events, so the UI catches
   * up even when no further live notification would arrive (e.g. the run
   * finished during the outage). No-op on the first connect — no cursors
   * exist yet — and for sessions with a backfill already in flight.
   */
  async resumeAll(): Promise<void> {
    const resumes: Promise<void>[] = [];
    for (const [sessionId, tracker] of this.trackers) {
      if (
        this.resuming.has(sessionId) ||
        this.needsResync.has(sessionId) ||
        (tracker.streamId === null && !this.registered.has(sessionId))
      ) {
        continue;
      }
      if (!this.pendingRetry.has(sessionId)) {
        this.buffered.set(sessionId, []);
      }
      this.resuming.add(sessionId);
      resumes.push(this.runResume(sessionId, tracker));
    }
    await Promise.all(resumes);
  }

  private async runResume(sessionId: string, tracker: ReplayTracker): Promise<void> {
    let outcome: 'success' | 'retry' | 'resync' = 'success';
    try {
      const result = await this.resume(sessionId, tracker.streamId, tracker.lastSeq);
      for (const event of tracker.applyResume(result)) {
        this.deliver(event.method, event.params);
      }
      this.pendingRetry.delete(sessionId);
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === RESYNC_REQUIRED_CODE) {
        outcome = 'resync';
        // The error data names the server's current stream and its retained
        // tail; that's the cursor the post-reload completeResync must adopt.
        const data = (err as { data?: unknown }).data as Record<string, unknown> | undefined;
        if (data && typeof data.stream_id === 'string') {
          this.resyncCursors.set(sessionId, {
            streamId: data.stream_id,
            lastSeq: typeof data.retained_last_seq === 'number' ? data.retained_last_seq : 0,
          });
        }
        this.requireResync(sessionId);
      } else {
        // A transport failure while resuming is not evidence that the durable
        // cursor is invalid. Keep both the cursor and held live events for the
        // next successful reconnect instead of force-advancing or asking the
        // host to perform an unnecessary full-state rebuild.
        outcome = 'retry';
        this.pendingRetry.add(sessionId);
      }
    }
    const held = this.buffered.get(sessionId) ?? [];
    this.resuming.delete(sessionId);
    if (outcome === 'retry') {
      return;
    }
    this.buffered.delete(sessionId);
    if (outcome === 'resync') {
      return;
    }
    for (const event of held) {
      if (this.handle(event.method, event.params)) {
        continue;
      }
      this.deliver(event.method, event.params);
    }
  }
}
