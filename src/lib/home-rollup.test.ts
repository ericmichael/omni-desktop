import { describe, expect, it } from 'vitest';

import type { RiskSignal } from '@/lib/risk-signals';
import type { Milestone, Project, Ticket } from '@/shared/types';

import {
  groupRiskSignalsForHome,
  isMilestonePinned,
  isProjectPinned,
  milestoneProgress,
  projectOpenTicketCount,
  rankFocusForMilestone,
  rankFocusForProject,
} from './home-rollup';

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

describe('isMilestonePinned', () => {
  it('returns false when pinnedAt is undefined', () => {
    expect(isMilestonePinned(makeMilestone({ id: 'm1' }))).toBe(false);
  });

  it('returns true when pinnedAt is set, regardless of age', () => {
    const fresh = makeMilestone({ id: 'm1', pinnedAt: NOW });
    const old = makeMilestone({ id: 'm2', pinnedAt: NOW - 365 * DAY_MS });
    expect(isMilestonePinned(fresh)).toBe(true);
    expect(isMilestonePinned(old)).toBe(true);
  });
});

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

describe('rankFocusForMilestone', () => {
  it('returns null when the milestone has no open tickets', () => {
    const m = makeMilestone({ id: 'm1' });
    const tickets = [makeTicket({ id: 't1', milestoneId: 'm1', resolution: 'completed' })];
    expect(rankFocusForMilestone({ milestone: m, tickets, milestones: { m1: m }, now: NOW })).toBeNull();
  });

  it('only ranks tickets inside the milestone', () => {
    const m = makeMilestone({ id: 'm1' });
    const tickets = [
      makeTicket({ id: 'inside', milestoneId: 'm1', priority: 'low' }),
      makeTicket({ id: 'outside', milestoneId: 'm2', priority: 'critical' }),
    ];
    expect(rankFocusForMilestone({ milestone: m, tickets, milestones: { m1: m }, now: NOW })?.ticket.id).toBe('inside');
  });

  it('picks the highest-priority open ticket', () => {
    const m = makeMilestone({ id: 'm1' });
    const tickets = [
      makeTicket({ id: 'low', milestoneId: 'm1', priority: 'low' }),
      makeTicket({ id: 'high', milestoneId: 'm1', priority: 'high' }),
    ];
    expect(rankFocusForMilestone({ milestone: m, tickets, milestones: { m1: m }, now: NOW })?.ticket.id).toBe('high');
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

describe('groupRiskSignalsForHome', () => {
  it('routes open_ticket signals to both project and milestone buckets', () => {
    const tickets = [makeTicket({ id: 't1', projectId: 'p1', milestoneId: 'm1' })];
    const signals: RiskSignal[] = [
      {
        id: 'stalled:t1',
        kind: 'stalled_ticket',
        severity: 'medium',
        title: 'T1',
        action: { kind: 'open_ticket', ticketId: 't1' },
      },
    ];
    const { byProject, byMilestone, inbox } = groupRiskSignalsForHome({ signals, tickets });
    expect(byProject.get('p1')?.[0]?.id).toBe('stalled:t1');
    expect(byMilestone.get('m1')?.[0]?.id).toBe('stalled:t1');
    expect(inbox).toEqual([]);
  });

  it('routes open_ticket on a loose ticket to project only', () => {
    const tickets = [makeTicket({ id: 't1', projectId: 'p1' })];
    const signals: RiskSignal[] = [
      {
        id: 'stalled:t1',
        kind: 'stalled_ticket',
        severity: 'medium',
        title: 'T1',
        action: { kind: 'open_ticket', ticketId: 't1' },
      },
    ];
    const { byProject, byMilestone } = groupRiskSignalsForHome({ signals, tickets });
    expect(byProject.get('p1')?.[0]?.id).toBe('stalled:t1');
    expect(byMilestone.size).toBe(0);
  });

  it('routes open_milestone signals only to the milestone bucket', () => {
    const signals: RiskSignal[] = [
      {
        id: 'milestone_overdue:m1',
        kind: 'milestone_overdue',
        severity: 'high',
        title: 'M1',
        action: { kind: 'open_milestone', milestoneId: 'm1', projectId: 'p1' },
      },
    ];
    const { byProject, byMilestone } = groupRiskSignalsForHome({ signals, tickets: [] });
    expect(byProject.size).toBe(0);
    expect(byMilestone.get('m1')?.[0]?.id).toBe('milestone_overdue:m1');
  });

  it('routes open_project signals to the project bucket', () => {
    const signals: RiskSignal[] = [
      {
        id: 'quiet_project:p1',
        kind: 'quiet_project',
        severity: 'low',
        title: 'p1',
        action: { kind: 'open_project', projectId: 'p1' },
      },
    ];
    const { byProject } = groupRiskSignalsForHome({ signals, tickets: [] });
    expect(byProject.get('p1')?.[0]?.id).toBe('quiet_project:p1');
  });

  it('collects inbox signals into the inbox bucket', () => {
    const signals: RiskSignal[] = [
      {
        id: 'inbox_expiring:x',
        kind: 'inbox_expiring',
        severity: 'high',
        title: 'x',
        action: { kind: 'open_inbox_item', inboxItemId: 'x' },
      },
    ];
    const { inbox } = groupRiskSignalsForHome({ signals, tickets: [] });
    expect(inbox.map((s) => s.id)).toEqual(['inbox_expiring:x']);
  });

  it('drops WIP overflow (rendered via the WIP gauge instead)', () => {
    const signals: RiskSignal[] = [
      {
        id: 'wip_overflow',
        kind: 'wip_overflow',
        severity: 'high',
        title: 'wip',
        action: { kind: 'open_wip_dialog' },
      },
    ];
    const { byProject, byMilestone, inbox } = groupRiskSignalsForHome({ signals, tickets: [] });
    expect(byProject.size).toBe(0);
    expect(byMilestone.size).toBe(0);
    expect(inbox).toEqual([]);
  });
});
