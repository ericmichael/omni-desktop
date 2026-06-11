/**
 * Integration tests for `SupervisorOrchestrator`. Constructs a real
 * `ProjectManager` via the shared helper module so the orchestrator runs with
 * its production wiring (host accessors, store adapter),
 * while keeping every external dependency (Docker, WebSockets, fs) stubbed.
 *
 * Coverage areas:
 *   - Token usage accumulation
 *   - Auto-dispatch concurrency (global + per-column WIP limits)
 *   - handleMachineRunEnd run-record persistence (T1)
 *   - moveTicketToColumn cleans up workspace on terminal move (T3)
 *   - validateDispatchPreflight every branch (T5)
 *   - ensureSupervisorInfra idempotency (T5)
 *   - sendSupervisorMessage / resetSupervisorSession (T6)
 *   - restorePersistedTasks + startup cleanup (T7)
 *
 * Continuation, retries, and stall detection live in omni-code's ``/goal``
 * server function — covered by its own tests, not here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makePm, orch, seedMachine, TEST_PIPELINE, type MockMachine, type PmCtx } from '@/lib/project-manager-test-helpers';
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
      const ctx = makePm({
        pipeline: {
          columns: [
            { id: 'backlog', label: 'Backlog' },
            { id: 'in_progress', label: 'In Progress', maxConcurrent: 1 },
            { id: 'review', label: 'Review' },
            { id: 'done', label: 'Done' },
          ],
        },
        tickets: [{ id: 't1', columnId: 'in_progress' }],
      });
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

    it('getEffectiveMaxConcurrent returns the global supervisor limit', () => {
      const ctx = makePm({ tickets: [] });
      const { pm } = ctx;
      expect(orch(pm).getEffectiveMaxConcurrent('proj-1')).toBe(5);
    });

    it('isAutoDispatchEnabled reads the project flag', () => {
      const ctxOn = makePm({ autoDispatch: true });
      expect(orch(ctxOn.pm).isAutoDispatchEnabled('proj-1')).toBe(true);

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
      // startSupervisor throws — e.g., preflight failed.
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

    it('autoDispatchTick respects the destination active column maxConcurrent after moving from backlog', async () => {
      const ctx = makePm({
        autoDispatch: true,
        pipeline: {
          columns: [
            { id: 'backlog', label: 'Backlog' },
            { id: 'in_progress', label: 'In Progress', maxConcurrent: 1 },
            { id: 'review', label: 'Review' },
            { id: 'done', label: 'Done' },
          ],
        },
        tickets: [
          { id: 'busy', columnId: 'in_progress' },
          { id: 't-ready', columnId: 'backlog' },
        ],
      });
      const busy = seedMachine(ctx, 'busy');
      busy.phase = 'running';
      const startSpy = vi.fn(async () => {});
      (orch(ctx.pm) as unknown as { startSupervisor: typeof startSpy }).startSupervisor = startSpy;

      await orch(ctx.pm).autoDispatchTick();

      expect(startSpy).not.toHaveBeenCalled();
      const readyTicket = ctx.store.get('tickets', []).find((t: Ticket) => t.id === 't-ready')!;
      expect(readyTicket.columnId).toBe('backlog');
    });
  });

  // handleClientToolCall moved out of main — tool dispatch now lives entirely
  // in the renderer's `buildClientToolHandler`. See
  // `src/renderer/features/Tickets/*.test.ts` for the equivalent coverage.

  // -------------------------------------------------------------------------
  // T1 — handleMachineRunEnd (run record persistence)
  // Continue / retry / completion decisioning lives in omni-code's ``/goal``
  // server function; the launcher only persists the run record.
  // -------------------------------------------------------------------------
  describe('handleMachineRunEnd', () => {
    /** Build a PM with a single ticket and a streaming machine registered. */
    const setupStreamingMachine = (): { ctx: PmCtx; mock: MockMachine } => {
      const ctx = makePm({ tickets: [{ id: 't1' }] });
      const mock = seedMachine(ctx, 't1');
      mock.phase = 'running';
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

    /** Seed a PM + machine in 'running' phase. */
    const setupRunning = (pipeline: Pipeline = TEST_PIPELINE): { ctx: PmCtx; mock: MockMachine } => {
      const ctx = makePm({
        pipeline,
        tickets: [{ id: 't1', columnId: 'in_progress' }],
      });
      const mock = seedMachine(ctx, 't1');
      mock.phase = 'running';
      return { ctx, mock };
    };

    it('terminal-column move stops the supervisor', async () => {
      const { ctx, mock } = setupRunning();

      ctx.pm.moveTicketToColumn('t1', 'done');
      await vi.runOnlyPendingTimersAsync();

      expect(mock.stop).toHaveBeenCalled();
    });

    it('terminal-column move deletes the machine entry (workspace cleanup)', async () => {
      const { ctx } = setupRunning();

      ctx.pm.moveTicketToColumn('t1', 'done');
      await vi.runOnlyPendingTimersAsync();

      expect(orch(ctx.pm).machines.has('t1')).toBe(false);
    });

    it('backlog move stops the supervisor', async () => {
      const { ctx } = setupRunning();
      ctx.pm.moveTicketToColumn('t1', 'backlog');
      await vi.runOnlyPendingTimersAsync();

      // Backlog path routes through stopSupervisor → bridge.stopGoal.
      expect(ctx.bridge.stopGoal).toHaveBeenCalled();
    });

    it('gated-column move stops the supervisor', async () => {
      const { ctx } = setupRunning(GATED_PIPELINE);

      ctx.pm.moveTicketToColumn('t1', 'review');
      await vi.runOnlyPendingTimersAsync();

      expect(ctx.bridge.stopGoal).toHaveBeenCalled();
    });

    it('moving to the terminal column auto-resolves the ticket as completed', async () => {
      const { ctx } = setupRunning();
      ctx.pm.moveTicketToColumn('t1', 'done');
      await vi.runOnlyPendingTimersAsync();

      const ticket = ctx.store.get('tickets', []).find((t: Ticket) => t.id === 't1')!;
      expect(ticket.resolution).toBe('completed');
      expect(ticket.resolvedAt).toBeGreaterThan(0);
    });

    it('reopen (terminal → non-terminal) clears resolution and resolvedAt', async () => {
      const { ctx } = setupRunning();
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
      const { ctx } = setupRunning();
      expect(() => ctx.pm.moveTicketToColumn('nonexistent' as TicketId, 'done')).not.toThrow();
    });

    it('is a no-op for an unknown column', () => {
      const { ctx } = setupRunning();
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
          { id: 't-active' },
        ],
      });
      const { pm } = ctx;
      const active = seedMachine(ctx, 't-active');
      active.phase = 'running';
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

    it('forwards a one-off profile to the bridge', async () => {
      const ctx = makePm({
        source: { kind: 'local', workspaceDir: '/tmp/fake' },
        tickets: [{ id: 't1' }],
      });
      await orch(ctx.pm).ensureColumn('t1' as TicketId, 'aci-desktop');
      expect(ctx.bridge.ensureColumn).toHaveBeenCalledWith(
        expect.objectContaining({ ticketId: 't1', profileName: 'aci-desktop' })
      );
    });
  });

  describe('startSupervisor', () => {
    it('re-arms an idle existing machine before dispatching an autopilot run', async () => {
      const ctx = makePm({
        source: { kind: 'local', workspaceDir: '/tmp/fake' },
        tickets: [{ id: 't1' }],
      });
      const mock = seedMachine(ctx, 't1' as TicketId);
      mock.phase = 'idle';

      await orch(ctx.pm).startSupervisor('t1' as TicketId);

      expect(mock.phase).toBe('running');
      expect(ctx.bridge.startGoal).toHaveBeenCalledWith(
        expect.objectContaining({
          ticketId: 't1',
          runOverrides: expect.objectContaining({
            safeToolOverrides: { safe_tool_patterns: ['.*'] },
          }),
        })
      );
    });

    it('passes the selected profile into code tab setup before starting', async () => {
      const ctx = makePm({
        source: { kind: 'local', workspaceDir: '/tmp/fake' },
        tickets: [{ id: 't1' }],
      });

      await orch(ctx.pm).startSupervisor('t1' as TicketId, 'local:machine-1');

      expect(ctx.bridge.ensureColumn).toHaveBeenCalledWith(
        expect.objectContaining({ ticketId: 't1', profileName: 'local:machine-1' })
      );
    });

    it('passes goal text as prompt and durable rules as additionalInstructions without duplicating the full prompt', async () => {
      const ctx = makePm({
        source: { kind: 'local', workspaceDir: '/tmp/fake' },
        pipeline: {
          columns: [
            { id: 'backlog', label: 'Backlog' },
            {
              id: 'in_progress',
              label: 'In Progress',
              workflow: {
                purpose: 'Implement the accepted ticket plan.',
                definitionOfDone: ['Edited Implementation DoD reaches the agent goal text'],
                agentInstructions: 'Keep the launcher workflow source of truth in the database.',
              },
            },
            { id: 'review', label: 'Review', gate: true },
            { id: 'done', label: 'Done' },
          ],
        },
        tickets: [
          {
            id: 't1',
            columnId: 'in_progress',
            title: 'Split autopilot prompt channels',
            description: 'Send the ticket goal separately from durable runtime instructions.',
          },
        ],
      });

      await orch(ctx.pm).startSupervisor('t1' as TicketId);

      const startGoalCall = ctx.bridge.startGoal.mock.calls[ctx.bridge.startGoal.mock.calls.length - 1];
      const startGoalArg = startGoalCall?.[0] as {
        prompt: string;
        runOverrides?: { additionalInstructions?: string };
      };
      expect(startGoalArg.prompt).toContain('Title: Split autopilot prompt channels');
      expect(startGoalArg.prompt).toContain('Send the ticket goal separately from durable runtime instructions.');
      expect(startGoalArg.prompt).toContain('Implement the accepted ticket plan.');
      expect(startGoalArg.prompt).toContain('Edited Implementation DoD reaches the agent goal text');
      expect(startGoalArg.prompt).toContain('move the ticket to `Review`');
      expect(startGoalArg.prompt).toContain('human gate; move there and stop');

      const additionalInstructions = startGoalArg.runOverrides?.additionalInstructions;
      expect(additionalInstructions).toEqual(expect.any(String));
      expect(additionalInstructions).toContain('move_ticket');
      expect(additionalInstructions).toContain('spawn_worker');
      expect(additionalInstructions).not.toContain('Title: Split autopilot prompt channels');
      expect(additionalInstructions).not.toContain('Send the ticket goal separately from durable runtime instructions.');
      expect(additionalInstructions).not.toContain('Edited Implementation DoD reaches the agent goal text');
      expect(additionalInstructions).not.toBe(startGoalArg.prompt);
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

    for (const phase of ['idle', 'error', 'ready'] as TicketPhase[]) {
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
          { id: 't-connecting', phase: 'connecting' },
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
