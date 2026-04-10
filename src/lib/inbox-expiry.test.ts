import { describe, expect, it } from 'vitest';

import { daysRemaining, INBOX_EXPIRY_MS, isExpired } from './inbox-expiry';
import type { InboxItem } from '@/shared/types';

const makeItem = (overrides: Partial<InboxItem> = {}): InboxItem => ({
  id: 'test-1',
  title: 'Test item',
  status: 'open',
  createdAt: 1_000_000,
  updatedAt: 1_000_000,
  ...overrides,
});

describe('isExpired', () => {
  it('returns false for a fresh item', () => {
    const item = makeItem({ createdAt: 1000 });
    expect(isExpired(item, 1000 + 1000)).toBe(false);
  });

  it('returns true when 7 days have elapsed', () => {
    const item = makeItem({ createdAt: 0 });
    expect(isExpired(item, INBOX_EXPIRY_MS)).toBe(true);
  });

  it('returns true when more than 7 days have elapsed', () => {
    const item = makeItem({ createdAt: 0 });
    expect(isExpired(item, INBOX_EXPIRY_MS + 1)).toBe(true);
  });

  it('returns false at 6 days 23 hours', () => {
    const item = makeItem({ createdAt: 0 });
    const almostExpired = INBOX_EXPIRY_MS - 60 * 60 * 1000;
    expect(isExpired(item, almostExpired)).toBe(false);
  });

  it('ignores items with non-open status', () => {
    expect(isExpired(makeItem({ status: 'done', createdAt: 0 }), INBOX_EXPIRY_MS + 1)).toBe(false);
    expect(isExpired(makeItem({ status: 'deferred', createdAt: 0 }), INBOX_EXPIRY_MS + 1)).toBe(false);
    expect(isExpired(makeItem({ status: 'iceboxed', createdAt: 0 }), INBOX_EXPIRY_MS + 1)).toBe(false);
  });

  it('respects custom expiry duration', () => {
    const oneDay = 24 * 60 * 60 * 1000;
    const item = makeItem({ createdAt: 0 });
    expect(isExpired(item, oneDay - 1, oneDay)).toBe(false);
    expect(isExpired(item, oneDay, oneDay)).toBe(true);
  });
});

describe('daysRemaining', () => {
  it('returns 7 for a brand-new item', () => {
    const now = 1000;
    const item = makeItem({ createdAt: now });
    expect(daysRemaining(item, now)).toBe(7);
  });

  it('returns 1 when less than 24h remain', () => {
    const item = makeItem({ createdAt: 0 });
    const sixDaysAndABit = 6 * 24 * 60 * 60 * 1000 + 1;
    expect(daysRemaining(item, sixDaysAndABit)).toBe(1);
  });

  it('returns 0 at exactly 7 days', () => {
    const item = makeItem({ createdAt: 0 });
    expect(daysRemaining(item, INBOX_EXPIRY_MS)).toBe(0);
  });

  it('returns negative when past expiry', () => {
    const item = makeItem({ createdAt: 0 });
    expect(daysRemaining(item, INBOX_EXPIRY_MS + 24 * 60 * 60 * 1000)).toBe(-1);
  });
});
