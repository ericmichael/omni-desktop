import { describe, expect, it } from 'vitest';

import { appendActivityEvent } from '@/lib/activity-log';
import type { ActivityEvent } from '@/shared/types';

const DAY_MS = 24 * 60 * 60 * 1000;

const event = (id: string, at: number): ActivityEvent => ({
  id,
  at,
  kind: 'routine_run_finished',
  title: `Run ${id}`,
  link: { type: 'routine', taskId: 'task-1' },
});

describe('appendActivityEvent', () => {
  it('prepends newest-first onto an empty/undefined log', () => {
    const log = appendActivityEvent(undefined, event('a', 1000));
    const next = appendActivityEvent(log, event('b', 2000));
    expect(next.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('prunes entries older than 14 days relative to now', () => {
    const now = 100 * DAY_MS;
    const log = [event('old', now - 15 * DAY_MS), event('kept', now - 13 * DAY_MS)];
    const next = appendActivityEvent(log, event('new', now), now);
    expect(next.map((e) => e.id)).toEqual(['new', 'kept']);
  });

  it('caps the log at 200 entries', () => {
    const now = 100 * DAY_MS;
    let log: ActivityEvent[] = [];
    for (let i = 0; i < 205; i++) {
      log = appendActivityEvent(log, event(`e${i}`, now + i), now + i);
    }
    expect(log).toHaveLength(200);
    expect(log[0]?.id).toBe('e204');
  });
});
