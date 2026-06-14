import { describe, expect, it } from 'vitest';

import {
  mostRecentMissedScheduledTaskRun,
  nextScheduledTaskRun,
  normalizeScheduledTaskTime,
  shouldCatchUpScheduledTask,
} from '@/lib/scheduled-task-schedule';

describe('scheduled task schedule helpers', () => {
  it('computes interval schedules from the provided timestamp', () => {
    expect(nextScheduledTaskRun({ kind: 'interval', everyMinutes: 15 }, 1_000)).toBe(901_000);
  });

  it('computes the next daily time', () => {
    const after = new Date('2026-06-13T10:30:00').getTime();
    const next = nextScheduledTaskRun({ kind: 'daily', time: '09:00' }, after);
    expect(new Date(next!).getHours()).toBe(9);
    expect(new Date(next!).getDate()).toBe(14);
  });

  it('skips weekends for weekday schedules', () => {
    const after = new Date('2026-06-12T10:30:00').getTime();
    const next = nextScheduledTaskRun({ kind: 'daily', time: '09:00', weekdaysOnly: true }, after);
    expect(new Date(next!).getDay()).toBe(1);
  });

  it('bounds catch-up runs to seven days', () => {
    const now = 10 * 24 * 60 * 60 * 1000;
    expect(shouldCatchUpScheduledTask(now - 6 * 24 * 60 * 60 * 1000, now)).toBe(true);
    expect(shouldCatchUpScheduledTask(now - 8 * 24 * 60 * 60 * 1000, now)).toBe(false);
  });

  it('returns the most recent missed interval run within seven days', () => {
    const hour = 60 * 60 * 1000;
    const nextRunAt = new Date('2026-06-01T09:00:00').getTime();
    const now = nextRunAt + 10 * hour + 10 * 60 * 1000;

    expect(mostRecentMissedScheduledTaskRun({ kind: 'interval', everyMinutes: 60 }, nextRunAt, now)).toBe(
      nextRunAt + 10 * hour
    );
  });

  it('does not catch up interval runs outside the seven-day window', () => {
    const day = 24 * 60 * 60 * 1000;
    const nextRunAt = new Date('2026-06-01T09:00:00').getTime();
    const now = nextRunAt + 8 * day;

    expect(mostRecentMissedScheduledTaskRun({ kind: 'interval', everyMinutes: 10 * 24 * 60 }, nextRunAt, now)).toBe(
      null
    );
  });

  it('does not catch up manual schedules', () => {
    const now = Date.now();

    expect(mostRecentMissedScheduledTaskRun({ kind: 'manual' }, now - 1_000, now)).toBe(null);
  });

  it('normalizes HH:MM times', () => {
    expect(normalizeScheduledTaskTime('9:05')).toBe('09:05');
  });
});
