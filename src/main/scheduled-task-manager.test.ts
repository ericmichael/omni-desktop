import { afterEach, describe, expect, it, vi } from 'vitest';

import { ScheduledTaskManager } from '@/main/scheduled-task-manager';
import type { RoutineBridgeEvent, ScheduledTask, StoreData } from '@/shared/types';

const now = 1_700_000_000_000;

function createTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'routine-1',
    name: 'Routine',
    description: '',
    instructions: 'Do work',
    schedule: { kind: 'manual' },
    permissionMode: 'ask',
    enabled: true,
    createdAt: now,
    updatedAt: now,
    nextRunAt: null,
    allowedToolNames: [],
    allowedMcpTools: [],
    history: [],
    ...overrides,
  };
}

function createStore(storeData: Partial<StoreData>) {
  return {
    get: <Key extends keyof StoreData>(key: Key): StoreData[Key] => storeData[key] as StoreData[Key],
    set: <Key extends keyof StoreData>(key: Key, value: StoreData[Key]): void => {
      storeData[key] = value;
    },
  } as any;
}

/** Mock RoutineBridge that records dispatches and lets tests emit events. */
function createBridge(startRunResult: { runId: string } = { runId: 'run-1' }) {
  let handler: ((event: RoutineBridgeEvent) => void) | undefined;
  const calls = {
    ensureColumn: [] as Array<{ taskId: string; sessionId: string; activate?: boolean }>,
    startRun: [] as Array<{ taskId: string; prompt: string; safeToolOverrides?: unknown }>,
    stop: [] as string[],
  };
  const bridge = {
    onEvent: (h: (event: RoutineBridgeEvent) => void) => {
      handler = h;
      return () => {
        handler = undefined;
      };
    },
    ensureColumn: vi.fn(async (arg: { taskId: string; sessionId: string; activate?: boolean }) => {
      calls.ensureColumn.push(arg);
    }),
    startRun: vi.fn(async (arg: { taskId: string; prompt: string; safeToolOverrides?: unknown }) => {
      calls.startRun.push(arg);
      return startRunResult;
    }),
    stop: vi.fn(async (taskId: string) => {
      calls.stop.push(taskId);
    }),
    disposeAll: vi.fn(),
  };
  return {
    bridge: bridge as any,
    calls,
    emit: (event: RoutineBridgeEvent) => handler?.(event),
  };
}

describe('ScheduledTaskManager routine bridge', () => {
  let manager: ScheduledTaskManager | null = null;

  afterEach(() => {
    manager?.stop();
    manager = null;
  });

  it('fires a routine through the column bridge', async () => {
    const storeData: Partial<StoreData> = { scheduledTasks: [createTask()] };
    const { bridge, calls } = createBridge();
    manager = new ScheduledTaskManager({ store: createStore(storeData), bridge, now: () => now });

    manager.runNow('routine-1');

    await vi.waitFor(() => expect(calls.startRun.length).toBe(1));
    expect(calls.ensureColumn[0]).toMatchObject({ taskId: 'routine-1', activate: true });
    const sessionId = calls.ensureColumn[0]!.sessionId;
    expect(sessionId).toBeTruthy();
    expect(calls.startRun[0]).toMatchObject({ taskId: 'routine-1', prompt: 'Do work' });

    await vi.waitFor(() => {
      const task = manager!.list()[0]!;
      expect(task.runningSessionId).toBe(sessionId);
      const run = task.history[0]!;
      expect(run.status).toBe('running');
      expect(run.runId).toBe('run-1');
      expect(run.sessionId).toBe(sessionId);
    });
  });

  it('passes the routine allow-list as safe tool overrides', async () => {
    const storeData: Partial<StoreData> = {
      scheduledTasks: [
        createTask({
          allowedToolNames: ['execute_bash'],
          allowedMcpTools: [{ serverLabel: 'omni-projects', toolName: 'create_ticket' }],
        }),
      ],
    };
    const { bridge, calls } = createBridge();
    manager = new ScheduledTaskManager({ store: createStore(storeData), bridge, now: () => now });

    manager.runNow('routine-1');

    await vi.waitFor(() => expect(calls.startRun.length).toBe(1));
    expect(calls.startRun[0]!.safeToolOverrides).toEqual({
      safe_tool_names: ['execute_bash'],
      safe_mcp_tools: [{ server_label: 'omni-projects', tool_name: 'create_ticket' }],
    });
  });

  it('marks the run completed and clears the running session on run-end', async () => {
    const storeData: Partial<StoreData> = { scheduledTasks: [createTask()] };
    const { bridge, calls, emit } = createBridge();
    manager = new ScheduledTaskManager({ store: createStore(storeData), bridge, now: () => now });

    manager.runNow('routine-1');
    await vi.waitFor(() => expect(calls.startRun.length).toBe(1));

    emit({ kind: 'run-end', taskId: 'routine-1', reason: 'completed' });

    await vi.waitFor(() => {
      const task = manager!.list()[0]!;
      expect(task.runningSessionId).toBeUndefined();
      expect(task.history[0]!.status).toBe('completed');
    });
  });

  it('marks the run failed on a failure end reason', async () => {
    const storeData: Partial<StoreData> = { scheduledTasks: [createTask()] };
    const { bridge, calls, emit } = createBridge();
    manager = new ScheduledTaskManager({ store: createStore(storeData), bridge, now: () => now });

    manager.runNow('routine-1');
    await vi.waitFor(() => expect(calls.startRun.length).toBe(1));

    emit({ kind: 'run-end', taskId: 'routine-1', reason: 'error' });

    await vi.waitFor(() => {
      const task = manager!.list()[0]!;
      expect(task.history[0]!.status).toBe('failed');
      expect(task.history[0]!.reason).toBe('error');
    });
  });

  it('surfaces approval requests as waiting_for_approval', async () => {
    const storeData: Partial<StoreData> = { scheduledTasks: [createTask()] };
    const { bridge, calls, emit } = createBridge();
    manager = new ScheduledTaskManager({ store: createStore(storeData), bridge, now: () => now });

    manager.runNow('routine-1');
    await vi.waitFor(() => expect(calls.startRun.length).toBe(1));

    emit({ kind: 'approval-requested', taskId: 'routine-1', approval: { kind: 'function', toolName: 'execute_bash' } });
    await vi.waitFor(() => {
      const run = manager!.list()[0]!.history[0]!;
      expect(run.status).toBe('waiting_for_approval');
      expect(run.pendingApprovalToolName).toBe('execute_bash');
    });

    emit({ kind: 'approval-resolved', taskId: 'routine-1' });
    await vi.waitFor(() => expect(manager!.list()[0]!.history[0]!.status).toBe('running'));
  });
});
