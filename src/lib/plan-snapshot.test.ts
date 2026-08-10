import { describe, expect, it } from 'vitest';

import {
  diffHumanGateItems,
  hasIncompleteSteps,
  humanGateInboxNote,
  humanGateInboxTitle,
  humanGateMarker,
  isHumanGateStep,
  isIncompleteStep,
} from '@/lib/plan-snapshot';
import type { InboxItem, InboxItemId, PlanSnapshotEntry, TicketId } from '@/shared/types';

const TICKET = 'tkt_1' as TicketId;

const step = (overrides: Partial<PlanSnapshotEntry> = {}): PlanSnapshotEntry => ({
  id: '1',
  subject: 'Review the deploy plan',
  status: 'pending',
  ...overrides,
});

const gateItem = (id: string, ticketId: TicketId, stepId: string, extra: Partial<InboxItem> = {}): InboxItem => ({
  id: id as InboxItemId,
  title: 'agent is waiting on you: Review the deploy plan',
  note: `Some body\n\n${humanGateMarker(ticketId, stepId)}`,
  status: 'new',
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});

describe('isIncompleteStep / hasIncompleteSteps', () => {
  it('treats every non-completed status as incomplete', () => {
    expect(isIncompleteStep(step({ status: 'pending' }))).toBe(true);
    expect(isIncompleteStep(step({ status: 'in_progress' }))).toBe(true);
    expect(isIncompleteStep(step({ status: 'blocked' }))).toBe(true);
    expect(isIncompleteStep(step({ status: 'completed' }))).toBe(false);
  });

  it('hasIncompleteSteps is false for an all-completed snapshot', () => {
    expect(hasIncompleteSteps([step({ status: 'completed' }), step({ id: '2', status: 'completed' })])).toBe(false);
    expect(hasIncompleteSteps([step({ status: 'completed' }), step({ id: '2', status: 'blocked' })])).toBe(true);
    expect(hasIncompleteSteps([])).toBe(false);
  });
});

describe('isHumanGateStep', () => {
  it('requires blocked status and a non-agent owner', () => {
    expect(isHumanGateStep(step({ status: 'blocked', owner: 'user' }))).toBe(true);
    expect(isHumanGateStep(step({ status: 'blocked', owner: 'eric@example.com' }))).toBe(true);
    expect(isHumanGateStep(step({ status: 'blocked', owner: 'agent:reviewer' }))).toBe(false);
    expect(isHumanGateStep(step({ status: 'blocked' }))).toBe(false);
    expect(isHumanGateStep(step({ status: 'blocked', owner: '' }))).toBe(false);
    expect(isHumanGateStep(step({ status: 'pending', owner: 'user' }))).toBe(false);
    expect(isHumanGateStep(step({ status: 'in_progress', owner: 'user' }))).toBe(false);
  });
});

describe('humanGateInboxTitle / humanGateInboxNote', () => {
  it('titles the item with the step subject', () => {
    expect(humanGateInboxTitle(step())).toBe('agent is waiting on you: Review the deploy plan');
  });

  it('embeds the dedupe marker and the exit criteria in the note', () => {
    const note = humanGateInboxNote(TICKET, step({ owner: 'user', exitCriteria: 'deploy approved in writing' }));
    expect(note).toContain(humanGateMarker(TICKET, '1'));
    expect(note).toContain('Done when: deploy approved in writing');
  });
});

describe('diffHumanGateItems', () => {
  it('creates an item for a new human gate', () => {
    const diff = diffHumanGateItems(TICKET, [step({ status: 'blocked', owner: 'user' })], []);
    expect(diff.create.map((s) => s.id)).toEqual(['1']);
    expect(diff.removeIds).toEqual([]);
  });

  it('does not re-create an item that already exists for the same ticket+step', () => {
    const diff = diffHumanGateItems(
      TICKET,
      [step({ status: 'blocked', owner: 'user' })],
      [gateItem('inb_1', TICKET, '1')]
    );
    expect(diff.create).toEqual([]);
    expect(diff.removeIds).toEqual([]);
  });

  it('removes the item when the step is no longer blocked', () => {
    const diff = diffHumanGateItems(
      TICKET,
      [step({ status: 'in_progress', owner: 'user' })],
      [gateItem('inb_1', TICKET, '1')]
    );
    expect(diff.create).toEqual([]);
    expect(diff.removeIds).toEqual(['inb_1']);
  });

  it('removes the item when the step leaves the snapshot', () => {
    const diff = diffHumanGateItems(
      TICKET,
      [step({ id: '9', status: 'blocked', owner: 'user' })],
      [gateItem('inb_1', TICKET, '1')]
    );
    expect(diff.create.map((s) => s.id)).toEqual(['9']);
    expect(diff.removeIds).toEqual(['inb_1']);
  });

  it('an empty snapshot removes every gate item for the ticket (settlement)', () => {
    const diff = diffHumanGateItems(TICKET, [], [gateItem('inb_1', TICKET, '1'), gateItem('inb_2', TICKET, '2')]);
    expect(diff.removeIds).toEqual(['inb_1', 'inb_2']);
  });

  it('ignores other tickets, unmarked items, and promoted tombstones', () => {
    const otherTicket = gateItem('inb_other', 'tkt_2' as TicketId, '1');
    const unmarked: InboxItem = {
      id: 'inb_plain' as InboxItemId,
      title: 'Buy milk',
      status: 'new',
      createdAt: 0,
      updatedAt: 0,
    };
    const promoted = gateItem('inb_promoted', TICKET, '1', {
      promotedTo: { kind: 'ticket', id: 'tkt_9', at: 1 },
    });
    const diff = diffHumanGateItems(TICKET, [], [otherTicket, unmarked, promoted]);
    expect(diff.removeIds).toEqual([]);
  });
});
