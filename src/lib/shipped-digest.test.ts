import { describe, expect, it } from 'vitest';

import type { Milestone, Ticket } from '@/shared/types';

import { computeShippedDigest, localBoundaries } from './shipped-digest';

const DAY_MS = 24 * 60 * 60 * 1000;
const START_OF_WEEK = 1_700_000_000_000;
const START_OF_TODAY = START_OF_WEEK + 3 * DAY_MS; // mid-week

function makeTicket(overrides: Partial<Ticket> & { id: string }): Ticket {
  return {
    projectId: 'p1',
    title: `Ticket ${overrides.id}`,
    description: '',
    priority: 'medium',
    blockedBy: [],
    createdAt: START_OF_WEEK - 10 * DAY_MS,
    updatedAt: START_OF_WEEK,
    columnId: 'done',
    ...overrides,
  };
}

function makeMilestone(overrides: Partial<Milestone> & { id: string }): Milestone {
  return {
    projectId: 'p1',
    title: `Milestone ${overrides.id}`,
    description: '',
    status: 'active',
    createdAt: START_OF_WEEK - 30 * DAY_MS,
    updatedAt: START_OF_WEEK,
    ...overrides,
  };
}

const baseBoundaries = { startOfToday: START_OF_TODAY, startOfWeek: START_OF_WEEK };

describe('computeShippedDigest', () => {
  it('returns empty buckets when nothing shipped', () => {
    const result = computeShippedDigest({ tickets: [], milestones: [], ...baseBoundaries });
    expect(result.today.items).toEqual([]);
    expect(result.week.items).toEqual([]);
    expect(result.byProject).toEqual({});
  });

  it('excludes unresolved tickets', () => {
    const tickets = [makeTicket({ id: 't1', resolvedAt: START_OF_TODAY + 1000 })];
    const result = computeShippedDigest({ tickets, milestones: [], ...baseBoundaries });
    expect(result.week.items).toHaveLength(0);
  });

  it('excludes tickets resolved before the week started', () => {
    const tickets = [
      makeTicket({
        id: 't1',
        resolution: 'completed',
        resolvedAt: START_OF_WEEK - DAY_MS,
      }),
    ];
    const result = computeShippedDigest({ tickets, milestones: [], ...baseBoundaries });
    expect(result.week.items).toHaveLength(0);
  });

  it('buckets tickets resolved today into both today and week', () => {
    const tickets = [
      makeTicket({
        id: 't1',
        resolution: 'completed',
        resolvedAt: START_OF_TODAY + 60 * 60 * 1000,
      }),
    ];
    const result = computeShippedDigest({ tickets, milestones: [], ...baseBoundaries });
    expect(result.today.ticketCount).toBe(1);
    expect(result.week.ticketCount).toBe(1);
  });

  it('buckets tickets resolved earlier this week into week only', () => {
    const tickets = [
      makeTicket({
        id: 't1',
        resolution: 'completed',
        resolvedAt: START_OF_WEEK + DAY_MS,
      }),
    ];
    const result = computeShippedDigest({ tickets, milestones: [], ...baseBoundaries });
    expect(result.today.ticketCount).toBe(0);
    expect(result.week.ticketCount).toBe(1);
  });

  it('includes completed milestones with completedAt in the week', () => {
    const milestones = [
      makeMilestone({
        id: 'm1',
        status: 'completed',
        completedAt: START_OF_TODAY + 100,
      }),
    ];
    const result = computeShippedDigest({ tickets: [], milestones, ...baseBoundaries });
    expect(result.today.milestoneCount).toBe(1);
    expect(result.week.milestoneCount).toBe(1);
  });

  it('ignores completed milestones without completedAt (legacy data)', () => {
    const milestones = [makeMilestone({ id: 'm1', status: 'completed' })];
    const result = computeShippedDigest({ tickets: [], milestones, ...baseBoundaries });
    expect(result.week.items).toHaveLength(0);
  });

  it('rolls up counts per project', () => {
    const tickets = [
      makeTicket({
        id: 't1',
        projectId: 'pA',
        resolution: 'completed',
        resolvedAt: START_OF_TODAY + 100,
      }),
      makeTicket({
        id: 't2',
        projectId: 'pA',
        resolution: 'completed',
        resolvedAt: START_OF_WEEK + DAY_MS,
      }),
      makeTicket({
        id: 't3',
        projectId: 'pB',
        resolution: 'completed',
        resolvedAt: START_OF_TODAY + 200,
      }),
    ];
    const result = computeShippedDigest({ tickets, milestones: [], ...baseBoundaries });
    expect(result.byProject).toEqual({
      pA: { today: 1, week: 2 },
      pB: { today: 1, week: 1 },
    });
  });

  it('sorts items newest first', () => {
    const tickets = [
      makeTicket({
        id: 'older',
        resolution: 'completed',
        resolvedAt: START_OF_WEEK + DAY_MS,
      }),
      makeTicket({
        id: 'newer',
        resolution: 'completed',
        resolvedAt: START_OF_WEEK + 2 * DAY_MS,
      }),
    ];
    const result = computeShippedDigest({ tickets, milestones: [], ...baseBoundaries });
    expect(result.week.items[0]?.kind === 'ticket' && result.week.items[0].ticket.id).toBe('newer');
  });
});

describe('localBoundaries', () => {
  it('startOfToday is midnight of the given date', () => {
    const d = new Date(2026, 3, 15, 14, 30, 5); // Apr 15, 2026 14:30:05 local
    const { startOfToday } = localBoundaries(d);
    const midnight = new Date(2026, 3, 15, 0, 0, 0, 0).getTime();
    expect(startOfToday).toBe(midnight);
  });

  it('startOfWeek is Monday for a Wednesday', () => {
    const d = new Date(2026, 3, 15, 14, 0, 0); // Apr 15, 2026 = Wednesday
    const { startOfWeek } = localBoundaries(d);
    const monday = new Date(2026, 3, 13, 0, 0, 0, 0).getTime();
    expect(startOfWeek).toBe(monday);
  });

  it('startOfWeek on a Monday is the same day at midnight', () => {
    const d = new Date(2026, 3, 13, 10, 0, 0); // Apr 13, 2026 = Monday
    const { startOfWeek } = localBoundaries(d);
    const monday = new Date(2026, 3, 13, 0, 0, 0, 0).getTime();
    expect(startOfWeek).toBe(monday);
  });

  it('startOfWeek on a Sunday rolls back six days', () => {
    const d = new Date(2026, 3, 19, 10, 0, 0); // Apr 19, 2026 = Sunday
    const { startOfWeek } = localBoundaries(d);
    const monday = new Date(2026, 3, 13, 0, 0, 0, 0).getTime();
    expect(startOfWeek).toBe(monday);
  });
});
