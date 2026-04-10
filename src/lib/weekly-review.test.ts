import { describe, expect, it } from 'vitest';

import { dayName, isReviewDue } from './weekly-review';

describe('dayName', () => {
  it('returns the correct day name', () => {
    expect(dayName(0)).toBe('Sunday');
    expect(dayName(5)).toBe('Friday');
    expect(dayName(6)).toBe('Saturday');
  });

  it('falls back to Friday for invalid input', () => {
    expect(dayName(99)).toBe('Friday');
  });
});

describe('isReviewDue', () => {
  // Helper: create a Date for a specific day of week
  const fridayNoon = new Date('2026-04-10T12:00:00Z'); // Friday
  const thursdayNoon = new Date('2026-04-09T12:00:00Z'); // Thursday

  it('returns true on review day when never reviewed', () => {
    expect(isReviewDue(5, null, fridayNoon.getTime())).toBe(true);
  });

  it('returns false on non-review day', () => {
    expect(isReviewDue(5, null, thursdayNoon.getTime())).toBe(false);
  });

  it('returns false if reviewed recently (within 5 days)', () => {
    const recentReview = fridayNoon.getTime() - 2 * 24 * 60 * 60 * 1000; // 2 days ago
    expect(isReviewDue(5, recentReview, fridayNoon.getTime())).toBe(false);
  });

  it('returns true if last review was more than 5 days ago', () => {
    const oldReview = fridayNoon.getTime() - 7 * 24 * 60 * 60 * 1000; // 7 days ago
    expect(isReviewDue(5, oldReview, fridayNoon.getTime())).toBe(true);
  });

  it('returns true if last review was exactly 5 days ago', () => {
    const fiveDaysAgo = fridayNoon.getTime() - 5 * 24 * 60 * 60 * 1000;
    expect(isReviewDue(5, fiveDaysAgo, fridayNoon.getTime())).toBe(true);
  });

  it('works for any day of week', () => {
    // Thursday = day 4
    expect(isReviewDue(4, null, thursdayNoon.getTime())).toBe(true);
    expect(isReviewDue(4, null, fridayNoon.getTime())).toBe(false);
  });
});
