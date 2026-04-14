import type { InboxItem } from '@/shared/types';

/**
 * Inbox expiry policy. Captured items roll over to `later` if they sit
 * unshaped for too long — keeps the inbox from becoming a graveyard.
 *
 * Only `new` items expire. `shaped` items don't: shaping is a deliberate
 * signal that the user intends to act, so they should stay in the active
 * view until explicitly deferred. `later` and promoted items are already
 * out of the active pool.
 */

/** Default expiry window: 7 days in milliseconds. */
export const INBOX_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Background sweep cadence: once per hour. */
export const INBOX_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** True if `createdAt` is at least `expiryMs` milliseconds in the past. */
export function hasExpired(createdAt: number, nowMs: number, expiryMs: number = INBOX_EXPIRY_MS): boolean {
  return nowMs - createdAt >= expiryMs;
}

/** Number of whole days remaining before expiry. Negative if already past. */
export function daysRemaining(createdAt: number, nowMs: number, expiryMs: number = INBOX_EXPIRY_MS): number {
  const expiresAt = createdAt + expiryMs;
  return Math.ceil((expiresAt - nowMs) / (24 * 60 * 60 * 1000));
}

/**
 * Sweep a batch of inbox items, flipping any expired `new` items to `later`.
 * Returns a new array — callers are responsible for persisting it. Items
 * that don't change are returned by reference so equality checks stay cheap.
 */
export function sweepInbox(
  items: InboxItem[],
  nowMs: number,
  expiryMs: number = INBOX_EXPIRY_MS
): InboxItem[] {
  return items.map((item) => {
    if (item.status !== 'new') {
return item;
}
    if (!hasExpired(item.createdAt, nowMs, expiryMs)) {
return item;
}
    return { ...item, status: 'later', laterAt: nowMs, updatedAt: nowMs };
  });
}
