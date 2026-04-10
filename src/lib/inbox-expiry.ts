import type { InboxItem } from '@/shared/types';

/** Default inbox item expiry: 7 days in milliseconds. */
export const INBOX_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Sweep interval: check for expired items every hour. */
export const INBOX_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Returns true if the inbox item has passed its expiry window. */
export const isExpired = (item: InboxItem, nowMs: number, expiryMs: number = INBOX_EXPIRY_MS): boolean => {
  return item.status === 'open' && nowMs - item.createdAt >= expiryMs;
};

/** Returns the number of whole days remaining before expiry. Negative if already expired. */
export const daysRemaining = (item: InboxItem, nowMs: number, expiryMs: number = INBOX_EXPIRY_MS): number => {
  const expiresAt = item.createdAt + expiryMs;
  return Math.ceil((expiresAt - nowMs) / (24 * 60 * 60 * 1000));
};
