import { describe, expect, it } from 'vitest';

import type { Milestone, Ticket } from '@/shared/types';

import { focusHeader, type FocusItem,rankFocus } from './focus-ranker';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function makeTicket(overrides: Partial<Ticket> & { id: string }): Ticket {
  return {
    projectId: 'p1',
    title: `Ticket ${overrides.id}`,
    description: '',
    priority: 'medium',
    blockedBy: [],
    createdAt: NOW - 10 * DAY_MS,
    updatedAt: NOW - DAY_MS,
    columnId: 'backlog',
    columnChangedAt: NOW - DAY_MS,
    ...overrides,
  };
}

function makeMilestone(overrides: Partial<Milestone> & { id: string }): Milestone {
  return {
    projectId: 'p1',
    title: `Milestone ${overrides.id}`,
    description: '',
    status: 'active',
    createdAt: NOW - 30 * DAY_MS,
    updatedAt: NOW - DAY_MS,
    ...overrides,
  };
}

describe('rankFocus', () => {
  it('returns an empty list when there are no tickets', () => {
    expect(rankFocus({ tickets: [], milestones: {}, now: NOW })).toEqual([]);
  });

  it('skips resolved tickets', () => {
    const tickets = [
      makeTicket({ id: 't1', resolution: 'completed', resolvedAt: NOW - DAY_MS }),
    ];
    expect(rankFocus({ tickets, milestones: {}, now: NOW })).toEqual([]);
  });

  it('skips tickets in a terminal column even without resolution', () => {
    // Simulates dragging a card into Done without clicking "Close as completed".
    const tickets = [makeTicket({ id: 't1', columnId: 'done', priority: 'critical' })];
    const result = rankFocus({
      tickets,
      milestones: {},
      terminalColumnIds: new Set(['done']),
      now: NOW,
    });
    expect(result).toEqual([]);
  });

  it('promotes phase=completed (in an active column) to self-blocked with a review reason', () => {
    const tickets = [
      makeTicket({ id: 'next', priority: 'critical' }),
      makeTicket({ id: 'reviewme', phase: 'completed', priority: 'low' }),
    ];
    const result = rankFocus({
      tickets,
      milestones: {},
      terminalColumnIds: new Set(['done']),
      now: NOW,
    });
    expect(result[0]?.ticket.id).toBe('reviewme');
    expect(result[0]?.rank).toBe('self_blocked');
    expect(result[0]?.reason).toBe('Agent finished — review');
  });

  it('treats tickets blocked by a terminal-column ticket as unblocked', () => {
    const tickets = [
      makeTicket({ id: 'blocker', columnId: 'done' }),
      makeTicket({ id: 'free', columnId: 'backlog', blockedBy: ['blocker'] }),
    ];
    const result = rankFocus({
      tickets,
      milestones: {},
      terminalColumnIds: new Set(['done']),
      now: NOW,
    });
    // Only the active ticket should come through, and it should read as unblocked.
    expect(result.map((r) => r.ticket.id)).toEqual(['free']);
    expect(result[0]?.reason).toContain('unblocked');
  });

  it('puts in-flight tickets ahead of everything else', () => {
    const tickets = [
      makeTicket({ id: 'idle', priority: 'critical' }),
      makeTicket({ id: 'running', phase: 'running', priority: 'low' }),
    ];
    const result = rankFocus({ tickets, milestones: {}, now: NOW });
    expect(result[0]?.ticket.id).toBe('running');
    expect(result[0]?.rank).toBe('in_flight');
  });

  it('puts self-blocked tickets ahead of next-up candidates', () => {
    const tickets = [
      makeTicket({ id: 'fresh', priority: 'critical' }),
      makeTicket({ id: 'stuck', phase: 'awaiting_input', priority: 'low' }),
    ];
    const result = rankFocus({ tickets, milestones: {}, now: NOW });
    expect(result[0]?.ticket.id).toBe('stuck');
    expect(result[0]?.rank).toBe('self_blocked');
    expect(result[0]?.reason).toBe('Needs your input');
    expect(result[1]?.ticket.id).toBe('fresh');
  });

  it('labels errored tickets distinctly', () => {
    const tickets = [makeTicket({ id: 't1', phase: 'error' })];
    expect(rankFocus({ tickets, milestones: {}, now: NOW })[0]?.reason).toBe(
      'Errored — retry or triage'
    );
  });

  it('ranks higher priority ahead of lower priority', () => {
    const tickets = [
      makeTicket({ id: 'low', priority: 'low' }),
      makeTicket({ id: 'high', priority: 'high' }),
    ];
    const result = rankFocus({ tickets, milestones: {}, now: NOW });
    expect(result.map((r) => r.ticket.id)).toEqual(['high', 'low']);
  });

  it('boosts tickets in active milestones', () => {
    const tickets = [
      makeTicket({ id: 'no_ms', priority: 'medium' }),
      makeTicket({ id: 'with_ms', priority: 'medium', milestoneId: 'm1' }),
    ];
    const milestones = { m1: makeMilestone({ id: 'm1' }) };
    const result = rankFocus({ tickets, milestones, now: NOW });
    expect(result[0]?.ticket.id).toBe('with_ms');
  });

  it('boosts tickets in milestones with an approaching deadline', () => {
    const tickets = [
      makeTicket({ id: 'far', priority: 'medium', milestoneId: 'far' }),
      makeTicket({ id: 'soon', priority: 'medium', milestoneId: 'soon' }),
    ];
    const milestones = {
      far: makeMilestone({ id: 'far', dueDate: NOW + 30 * DAY_MS }),
      soon: makeMilestone({ id: 'soon', dueDate: NOW + 2 * DAY_MS }),
    };
    const result = rankFocus({ tickets, milestones, now: NOW });
    expect(result[0]?.ticket.id).toBe('soon');
    expect(result[0]?.reason).toContain('due in 2d');
  });

  it('tags overdue milestones', () => {
    const tickets = [makeTicket({ id: 't1', milestoneId: 'm1' })];
    const milestones = { m1: makeMilestone({ id: 'm1', dueDate: NOW - DAY_MS }) };
    expect(rankFocus({ tickets, milestones, now: NOW })[0]?.reason).toContain('overdue');
  });

  it('penalizes blocked tickets by denying the unblocked bonus', () => {
    const tickets = [
      makeTicket({ id: 'blocker', priority: 'medium' }),
      makeTicket({ id: 'blocked', priority: 'medium', blockedBy: ['blocker'] }),
      makeTicket({ id: 'free', priority: 'medium' }),
    ];
    const result = rankFocus({ tickets, milestones: {}, now: NOW });
    // Blocked ticket should rank last of the three (same priority, no bonus).
    expect(result[result.length - 1]?.ticket.id).toBe('blocked');
    expect(result[result.length - 1]?.reason).toContain('blocked');
  });

  it('treats tickets blocked only by resolved tickets as unblocked', () => {
    const tickets = [
      makeTicket({ id: 'done', resolution: 'completed', resolvedAt: NOW - DAY_MS }),
      makeTicket({ id: 'free', blockedBy: ['done'] }),
    ];
    const result = rankFocus({ tickets, milestones: {}, now: NOW });
    expect(result[0]?.ticket.id).toBe('free');
    expect(result[0]?.reason).toContain('unblocked');
  });

  it('uses columnChangedAt as a tiebreaker (oldest first)', () => {
    const tickets = [
      makeTicket({ id: 'fresh', columnChangedAt: NOW - DAY_MS }),
      makeTicket({ id: 'stale', columnChangedAt: NOW - 10 * DAY_MS }),
    ];
    const result = rankFocus({ tickets, milestones: {}, now: NOW });
    expect(result[0]?.ticket.id).toBe('stale');
  });

  it('caps results at the requested limit', () => {
    const tickets = Array.from({ length: 10 }, (_, i) =>
      makeTicket({ id: `t${i}`, priority: 'medium' })
    );
    const result = rankFocus({ tickets, milestones: {}, now: NOW, limit: 3 });
    expect(result).toHaveLength(3);
  });

  it('sorts all three tiers together in the expected order', () => {
    const tickets = [
      makeTicket({ id: 'next', priority: 'critical' }),
      makeTicket({ id: 'blocked', phase: 'awaiting_input', priority: 'low' }),
      makeTicket({ id: 'live', phase: 'running', priority: 'low' }),
    ];
    const result = rankFocus({ tickets, milestones: {}, now: NOW });
    expect(result.map((r) => r.rank)).toEqual(['in_flight', 'self_blocked', 'next_up']);
    expect(result.map((r) => r.ticket.id)).toEqual(['live', 'blocked', 'next']);
  });
});

describe('focusHeader', () => {
  const emptyRanked: FocusItem[] = [];
  const oneRanked: FocusItem[] = [
    {
      ticket: {} as Ticket,
      rank: 'next_up',
      score: 3,
      reason: 'High priority',
    },
  ];

  it('returns in_flight when WIP is used', () => {
    expect(focusHeader({ ranked: emptyRanked, wipUsed: 2, wipLimit: 3, shapedInboxCount: 0 })).toEqual({
      kind: 'in_flight',
      activeCount: 2,
    });
  });

  it('returns start when WIP is free and there are candidates', () => {
    expect(focusHeader({ ranked: oneRanked, wipUsed: 0, wipLimit: 3, shapedInboxCount: 0 })).toEqual({
      kind: 'start',
      openSlots: 3,
    });
  });

  it('returns shape_inbox when nothing is ranked but shaped items exist', () => {
    expect(focusHeader({ ranked: emptyRanked, wipUsed: 0, wipLimit: 3, shapedInboxCount: 4 })).toEqual({
      kind: 'shape_inbox',
      shapedCount: 4,
    });
  });

  it('returns empty when nothing is actionable', () => {
    expect(focusHeader({ ranked: emptyRanked, wipUsed: 0, wipLimit: 3, shapedInboxCount: 0 })).toEqual({
      kind: 'empty',
    });
  });
});
