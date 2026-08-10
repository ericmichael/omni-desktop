/**
 * Tests for plan-snapshot persistence on the SupervisorOrchestrator
 * (docs/agentic-workflow-enforcement-plan.md §F): forwarded `plan-update`
 * bridge events persist to `Ticket.lastPlanSnapshot` with a trailing
 * debounce, human-gate steps sync deduplicated inbox items, and settlement
 * clears both.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SupervisorBridge, SupervisorBridgeEventHandler } from '@/main/supervisor-bridge';
import {
  PLAN_SNAPSHOT_DEBOUNCE_MS,
  SupervisorOrchestrator,
  type SupervisorOrchestratorDeps,
} from '@/main/supervisor-orchestrator';
import type {
  ColumnId,
  InboxItem,
  InboxItemId,
  Pipeline,
  PlanSnapshotEntry,
  ProjectId,
  Ticket,
  TicketId,
} from '@/shared/types';

const TICKET_ID = 't1' as TicketId;
const PROJECT_ID = 'p1' as ProjectId;

const pipeline: Pipeline = {
  columns: [
    { id: 'todo' as ColumnId, label: 'To do', category: 'todo' },
    { id: 'doing' as ColumnId, label: 'Doing', category: 'doing' },
    { id: 'done' as ColumnId, label: 'Done', category: 'done' },
  ],
};

const baseTicket = (): Ticket => ({
  id: TICKET_ID,
  projectId: PROJECT_ID,
  columnId: 'doing' as ColumnId,
  title: 'T',
  description: '',
  priority: 'medium',
  blockedBy: [],
  createdAt: 0,
  updatedAt: 0,
});

const snapshot = (steps: Partial<PlanSnapshotEntry>[]): PlanSnapshotEntry[] =>
  steps.map((s, i) => ({ id: String(i + 1), subject: `Step ${i + 1}`, status: 'pending', ...s }));

type Harness = {
  orchestrator: SupervisorOrchestrator;
  emit: SupervisorBridgeEventHandler;
  tickets: Map<TicketId, Ticket>;
  inboxItems: InboxItem[];
  updateTicket: ReturnType<typeof vi.fn>;
};

const makeHarness = (): Harness => {
  let handler: SupervisorBridgeEventHandler = () => {};
  const bridge = {
    onEvent: (h: SupervisorBridgeEventHandler) => {
      handler = h;
      return () => {};
    },
  } as unknown as SupervisorBridge;

  const tickets = new Map<TicketId, Ticket>([[TICKET_ID, baseTicket()]]);
  const updateTicket = vi.fn((id: TicketId, patch: Partial<Ticket>) => {
    const current = tickets.get(id);
    if (current) {
      tickets.set(id, { ...current, ...patch });
    }
  });

  const inboxItems: InboxItem[] = [];
  let nextInboxId = 0;
  const inbox = {
    getAll: () => inboxItems,
    add: (input: { title: string; note?: string; projectId?: ProjectId | null }) => {
      const item: InboxItem = {
        id: `inb_${++nextInboxId}` as InboxItemId,
        title: input.title,
        note: input.note,
        projectId: input.projectId,
        status: 'new',
        createdAt: 0,
        updatedAt: 0,
      };
      inboxItems.push(item);
      return item;
    },
    remove: (id: InboxItemId) => {
      const index = inboxItems.findIndex((i) => i.id === id);
      if (index === -1) {
        throw new Error(`not found: ${id}`);
      }
      inboxItems.splice(index, 1);
    },
  };

  const deps = {
    store: {},
    host: {
      getTicketById: (id: TicketId) => tickets.get(id),
      getPipeline: () => pipeline,
      updateTicket,
    },
    sendToWindow: vi.fn(),
    bridge,
    inbox,
  } as unknown as SupervisorOrchestratorDeps;

  const orchestrator = new SupervisorOrchestrator(deps);
  return { orchestrator, emit: (e) => handler(e), tickets, inboxItems, updateTicket };
};

let harness: Harness;

beforeEach(() => {
  vi.useFakeTimers();
  harness = makeHarness();
});

afterEach(() => {
  harness.orchestrator.dispose();
  vi.useRealTimers();
});

const flush = (): void => {
  vi.advanceTimersByTime(PLAN_SNAPSHOT_DEBOUNCE_MS + 1);
};

describe('plan-update persistence', () => {
  it('persists the snapshot to lastPlanSnapshot after the debounce window', () => {
    const steps = snapshot([{ status: 'completed' }, { status: 'in_progress' }]);
    harness.emit({ kind: 'plan-update', ticketId: TICKET_ID, snapshot: steps });

    expect(harness.updateTicket).not.toHaveBeenCalled();
    flush();
    expect(harness.updateTicket).toHaveBeenCalledWith(TICKET_ID, { lastPlanSnapshot: steps });
  });

  it('coalesces bursts — only the latest snapshot is written', () => {
    harness.emit({ kind: 'plan-update', ticketId: TICKET_ID, snapshot: snapshot([{}]) });
    const latest = snapshot([{}, {}]);
    harness.emit({ kind: 'plan-update', ticketId: TICKET_ID, snapshot: latest });

    flush();
    expect(harness.updateTicket).toHaveBeenCalledTimes(1);
    expect(harness.updateTicket).toHaveBeenCalledWith(TICKET_ID, { lastPlanSnapshot: latest });
  });

  it('ignores null and empty snapshots (fresh sessions report no plan)', () => {
    harness.emit({ kind: 'plan-update', ticketId: TICKET_ID, snapshot: null });
    harness.emit({ kind: 'plan-update', ticketId: TICKET_ID, snapshot: [] });
    flush();
    expect(harness.updateTicket).not.toHaveBeenCalled();
  });

  it('does not write to a ticket already settled into a done column', () => {
    harness.tickets.set(TICKET_ID, { ...baseTicket(), columnId: 'done' as ColumnId });
    harness.emit({ kind: 'plan-update', ticketId: TICKET_ID, snapshot: snapshot([{}]) });
    flush();
    expect(harness.updateTicket).not.toHaveBeenCalled();
  });
});

describe('human-gate inbox items', () => {
  const blockedOnUser = (): PlanSnapshotEntry[] =>
    snapshot([{ status: 'completed' }, { status: 'blocked', owner: 'user', subject: 'Approve the schema change' }]);

  it('creates an inbox item for a blocked human-owned step', () => {
    harness.emit({ kind: 'plan-update', ticketId: TICKET_ID, snapshot: blockedOnUser() });
    flush();

    expect(harness.inboxItems).toHaveLength(1);
    expect(harness.inboxItems[0]!.title).toBe('agent is waiting on you: Approve the schema change');
    expect(harness.inboxItems[0]!.projectId).toBe(PROJECT_ID);
  });

  it('does not duplicate the item on repeated snapshot writes', () => {
    harness.emit({ kind: 'plan-update', ticketId: TICKET_ID, snapshot: blockedOnUser() });
    flush();
    harness.emit({ kind: 'plan-update', ticketId: TICKET_ID, snapshot: blockedOnUser() });
    flush();

    expect(harness.inboxItems).toHaveLength(1);
  });

  it('removes the item when the step unblocks', () => {
    harness.emit({ kind: 'plan-update', ticketId: TICKET_ID, snapshot: blockedOnUser() });
    flush();
    const unblocked = blockedOnUser().map((s) => (s.id === '2' ? { ...s, status: 'in_progress' as const } : s));
    harness.emit({ kind: 'plan-update', ticketId: TICKET_ID, snapshot: unblocked });
    flush();

    expect(harness.inboxItems).toHaveLength(0);
  });

  it('does not create items for agent-owned blocked steps', () => {
    harness.emit({
      kind: 'plan-update',
      ticketId: TICKET_ID,
      snapshot: snapshot([{ status: 'blocked', owner: 'agent:reviewer' }]),
    });
    flush();
    expect(harness.inboxItems).toHaveLength(0);
  });
});

describe('settlement', () => {
  it('clears the stored snapshot, gate items, and any pending write', () => {
    harness.emit({
      kind: 'plan-update',
      ticketId: TICKET_ID,
      snapshot: snapshot([{ status: 'blocked', owner: 'user' }]),
    });
    flush();
    expect(harness.tickets.get(TICKET_ID)!.lastPlanSnapshot).toBeDefined();
    expect(harness.inboxItems).toHaveLength(1);

    // A trailing update is in flight when the ticket settles.
    harness.emit({ kind: 'plan-update', ticketId: TICKET_ID, snapshot: snapshot([{}, {}]) });
    harness.orchestrator.settlePlanSnapshot(TICKET_ID);

    expect(harness.tickets.get(TICKET_ID)!.lastPlanSnapshot).toBeUndefined();
    expect(harness.inboxItems).toHaveLength(0);

    // The pending debounced write was cancelled — nothing resurrects.
    const writes = harness.updateTicket.mock.calls.length;
    flush();
    expect(harness.updateTicket.mock.calls.length).toBe(writes);
  });
});
