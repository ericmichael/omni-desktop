import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ActivityActions,
  publishSubagentsSnapshot,
  registerActivityActions,
  requestActivityFocus,
  subagentItemId,
  type SubagentSummary,
} from '@/renderer/omniagents-ui/activity-store';
import type { TaskSummary } from '@/renderer/omniagents-ui/canonical-plan-tasks';

import { AgentsSurface } from './AgentsSurface';

// The detail page mounts the full transcript viewer only when a runtime
// connection exists; these tests pass none, but the import alone would pull
// the whole chat app tree in.
vi.mock('@/renderer/omniagents-ui', () => ({ OmniAgentsApp: () => null }));
vi.mock('@/renderer/services/ipc', () => ({ serverOrigin: () => 'http://localhost:3001' }));
vi.mock('@/renderer/services/store', async () => {
  const { atom } = await import('nanostores');
  return { persistedStoreApi: { $atom: atom({}) } };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const SESSION = 'parent-sess';

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
  publishSubagentsSnapshot(SESSION, []);
  registerActivityActions(SESSION, null);
  vi.unstubAllGlobals();
});

const worker = (overrides: Partial<SubagentSummary> = {}): SubagentSummary => ({
  subagent_id: 'w-1',
  kind: 'worker',
  worker_id: 'w-1',
  status: 'running',
  task: 'implement the fix',
  parent_session_id: SESSION,
  session_id: 'worker-sess',
  run_id: 'run-1',
  result: null,
  error: null,
  isolation: null,
  started_at: null,
  finished_at: null,
  wall_time_ms: null,
  ...overrides,
});

const actionsWith = (getWorkerPlan: ActivityActions['getWorkerPlan']): ActivityActions => ({
  killWorker: vi.fn(),
  killJob: vi.fn(),
  tailJob: vi.fn(),
  getWorkerPlan,
});

/** Publish state, deep-link straight into the worker's detail page, render. */
const renderWorkerDetail = async (subagent: SubagentSummary, actions: ActivityActions | null) => {
  publishSubagentsSnapshot(SESSION, [subagent]);
  registerActivityActions(SESSION, actions);
  requestActivityFocus(SESSION, subagentItemId(subagent.subagent_id));
  await act(async () => {
    root.render(<AgentsSurface sessionId={SESSION} />);
    await Promise.resolve();
  });
  // Let the lazy plan fetch settle.
  await act(async () => {
    await Promise.resolve();
  });
};

const workerPlanSection = () => container.querySelector('[data-testid="worker-plan"]');

describe('AgentsSurface worker-plan drill-down', () => {
  it('renders the worker plan, fetched lazily by the worker session id, in the tasks-row language', async () => {
    const tasks: TaskSummary[] = [
      { id: '1', subject: 'repro the bug', status: 'completed', exitCriteria: 'failing test exists', verified: false },
      { id: '2', subject: 'fix it', status: 'in_progress', blockedBy: [] },
    ];
    const getWorkerPlan = vi.fn().mockResolvedValue(tasks);
    await renderWorkerDetail(worker(), actionsWith(getWorkerPlan));

    expect(getWorkerPlan).toHaveBeenCalledExactlyOnceWith('worker-sess');
    const section = workerPlanSection();
    expect(section).not.toBeNull();
    expect(section!.textContent).toContain('Plan');
    const rowOne = section!.querySelector('[data-testid="task-row-1"]');
    expect(rowOne).not.toBeNull();
    expect(rowOne!.textContent).toContain('#1');
    expect(rowOne!.textContent).toContain('repro the bug');
    expect(rowOne!.textContent).toContain('failing test exists');
    expect(rowOne!.textContent).toContain('unverified');
    expect(section!.querySelector('[data-testid="task-row-2"]')).not.toBeNull();
  });

  it('renders no plan section when the read fails', async () => {
    const getWorkerPlan = vi.fn().mockRejectedValue(new Error('runtime gone'));
    await renderWorkerDetail(worker(), actionsWith(getWorkerPlan));

    expect(getWorkerPlan).toHaveBeenCalled();
    expect(workerPlanSection()).toBeNull();
  });

  it('renders no plan section when the worker has no plan or no actions are registered', async () => {
    const getWorkerPlan = vi.fn().mockResolvedValue(null);
    await renderWorkerDetail(worker(), actionsWith(getWorkerPlan));
    expect(workerPlanSection()).toBeNull();

    await act(async () => root.unmount());
    root = createRoot(container);
    await renderWorkerDetail(worker(), null);
    expect(workerPlanSection()).toBeNull();
  });
});
