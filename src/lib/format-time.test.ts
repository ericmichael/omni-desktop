import { describe, expect, it } from 'vitest';

import { formatDuration, formatElapsed, formatTimestamp } from './format-time';

describe('formatTimestamp', () => {
  const now = new Date('2026-07-14T15:00:00').getTime();

  it('shows time only for the same day', () => {
    const ts = new Date('2026-07-14T09:04:00').getTime();
    expect(formatTimestamp(ts, now)).toMatch(/^9:04/);
    expect(formatTimestamp(ts, now)).not.toMatch(/Jul/);
  });

  it('shows month and day for other days this year', () => {
    const ts = new Date('2026-07-12T09:04:00').getTime();
    const label = formatTimestamp(ts, now);
    expect(label).toMatch(/Jul 12/);
    expect(label).not.toMatch(/2026/);
  });

  it('adds the year when it differs', () => {
    const ts = new Date('2025-12-31T23:59:00').getTime();
    expect(formatTimestamp(ts, now)).toMatch(/2025/);
  });
});

describe('formatDuration', () => {
  it('formats sub-second, seconds, minutes, and hours', () => {
    expect(formatDuration(500)).toBe('<1s');
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(3 * 60_000)).toBe('3m');
    expect(formatDuration(65 * 60_000)).toBe('1h 5m');
    expect(formatDuration(120 * 60_000)).toBe('2h');
  });
});

describe('formatElapsed', () => {
  it('keeps seconds visible under an hour and clamps negatives', () => {
    expect(formatElapsed(-500)).toBe('0s');
    expect(formatElapsed(42_000)).toBe('42s');
    expect(formatElapsed(3 * 60_000 + 2_000)).toBe('3m02s');
    expect(formatElapsed(65 * 60_000)).toBe('1h05m');
    expect(formatElapsed(600 * 60_000)).toBe('10h00m');
  });
});
