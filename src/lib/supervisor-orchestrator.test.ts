/**
 * Integration tests for `SupervisorOrchestrator` — the supervisor lifecycle
 * extracted from `ProjectManager` over Sprint C2c. Constructs a real
 * `ProjectManager` via the shared helper module so the orchestrator runs with
 * its production wiring (host accessors, store adapter, workflow loader),
 * while keeping every external dependency (Docker, WebSockets, fs) stubbed.
 *
 * Coverage areas:
 *   - Token usage accumulation
 *   - Retry loop with exponential backoff (T2)
 *   - Stall detection (streaming + non-streaming timeouts)
 *   - Auto-dispatch concurrency (global + per-column WIP limits)
 *   - handleClientToolCall error responses
 *   - handleMachineRunEnd run-record persistence + branches (T1)
 *   - moveTicketToColumn cancels retries / cleans up workspace (T3)
 *   - validateDispatchPreflight every branch (T5)
 *   - ensureSupervisorInfra idempotency (T5)
 *   - sendSupervisorMessage / resetSupervisorSession (T6)
 *   - restorePersistedTasks + startup cleanup (T7)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makePm, orch, seedMachine, TEST_PIPELINE, type MockMachine, type PmCtx } from '@/lib/project-manager-test-helpers';
import type { WorkflowConfig } from '@/lib/workflow';
import type { ProjectManager } from '@/main/project-manager';
import type { TicketPhase } from '@/shared/ticket-phase';
import type { AgentProcessStatus, Pipeline, Ticket, TicketId, WithTimestamp } from '@/shared/types';

describe('SupervisorOrchestrator integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Silence noisy console logs from the implementation
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Token usage
  // -------------------------------------------------------------------------
  describe('token usage', () => {
    it('accumulates tokens across onTokenUsage callbacks (Wave 1 fix)', () => {
      const ctx = makePm({
        tickets: [{ id: 't1' }],
      });
      const { pm, store } = ctx;

      const mock = seedMachine(ctx, 't1' as TicketId);
      mock.simulateTokenUsage({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
      mock.simulateTokenUsage({ inputTokens: 200, outputTokens: 100, totalTokens: 300 });

      const ticket = store.get('tickets', []).find((t: Ticket) => t.id === 't1')!;
      expect(ticket.tokenUsage).toEqual({
        inputTokens: 300,
        outputTokens: 150,
        totalTokens: 450,
      });
    });

    it('is a no-op when delta is zero', () => {
      const ctx = makePm({ tickets: [{ id: 't1' }] });
      const { pm, store, machines } = ctx;
      const mock = seedMachine(ctx, 't1');

      mock.simulateTokenUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
      const ticket = store.get('tickets', []).find((t: Ticket) => t.id === 't1')!;
      // Either undefined (never set) or totalTokens === 0
      expect(ticket.tokenUsage?.totalTokens ?? 0).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Retry loop
  // -------------------------------------------------------------------------
  describe('retry loop', () => {
    const setupRunningMachine = (): {
      ctx: PmCtx;
      mock: MockMachine;
    } => {
      const ctx = makePm({ tickets: [{ id: 't1' }] });
      const mock = seedMachine(ctx, 't1');
      mock.phase = 'running';
      return { ctx, mock };
    };

    it('schedules a retry with exponential backoff after an error run_end', async () => {
      const { ctx, mock } = setupRunningMachine();
      mock.retryAttempt = 0;

      mock.simulateRunEnd('error');
      // handleMachineRunEnd returns a promise via withTicketLock — flush microtasks
      await vi.runOnlyPendingTimersAsync();

      expect(mock.scheduleRetryTimer).toHaveBeenCalled();
      const calls = (mock.scheduleRetryTimer as ReturnType<typeof vi.fn>).mock.calls;
      const delay = calls[0]![0] as number;
      // handleMachineRunEnd passes attempt = retryAttempt + 1 = 1
      // scheduleRetry computes: RETRY_BASE_DELAY_MS * 2^1 = 20_000
      expect(delay).toBe(20_000);
      void ctx;
    });

    it('stops retrying after MAX_RETRY_ATTEMPTS and transitions to error', () => {
      const { ctx, mock } = setupRunningMachine();

      // Directly invoke scheduleRetry with attempt >= MAX_RETRY_ATTEMPTS (=5)
      orch(ctx.pm).scheduleRetry('t1', 'error', { attempt: 5 });

      expect(mock.phase).toBe('error');
      expect(mock.scheduleRetryTimer).not.toHaveBeenCalled();
    });

    it('does not schedule a retry on a "stopped" run_end', async () => {
      const { mock } = setupRunningMachine();

      mock.simulateRunEnd('stopped');
      await vi.runOnlyPendingTimersAsync();

      expect(mock.scheduleRetryTimer).not.toHaveBeenCalled();
      expect(mock.phase).toBe('idle');
    });

    // ---- T2 wave -------------------------------------------------------

    describe('backoff ladder', () => {
      const getDelay = (mock: MockMachine, call: number): number => {
        const calls = (mock.scheduleRetryTimer as ReturnType<typeof vi.fn>).mock.calls;
        return calls[call]![0] as number;
      };

      it('produces 10s, 20s, 40s, 80s, 160s for attempts 0..4', () => {
        const { ctx, mock } = setupRunningMachine();
        const expected = [10_000, 20_000, 40_000, 80_000, 160_000];
        for (let attempt = 0; attempt < expected.length; attempt++) {
          orch(ctx.pm).scheduleRetry('t1', 'error', { attempt });
          expect(getDelay(mock, attempt)).toBe(expected[attempt]);
        }
      });

      it('clamps the delay at MAX_RETRY_BACKOFF_MS (5 minutes) for very large attempts', () => {
        // Use a workflow config that raises maxRetries so attempt=10 doesn't hit the error branch.
        const ctx = makePm(
          { tickets: [{ id: 't1' }] },
          { workflowConfig: { supervisor: { max_retry_attempts: 100 } } }
        );
        const { pm, machines } = ctx;
        const mock = seedMachine(ctx, 't1');
        mock.phase = 'running';

        orch(pm).scheduleRetry('t1', 'error', { attempt: 10 });
        const calls = (mock.scheduleRetryTimer as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls[0]![0]).toBe(5 * 60 * 1000);
      });

      it('never calls scheduleRetry with failureClass="completed" from the run-end path', async () => {
        // decideRunEndAction never returns {type: retry, failureClass: completed}
        // — continuations go through startMachineRun directly. This test pins
        // that behavior so the dead "completed" branch in scheduleRetry can be
        // safely removed.
        const { ctx, mock } = setupRunningMachine();
        const schedSpy = vi.fn();
        (ctx.pm as unknown as { scheduleRetry: typeof schedSpy }).scheduleRetry = schedSpy;

        // Fire every "continuation-like" reason classify_run_end recognizes
        for (const reason of ['completed', 'done', 'finished', 'success', 'max_turns']) {
          mock.phase = 'running';
          mock.simulateRunEnd(reason);
          await vi.runOnlyPendingTimersAsync();
        }

        for (const call of schedSpy.mock.calls) {
          expect(call[1]).not.toBe('completed');
        }
      });
    });

    describe('handleRetryFired', () => {
      it('bails silently when the ticket has reached a terminal column', async () => {
        const { ctx, mock } = setupRunningMachine();
        // Move ticket directly in the store (avoid moveTicketToColumn's cleanup side-effects).
        const tickets = ctx.store.get('tickets', []);
        tickets[0]!.columnId = 'done';
        ctx.store.set('tickets', tickets);

        await orch(ctx.pm).handleRetryFired('t1', 'error', 1, 0);

        expect(mock.phase).toBe('idle');
        // Must not re-arm a new timer
        expect(mock.scheduleRetryTimer).not.toHaveBeenCalled();
      });

      it('requeues with attempt+1 when no concurrency slots are available', async () => {
        const { ctx, mock } = (() => {
          const base = setupRunningMachine();
          // Saturate global concurrency by creating 4 more running machines
          for (let i = 0; i < 4; i++) {
            const otherMock = seedMachine(base.ctx, `other-${i}` as TicketId);
            otherMock.phase = 'running';
          }
          return { ctx: base.ctx, mock: base.mock };
        })();

        await orch(ctx.pm).handleRetryFired('t1', 'error', 2, 0);

        // Timer re-armed with attempt+1 delay = 10_000 * 2^3 = 80_000
        const calls = (mock.scheduleRetryTimer as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls.length).toBeGreaterThan(0);
        expect(calls[calls.length - 1]![0]).toBe(80_000);
      });

      it('silently releases when the ticket or machine no longer exists', async () => {
        const { ctx } = setupRunningMachine();
        // Remove the ticket entirely
        ctx.store.set('tickets', []);
        orch(ctx.pm).machines.delete('t1');

        await expect(orch(ctx.pm).handleRetryFired('t1', 'error', 1, 0)).resolves.toBeUndefined();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Stall detection
  // -------------------------------------------------------------------------
  describe('stall detection', () => {
    const STALL_TIMEOUT_MS = 5 * 60 * 1000;
    const STALL_CHECK_INTERVAL_MS = 30_000;

    it('transitions a stalled non-streaming active machine by stopping it', async () => {
      const ctx = makePm({ tickets: [{ id: 't1' }] });
      const { pm, machines } = ctx;
      const mock = seedMachine(ctx, 't1');

      // Active but non-streaming → eligible for stall detection
      mock.phase = 'provisioning';
      mock.lastActivityAt = Date.now() - (STALL_TIMEOUT_MS + 10_000);

      // Advance one stall-check tick
      await vi.advanceTimersByTimeAsync(STALL_CHECK_INTERVAL_MS + 100);

      expect(mock.stop).toHaveBeenCalled();
    });

    it('does not stall a machine with recent activity', async () => {
      const ctx = makePm({ tickets: [{ id: 't1' }] });
      const { pm, machines } = ctx;
      const mock = seedMachine(ctx, 't1');

      mock.phase = 'provisioning';
      mock.lastActivityAt = Date.now(); // fresh

      await vi.advanceTimersByTimeAsync(STALL_CHECK_INTERVAL_MS + 100);

      expect(mock.stop).not.toHaveBeenCalled();
    });

    it('does not stall idle/terminal machines', async () => {
      const ctx = makePm({ tickets: [{ id: 't1' }] });
      const { pm, machines } = ctx;
      const mock = seedMachine(ctx, 't1');

      mock.phase = 'idle';
      mock.lastActivityAt = Date.now() - (STALL_TIMEOUT_MS + 10_000);

      await vi.advanceTimersByTimeAsync(STALL_CHECK_INTERVAL_MS + 100);

      expect(mock.stop).not.toHaveBeenCalled();
    });

    it('uses extended timeout for streaming phases (short silence is not a stall)', async () => {
      const ctx = makePm({ tickets: [{ id: 't1' }] });
      const { pm, machines } = ctx;
      const mock = seedMachine(ctx, 't1');

      // Silent for 10 minutes — well past the 5-minute non-streaming timeout,
      // but far below the 30-minute streaming safety-net.
      mock.phase = 'running';
      mock.lastActivityAt = Date.now() - 10 * 60 * 1000;

      await vi.advanceTimersByTimeAsync(STALL_CHECK_INTERVAL_MS + 100);

      expect(mock.stop).not.toHaveBeenCalled();
    });

    it('fires safety-net for streaming phases that exceed STREAMING_STALL_TIMEOUT_MS', async () => {
      const STREAMING_STALL_TIMEOUT_MS = 30 * 60 * 1000;
      const ctx = makePm({ tickets: [{ id: 't1' }] });
      const { pm, machines } = ctx;
      const mock = seedMachine(ctx, 't1');

      // Silent for 31 minutes — past the streaming safety-net.
      mock.phase = 'running';
      mock.lastActivityAt = Date.now() - (STREAMING_STALL_TIMEOUT_MS + 60_000);

      await vi.advanceTimersByTimeAsync(STALL_CHECK_INTERVAL_MS + 100);

      expect(mock.stop).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Auto-dispatch concurrency
  // -------------------------------------------------------------------------
  describe('auto-dispatch concurrency', () => {
    it('canStartSupervisor returns false when global limit is reached', () => {
      const ctx = makePm({
        tickets: Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, columnId: 'in_progress' })),
      });
      const { pm, machines } = ctx;

      // Pre-populate 5 running machines (= MAX_CONCURRENT_SUPERVISORS)
      for (let i = 0; i < 5; i++) {
        const mock = seedMachine(ctx, `t${i}` as TicketId);

        mock.phase = 'running';
      }

      expect(orch(pm).canStartSupervisor('proj-1', 'in_progress')).toBe(false);
    });

    it('canStartSupervisor returns false when per-column limit is reached (Wave 1 fix 4.5)', () => {
      const ctx = makePm(
        { tickets: [{ id: 't1', columnId: 'in_progress' }] },
        {
          workflowConfig: {
            supervisor: { max_concurrent_by_column: { in_progress: 1 } },
          },
        }
      );
      const { pm, machines } = ctx;

      const mock = seedMachine(ctx, 't1');


      mock.phase = 'running';

      // Second ticket in same column — should be blocked by per-column limit
      expect(orch(pm).canStartSupervisor('proj-1', 'in_progress')).toBe(false);
      // But a different column (no limit) is still OK
      expect(orch(pm).canStartSupervisor('proj-1', 'review')).toBe(true);
    });

    it('canStartSupervisor returns true when slots are available', () => {
      const ctx = makePm({ tickets: [{ id: 't1' }] });
      const { pm } = ctx;
      expect(orch(pm).canStartSupervisor('proj-1', 'in_progress')).toBe(true);
    });

    it('getEffectiveMaxConcurrent clamps FLEET.md override to global limit', () => {
      const ctx = makePm({ tickets: [] }, { workflowConfig: { supervisor: { max_concurrent: 99 } } });
      const { pm } = ctx;
      // Global MAX_CONCURRENT_SUPERVISORS is 5; override clamped down.
      expect(orch(pm).getEffectiveMaxConcurrent('proj-1')).toBe(5);
    });

    it('isAutoDispatchEnabled reads project flag before FLEET.md override', () => {
      const ctxOn = makePm({ autoDispatch: true });
      expect(orch(ctxOn.pm).isAutoDispatchEnabled('proj-1')).toBe(true);

      const ctxWorkflow = makePm(
        { autoDispatch: false },
        { workflowConfig: { supervisor: { auto_dispatch: true } } }
      );
      expect(orch(ctxWorkflow.pm).isAutoDispatchEnabled('proj-1')).toBe(true);

      const ctxOff = makePm({ autoDispatch: false });
      expect(orch(ctxOff.pm).isAutoDispatchEnabled('proj-1')).toBe(false);
    });

    it('autoDispatchTick skips projects with auto-dispatch disabled', async () => {
      const ctx = makePm({
        autoDispatch: false,
        tickets: [{ id: 't-ready', columnId: 'backlog' }],
      });
      const { pm } = ctx;
      // Stub startSupervisor to avoid real sandbox construction
      const startSpy = vi.fn(async () => {});
      (orch(pm) as unknown as { startSupervisor: typeof startSpy }).startSupervisor = startSpy;

      await orch(pm).autoDispatchTick();

      expect(startSpy).not.toHaveBeenCalled();
    });

    it('autoDispatchTick invokes startSupervisor for a ready ticket when enabled', async () => {
      const ctx = makePm({
        autoDispatch: true,
        tickets: [{ id: 't-ready', columnId: 'backlog' }],
      });
      const { pm } = ctx;
      const startSpy = vi.fn(async () => {});
      (orch(pm) as unknown as { startSupervisor: typeof startSpy }).startSupervisor = startSpy;

      await orch(pm).autoDispatchTick();

      expect(startSpy).toHaveBeenCalledWith('t-ready');
    });

    it('autoDispatchTick reverts the column move when startSupervisor rejects (bug #2)', async () => {
      const ctx = makePm({
        autoDispatch: true,
        tickets: [{ id: 't-ready', columnId: 'backlog' }],
      });
      const { pm, store } = ctx;
      // startSupervisor throws — e.g., preflight failed, hook failed, etc.
      const startSpy = vi.fn(async () => {
        throw new Error('preflight failed');
      });
      (orch(pm) as unknown as { startSupervisor: typeof startSpy }).startSupervisor = startSpy;

      await orch(pm).autoDispatchTick();

      // The pre-move put it in 'in_progress'; the failure must revert so the
      // next tick can re-pick it from the backlog.
      const ticket = store.get('tickets', []).find((t: Ticket) => t.id === 't-ready')!;
      expect(ticket.columnId).toBe('backlog');
    });

    it('autoDispatchTick skips tickets whose supervisor is already active', async () => {
      const ctx = makePm({
        autoDispatch: true,
        // A ticket in backlog that is ALSO active (e.g., leftover from a half-failed cycle).
        tickets: [{ id: 't-ready', columnId: 'backlog' }],
      });
      const { pm, machines } = ctx;
      const mock = seedMachine(ctx, 't-ready');

      mock.phase = 'running';

      const startSpy = vi.fn(async () => {});
      (orch(pm) as unknown as { startSupervisor: typeof startSpy }).startSupervisor = startSpy;

      await orch(pm).autoDispatchTick();

      expect(startSpy).not.toHaveBeenCalled();
    });

    it('autoDispatchTick does not dispatch when global MAX_CONCURRENT_SUPERVISORS is reached', async () => {
      const ctx = makePm({
        autoDispatch: true,
        tickets: [
          ...Array.from({ length: 5 }, (_, i) => ({ id: `busy-${i}`, columnId: 'in_progress' })),
          { id: 't-ready', columnId: 'backlog' },
        ],
      });
      const { pm, machines } = ctx;
      for (let i = 0; i < 5; i++) {
        const mock = seedMachine(ctx, `busy-${i}` as TicketId);

        mock.phase = 'running';
      }
      const startSpy = vi.fn(async () => {});
      (orch(pm) as unknown as { startSupervisor: typeof startSpy }).startSupervisor = startSpy;

      await orch(pm).autoDispatchTick();

      expect(startSpy).not.toHaveBeenCalled();
    });
  });

  // handleClientToolCall moved out of main — tool dispatch now lives entirely
  // in the renderer's `buildClientToolHandler`. See
  // `src/renderer/features/Tickets/*.test.ts` for the equivalent coverage.

  // -------------------------------------------------------------------------
  // T1 — handleMachineRunEnd (run record, continue/complete/stopped/retry)
  // -------------------------------------------------------------------------
  describe('handleMachineRunEnd', () => {
    /** Build a PM with a single ticket and a streaming machine registered. */
    const setupStreamingMachine = (
      opts: { reason?: string; continuationTurn?: number; workflowConfig?: Partial<WorkflowConfig> } = {}
    ): { ctx: PmCtx; mock: MockMachine } => {
      const ctx = makePm({ tickets: [{ id: 't1' }] }, { workflowConfig: opts.workflowConfig });
      const mock = seedMachine(ctx, 't1');
      mock.phase = 'running';
      mock.continuationTurn = opts.continuationTurn ?? 0;
      return { ctx, mock };
    };

    describe('run record persistence', () => {
      it('appends a run record on every run_end', async () => {
        const { ctx, mock } = setupStreamingMachine();
        mock.simulateRunEnd('error');
        await vi.runOnlyPendingTimersAsync();

        const ticket = ctx.store.get('tickets', []).find((t: Ticket) => t.id === 't1')!;
        expect(ticket.runs).toHaveLength(1);
        expect(ticket.runs![0]!.endReason).toBe('error');
      });

      it('accumulates multiple runs in order', async () => {
        const { ctx, mock } = setupStreamingMachine();
        mock.simulateRunEnd('error');
        await vi.runOnlyPendingTimersAsync();
        // After error the machine was transitioned through retry scheduling; re-set streaming.
        mock.phase = 'running';
        mock.simulateRunEnd('stalled');
        await vi.runOnlyPendingTimersAsync();

        const ticket = ctx.store.get('tickets', []).find((t: Ticket) => t.id === 't1')!;
        expect(ticket.runs!.map((r) => r.endReason)).toEqual(['error', 'stalled']);
      });

      it('snapshots current tokenUsage into the run record', async () => {
        const { ctx, mock } = setupStreamingMachine();
        mock.simulateTokenUsage({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
        mock.simulateRunEnd('error');
        await vi.runOnlyPendingTimersAsync();

        const ticket = ctx.store.get('tickets', []).find((t: Ticket) => t.id === 't1')!;
        expect(ticket.runs![0]!.tokenUsage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
      });

      it('records startedAt as the time the run actually started, not ticket.updatedAt (bug #1)', async () => {
        const { ctx, mock } = setupStreamingMachine();
        // Simulate the normal sequence: run starts, token updates flow in (which bump
        // ticket.updatedAt via onTokenUsage), then run_end arrives.
        const runStartTime = Date.now();
        // Mirror what startMachineRun does: stamp the real run-start time.
        orch(ctx.pm).runStartedAt.set('t1', runStartTime);

        vi.advanceTimersByTime(5_000);
        mock.simulateTokenUsage({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });

        vi.advanceTimersByTime(5_000);
        mock.simulateRunEnd('error');
        await vi.runOnlyPendingTimersAsync();

        const ticket = ctx.store.get('tickets', []).find((t: Ticket) => t.id === 't1')!;
        const run = ticket.runs![0]!;
        // startedAt must reflect the real run start, not the last ticket mutation.
        expect(run.startedAt).toBe(runStartTime);
        // And endedAt must be strictly later.
        expect(run.endedAt).toBeGreaterThan(run.startedAt);
      });
    });

    describe('stopped branch', () => {
      it('transitions to idle and does not schedule a retry', async () => {
        const { mock } = setupStreamingMachine();
        mock.simulateRunEnd('stopped');
        await vi.runOnlyPendingTimersAsync();

        expect(mock.phase).toBe('idle');
        expect(mock.scheduleRetryTimer).not.toHaveBeenCalled();
      });

      it('still persists the run record', async () => {
        const { ctx, mock } = setupStreamingMachine();
        mock.simulateRunEnd('stopped');
        await vi.runOnlyPendingTimersAsync();

        const ticket = ctx.store.get('tickets', []).find((t: Ticket) => t.id === 't1')!;
        expect(ticket.runs).toHaveLength(1);
        expect(ticket.runs![0]!.endReason).toBe('stopped');
      });
    });

    describe('continue branch', () => {
      it('increments continuationTurn and schedules a start_run after the 500ms delay', async () => {
        const { ctx, mock } = setupStreamingMachine({ continuationTurn: 0 });

        mock.simulateRunEnd('completed');
        // Let the withTicketLock microtask run
        await Promise.resolve();
        await Promise.resolve();
        // Now advance the explicit 500ms delay before startMachineRun fires.
        await vi.advanceTimersByTimeAsync(600);

        expect(mock.continuationTurn).toBe(1);
        // Phase transitions: continuing (action accepted) → running (start_run dispatched).
        // startMachineRun flips to `running` synchronously when bridge.run is sent.
        expect(mock.phase).toBe('running');
        expect(mock.startRun).toHaveBeenCalled();
        // Verify the prompt is a continuation prompt. `bridge.run` receives
        // an options object with `{ ticketId, prompt, ... }`.
        const lastCall = (mock.startRun as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
        const prompt = (lastCall[0] as { prompt?: string }).prompt ?? '';
        expect(prompt).toMatch(/continuation/i);
        void ctx;
      });

      it('completes (does not continue) when nextTurn would reach maxContinuationTurns', async () => {
        // max_continuation_turns default is 10; set turn to 9 so nextTurn = 10 → complete
        const { mock } = setupStreamingMachine({ continuationTurn: 9 });
        mock.simulateRunEnd('completed');
        await vi.runOnlyPendingTimersAsync();

        expect(mock.phase).toBe('completed');
        expect(mock.startRun).not.toHaveBeenCalled();
      });

      it('bails to completed when the agent moved the ticket to terminal column mid-run', async () => {
        const { ctx, mock } = setupStreamingMachine({ continuationTurn: 0 });
        // Directly mutate the store so handleMachineRunEnd's fresh-ticket re-read
        // sees the terminal column. Going through moveTicketToColumn would trigger
        // the cleanup side-effect (machine disposed, entry deleted) which is a
        // different code path covered elsewhere.
        const tickets = ctx.store.get('tickets', []);
        tickets[0]!.columnId = 'done';
        ctx.store.set('tickets', tickets);

        mock.simulateRunEnd('completed');
        await vi.runOnlyPendingTimersAsync();

        expect(mock.phase).toBe('completed');
        expect(mock.startRun).not.toHaveBeenCalled();
      });
    });

    describe('retry branch', () => {
      it('schedules retry on error with attempt = retryAttempt + 1', async () => {
        const { mock } = setupStreamingMachine();
        mock.retryAttempt = 2;

        mock.simulateRunEnd('error');
        await vi.runOnlyPendingTimersAsync();

        expect(mock.scheduleRetryTimer).toHaveBeenCalled();
      });
    });

    describe('guard: not streaming', () => {
      it('ignores run_end when the machine was already transitioned out of streaming', async () => {
        const { ctx, mock } = setupStreamingMachine();
        mock.phase = 'idle'; // user hit stop between run_end being queued and arriving

        mock.simulateRunEnd('error');
        await vi.runOnlyPendingTimersAsync();

        expect(mock.scheduleRetryTimer).not.toHaveBeenCalled();
        const ticket = ctx.store.get('tickets', []).find((t: Ticket) => t.id === 't1')!;
        // No run record should be persisted when we bail at the guard.
        expect(ticket.runs ?? []).toHaveLength(0);
      });
    });
  });

  // -------------------------------------------------------------------------
  // T3 — moveTicketToColumn side effects
  // -------------------------------------------------------------------------
  describe('moveTicketToColumn', () => {
    const GATED_PIPELINE: Pipeline = {
      columns: [
        { id: 'backlog', label: 'Backlog' },
        { id: 'in_progress', label: 'In Progress' },
        { id: 'review', label: 'Review', gate: true },
        { id: 'done', label: 'Done' },
      ],
    };

    /** Seed a PM + machine in 'running' phase with a stubbed retry timer. */
    const setupWithRetryArmed = (pipeline: Pipeline = TEST_PIPELINE): { ctx: PmCtx; mock: MockMachine } => {
      const ctx = makePm({
        pipeline,
        tickets: [{ id: 't1', columnId: 'in_progress' }],
      });
      const mock = seedMachine(ctx, 't1');
      mock.phase = 'running';
      return { ctx, mock };
    };

    it('terminal-column move cancels the retry timer and stops the supervisor', async () => {
      const { ctx, mock } = setupWithRetryArmed();

      ctx.pm.moveTicketToColumn('t1', 'done');
      await vi.runOnlyPendingTimersAsync();

      expect(mock.cancelRetryTimer).toHaveBeenCalled();
      expect(mock.stop).toHaveBeenCalled();
    });

    it('terminal-column move deletes the machine entry (workspace cleanup)', async () => {
      const { ctx } = setupWithRetryArmed();

      ctx.pm.moveTicketToColumn('t1', 'done');
      await vi.runOnlyPendingTimersAsync();

      expect(orch(ctx.pm).machines.has('t1')).toBe(false);
    });

    it('backlog move cancels the retry timer (bug #3)', async () => {
      const { ctx, mock } = setupWithRetryArmed();
      // Put the ticket in an active column first so moving back to backlog is a real move.
      ctx.pm.moveTicketToColumn('t1', 'backlog');
      await vi.runOnlyPendingTimersAsync();

      // A retry scheduled for this ticket must not be allowed to re-dispatch
      // a shelved ticket later.
      expect(mock.cancelRetryTimer).toHaveBeenCalled();
    });

    it('gated-column move cancels the retry timer (bug #3)', async () => {
      const { ctx, mock } = setupWithRetryArmed(GATED_PIPELINE);

      ctx.pm.moveTicketToColumn('t1', 'review');
      await vi.runOnlyPendingTimersAsync();

      expect(mock.cancelRetryTimer).toHaveBeenCalled();
    });

    it('moving to the terminal column auto-resolves the ticket as completed', async () => {
      const { ctx } = setupWithRetryArmed();
      ctx.pm.moveTicketToColumn('t1', 'done');
      await vi.runOnlyPendingTimersAsync();

      const ticket = ctx.store.get('tickets', []).find((t: Ticket) => t.id === 't1')!;
      expect(ticket.resolution).toBe('completed');
      expect(ticket.resolvedAt).toBeGreaterThan(0);
    });

    it('reopen (terminal → non-terminal) clears resolution and resolvedAt', async () => {
      const { ctx } = setupWithRetryArmed();
      ctx.pm.resolveTicket('t1', 'completed');
      await vi.runOnlyPendingTimersAsync();

      let ticket = ctx.store.get('tickets', []).find((t: Ticket) => t.id === 't1')!;
      expect(ticket.resolution).toBe('completed');
      expect(ticket.resolvedAt).toBeGreaterThan(0);

      // Reopen into an active column.
      ctx.pm.moveTicketToColumn('t1', 'in_progress');

      ticket = ctx.store.get('tickets', []).find((t: Ticket) => t.id === 't1')!;
      expect(ticket.resolution).toBeUndefined();
      expect(ticket.resolvedAt).toBeUndefined();
    });

    it('is a no-op for an unknown ticket', () => {
      const { ctx } = setupWithRetryArmed();
      expect(() => ctx.pm.moveTicketToColumn('nonexistent' as TicketId, 'done')).not.toThrow();
    });

    it('is a no-op for an unknown column', () => {
      const { ctx } = setupWithRetryArmed();
      ctx.pm.moveTicketToColumn('t1', 'no-such-column');
      const ticket = ctx.store.get('tickets', []).find((t: Ticket) => t.id === 't1')!;
      expect(ticket.columnId).toBe('in_progress');
    });
  });

  // -------------------------------------------------------------------------
  // T5 — validateDispatchPreflight + ensureSupervisorInfra idempotency
  // -------------------------------------------------------------------------
  describe('validateDispatchPreflight', () => {
    const LOCAL_SOURCE = { kind: 'local' as const, workspaceDir: '/tmp/fake-workspace' };

    it('rejects an unknown ticket', () => {
      const ctx = makePm({ source: LOCAL_SOURCE, tickets: [{ id: 't1' }] });
      const { pm } = ctx;
      const err = orch(pm).validateDispatchPreflight('nope' as TicketId);
      expect(err).toMatch(/not found/i);
    });

    it('rejects a project with no source', () => {
      const ctx = makePm({ tickets: [{ id: 't1' }] });
      const { pm } = ctx;
      const err = orch(pm).validateDispatchPreflight('t1');
      expect(err).toMatch(/no repository/i);
    });

    it('rejects a local project with empty workspaceDir', () => {
      const ctx = makePm({
        source: { kind: 'local', workspaceDir: '' },
        tickets: [{ id: 't1' }],
      });
      const { pm } = ctx;
      const err = orch(pm).validateDispatchPreflight('t1');
      expect(err).toMatch(/workspace directory/i);
    });

    it('rejects a git-remote project with empty repoUrl', () => {
      const ctx = makePm({
        source: { kind: 'git-remote', repoUrl: '' },
        tickets: [{ id: 't1' }],
      });
      const { pm } = ctx;
      const err = orch(pm).validateDispatchPreflight('t1');
      expect(err).toMatch(/repository url/i);
    });

    it('rejects a ticket in the terminal column', () => {
      const ctx = makePm({
        source: LOCAL_SOURCE,
        tickets: [{ id: 't1', columnId: 'done' }],
      });
      const { pm } = ctx;
      const err = orch(pm).validateDispatchPreflight('t1');
      expect(err).toMatch(/terminal column/i);
    });

    it('rejects when a machine is already active (not idle/ready/error/completed)', () => {
      const ctx = makePm({ source: LOCAL_SOURCE, tickets: [{ id: 't1' }] });
      const { pm, machines } = ctx;
      const mock = seedMachine(ctx, 't1');

      mock.phase = 'running';

      const err = orch(pm).validateDispatchPreflight('t1');
      expect(err).toMatch(/already active/i);
    });

    it('allows dispatch when machine is in idle/ready/error/completed', () => {
      const ctx = makePm({ source: LOCAL_SOURCE, tickets: [{ id: 't1' }] });
      const { pm } = ctx;
      const mock = seedMachine(ctx, 't1' as TicketId);

      for (const phase of ['idle', 'ready', 'error', 'completed'] as TicketPhase[]) {
        mock.phase = phase;
        expect(orch(pm).validateDispatchPreflight('t1')).toBeNull();
      }
    });

    it('rejects when global MAX_CONCURRENT_SUPERVISORS is reached', () => {
      const ctx = makePm({
        source: LOCAL_SOURCE,
        tickets: Array.from({ length: 6 }, (_, i) => ({ id: `t${i}` })),
      });
      const { pm } = ctx;
      for (let i = 0; i < 5; i++) {
        const m = seedMachine(ctx, `t${i}` as TicketId);
        m.phase = 'running';
      }
      const err = orch(pm).validateDispatchPreflight('t5');
      expect(err).toMatch(/concurrency limit/i);
    });

    it('rejects when WIP limit is reached', () => {
      const ctx = makePm({
        source: LOCAL_SOURCE,
        wipLimit: 1,
        tickets: [
          { id: 't1' },
          { id: 't-active', phase: 'running' }, // isActivePhase → counts toward WIP
        ],
      });
      const { pm } = ctx;
      const err = orch(pm).validateDispatchPreflight('t1');
      expect(err).toBe('WIP_LIMIT:1');
    });

    it('does not count the ticket itself toward WIP (retry case)', () => {
      const ctx = makePm({
        source: LOCAL_SOURCE,
        wipLimit: 1,
        tickets: [{ id: 't1', phase: 'running' }],
      });
      const { pm } = ctx;
      // t1 retrying its own dispatch: WIP count excludes self, so it's allowed.
      expect(orch(pm).validateDispatchPreflight('t1')).toBeNull();
    });

    it('returns null on the happy path', () => {
      const ctx = makePm({ source: LOCAL_SOURCE, tickets: [{ id: 't1' }] });
      const { pm } = ctx;
      expect(orch(pm).validateDispatchPreflight('t1')).toBeNull();
    });
  });

  describe('ensureColumn', () => {
    it('calls bridge.ensureColumn with the resolved workspace dir', async () => {
      const ctx = makePm({
        source: { kind: 'local', workspaceDir: '/tmp/fake' },
        tickets: [{ id: 't1' }],
      });
      await orch(ctx.pm).ensureColumn('t1' as TicketId);
      expect(ctx.bridge.ensureColumn).toHaveBeenCalledWith(
        expect.objectContaining({ ticketId: 't1' })
      );
    });
  });

  // -------------------------------------------------------------------------
  // T6 — sendSupervisorMessage + resetSupervisorSession
  // -------------------------------------------------------------------------
  describe('sendSupervisorMessage', () => {
    const LOCAL_SOURCE = { kind: 'local' as const, workspaceDir: '/tmp/fake' };

    const setupWithMachine = (phase: TicketPhase): { ctx: PmCtx; mock: MockMachine } => {
      const ctx = makePm({ source: LOCAL_SOURCE, tickets: [{ id: 't1' }] });
      const mock = seedMachine(ctx, 't1');
      mock.phase = phase;
      return { ctx, mock };
    };

    for (const phase of ['idle', 'error', 'ready', 'awaiting_input'] as TicketPhase[]) {
      it(`starts a new run via startRun when the machine is in "${phase}"`, async () => {
        const { ctx, mock } = setupWithMachine(phase);
        await orch(ctx.pm).sendSupervisorMessage('t1', 'hello');
        expect(mock.startRun).toHaveBeenCalled();
        expect(mock.sendMessage).not.toHaveBeenCalled();
      });
    }

    it('forwards via bridge.send when the machine is streaming', async () => {
      const { ctx, mock } = setupWithMachine('running');
      await orch(ctx.pm).sendSupervisorMessage('t1', 'hello mid-run');
      expect(mock.sendMessage).toHaveBeenCalledWith('t1', 'hello mid-run');
      expect(mock.startRun).not.toHaveBeenCalled();
    });

    it('is a no-op (does not throw) when sendMessage rejects mid-stream', async () => {
      const { ctx, mock } = setupWithMachine('running');
      (mock.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ws closed'));
      await expect(orch(ctx.pm).sendSupervisorMessage('t1', 'hi')).resolves.toBeUndefined();
    });

    it('throws when no machine exists and the ticket is unknown', async () => {
      const ctx = makePm({ source: LOCAL_SOURCE, tickets: [{ id: 't1' }] });
      const { pm } = ctx;
      await expect(orch(pm).sendSupervisorMessage('nope' as TicketId, 'hi')).rejects.toThrow(/not found/i);
    });

    it('throws when no machine exists and concurrency is saturated', async () => {
      const ctx = makePm({
        source: LOCAL_SOURCE,
        tickets: [{ id: 't1' }, ...Array.from({ length: 5 }, (_, i) => ({ id: `busy-${i}` }))],
      });
      const { pm } = ctx;
      for (let i = 0; i < 5; i++) {
        const m = seedMachine(ctx, `busy-${i}` as TicketId);
        m.phase = 'running';
      }

      await expect(orch(pm).sendSupervisorMessage('t1', 'hi')).rejects.toThrow(/concurrency/i);
    });

    it('routes through ensureColumn when no machine exists and slots are available', async () => {
      const ctx = makePm({ source: LOCAL_SOURCE, tickets: [{ id: 't1' }] });
      const { pm } = ctx;
      const ensureSpy = vi.fn(async () => {
        const seeded = seedMachine(ctx, 't1' as TicketId);
        return { state: seeded.state, tabId: 'tab-t1' as unknown as import('@/shared/types').CodeTabId };
      });
      (orch(pm) as unknown as { ensureColumn: typeof ensureSpy }).ensureColumn = ensureSpy;

      await orch(pm).sendSupervisorMessage('t1', 'hi');

      expect(ensureSpy).toHaveBeenCalledWith('t1');
    });
  });

  describe('resetSupervisorSession', () => {
    it('stops the in-flight run and asks the column to mint a fresh session', async () => {
      const ctx = makePm({
        source: { kind: 'local', workspaceDir: '/tmp/fake' },
        tickets: [{ id: 't1' }],
      });
      const mock = seedMachine(ctx, 't1');
      mock.phase = 'running';

      await orch(ctx.pm).resetSupervisorSession('t1');

      expect(ctx.bridge.stop).toHaveBeenCalledWith('t1');
      expect(ctx.bridge.reset).toHaveBeenCalledWith('t1');
    });

    it('is a no-op when no machine exists', async () => {
      const ctx = makePm({
        source: { kind: 'local', workspaceDir: '/tmp/fake' },
        tickets: [{ id: 't1' }],
      });
      const { pm } = ctx;
      await expect(orch(pm).resetSupervisorSession('t1')).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // T7 — restorePersistedTasks + startup cleanup
  // -------------------------------------------------------------------------
  describe('restorePersistedTasks', () => {
    const makeTask = (
      id: string,
      statusType: AgentProcessStatus['type'],
      extra: Partial<import('@/shared/types').Task> = {}
    ): import('@/shared/types').Task =>
      ({
        id,
        projectId: 'proj-1',
        taskDescription: 'test',
        status: { type: statusType, timestamp: Date.now() } as unknown as WithTimestamp<AgentProcessStatus>,
        createdAt: Date.now(),
        ...extra,
      }) as unknown as import('@/shared/types').Task;

    it('marks running tasks as exited', () => {
      const ctx = makePm({ tickets: [{ id: 't1' }] });
      const { pm, store } = ctx;
      store.set('tasks', [makeTask('task-1', 'running')]);

      orch(pm).restorePersistedTasks();

      const tasks = store.get('tasks', []);
      expect(tasks[0]!.status.type).toBe('exited');
    });

    it('preserves already-exited and errored tasks', () => {
      const ctx = makePm({ tickets: [{ id: 't1' }] });
      const { pm, store } = ctx;
      store.set('tasks', [makeTask('task-exited', 'exited'), makeTask('task-error', 'error')]);

      orch(pm).restorePersistedTasks();

      const tasks = store.get('tasks', []);
      expect(tasks.map((t) => t.status.type).sort()).toEqual(['error', 'exited']);
    });

    it('resets active ticket phases to idle', () => {
      const ctx = makePm({
        tickets: [
          { id: 't-running', phase: 'running' },
          { id: 't-provisioning', phase: 'provisioning' },
          { id: 't-awaiting', phase: 'awaiting_input' },
        ],
      });
      const { pm, store } = ctx;

      orch(pm).restorePersistedTasks();

      const tickets = store.get('tickets', []);
      for (const t of tickets) {
        expect(t.phase).toBe('idle');
      }
    });

    it('preserves completed phase across restart', () => {
      const ctx = makePm({ tickets: [{ id: 't1', phase: 'completed' }] });
      const { pm, store } = ctx;

      orch(pm).restorePersistedTasks();

      const ticket = store.get('tickets', []).find((t: Ticket) => t.id === 't1')!;
      expect(ticket.phase).toBe('completed');
    });

    it('resets error phase to idle on restart (documented behavior, not a preservation)', () => {
      // NOTE: The comment in resetStaleTicketStates explains this is intentional —
      // error states from prior sessions are considered stale because the in-memory
      // retry counters are gone. If this behavior changes in the future, update
      // both the comment and this test together.
      const ctx = makePm({ tickets: [{ id: 't1', phase: 'error' }] });
      const { pm, store } = ctx;

      orch(pm).restorePersistedTasks();

      const ticket = store.get('tickets', []).find((t: Ticket) => t.id === 't1')!;
      expect(ticket.phase).toBe('idle');
    });

    it('preserves idle phase', () => {
      const ctx = makePm({ tickets: [{ id: 't1', phase: 'idle' }] });
      const { pm, store } = ctx;

      orch(pm).restorePersistedTasks();

      const ticket = store.get('tickets', []).find((t: Ticket) => t.id === 't1')!;
      expect(ticket.phase).toBe('idle');
    });

    it('removes orphaned persisted tasks that reference a deleted ticket', async () => {
      const ctx = makePm({ tickets: [{ id: 't1' }] });
      const { pm, store } = ctx;
      store.set('tasks', [makeTask('orphan-task', 'exited', { ticketId: 'deleted-ticket' as TicketId })]);

      orch(pm).restorePersistedTasks();
      // startupTerminalCleanup is fire-and-forget; flush the microtask queue.
      await vi.runOnlyPendingTimersAsync();

      const tasks = store.get('tasks', []);
      expect(tasks.find((t) => t.id === 'orphan-task')).toBeUndefined();
    });

    it('removes persisted tasks whose ticket is in a terminal column', async () => {
      const ctx = makePm({
        tickets: [{ id: 't1', columnId: 'done' }],
      });
      const { pm, store } = ctx;
      // Ticket references a task; both should be cleaned up.
      const tickets = store.get('tickets', []);
      tickets[0]!.supervisorTaskId = 'task-1' as never;
      store.set('tickets', tickets);
      store.set('tasks', [makeTask('task-1', 'exited', { ticketId: 't1' as TicketId })]);

      orch(pm).restorePersistedTasks();
      await vi.runOnlyPendingTimersAsync();

      const tasksAfter = store.get('tasks', []);
      expect(tasksAfter.find((t) => t.id === 'task-1')).toBeUndefined();
    });
  });
});
