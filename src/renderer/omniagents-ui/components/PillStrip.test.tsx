import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaskSummary } from '@/renderer/omniagents-ui/canonical-plan-tasks';

import { PillStrip } from './PillStrip';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.querySelectorAll('[data-radix-popper-content-wrapper]').forEach((element) => element.remove());
  vi.unstubAllGlobals();
});

const task = (overrides: Partial<TaskSummary> = {}): TaskSummary => ({
  id: '1',
  subject: 'step subject',
  status: 'pending',
  ...overrides,
});

const renderTasksPopover = async (tasks: TaskSummary[]) => {
  await act(async () => {
    root.render(<PillStrip subagents={[]} jobs={[]} tasks={tasks} />);
    await Promise.resolve();
  });
  const pill = Array.from(container.querySelectorAll('button')).find((b) => b.getAttribute('title') === 'Tasks');
  if (!pill) {
    throw new Error('Tasks pill not found');
  }
  await act(async () => pill.click());
};

const taskRow = (id: string): HTMLElement => {
  const row = document.body.querySelector(`[data-testid="task-row-${id}"]`);
  if (!row) {
    throw new Error(`task row ${id} not found`);
  }
  return row as HTMLElement;
};

describe('PillStrip tasks popover', () => {
  it('splits completed rows by verification: verified keeps today’s rendering, unverified goes hollow amber', async () => {
    await renderTasksPopover([
      task({ id: '1', subject: 'verified step', status: 'completed', verified: true }),
      task({ id: '2', subject: 'unverified step', status: 'completed', verified: false }),
      task({ id: '3', subject: 'unreviewed step', status: 'completed' }),
    ]);

    const verified = taskRow('1');
    expect(verified.textContent).not.toContain('unverified');
    expect(verified.getAttribute('title')).toBeNull();
    expect(verified.querySelector('.line-through')).not.toBeNull();

    const unverified = taskRow('2');
    expect(unverified.getAttribute('title')).toBe('completed (unverified)');
    expect(unverified.textContent).toContain('unverified');
    // No strikethrough ambiguity; the dot is hollow amber instead of solid.
    expect(unverified.querySelector('.line-through')).toBeNull();
    expect(unverified.querySelector('.border-warning')).not.toBeNull();
    expect(unverified.querySelector('.bg-success')).toBeNull();

    // Unreviewed (verified absent) renders exactly like verified.
    const unreviewed = taskRow('3');
    expect(unreviewed.textContent).not.toContain('unverified');
    expect(unreviewed.querySelector('.line-through')).not.toBeNull();
  });

  it('renders the exit-criteria secondary line only when set', async () => {
    await renderTasksPopover([
      task({ id: '1', subject: 'with criteria', exitCriteria: 'npm run test:no-watch passes' }),
      task({ id: '2', subject: 'without criteria' }),
    ]);

    expect(taskRow('1').textContent).toContain('npm run test:no-watch passes');
    expect(taskRow('2').querySelector('p')).toBeNull();
  });

  it('annotates mid-step criteria edits only when criteriaEdited is true', async () => {
    await renderTasksPopover([
      task({ id: '1', subject: 'edited criteria', exitCriteria: 'tests pass', criteriaEdited: true }),
      task({ id: '2', subject: 'stable criteria', exitCriteria: 'tests pass' }),
      task({ id: '3', subject: 'edited, no criteria line', status: 'in_progress', criteriaEdited: true }),
    ]);

    expect(taskRow('1').textContent).toContain('criteria edited mid-step');
    expect(taskRow('2').textContent).not.toContain('criteria edited');
    // The note stands alone when the (edited-away) criteria line is empty.
    expect(taskRow('3').textContent).toContain('criteria edited mid-step');
  });

  it('folds the criteria edit into the completed-unverified tooltip', async () => {
    await renderTasksPopover([
      task({ id: '1', subject: 'edited unverified', status: 'completed', verified: false, criteriaEdited: true }),
      task({ id: '2', subject: 'plain unverified', status: 'completed', verified: false }),
      task({ id: '3', subject: 'edited verified', status: 'completed', verified: true, criteriaEdited: true }),
    ]);

    expect(taskRow('1').getAttribute('title')).toBe('completed (unverified; criteria edited mid-step)');
    expect(taskRow('2').getAttribute('title')).toBe('completed (unverified)');
    // Verified completions keep a clean row tooltip — the note stays on the
    // criteria line, in the same muted register.
    expect(taskRow('3').getAttribute('title')).toBeNull();
  });

  it('adds the unverified count to the header counts line only when nonzero', async () => {
    await renderTasksPopover([
      task({ id: '1', status: 'completed', verified: false }),
      task({ id: '2', status: 'completed', verified: true }),
      task({ id: '3', status: 'in_progress' }),
    ]);
    expect(document.body.textContent).toContain('1 unverified');

    await act(async () => root.unmount());
    document.body.querySelectorAll('[data-radix-popper-content-wrapper]').forEach((element) => element.remove());
    root = createRoot(container);
    await renderTasksPopover([task({ id: '1', status: 'completed', verified: true })]);
    expect(document.body.textContent).not.toContain('unverified');
  });
});
