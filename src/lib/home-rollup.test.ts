import { describe, expect, it } from 'vitest';

import type { Milestone, Project, Ticket } from '@/shared/types';

import { isProjectPinned, milestoneProgress, projectOpenTicketCount, rankFocusForProject } from './home-rollup';

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

function makeProject(overrides: Partial<Project> & { id: string }): Project {
  return {
    label: `Project ${overrides.id}`,
    slug: overrides.id,
    createdAt: NOW - 60 * DAY_MS,
    sources: [],
    ...overrides,
  };
}

describe('isProjectPinned', () => {
  it('returns false when pinnedAt is undefined', () => {
    expect(isProjectPinned(makeProject({ id: 'p1' }))).toBe(false);
  });

  it('returns true when pinnedAt is set, regardless of age', () => {
    const fresh = makeProject({ id: 'p1', pinnedAt: NOW });
    const old = makeProject({ id: 'p2', pinnedAt: NOW - 365 * DAY_MS });
    expect(isProjectPinned(fresh)).toBe(true);
    expect(isProjectPinned(old)).toBe(true);
  });
});

describe('milestoneProgress', () => {
  it('returns {resolved:0,total:0,pct:1} for empty milestones', () => {
    expect(milestoneProgress(makeMilestone({ id: 'm1' }), [])).toEqual({
      resolved: 0,
      total: 0,
      pct: 1,
    });
  });

  it('counts only tickets in the milestone', () => {
    const m = makeMilestone({ id: 'm1' });
    const tickets = [
      makeTicket({ id: 't1', milestoneId: 'm1', resolution: 'completed' }),
      makeTicket({ id: 't2', milestoneId: 'm1' }),
      makeTicket({ id: 't3', milestoneId: 'm2', resolution: 'completed' }),
      makeTicket({ id: 't4' }),
    ];
    expect(milestoneProgress(m, tickets)).toEqual({ resolved: 1, total: 2, pct: 0.5 });
  });
});

describe('projectOpenTicketCount', () => {
  it('counts only unresolved, non-terminal tickets in the project', () => {
    const p = makeProject({ id: 'p1' });
    const tickets = [
      makeTicket({ id: 't1', projectId: 'p1' }),
      makeTicket({ id: 't2', projectId: 'p1', resolution: 'completed' }),
      makeTicket({ id: 't3', projectId: 'p1', columnId: 'done' }),
      makeTicket({ id: 't4', projectId: 'p2' }),
    ];
    expect(projectOpenTicketCount({ project: p, tickets, terminalColumnIds: new Set(['done']) })).toBe(1);
  });
});

describe('rankFocusForProject', () => {
  it('ranks across all the project tickets including milestone-scoped ones', () => {
    const p = makeProject({ id: 'p1' });
    const tickets = [
      makeTicket({ id: 'milestoned', projectId: 'p1', milestoneId: 'm1', priority: 'low' }),
      makeTicket({ id: 'loose', projectId: 'p1', priority: 'high' }),
      makeTicket({ id: 'other-project', projectId: 'p2', priority: 'critical' }),
    ];
    expect(rankFocusForProject({ project: p, tickets, milestones: {}, now: NOW })?.ticket.id).toBe('loose');
  });

  it('returns null when the project has no open tickets', () => {
    const p = makeProject({ id: 'p1' });
    const tickets = [makeTicket({ id: 't1', projectId: 'p1', resolution: 'completed' })];
    expect(rankFocusForProject({ project: p, tickets, milestones: {}, now: NOW })).toBeNull();
  });
});
