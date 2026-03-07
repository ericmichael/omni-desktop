// --- Failure classification ---

export type FailureClass = 'completed' | 'stopped' | 'max_turns' | 'error' | 'stalled';

export const classifyRunEndReason = (reason: string): FailureClass => {
  const r = reason.toLowerCase();
  if (r === 'completed' || r === 'done' || r === 'finished' || r === 'success') {
    return 'completed';
  }
  if (r === 'cancelled' || r === 'canceled' || r === 'stopped' || r === 'user_stopped') {
    return 'stopped';
  }
  if (r === 'max_turns') {
    return 'max_turns';
  }
  if (r === 'stalled') {
    return 'stalled';
  }
  return 'error';
};

// --- Run-end decision tree ---

export type RunEndAction =
  | { type: 'complete' }
  | { type: 'stopped' }
  | { type: 'continue'; nextTurn: number }
  | { type: 'retry'; failureClass: FailureClass };

/**
 * Pure function: given a run_end reason + ticket state, decide what to do next.
 *
 * Omniagents end_reason values: completed, cancelled, max_turns, error, guardrail_violation
 */
export const decideRunEndAction = (opts: {
  reason: string;
  continuationTurn: number;
  maxContinuationTurns: number;
}): RunEndAction => {
  const failureClass = classifyRunEndReason(opts.reason);

  if (failureClass === 'stopped') {
    return { type: 'stopped' };
  }

  // max_turns means the agent hit omniagents' internal turn limit — continue
  // with a fresh run (counts as a continuation turn)
  if (failureClass === 'completed' || failureClass === 'max_turns') {
    const nextTurn = opts.continuationTurn + 1;
    if (nextTurn >= opts.maxContinuationTurns) {
      return { type: 'complete' };
    }

    return { type: 'continue', nextTurn };
  }

  // Error or stall — schedule retry
  return { type: 'retry', failureClass };
};
