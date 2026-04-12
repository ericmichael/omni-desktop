/**
 * Determines whether an incoming server event belongs to the current session
 * and should be processed by the UI.
 *
 * Two categories of events:
 *
 * - **Strict events** (tool_called, tool_result, message_output, run_started):
 *   Must match the current session OR be accepted during a pending startRun.
 *
 * - **Loose events** (run_end, run_status, token):
 *   Rejected only when both sides have a session ID and they disagree.
 */

export type SessionFilterState = {
  /** The session the UI is currently displaying. */
  currentSessionId: string | undefined;
  /** True between calling startRun and receiving run_started. */
  startingRun: boolean;
};

/**
 * Returns `true` when a strict event should be **accepted** (processed).
 *
 * Strict events carry content that mutates the conversation (tools, messages,
 * run lifecycle).  They must be tightly scoped to the active session.
 */
export function acceptStrictEvent(
  state: SessionFilterState,
  eventSessionId: string | undefined,
): boolean {
  // If we know our session and the event's session, they must match.
  if (state.currentSessionId && eventSessionId && state.currentSessionId !== eventSessionId) {
    return false;
  }

  // If we know our session but the event has none, accept (legacy compat).
  if (state.currentSessionId && !eventSessionId) {
    return true;
  }

  // If we don't know our session yet, only accept while a startRun is in flight.
  if (!state.currentSessionId) {
    return state.startingRun;
  }

  return true;
}

/**
 * Returns `true` when a loose event should be **accepted** (processed).
 *
 * Loose events are status/metadata updates.  They're rejected only when
 * both the UI and the event carry session IDs that disagree.
 */
export function acceptLooseEvent(
  state: SessionFilterState,
  eventSessionId: string | undefined,
): boolean {
  if (eventSessionId && state.currentSessionId && state.currentSessionId !== eventSessionId) {
    return false;
  }
  return true;
}
