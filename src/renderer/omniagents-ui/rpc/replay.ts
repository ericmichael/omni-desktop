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
  private resuming = new Set<string>();
  private buffered = new Map<string, ReplayedEvent[]>();

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
      this.onResyncRequired(sessionId);
      return false;
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
  resumeAll(): void {
    for (const [sessionId, tracker] of this.trackers) {
      if (tracker.streamId === null || this.resuming.has(sessionId)) {
        continue;
      }
      this.buffered.set(sessionId, []);
      this.resuming.add(sessionId);
      void this.runResume(sessionId, tracker);
    }
  }

  private async runResume(sessionId: string, tracker: ReplayTracker): Promise<void> {
    let failed = false;
    try {
      const result = await this.resume(sessionId, tracker.streamId, tracker.lastSeq);
      for (const event of tracker.applyResume(result)) {
        this.deliver(event.method, event.params);
      }
    } catch (err) {
      // Resync required (or transport failure): surface to the host app,
      // which refetches authoritative state.
      failed = true;
      if ((err as { code?: unknown } | null)?.code === RESYNC_REQUIRED_CODE) {
        // The server can never serve this cursor again (stream epoch
        // changed, or the session was deleted — resume_session would only
        // re-materialize it). Drop the tracker so later resumeAll passes
        // skip the session; a future live event re-adopts its stream.
        this.trackers.delete(sessionId);
      }
      this.onResyncRequired(sessionId);
    } finally {
      const held = this.buffered.get(sessionId) ?? [];
      this.buffered.delete(sessionId);
      this.resuming.delete(sessionId);
      for (const event of held) {
        if (failed) {
          // Degrade to deliver-anyway: force the cursor past the held
          // events so they cannot re-trigger a resume loop while the host
          // performs its full resync.
          const seq = event.params.seq;
          if (typeof seq === 'number') {
            tracker.forceAdvance(seq);
          }
          this.deliver(event.method, event.params);
          continue;
        }
        if (this.handle(event.method, event.params)) {
          continue;
        }
        this.deliver(event.method, event.params);
      }
    }
  }
}
