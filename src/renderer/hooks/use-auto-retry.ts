import { useCallback, useEffect, useRef, useState } from 'react';

/** Backoff between automatic retries; the last delay repeats. */
export const AUTO_RETRY_DELAYS_MS: readonly number[] = [1500, 3000, 6000, 10_000];
/** How long a failure streak may last before the surface asks the user. */
export const AUTO_RETRY_GIVE_UP_AFTER_MS = 60_000;

export type UseAutoRetryOptions = {
  /** The watched thing is in a failed state right now. */
  failing: boolean;
  /**
   * The watched thing is back to normal. Ends the failure streak. An
   * in-flight attempt is neither failing nor healthy, so the streak clock
   * keeps running across it.
   */
  healthy: boolean;
  /** Kick off another attempt. Read through a ref, so identity may change. */
  retry: () => void;
  /** Backoff schedule in milliseconds; the last entry repeats. */
  delaysMs?: readonly number[];
  /** Streak length after which `exhausted` turns on. Retries keep going. */
  giveUpAfterMs?: number;
};

export type UseAutoRetryResult = {
  /**
   * A failure streak is in progress and still within the quiet window:
   * keep the current view, show a small status line, no button.
   */
  retrying: boolean;
  /**
   * The streak has lasted at least `giveUpAfterMs`. Automatic retries
   * continue; the surface may now show its full error affordance.
   */
  exhausted: boolean;
  /** Automatic attempts made during the current streak. */
  attempts: number;
};

type StreakState = {
  active: boolean;
  exhausted: boolean;
  attempts: number;
};

const IDLE: StreakState = { active: false, exhausted: false, attempts: 0 };

/**
 * Quiet automatic recovery for a failing dependency (RPC boot, sandbox
 * launch). While `failing` is true, `retry` is called on a capped backoff.
 * The streak starts on the first failure and ends only when `healthy`
 * turns true, so brief in-flight phases between attempts never reset the
 * clock. After `giveUpAfterMs` of continuous failure `exhausted` flips on,
 * which is the caller's cue to show its error card — retries still run
 * behind it, and a manual retry from that card composes naturally because
 * it drives the same state the hook watches.
 */
export function useAutoRetry(options: UseAutoRetryOptions): UseAutoRetryResult {
  const { failing, healthy } = options;
  const giveUpAfterMs = options.giveUpAfterMs ?? AUTO_RETRY_GIVE_UP_AFTER_MS;

  const retryRef = useRef(options.retry);
  retryRef.current = options.retry;
  const delaysRef = useRef(options.delaysMs ?? AUTO_RETRY_DELAYS_MS);
  delaysRef.current = options.delaysMs ?? AUTO_RETRY_DELAYS_MS;

  const [streak, setStreak] = useState<StreakState>(IDLE);
  const activeRef = useRef(false);
  const deadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDeadline = useCallback(() => {
    if (deadlineRef.current !== null) {
      clearTimeout(deadlineRef.current);
      deadlineRef.current = null;
    }
  }, []);

  // Streak lifecycle: healthy ends it, the first failure starts it and arms
  // the give-up deadline.
  useEffect(() => {
    if (healthy) {
      if (activeRef.current) {
        activeRef.current = false;
        clearDeadline();
        setStreak(IDLE);
      }
      return;
    }
    if (!failing || activeRef.current) {
      return;
    }
    activeRef.current = true;
    clearDeadline();
    deadlineRef.current = setTimeout(() => {
      deadlineRef.current = null;
      setStreak((current) => (current.active ? { ...current, exhausted: true } : current));
    }, giveUpAfterMs);
    setStreak({ active: true, exhausted: false, attempts: 0 });
  }, [failing, healthy, giveUpAfterMs, clearDeadline]);

  useEffect(() => clearDeadline, [clearDeadline]);

  // One pending attempt at a time, only while actually failing. Each fired
  // attempt bumps `attempts`, which re-arms this effect with the next delay
  // if the failure persists. Cleared whenever `failing` drops (attempt in
  // flight, recovered, unmounted), so a fast loop is impossible.
  const { active, attempts } = streak;
  useEffect(() => {
    if (!failing || !active) {
      return;
    }
    const delays = delaysRef.current;
    const delay = delays[Math.min(attempts, delays.length - 1)] ?? 0;
    const timer = setTimeout(() => {
      setStreak((current) => (current.active ? { ...current, attempts: current.attempts + 1 } : current));
      retryRef.current();
    }, delay);
    return () => clearTimeout(timer);
  }, [failing, active, attempts]);

  return {
    retrying: active && !streak.exhausted,
    exhausted: streak.exhausted,
    attempts,
  };
}
