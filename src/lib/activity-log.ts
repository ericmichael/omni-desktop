import type { ActivityEvent } from '@/shared/types';

/** Feed entries older than this never render — prune them on write. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Hard cap so the store key stays small even under noisy fleets. */
const MAX_ENTRIES = 200;

/**
 * Prepend an event to the activity log, newest-first, pruning entries older
 * than 14 days and capping the total. Pure — callers persist the result.
 */
export function appendActivityEvent(
  log: ActivityEvent[] | undefined,
  event: ActivityEvent,
  now: number = event.at
): ActivityEvent[] {
  const cutoff = now - MAX_AGE_MS;
  return [event, ...(log ?? []).filter((e) => e.at >= cutoff)].slice(0, MAX_ENTRIES);
}
