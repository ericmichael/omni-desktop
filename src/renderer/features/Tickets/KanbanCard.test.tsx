import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/renderer/ds/ui/tooltip';
import type { PlanSnapshotEntry, Ticket } from '@/shared/types';

import { KanbanCard } from './KanbanCard';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// The card only reads blockers/pipeline from the store and drag state from
// dnd-kit; stub both so the component renders standalone (vi.mock hoists
// above the imports, so the factory pulls nanostores in itself).
vi.mock('./state', async () => {
  const { atom } = await import('nanostores');
  return {
    $tickets: atom({}),
    $pipeline: atom(null),
    ticketApi: {
      goToTicket: vi.fn(),
      requestStartSupervisor: vi.fn(),
      ensureSupervisorInfra: vi.fn(),
    },
  };
});

vi.mock('@/renderer/services/navigation', () => ({
  openTicketInCode: vi.fn(),
}));

vi.mock('@dnd-kit/core', () => ({
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, isDragging: false }),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: 'ticket-1',
  projectId: 'project-1',
  title: 'Fix the flaky test',
  description: '',
  priority: 'medium',
  blockedBy: [],
  createdAt: 1,
  updatedAt: 2,
  columnId: 'doing',
  ...overrides,
});

const snapshot: PlanSnapshotEntry[] = [
  { id: '1', subject: 'reproduce', status: 'completed', verified: true },
  { id: '2', subject: 'fix bug', activeForm: 'Fixing the bug', status: 'in_progress' },
  { id: '3', subject: 'verify fix', status: 'completed', verified: false },
  { id: '4', subject: 'human sign-off', status: 'blocked', owner: 'eric', blockedBy: ['2'] },
];

const render = async (t: Ticket) => {
  await act(async () => {
    root.render(
      <TooltipProvider>
        <KanbanCard ticket={t} />
      </TooltipProvider>
    );
    await Promise.resolve();
  });
};

describe('KanbanCard plan progress', () => {
  it('renders nothing extra without a snapshot — output matches a snapshotless card', async () => {
    await render(ticket());
    expect(container.querySelector('[data-testid="plan-progress"]')).toBeNull();
    const withoutField = container.innerHTML;

    await render(ticket({ lastPlanSnapshot: [] }));
    expect(container.innerHTML).toBe(withoutField);
  });

  it('shows the step fraction, active line, blocked indicator, and unverified badge', async () => {
    await render(ticket({ lastPlanSnapshot: snapshot }));
    const row = container.querySelector('[data-testid="plan-progress"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('2/4');
    expect(row!.textContent).toContain('Fixing the bug');
    expect(row!.textContent).toContain('blocked');
    expect(row!.textContent).toContain('1 unverified');
  });

  it('falls back to the subject when the active step has no activeForm and omits absent indicators', async () => {
    await render(
      ticket({
        lastPlanSnapshot: [
          { id: '1', subject: 'only step', status: 'in_progress' },
          { id: '2', subject: 'later', status: 'pending' },
        ],
      })
    );
    const row = container.querySelector('[data-testid="plan-progress"]');
    expect(row!.textContent).toContain('0/2');
    expect(row!.textContent).toContain('only step');
    expect(row!.textContent).not.toContain('blocked');
    expect(row!.textContent).not.toContain('unverified');
  });
});
