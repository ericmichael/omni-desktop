/**
 * Tests for MilestoneManager — milestone lifecycle, completedAt stamping,
 * ticket orphan-clearing, branch resolution, and cascade deletion.
 *
 * Pure store-ops manager — no file I/O, no processes, no network.
 * All deps are injectable in-memory fakes.
 */
import { describe, expect, it } from 'vitest';

import { MilestoneManager, type MilestoneManagerStore } from '@/main/milestone-manager';
import type { Milestone, MilestoneId, Ticket } from '@/shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(
  initial?: { milestones?: Milestone[]; tickets?: Ticket[] }
): MilestoneManagerStore & { milestones: Milestone[]; tickets: Ticket[] } {
  const store = {
    milestones: initial?.milestones ?? [],
    tickets: initial?.tickets ?? [],
    getMilestones() {
      return store.milestones;
    },
    setMilestones(items: Milestone[]) {
      store.milestones = items;
    },
    getTickets() {
      return store.tickets;
    },
    setTickets(items: Ticket[]) {
      store.tickets = items;
    },
  };
  return store;
}

let idCounter = 0;
let clock = 1000;

function makeMgr(initial?: { milestones?: Milestone[]; tickets?: Ticket[] }) {
  idCounter = 0;
  clock = 1000;
  const store = makeStore(initial);
  const mgr = new MilestoneManager({
    store,
    newId: () => `ms-${++idCounter}`,
    now: () => clock,
  });
  return { mgr, store };
}

function makeMilestone(overrides: Partial<Milestone> & { id: string; projectId: string }): Milestone {
  return {
    title: 'Test Milestone',
    description: '',
    status: 'active',
    createdAt: 500,
    updatedAt: 500,
    ...overrides,
  };
}

function makeTicket(overrides: Partial<Ticket> & { id: string; projectId: string; columnId: string }): Ticket {
  return {
    title: 'Test Ticket',
    description: '',
    priority: 'medium',
    blockedBy: [],
    createdAt: 500,
    updatedAt: 500,
    ...overrides,
  } as Ticket;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MilestoneManager', () => {
  describe('CRUD', () => {
    it('starts empty', () => {
      const { mgr } = makeMgr();
      expect(mgr.getAll()).toEqual([]);
    });

    it('adds a milestone with generated id and timestamps', () => {
      const { mgr } = makeMgr();
      const ms = mgr.add({ projectId: 'p1', title: 'Sprint 1', description: 'desc', status: 'active' });

      expect(ms.id).toBe('ms-1');
      expect(ms.projectId).toBe('p1');
      expect(ms.title).toBe('Sprint 1');
      expect(ms.createdAt).toBe(1000);
      expect(ms.updatedAt).toBe(1000);
    });

    it('persists added milestone to store', () => {
      const { mgr, store } = makeMgr();
      mgr.add({ projectId: 'p1', title: 'Sprint 1', description: '', status: 'active' });

      expect(store.milestones).toHaveLength(1);
      expect(store.milestones[0]!.id).toBe('ms-1');
    });

    it('getById returns the milestone', () => {
      const { mgr } = makeMgr();
      mgr.add({ projectId: 'p1', title: 'Sprint 1', description: '', status: 'active' });

      expect(mgr.getById('ms-1')).toBeDefined();
      expect(mgr.getById('ms-1')!.title).toBe('Sprint 1');
    });

    it('getById returns undefined for unknown id', () => {
      const { mgr } = makeMgr();
      expect(mgr.getById('nonexistent')).toBeUndefined();
    });

    it('getByProject filters by projectId', () => {
      const { mgr } = makeMgr();
      mgr.add({ projectId: 'p1', title: 'A', description: '', status: 'active' });
      mgr.add({ projectId: 'p2', title: 'B', description: '', status: 'active' });
      mgr.add({ projectId: 'p1', title: 'C', description: '', status: 'active' });

      const p1 = mgr.getByProject('p1');
      expect(p1).toHaveLength(2);
      expect(p1.map((m) => m.title).sort()).toEqual(['A', 'C']);
    });

    it('update modifies fields and stamps updatedAt', () => {
      const { mgr } = makeMgr();
      mgr.add({ projectId: 'p1', title: 'Draft', description: '', status: 'active' });

      clock = 2000;
      mgr.update('ms-1', { title: 'Final' });

      const ms = mgr.getById('ms-1')!;
      expect(ms.title).toBe('Final');
      expect(ms.updatedAt).toBe(2000);
      expect(ms.createdAt).toBe(1000); // unchanged
    });

    it('update is a no-op for unknown id', () => {
      const { mgr, store } = makeMgr();
      mgr.update('nonexistent', { title: 'Nope' });
      expect(store.milestones).toHaveLength(0);
    });

    it('remove deletes the milestone', () => {
      const { mgr } = makeMgr();
      mgr.add({ projectId: 'p1', title: 'Doomed', description: '', status: 'active' });

      mgr.remove('ms-1');
      expect(mgr.getAll()).toHaveLength(0);
    });

    it('remove is a no-op for unknown id', () => {
      const { mgr } = makeMgr();
      mgr.add({ projectId: 'p1', title: 'Keep', description: '', status: 'active' });
      mgr.remove('nonexistent');
      expect(mgr.getAll()).toHaveLength(1);
    });
  });

  describe('completedAt stamping', () => {
    it('stamps completedAt on first transition to completed', () => {
      const { mgr } = makeMgr();
      mgr.add({ projectId: 'p1', title: 'MS', description: '', status: 'active' });

      clock = 3000;
      mgr.update('ms-1', { status: 'completed' });

      expect(mgr.getById('ms-1')!.completedAt).toBe(3000);
    });

    it('clears completedAt on transition out of completed', () => {
      const { mgr } = makeMgr();
      mgr.add({ projectId: 'p1', title: 'MS', description: '', status: 'active' });

      clock = 3000;
      mgr.update('ms-1', { status: 'completed' });
      expect(mgr.getById('ms-1')!.completedAt).toBe(3000);

      clock = 4000;
      mgr.update('ms-1', { status: 'active' });
      expect(mgr.getById('ms-1')!.completedAt).toBeUndefined();
    });

    it('does not re-stamp completedAt if already set', () => {
      const ms = makeMilestone({ id: 'ms-1', projectId: 'p1', status: 'active', completedAt: 999 });
      const { mgr } = makeMgr({ milestones: [ms] });

      clock = 5000;
      mgr.update('ms-1', { status: 'completed' });

      // Should keep the original completedAt since it was already set
      expect(mgr.getById('ms-1')!.completedAt).toBe(999);
    });

    it('does not touch completedAt for non-status updates', () => {
      const { mgr } = makeMgr();
      mgr.add({ projectId: 'p1', title: 'MS', description: '', status: 'completed' });

      clock = 2000;
      mgr.update('ms-1', { title: 'Renamed' });

      // completedAt was set during add (status was already completed)
      // but update with just title should not clear it
      const ms = mgr.getById('ms-1')!;
      expect(ms.title).toBe('Renamed');
    });
  });

  describe('ticket orphan-clearing on remove', () => {
    it('clears milestoneId from linked tickets when milestone is removed', () => {
      const ms = makeMilestone({ id: 'ms-1', projectId: 'p1' });
      const t1 = makeTicket({ id: 't1', projectId: 'p1', columnId: 'backlog', milestoneId: 'ms-1' });
      const t2 = makeTicket({ id: 't2', projectId: 'p1', columnId: 'backlog', milestoneId: 'ms-1' });
      const t3 = makeTicket({ id: 't3', projectId: 'p1', columnId: 'backlog' }); // no milestone

      const { mgr, store } = makeMgr({ milestones: [ms], tickets: [t1, t2, t3] });

      clock = 5000;
      mgr.remove('ms-1');

      expect(store.tickets[0]!.milestoneId).toBeUndefined();
      expect(store.tickets[0]!.updatedAt).toBe(5000);
      expect(store.tickets[1]!.milestoneId).toBeUndefined();
      expect(store.tickets[2]!.milestoneId).toBeUndefined(); // was already undefined
    });

    it('does not touch tickets when no tickets reference the milestone', () => {
      const ms = makeMilestone({ id: 'ms-1', projectId: 'p1' });
      const t1 = makeTicket({ id: 't1', projectId: 'p1', columnId: 'backlog' });

      const { mgr, store } = makeMgr({ milestones: [ms], tickets: [t1] });
      const originalUpdatedAt = t1.updatedAt;

      mgr.remove('ms-1');

      expect(store.tickets[0]!.updatedAt).toBe(originalUpdatedAt);
    });
  });

  describe('removeAllForProject', () => {
    it('removes all milestones for a project', () => {
      const ms1 = makeMilestone({ id: 'ms-1', projectId: 'p1' });
      const ms2 = makeMilestone({ id: 'ms-2', projectId: 'p2' });
      const ms3 = makeMilestone({ id: 'ms-3', projectId: 'p1' });

      const { mgr, store } = makeMgr({ milestones: [ms1, ms2, ms3] });

      mgr.removeAllForProject('p1');

      expect(store.milestones).toHaveLength(1);
      expect(store.milestones[0]!.id).toBe('ms-2');
    });

    it('is a no-op when project has no milestones', () => {
      const ms = makeMilestone({ id: 'ms-1', projectId: 'p1' });
      const { mgr, store } = makeMgr({ milestones: [ms] });

      mgr.removeAllForProject('p999');

      expect(store.milestones).toHaveLength(1);
    });
  });

  describe('resolveTicketBranch', () => {
    it('returns ticket branch when ticket has its own branch', () => {
      const { mgr } = makeMgr();
      const ticket = makeTicket({ id: 't1', projectId: 'p1', columnId: 'backlog', branch: 'feat/mine' });

      expect(mgr.resolveTicketBranch(ticket)).toBe('feat/mine');
    });

    it('falls back to milestone branch when ticket has no branch', () => {
      const ms = makeMilestone({ id: 'ms-1', projectId: 'p1', branch: 'release/1.0' });
      const { mgr } = makeMgr({ milestones: [ms] });
      const ticket = makeTicket({ id: 't1', projectId: 'p1', columnId: 'backlog', milestoneId: 'ms-1' });

      expect(mgr.resolveTicketBranch(ticket)).toBe('release/1.0');
    });

    it('returns undefined when neither ticket nor milestone has a branch', () => {
      const ms = makeMilestone({ id: 'ms-1', projectId: 'p1' });
      const { mgr } = makeMgr({ milestones: [ms] });
      const ticket = makeTicket({ id: 't1', projectId: 'p1', columnId: 'backlog', milestoneId: 'ms-1' });

      expect(mgr.resolveTicketBranch(ticket)).toBeUndefined();
    });

    it('returns undefined when ticket has no milestoneId', () => {
      const { mgr } = makeMgr();
      const ticket = makeTicket({ id: 't1', projectId: 'p1', columnId: 'backlog' });

      expect(mgr.resolveTicketBranch(ticket)).toBeUndefined();
    });

    it('returns undefined when milestoneId references a deleted milestone', () => {
      const { mgr } = makeMgr();
      const ticket = makeTicket({ id: 't1', projectId: 'p1', columnId: 'backlog', milestoneId: 'ms-deleted' });

      expect(mgr.resolveTicketBranch(ticket)).toBeUndefined();
    });
  });
});
