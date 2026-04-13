import { describe, expect, it } from 'vitest';

import { daysRemaining, hasExpired, INBOX_EXPIRY_MS, sweepInbox } from './inbox-expiry';
import type { InboxItem } from '@/shared/types';

describe('hasExpired', () => {
  it('returns false for a fresh item', () => {
    expect(hasExpired(1000, 1000 + 1000)).toBe(false);
  });

  it('returns true when 7 days have elapsed', () => {
    expect(hasExpired(0, INBOX_EXPIRY_MS)).toBe(true);
  });

  it('returns true when more than 7 days have elapsed', () => {
    expect(hasExpired(0, INBOX_EXPIRY_MS + 1)).toBe(true);
  });

  it('returns false at 6 days 23 hours', () => {
    const almostExpired = INBOX_EXPIRY_MS - 60 * 60 * 1000;
    expect(hasExpired(0, almostExpired)).toBe(false);
  });

  it('respects custom expiry duration', () => {
    const oneDay = 24 * 60 * 60 * 1000;
    expect(hasExpired(0, oneDay - 1, oneDay)).toBe(false);
    expect(hasExpired(0, oneDay, oneDay)).toBe(true);
  });
});

describe('daysRemaining', () => {
  it('returns 7 for a brand-new item', () => {
    const now = 1000;
    expect(daysRemaining(now, now)).toBe(7);
  });

  it('returns 1 when less than 24h remain', () => {
    const sixDaysAndABit = 6 * 24 * 60 * 60 * 1000 + 1;
    expect(daysRemaining(0, sixDaysAndABit)).toBe(1);
  });

  it('returns 0 at exactly 7 days', () => {
    expect(daysRemaining(0, INBOX_EXPIRY_MS)).toBe(0);
  });

  it('returns negative when past expiry', () => {
    expect(daysRemaining(0, INBOX_EXPIRY_MS + 24 * 60 * 60 * 1000)).toBe(-1);
  });
});

describe('sweepInbox', () => {
  const item = (overrides: Partial<InboxItem>): InboxItem => ({
    id: 'i1',
    title: 't',
    status: 'new',
    projectId: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });

  it('flips expired new items to later and stamps laterAt', () => {
    const input = [item({ id: 'a', createdAt: 0 })];
    const out = sweepInbox(input, INBOX_EXPIRY_MS);
    expect(out[0].status).toBe('later');
    expect(out[0].laterAt).toBe(INBOX_EXPIRY_MS);
    expect(out[0].updatedAt).toBe(INBOX_EXPIRY_MS);
  });

  it('leaves fresh new items untouched and returns them by reference', () => {
    const fresh = item({ id: 'a', createdAt: 100 });
    const out = sweepInbox([fresh], 200);
    expect(out[0]).toBe(fresh);
  });

  it('never touches shaped items even when past expiry', () => {
    const shaped = item({
      id: 'a',
      status: 'shaped',
      createdAt: 0,
      shaping: { outcome: 'x', appetite: 'small' },
    });
    const out = sweepInbox([shaped], INBOX_EXPIRY_MS * 2);
    expect(out[0]).toBe(shaped);
    expect(out[0].status).toBe('shaped');
  });

  it('never touches later items', () => {
    const later = item({ id: 'a', status: 'later', laterAt: 10, createdAt: 0 });
    const out = sweepInbox([later], INBOX_EXPIRY_MS * 2);
    expect(out[0]).toBe(later);
  });

  it('respects custom expiry window', () => {
    const oneDay = 24 * 60 * 60 * 1000;
    const input = [item({ id: 'a', createdAt: 0 })];
    const out = sweepInbox(input, oneDay, oneDay);
    expect(out[0].status).toBe('later');
  });
});
