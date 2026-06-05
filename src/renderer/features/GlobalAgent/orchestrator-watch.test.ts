import { afterEach, describe, expect, it, vi } from 'vitest';

import { emitColumnRunEnd, emitColumnRunStarted, type SessionController } from '@/renderer/services/session-control';

import { setOrchestratorController, watchColumnRun } from './orchestrator-watch';

const orchestrator = (notify = vi.fn().mockResolvedValue(undefined)): SessionController => ({
  sendMessage: vi.fn(),
  decideApproval: vi.fn(),
  stopRun: vi.fn(),
  getState: () => ({ running: false, awaitingApproval: [], transcript: { total: 0, latestCursor: null } }),
  getTranscript: () => ({ total: 0, latestCursor: null, entries: [], hasMore: false }),
  getEntry: () => null,
  notify,
  newSession: vi.fn(),
});

afterEach(() => {
  setOrchestratorController(null);
});

describe('orchestrator-watch', () => {
  it('pushes a framed wakeup to the orchestrator when a watched column finishes', () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    setOrchestratorController(orchestrator(notify));
    watchColumnRun('tab-1', 'run-1');

    emitColumnRunEnd('tab-1', { runId: 'run-1', reason: 'completed' });

    expect(notify).toHaveBeenCalledTimes(1);
    const [content, source] = notify.mock.calls[0]!;
    expect(source).toBe('column.done');
    expect(content).toContain('tab-1');
    expect(content).toContain('column_transcript');
  });

  it('ignores run-ends for columns that were not dispatched', () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    setOrchestratorController(orchestrator(notify));

    emitColumnRunEnd('tab-unwatched', { reason: 'completed' });

    expect(notify).not.toHaveBeenCalled();
  });

  it('is one-shot — a second run-end on the same column does not re-fire', () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    setOrchestratorController(orchestrator(notify));
    watchColumnRun('tab-2', 'run-2');

    emitColumnRunEnd('tab-2', { runId: 'run-2', reason: 'completed' });
    emitColumnRunEnd('tab-2', { runId: 'run-2', reason: 'completed' });

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('idle dispatch: pins to the returned runId — another run-end does not fire it', () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    setOrchestratorController(orchestrator(notify));
    watchColumnRun('tab-3', 'run-target');

    emitColumnRunEnd('tab-3', { runId: 'run-other', reason: 'completed' });
    expect(notify).not.toHaveBeenCalled();

    emitColumnRunEnd('tab-3', { runId: 'run-target', reason: 'completed' });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('queued dispatch: waits for run-started, ignoring the run it was queued behind', () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    setOrchestratorController(orchestrator(notify));
    // Busy column → column_send had no runId yet.
    watchColumnRun('tab-5');

    // The run our dispatch is queued behind finishes — must NOT fire.
    emitColumnRunEnd('tab-5', { runId: 'run-prior', reason: 'completed' });
    expect(notify).not.toHaveBeenCalled();

    // Our message starts running → its run id is captured.
    emitColumnRunStarted('tab-5', 'run-ours');
    // A spurious other run-end still must not fire it.
    emitColumnRunEnd('tab-5', { runId: 'run-noise', reason: 'completed' });
    expect(notify).not.toHaveBeenCalled();

    // Our run finishes → fire once.
    emitColumnRunEnd('tab-5', { runId: 'run-ours', reason: 'completed' });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no orchestrator is registered', () => {
    setOrchestratorController(null);
    watchColumnRun('tab-4');
    // Must not throw.
    expect(() => emitColumnRunEnd('tab-4', { reason: 'completed' })).not.toThrow();
  });
});
