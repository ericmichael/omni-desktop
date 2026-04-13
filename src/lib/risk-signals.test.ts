import { describe, expect, it } from 'vitest';

import { detectRisks, RISK_THRESHOLDS } from './risk-signals';
import type { InboxItem, Milestone, Ticket } from '@/shared/types';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function makeTicket(overrides: Partial<Ticket> & { id: string }): Ticket {
  return {
    projectId: 'p1',
    title: `Ticket ${overrides.id}`,
    description: '',
    priority: 'medium',
    blockedBy: [],
    createdAt: NOW - 30 * DAY_MS,
    updatedAt: NOW - DAY_MS,
    columnId: 'backlog',
    columnChangedAt: NOW - DAY_MS,
    phaseChangedAt: NOW - DAY_MS,
    ...overrides,
  };
}

function makeMilestone(overrides: Partial<Milestone> & { id: string }): Milestone {
  return {
    projectId: 'p1',
    title: `Milestone ${overrides.id}`,
    description: '',
    status: 'active',
    createdAt: NOW - 60 * DAY_MS,
    updatedAt: NOW - DAY_MS,
    ...overrides,
  };
}

function makeInbox(overrides: Partial<InboxItem> & { id: string }): InboxItem {
  return {
    title: `Inbox ${overrides.id}`,
    status: 'new',
    createdAt: NOW - DAY_MS,
    updatedAt: NOW - DAY_MS,
    ...overrides,
  };
}

const baseInput = {
  projects: [{ id: 'p1', label: 'Project 1' }],
  wipLimit: 3,
  now: NOW,
};

describe('detectRisks', () => {
  it('returns empty on empty state', () => {
    expect(
      detectRisks({ tickets: [], milestones: [], inboxItems: [], ...baseInput })
    ).toEqual([]);
  });

  describe('stalled tickets', () => {
    it('flags tickets with no movement in threshold days', () => {
      const stale = NOW - (RISK_THRESHOLDS.stalledTicketDays + 1) * DAY_MS;
      const tickets = [
        makeTicket({ id: 't1', columnChangedAt: stale, phaseChangedAt: stale, updatedAt: stale }),
      ];
      const risks = detectRisks({ tickets, milestones: [], inboxItems: [], ...baseInput });
      expect(risks.some((r) => r.kind === 'stalled_ticket')).toBe(true);
    });

    it('does not flag fresh tickets', () => {
      const tickets = [makeTicket({ id: 't1' })];
      const risks = detectRisks({ tickets, milestones: [], inboxItems: [], ...baseInput });
      expect(risks.some((r) => r.kind === 'stalled_ticket')).toBe(false);
    });

    it('does not flag tickets in a terminal column', () => {
      const stale = NOW - 20 * DAY_MS;
      const tickets = [
        makeTicket({ id: 't1', columnId: 'done', columnChangedAt: stale, phaseChangedAt: stale, updatedAt: stale }),
      ];
      const risks = detectRisks({
        tickets,
        milestones: [],
        inboxItems: [],
        ...baseInput,
        terminalColumnIds: new Set(['done']),
      });
      expect(risks.some((r) => r.kind === 'stalled_ticket')).toBe(false);
    });

    it('does not flag resolved tickets', () => {
      const stale = NOW - 20 * DAY_MS;
      const tickets = [
        makeTicket({
          id: 't1',
          resolution: 'completed',
          resolvedAt: stale,
          columnChangedAt: stale,
          updatedAt: stale,
        }),
      ];
      const risks = detectRisks({ tickets, milestones: [], inboxItems: [], ...baseInput });
      expect(risks.some((r) => r.kind === 'stalled_ticket')).toBe(false);
    });

    it('does not flag running tickets', () => {
      const stale = NOW - 20 * DAY_MS;
      const tickets = [
        makeTicket({ id: 't1', phase: 'running', phaseChangedAt: stale, updatedAt: stale }),
      ];
      const risks = detectRisks({ tickets, milestones: [], inboxItems: [], ...baseInput });
      expect(risks.some((r) => r.kind === 'stalled_ticket')).toBe(false);
    });
  });

  describe('self-blocked', () => {
    it('flags awaiting_input tickets older than the threshold', () => {
      const old = NOW - 2 * DAY_MS;
      const tickets = [
        makeTicket({ id: 't1', phase: 'awaiting_input', phaseChangedAt: old }),
      ];
      const risks = detectRisks({ tickets, milestones: [], inboxItems: [], ...baseInput });
      expect(risks.some((r) => r.kind === 'self_blocked')).toBe(true);
    });

    it('does not flag freshly-blocked tickets', () => {
      const tickets = [
        makeTicket({ id: 't1', phase: 'awaiting_input', phaseChangedAt: NOW - 60 * 1000 }),
      ];
      const risks = detectRisks({ tickets, milestones: [], inboxItems: [], ...baseInput });
      expect(risks.some((r) => r.kind === 'self_blocked')).toBe(false);
    });
  });

  describe('WIP overflow', () => {
    it('flags when active count reaches wipLimit', () => {
      const tickets = [
        makeTicket({ id: 't1', phase: 'running' }),
        makeTicket({ id: 't2', phase: 'running' }),
        makeTicket({ id: 't3', phase: 'running' }),
      ];
      const risks = detectRisks({
        tickets,
        milestones: [],
        inboxItems: [],
        ...baseInput,
      });
      expect(risks.some((r) => r.kind === 'wip_overflow')).toBe(true);
    });

    it('does not flag below the limit', () => {
      const tickets = [makeTicket({ id: 't1', phase: 'running' })];
      const risks = detectRisks({ tickets, milestones: [], inboxItems: [], ...baseInput });
      expect(risks.some((r) => r.kind === 'wip_overflow')).toBe(false);
    });

    it('excludes terminal-column tickets from the active count', () => {
      const tickets = [
        makeTicket({ id: 't1', phase: 'running' }),
        makeTicket({ id: 't2', phase: 'running', columnId: 'done' }),
        makeTicket({ id: 't3', phase: 'running', columnId: 'done' }),
      ];
      const risks = detectRisks({
        tickets,
        milestones: [],
        inboxItems: [],
        ...baseInput,
        terminalColumnIds: new Set(['done']),
      });
      expect(risks.some((r) => r.kind === 'wip_overflow')).toBe(false);
    });
  });

  describe('milestone deadline pressure', () => {
    it('flags overdue milestones with unresolved tickets as high severity', () => {
      const milestones = [makeMilestone({ id: 'm1', dueDate: NOW - DAY_MS })];
      const tickets = [makeTicket({ id: 't1', milestoneId: 'm1' })];
      const risks = detectRisks({ tickets, milestones, inboxItems: [], ...baseInput });
      const overdue = risks.find((r) => r.kind === 'milestone_overdue');
      expect(overdue).toBeDefined();
      expect(overdue?.severity).toBe('high');
    });

    it('does not flag overdue milestones whose work is all done', () => {
      const milestones = [makeMilestone({ id: 'm1', dueDate: NOW - DAY_MS })];
      const tickets = [
        makeTicket({ id: 't1', milestoneId: 'm1', resolution: 'completed', resolvedAt: NOW - 2 * DAY_MS }),
      ];
      const risks = detectRisks({ tickets, milestones, inboxItems: [], ...baseInput });
      expect(risks.some((r) => r.kind === 'milestone_overdue')).toBe(false);
    });

    it('flags due-in-3-days with <50% complete as high severity', () => {
      const milestones = [makeMilestone({ id: 'm1', dueDate: NOW + 2 * DAY_MS })];
      const tickets = [
        makeTicket({ id: 't1', milestoneId: 'm1' }),
        makeTicket({ id: 't2', milestoneId: 'm1' }),
        makeTicket({ id: 't3', milestoneId: 'm1' }),
      ];
      const risks = detectRisks({ tickets, milestones, inboxItems: [], ...baseInput });
      const soon = risks.find((r) => r.kind === 'milestone_due_soon');
      expect(soon?.severity).toBe('high');
    });

    it('flags due-in-7-days with <75% complete as medium severity', () => {
      const milestones = [makeMilestone({ id: 'm1', dueDate: NOW + 5 * DAY_MS })];
      const tickets = [
        makeTicket({ id: 't1', milestoneId: 'm1' }),
        makeTicket({ id: 't2', milestoneId: 'm1' }),
        makeTicket({ id: 't3', milestoneId: 'm1' }),
      ];
      const risks = detectRisks({ tickets, milestones, inboxItems: [], ...baseInput });
      const soon = risks.find((r) => r.kind === 'milestone_due_soon');
      expect(soon?.severity).toBe('medium');
    });

    it('does not flag well-underway milestones', () => {
      const milestones = [makeMilestone({ id: 'm1', dueDate: NOW + 2 * DAY_MS })];
      const tickets = [
        makeTicket({ id: 't1', milestoneId: 'm1', resolution: 'completed', resolvedAt: NOW - DAY_MS }),
        makeTicket({ id: 't2', milestoneId: 'm1', resolution: 'completed', resolvedAt: NOW - DAY_MS }),
        makeTicket({ id: 't3', milestoneId: 'm1' }),
      ];
      const risks = detectRisks({ tickets, milestones, inboxItems: [], ...baseInput });
      expect(risks.some((r) => r.kind === 'milestone_due_soon')).toBe(false);
    });
  });

  describe('quiet milestone', () => {
    it('flags active milestones with no ticket activity in threshold days', () => {
      const quiet = NOW - (RISK_THRESHOLDS.milestoneQuietDays + 1) * DAY_MS;
      const milestones = [makeMilestone({ id: 'm1', updatedAt: quiet })];
      const tickets = [makeTicket({ id: 't1', milestoneId: 'm1', updatedAt: quiet })];
      const risks = detectRisks({ tickets, milestones, inboxItems: [], ...baseInput });
      expect(risks.some((r) => r.kind === 'milestone_quiet')).toBe(true);
    });

    it('is suppressed when a deadline signal already fires for the same milestone', () => {
      const quiet = NOW - 20 * DAY_MS;
      const milestones = [
        makeMilestone({ id: 'm1', updatedAt: quiet, dueDate: NOW + 2 * DAY_MS }),
      ];
      const tickets = [
        makeTicket({ id: 't1', milestoneId: 'm1', updatedAt: quiet }),
        makeTicket({ id: 't2', milestoneId: 'm1', updatedAt: quiet }),
      ];
      const risks = detectRisks({ tickets, milestones, inboxItems: [], ...baseInput });
      expect(risks.some((r) => r.kind === 'milestone_quiet')).toBe(false);
      expect(risks.some((r) => r.kind === 'milestone_due_soon')).toBe(true);
    });
  });

  describe('inbox', () => {
    it('flags items with <=1 day left as high severity', () => {
      const old = NOW - 6.5 * DAY_MS; // 7-day expiry → ~0.5 days left
      const inboxItems = [makeInbox({ id: 'i1', createdAt: old })];
      const risks = detectRisks({ tickets: [], milestones: [], inboxItems, ...baseInput });
      const urgent = risks.find((r) => r.kind === 'inbox_expiring');
      expect(urgent?.severity).toBe('high');
    });

    it('flags items past midway as medium severity (aging)', () => {
      const mid = NOW - 4 * DAY_MS;
      const inboxItems = [makeInbox({ id: 'i1', createdAt: mid })];
      const risks = detectRisks({ tickets: [], milestones: [], inboxItems, ...baseInput });
      const aging = risks.find((r) => r.kind === 'aging_inbox');
      expect(aging?.severity).toBe('medium');
    });

    it('ignores shaped items', () => {
      const old = NOW - 6.5 * DAY_MS;
      const inboxItems = [makeInbox({ id: 'i1', status: 'shaped', createdAt: old })];
      const risks = detectRisks({ tickets: [], milestones: [], inboxItems, ...baseInput });
      expect(risks.some((r) => r.kind === 'inbox_expiring' || r.kind === 'aging_inbox')).toBe(
        false
      );
    });

    it('ignores promoted items', () => {
      const old = NOW - 6.5 * DAY_MS;
      const inboxItems = [
        makeInbox({ id: 'i1', createdAt: old, promotedTo: { kind: 'ticket', id: 't1', at: NOW } }),
      ];
      const risks = detectRisks({ tickets: [], milestones: [], inboxItems, ...baseInput });
      expect(risks).toHaveLength(0);
    });
  });

  describe('quiet project', () => {
    it('flags projects with no activity in threshold days', () => {
      const quiet = NOW - (RISK_THRESHOLDS.projectQuietDays + 1) * DAY_MS;
      const tickets = [makeTicket({ id: 't1', updatedAt: quiet })];
      const risks = detectRisks({ tickets, milestones: [], inboxItems: [], ...baseInput });
      expect(risks.some((r) => r.kind === 'quiet_project')).toBe(true);
    });

    it('does not flag empty projects', () => {
      const risks = detectRisks({ tickets: [], milestones: [], inboxItems: [], ...baseInput });
      expect(risks.some((r) => r.kind === 'quiet_project')).toBe(false);
    });
  });

  it('sorts high-severity signals ahead of low', () => {
    const quiet = NOW - (RISK_THRESHOLDS.projectQuietDays + 1) * DAY_MS;
    const old = NOW - 6.5 * DAY_MS;
    const tickets = [makeTicket({ id: 't1', updatedAt: quiet })];
    const inboxItems = [makeInbox({ id: 'i1', createdAt: old })];
    const risks = detectRisks({ tickets, milestones: [], inboxItems, ...baseInput });
    expect(risks[0]?.severity).toBe('high');
    expect(risks[risks.length - 1]?.severity).toBe('low');
  });
});
