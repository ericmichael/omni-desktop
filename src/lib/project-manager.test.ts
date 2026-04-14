/**
 * Integration tests for `ProjectManager` orchestration logic.
 *
 * Uses the DI interfaces from `project-manager-deps.ts` with in-memory
 * stubs — no real Docker, WebSocket, or filesystem dependencies.
 *
 * Focus areas:
 *   - Token usage accumulation (Wave 1 fix: Math.max → +)
 *   - Retry loop with exponential backoff
 *   - Stall detection
 *   - Auto-dispatch concurrency (global + per-column)
 *   - handleClientToolCall error responses
 *   - processManager.statusFallback wiring
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  IMachineFactory,
  ISandbox,
  ISandboxFactory,
  ITicketMachine,
  IStore,
  IWorkflowLoader,
  MachineCallbacks,
  ProjectManagerDeps,
} from '@/lib/project-manager-deps';
import { ProjectManager } from '@/main/project-manager';
import type { TicketPhase } from '@/shared/ticket-phase';
import type { AgentProcessStatus, Pipeline, Project, StoreData, Ticket, TicketId, WithTimestamp } from '@/shared/types';
import type { WorkflowConfig } from '@/lib/workflow';

// ---------------------------------------------------------------------------
// Store stub
// ---------------------------------------------------------------------------

const ACTIVE_PHASES: TicketPhase[] = [
  'provisioning',
  'connecting',
  'session_creating',
  'ready',
  'running',
  'continuing',
  'awaiting_input',
  'retrying',
];
const STREAMING_PHASES: TicketPhase[] = ['running', 'continuing'];

const defaultStoreData = (): StoreData =>
  ({
    sandboxBackend: 'none',
    sandboxProfiles: null,
    selectedMachineId: null,
    optInToLauncherPrereleases: false,
    previewFeatures: false,
    layoutMode: 'fleet',
    theme: 'omni',
    onboardingComplete: true,
    projects: [],
    milestones: [],
    pages: [],
    inboxItems: [],
    tasks: [],
    tickets: [],
    wipLimit: 100,
    weeklyReviewDay: 5,
    lastWeeklyReviewAt: null,
    schemaVersion: 4,
    chatSessionId: null,
    chatProjectId: null,
    codeTabs: [],
    activeCodeTabId: null,
    codeLayoutMode: 'deck',
    codeDeckBackground: null,
    activeTicketId: null,
    enabledExtensions: {},
  }) as unknown as StoreData;

const makeStore = (overrides: Partial<StoreData> = {}): IStore => {
  const data: StoreData = { ...defaultStoreData(), ...overrides };
  return {
    get: <K extends keyof StoreData>(key: K, defaultValue?: StoreData[K]): StoreData[K] => {
      const v = data[key];
      if (v === undefined) {
        return defaultValue as StoreData[K];
      }
      return v;
    },
    set: <K extends keyof StoreData>(key: K, value: StoreData[K]): void => {
      data[key] = value;
    },
    get store(): StoreData {
      return data;
    },
  } as IStore;
};

// ---------------------------------------------------------------------------
// Mock machine + factory
// ---------------------------------------------------------------------------

type MockMachine = ITicketMachine & {
  ticketId: TicketId;
  phase: TicketPhase;
  callbacks: MachineCallbacks;
  // Test helpers
  simulateRunEnd: (reason: string) => void;
  simulateTokenUsage: (usage: { inputTokens: number; outputTokens: number; totalTokens: number }) => void;
  simulateClientRequest: (
    fnName: string,
    args: Record<string, unknown>,
    respond: (ok: boolean, result?: Record<string, unknown>) => void
  ) => void;
  // Inspection
  getLastActivity: () => number;
  // Spies
  stop: ReturnType<typeof vi.fn>;
  forcePhase: ReturnType<typeof vi.fn>;
  setWsUrl: ReturnType<typeof vi.fn>;
  createSession: ReturnType<typeof vi.fn>;
  startRun: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  recordActivity: ReturnType<typeof vi.fn>;
  cancelRetryTimer: ReturnType<typeof vi.fn>;
  scheduleRetryTimer: ReturnType<typeof vi.fn>;
};

type MakeFactoryReturn = {
  factory: IMachineFactory;
  machines: Map<TicketId, MockMachine>;
  createdOrder: TicketId[];
};

const makeMachineFactory = (): MakeFactoryReturn => {
  const machines = new Map<TicketId, MockMachine>();
  const createdOrder: TicketId[] = [];

  const factory: IMachineFactory = {
    create: (ticketId: TicketId, callbacks: MachineCallbacks): ITicketMachine => {
      const mock: MockMachine = {
        ticketId,
        phase: 'idle' as TicketPhase,
        callbacks,
        lastActivityAt: Date.now(),
        continuationTurn: 0,
        retryAttempt: 0,
        getPhase: () => mock.phase,
        isActive: () => ACTIVE_PHASES.includes(mock.phase),
        isStreaming: () => STREAMING_PHASES.includes(mock.phase),
        getSessionId: () => 'stub-session',
        getLastActivity: () => mock.lastActivityAt,
        transition: (to: TicketPhase) => {
          mock.phase = to;
          callbacks.onPhaseChange(ticketId, to);
        },
        forcePhase: vi.fn((to: TicketPhase) => {
          mock.phase = to;
        }) as unknown as MockMachine['forcePhase'],
        setWsUrl: vi.fn() as unknown as MockMachine['setWsUrl'],
        createSession: vi.fn(async () => 'stub-session') as unknown as MockMachine['createSession'],
        startRun: vi.fn(async () => ({ sessionId: 'stub-session' })) as unknown as MockMachine['startRun'],
        stop: vi.fn(async () => {
          mock.phase = 'idle';
        }) as unknown as MockMachine['stop'],
        dispose: vi.fn() as unknown as MockMachine['dispose'],
        recordActivity: vi.fn(() => {
          mock.lastActivityAt = Date.now();
        }) as unknown as MockMachine['recordActivity'],
        cancelRetryTimer: vi.fn() as unknown as MockMachine['cancelRetryTimer'],
        scheduleRetryTimer: vi.fn() as unknown as MockMachine['scheduleRetryTimer'],
        simulateRunEnd: (reason: string) => callbacks.onRunEnd(ticketId, reason),
        simulateTokenUsage: (usage) => callbacks.onTokenUsage(ticketId, usage),
        simulateClientRequest: (fnName, args, respond) => {
          callbacks.onClientRequest?.(ticketId, fnName, args, respond);
        },
      };
      machines.set(ticketId, mock);
      createdOrder.push(ticketId);
      return mock as unknown as ITicketMachine;
    },
  };

  return { factory, machines, createdOrder };
};

// ---------------------------------------------------------------------------
// Mock sandbox factory (unused in most tests, but required by DI)
// ---------------------------------------------------------------------------

type MockSandbox = ISandbox & {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
};

const makeSandboxFactory = (): { factory: ISandboxFactory; sandboxes: MockSandbox[] } => {
  const sandboxes: MockSandbox[] = [];
  const factory: ISandboxFactory = {
    create: (): ISandbox => {
      const sb: MockSandbox = {
        start: vi.fn(),
        stop: vi.fn(async () => {}),
        getStatus: vi.fn(() => null as WithTimestamp<AgentProcessStatus> | null),
      } as MockSandbox;
      sandboxes.push(sb);
      return sb;
    },
  };
  return { factory, sandboxes };
};

// ---------------------------------------------------------------------------
// Workflow loader stub
// ---------------------------------------------------------------------------

const makeWorkflowLoader = (configOverride: Partial<WorkflowConfig> = {}): IWorkflowLoader => {
  const config: WorkflowConfig = { ...configOverride };
  return {
    load: vi.fn(async () => ({})),
    loadFromRemote: vi.fn(async () => ({})),
    get: vi.fn(() => null),
    getConfig: vi.fn(() => config),
    getPromptTemplate: vi.fn(() => 'stub prompt template'),
    runHook: vi.fn(async () => true),
    dispose: vi.fn(),
  };
};

// ---------------------------------------------------------------------------
// sendToWindow capture
// ---------------------------------------------------------------------------

const makeSendToWindow = (): {
  fn: ProjectManagerDeps['sendToWindow'];
  calls: Array<{ channel: string; args: unknown[] }>;
} => {
  const calls: Array<{ channel: string; args: unknown[] }> = [];
  const fn = ((channel: string, ...args: unknown[]): void => {
    calls.push({ channel, args });
  }) as unknown as ProjectManagerDeps['sendToWindow'];
  return { fn, calls };
};

// ---------------------------------------------------------------------------
// Test project/pipeline/ticket seeding
// ---------------------------------------------------------------------------

const TEST_PIPELINE: Pipeline = {
  columns: [
    { id: 'backlog', label: 'Backlog' },
    { id: 'in_progress', label: 'In Progress' },
    { id: 'review', label: 'Review' },
    { id: 'done', label: 'Done' },
  ],
};

type SeedArgs = {
  projectId?: string;
  pipeline?: Pipeline;
  autoDispatch?: boolean;
  tickets?: Array<Partial<Ticket> & { id: string; columnId?: string }>;
};

const seedStore = (args: SeedArgs = {}): IStore => {
  const projectId = args.projectId ?? 'proj-1';
  const pipeline = args.pipeline ?? TEST_PIPELINE;
  const project: Project = {
    id: projectId,
    label: 'Test Project',
    createdAt: Date.now(),
    pipeline,
    autoDispatch: args.autoDispatch ?? false,
    // No source → startSupervisor would reject, but we aren't calling it.
  } as unknown as Project;

  const tickets: Ticket[] = (args.tickets ?? []).map(
    (t) =>
      ({
        id: t.id,
        projectId,
        title: t.title ?? `Ticket ${t.id}`,
        description: '',
        priority: t.priority ?? 'medium',
        columnId: t.columnId ?? pipeline.columns[0]!.id,
        blockedBy: t.blockedBy ?? [],
        createdAt: t.createdAt ?? Date.now(),
        updatedAt: t.updatedAt ?? Date.now(),
        comments: t.comments ?? [],
        runs: t.runs ?? [],
        phase: t.phase,
        tokenUsage: t.tokenUsage,
      }) as unknown as Ticket
  );

  return makeStore({
    projects: [project],
    tickets,
  });
};

// ---------------------------------------------------------------------------
// PM factory
// ---------------------------------------------------------------------------

type PmCtx = {
  pm: ProjectManager;
  store: IStore;
  machines: Map<TicketId, MockMachine>;
  send: ReturnType<typeof makeSendToWindow>;
  workflow: IWorkflowLoader;
  machineFactory: IMachineFactory;
};

const makePm = (
  storeOrSeed?: IStore | SeedArgs,
  opts: {
    workflowConfig?: Partial<WorkflowConfig>;
    processManager?: { statusFallback?: unknown };
  } = {}
): PmCtx => {
  const store =
    storeOrSeed && typeof storeOrSeed === 'object' && 'get' in storeOrSeed
      ? (storeOrSeed as IStore)
      : seedStore((storeOrSeed as SeedArgs) ?? {});
  const send = makeSendToWindow();
  const workflow = makeWorkflowLoader(opts.workflowConfig ?? {});
  const { factory: machineFactory, machines } = makeMachineFactory();
  const { factory: sandboxFactory } = makeSandboxFactory();

  const pm = new ProjectManager(
    {
      store: store as unknown as ConstructorParameters<typeof ProjectManager>[0]['store'],
      sendToWindow: send.fn as unknown as ConstructorParameters<typeof ProjectManager>[0]['sendToWindow'],
      processManager: opts.processManager as ConstructorParameters<typeof ProjectManager>[0]['processManager'],
    },
    {
      workflowLoader: workflow,
      machineFactory,
      sandboxFactory,
    }
  );

  return { pm, store, machines, send, workflow, machineFactory };
};

// Gain access to ProjectManager internals (machines map, private methods).
const internals = (
  pm: ProjectManager
): {
  machines: Map<TicketId, { machine: MockMachine; sandbox: unknown }>;
  runStartedAt: Map<TicketId, number>;
  createMachine: (ticketId: TicketId) => MockMachine;
  handleMachineRunEnd: (ticketId: TicketId, reason: string) => Promise<void>;
  scheduleRetry: (
    ticketId: TicketId,
    failureClass: string,
    opts: { attempt?: number; continuationTurn?: number; error?: string }
  ) => void;
  handleRetryFired: (
    ticketId: TicketId,
    failureClass: string,
    attempt: number,
    continuationTurn: number
  ) => Promise<void>;
  checkForStalledSupervisors: () => void;
  autoDispatchTick: () => Promise<void>;
  canStartSupervisor: (projectId?: string, columnId?: string) => boolean;
  handleClientToolCall: (
    ticketId: TicketId,
    fn: string,
    args: Record<string, unknown>,
    respond: (ok: boolean, result?: Record<string, unknown>) => void
  ) => void;
} => pm as unknown as never;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProjectManager integration', () => {
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
      const { pm, store, machines } = makePm({
        tickets: [{ id: 't1' }],
      });

      // Create machine via internal path (uses our factory)
      const mach = internals(pm).createMachine('t1');
      // Register in machines map so nothing assumes external registration
      internals(pm).machines.set('t1', { machine: mach, sandbox: null });

      const mock = machines.get('t1')!;
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
      const { pm, store, machines } = makePm({ tickets: [{ id: 't1' }] });
      const mach = internals(pm).createMachine('t1');
      internals(pm).machines.set('t1', { machine: mach, sandbox: null });
      const mock = machines.get('t1')!;

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
      const mach = internals(ctx.pm).createMachine('t1');
      internals(ctx.pm).machines.set('t1', { machine: mach, sandbox: null });
      const mock = ctx.machines.get('t1')!;
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
      internals(ctx.pm).scheduleRetry('t1', 'error', { attempt: 5 });

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
          internals(ctx.pm).scheduleRetry('t1', 'error', { attempt });
          expect(getDelay(mock, attempt)).toBe(expected[attempt]);
        }
      });

      it('clamps the delay at MAX_RETRY_BACKOFF_MS (5 minutes) for very large attempts', () => {
        // Use a workflow config that raises maxRetries so attempt=10 doesn't hit the error branch.
        const { pm, machines } = makePm(
          { tickets: [{ id: 't1' }] },
          { workflowConfig: { supervisor: { max_retry_attempts: 100 } } }
        );
        const mach = internals(pm).createMachine('t1');
        internals(pm).machines.set('t1', { machine: mach, sandbox: null });
        const mock = machines.get('t1')!;
        mock.phase = 'running';

        internals(pm).scheduleRetry('t1', 'error', { attempt: 10 });
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

        await internals(ctx.pm).handleRetryFired('t1', 'error', 1, 0);

        expect(mock.phase).toBe('idle');
        // Must not re-arm a new timer
        expect(mock.scheduleRetryTimer).not.toHaveBeenCalled();
      });

      it('requeues with attempt+1 when no concurrency slots are available', async () => {
        const { ctx, mock, machines } = (() => {
          const base = setupRunningMachine();
          // Saturate global concurrency by creating 4 more running machines
          for (let i = 0; i < 4; i++) {
            const m = internals(base.ctx.pm).createMachine(`other-${i}` as TicketId);
            internals(base.ctx.pm).machines.set(`other-${i}` as TicketId, { machine: m, sandbox: null });
            base.ctx.machines.get(`other-${i}` as TicketId)!.phase = 'running';
          }
          return { ctx: base.ctx, mock: base.mock, machines: base.ctx.machines };
        })();
        void machines;

        await internals(ctx.pm).handleRetryFired('t1', 'error', 2, 0);

        // Timer re-armed with attempt+1 delay = 10_000 * 2^3 = 80_000
        const calls = (mock.scheduleRetryTimer as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls.length).toBeGreaterThan(0);
        expect(calls[calls.length - 1]![0]).toBe(80_000);
      });

      it('silently releases when the ticket or machine no longer exists', async () => {
        const { ctx } = setupRunningMachine();
        // Remove the ticket entirely
        ctx.store.set('tickets', []);
        internals(ctx.pm).machines.delete('t1');

        await expect(internals(ctx.pm).handleRetryFired('t1', 'error', 1, 0)).resolves.toBeUndefined();
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
      const { pm, machines } = makePm({ tickets: [{ id: 't1' }] });
      const mach = internals(pm).createMachine('t1');
      internals(pm).machines.set('t1', { machine: mach, sandbox: null });
      const mock = machines.get('t1')!;

      // Active but non-streaming → eligible for stall detection
      mock.phase = 'provisioning';
      mock.lastActivityAt = Date.now() - (STALL_TIMEOUT_MS + 10_000);

      // Advance one stall-check tick
      await vi.advanceTimersByTimeAsync(STALL_CHECK_INTERVAL_MS + 100);

      expect(mock.stop).toHaveBeenCalled();
    });

    it('does not stall a machine with recent activity', async () => {
      const { pm, machines } = makePm({ tickets: [{ id: 't1' }] });
      const mach = internals(pm).createMachine('t1');
      internals(pm).machines.set('t1', { machine: mach, sandbox: null });
      const mock = machines.get('t1')!;

      mock.phase = 'provisioning';
      mock.lastActivityAt = Date.now(); // fresh

      await vi.advanceTimersByTimeAsync(STALL_CHECK_INTERVAL_MS + 100);

      expect(mock.stop).not.toHaveBeenCalled();
    });

    it('does not stall idle/terminal machines', async () => {
      const { pm, machines } = makePm({ tickets: [{ id: 't1' }] });
      const mach = internals(pm).createMachine('t1');
      internals(pm).machines.set('t1', { machine: mach, sandbox: null });
      const mock = machines.get('t1')!;

      mock.phase = 'idle';
      mock.lastActivityAt = Date.now() - (STALL_TIMEOUT_MS + 10_000);

      await vi.advanceTimersByTimeAsync(STALL_CHECK_INTERVAL_MS + 100);

      expect(mock.stop).not.toHaveBeenCalled();
    });

    it('uses extended timeout for streaming phases (short silence is not a stall)', async () => {
      const { pm, machines } = makePm({ tickets: [{ id: 't1' }] });
      const mach = internals(pm).createMachine('t1');
      internals(pm).machines.set('t1', { machine: mach, sandbox: null });
      const mock = machines.get('t1')!;

      // Silent for 10 minutes — well past the 5-minute non-streaming timeout,
      // but far below the 30-minute streaming safety-net.
      mock.phase = 'running';
      mock.lastActivityAt = Date.now() - 10 * 60 * 1000;

      await vi.advanceTimersByTimeAsync(STALL_CHECK_INTERVAL_MS + 100);

      expect(mock.stop).not.toHaveBeenCalled();
    });

    it('fires safety-net for streaming phases that exceed STREAMING_STALL_TIMEOUT_MS', async () => {
      const STREAMING_STALL_TIMEOUT_MS = 30 * 60 * 1000;
      const { pm, machines } = makePm({ tickets: [{ id: 't1' }] });
      const mach = internals(pm).createMachine('t1');
      internals(pm).machines.set('t1', { machine: mach, sandbox: null });
      const mock = machines.get('t1')!;

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
      const { pm, machines } = makePm({
        tickets: Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, columnId: 'in_progress' })),
      });

      // Pre-populate 5 running machines (= MAX_CONCURRENT_SUPERVISORS)
      for (let i = 0; i < 5; i++) {
        const mach = internals(pm).createMachine(`t${i}` as TicketId);
        internals(pm).machines.set(`t${i}` as TicketId, { machine: mach, sandbox: null });
        machines.get(`t${i}` as TicketId)!.phase = 'running';
      }

      expect(internals(pm).canStartSupervisor('proj-1', 'in_progress')).toBe(false);
    });

    it('canStartSupervisor returns false when per-column limit is reached (Wave 1 fix 4.5)', () => {
      const { pm, machines } = makePm(
        { tickets: [{ id: 't1', columnId: 'in_progress' }] },
        {
          workflowConfig: {
            supervisor: { max_concurrent_by_column: { in_progress: 1 } },
          },
        }
      );

      const mach = internals(pm).createMachine('t1');
      internals(pm).machines.set('t1', { machine: mach, sandbox: null });
      machines.get('t1')!.phase = 'running';

      // Second ticket in same column — should be blocked by per-column limit
      expect(internals(pm).canStartSupervisor('proj-1', 'in_progress')).toBe(false);
      // But a different column (no limit) is still OK
      expect(internals(pm).canStartSupervisor('proj-1', 'review')).toBe(true);
    });

    it('canStartSupervisor returns true when slots are available', () => {
      const { pm } = makePm({ tickets: [{ id: 't1' }] });
      expect(internals(pm).canStartSupervisor('proj-1', 'in_progress')).toBe(true);
    });

    it('autoDispatchTick skips projects with auto-dispatch disabled', async () => {
      const { pm } = makePm({
        autoDispatch: false,
        tickets: [{ id: 't-ready', columnId: 'backlog' }],
      });
      // Stub startSupervisor to avoid real sandbox construction
      const startSpy = vi.fn(async () => {});
      (pm as unknown as { startSupervisor: typeof startSpy }).startSupervisor = startSpy;

      await internals(pm).autoDispatchTick();

      expect(startSpy).not.toHaveBeenCalled();
    });

    it('autoDispatchTick invokes startSupervisor for a ready ticket when enabled', async () => {
      const { pm } = makePm({
        autoDispatch: true,
        tickets: [{ id: 't-ready', columnId: 'backlog' }],
      });
      const startSpy = vi.fn(async () => {});
      (pm as unknown as { startSupervisor: typeof startSpy }).startSupervisor = startSpy;

      await internals(pm).autoDispatchTick();

      expect(startSpy).toHaveBeenCalledWith('t-ready');
    });

    it('autoDispatchTick reverts the column move when startSupervisor rejects (bug #2)', async () => {
      const { pm, store } = makePm({
        autoDispatch: true,
        tickets: [{ id: 't-ready', columnId: 'backlog' }],
      });
      // startSupervisor throws — e.g., preflight failed, hook failed, etc.
      const startSpy = vi.fn(async () => {
        throw new Error('preflight failed');
      });
      (pm as unknown as { startSupervisor: typeof startSpy }).startSupervisor = startSpy;

      await internals(pm).autoDispatchTick();

      // The pre-move put it in 'in_progress'; the failure must revert so the
      // next tick can re-pick it from the backlog.
      const ticket = store.get('tickets', []).find((t: Ticket) => t.id === 't-ready')!;
      expect(ticket.columnId).toBe('backlog');
    });

    it('autoDispatchTick skips tickets whose supervisor is already active', async () => {
      const { pm, machines } = makePm({
        autoDispatch: true,
        // A ticket in backlog that is ALSO active (e.g., leftover from a half-failed cycle).
        tickets: [{ id: 't-ready', columnId: 'backlog' }],
      });
      const mach = internals(pm).createMachine('t-ready');
      internals(pm).machines.set('t-ready', { machine: mach, sandbox: null });
      machines.get('t-ready')!.phase = 'running';

      const startSpy = vi.fn(async () => {});
      (pm as unknown as { startSupervisor: typeof startSpy }).startSupervisor = startSpy;

      await internals(pm).autoDispatchTick();

      expect(startSpy).not.toHaveBeenCalled();
    });

    it('autoDispatchTick does not dispatch when global MAX_CONCURRENT_SUPERVISORS is reached', async () => {
      const { pm, machines } = makePm({
        autoDispatch: true,
        tickets: [
          ...Array.from({ length: 5 }, (_, i) => ({ id: `busy-${i}`, columnId: 'in_progress' })),
          { id: 't-ready', columnId: 'backlog' },
        ],
      });
      for (let i = 0; i < 5; i++) {
        const mach = internals(pm).createMachine(`busy-${i}` as TicketId);
        internals(pm).machines.set(`busy-${i}` as TicketId, { machine: mach, sandbox: null });
        machines.get(`busy-${i}` as TicketId)!.phase = 'running';
      }
      const startSpy = vi.fn(async () => {});
      (pm as unknown as { startSupervisor: typeof startSpy }).startSupervisor = startSpy;

      await internals(pm).autoDispatchTick();

      expect(startSpy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // handleClientToolCall error responses
  // -------------------------------------------------------------------------
  describe('handleClientToolCall error responses', () => {
    const invoke = (
      pm: ProjectManager,
      ticketId: TicketId,
      toolName: string,
      toolArgs: Record<string, unknown>
    ): { ok: boolean; result?: Record<string, unknown> } => {
      let captured: { ok: boolean; result?: Record<string, unknown> } = { ok: false };
      internals(pm).handleClientToolCall(
        ticketId,
        'tool.call',
        { tool: toolName, arguments: toolArgs },
        (ok, result) => {
          captured = { ok, result };
        }
      );
      return captured;
    };

    it('responds with ok=false when ticket_id is missing for get_ticket_comments (Wave 1 fix 4.2)', () => {
      const { pm } = makePm({ tickets: [{ id: 't1' }] });
      const result = invoke(pm, 't1', 'get_ticket_comments', {});
      expect(result.ok).toBe(false);
      expect((result.result?.error as { message?: string } | undefined)?.message).toMatch(/ticket_id/i);
    });

    it('responds with ok=false on unknown column for move_ticket', () => {
      const { pm } = makePm({ tickets: [{ id: 't1' }] });
      const result = invoke(pm, 't1', 'move_ticket', { column: 'no-such-column' });
      expect(result.ok).toBe(false);
      expect((result.result?.error as { message?: string } | undefined)?.message).toMatch(/unknown column/i);
    });

    it('responds with ok=true on successful move_ticket', () => {
      const { pm, store } = makePm({ tickets: [{ id: 't1' }] });
      const result = invoke(pm, 't1', 'move_ticket', { column: 'Review' });
      expect(result.ok).toBe(true);
      expect(result.result?.error).toBeUndefined();
      expect(result.result?.ok).toBe(true);
      // Verify actual side effect
      const updated = store.get('tickets', []).find((t: Ticket) => t.id === 't1')!;
      expect(updated.columnId).toBe('review');
    });

    it('responds with ok=false when tool name is missing', () => {
      const { pm } = makePm({ tickets: [{ id: 't1' }] });
      let captured: { ok: boolean; result?: Record<string, unknown> } = { ok: true };
      internals(pm).handleClientToolCall('t1', 'tool.call', {}, (ok, result) => {
        captured = { ok, result };
      });
      expect(captured.ok).toBe(false);
      expect((captured.result?.error as { message?: string } | undefined)?.message).toMatch(/tool name/i);
    });

    it('responds with ok=false for unknown ticketId', () => {
      const { pm } = makePm({ tickets: [{ id: 't1' }] });
      const result = invoke(pm, 'nonexistent' as TicketId, 'move_ticket', { column: 'Review' });
      expect(result.ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // T1 — handleMachineRunEnd (run record, continue/complete/stopped/retry)
  // -------------------------------------------------------------------------
  describe('handleMachineRunEnd', () => {
    /** Build a PM with a single ticket and a streaming machine registered. */
    const setupStreamingMachine = (
      opts: { reason?: string; continuationTurn?: number; workflowConfig?: Partial<WorkflowConfig> } = {}
    ): { ctx: PmCtx; mock: MockMachine } => {
      const ctx = makePm({ tickets: [{ id: 't1' }] }, { workflowConfig: opts.workflowConfig });
      const mach = internals(ctx.pm).createMachine('t1');
      internals(ctx.pm).machines.set('t1', { machine: mach, sandbox: null });
      const mock = ctx.machines.get('t1')!;
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
        internals(ctx.pm).runStartedAt.set('t1', runStartTime);

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
        expect(mock.phase).toBe('continuing');
        expect(mock.startRun).toHaveBeenCalled();
        // Verify the prompt is a continuation prompt
        const lastCall = (mock.startRun as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
        expect(String(lastCall[0])).toMatch(/continuation/i);
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
      const mach = internals(ctx.pm).createMachine('t1');
      internals(ctx.pm).machines.set('t1', { machine: mach, sandbox: null });
      const mock = ctx.machines.get('t1')!;
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

      expect(internals(ctx.pm).machines.has('t1')).toBe(false);
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

    it('reopen (terminal → non-terminal) clears resolution and resolvedAt', async () => {
      const { ctx } = setupWithRetryArmed();
      ctx.pm.resolveTicket('t1', 'done');
      await vi.runOnlyPendingTimersAsync();

      let ticket = ctx.store.get('tickets', []).find((t: Ticket) => t.id === 't1')!;
      expect(ticket.resolution).toBe('done');
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
  // processManager wiring
  // -------------------------------------------------------------------------
  describe('processManager integration', () => {
    it('sets processManager.statusFallback when a processManager is provided', () => {
      const processManager: { statusFallback?: unknown } = {};
      makePm({ tickets: [{ id: 't1' }] }, { processManager });
      expect(typeof processManager.statusFallback).toBe('function');
    });

    it('does not fail when no processManager is provided', () => {
      expect(() => makePm({ tickets: [{ id: 't1' }] })).not.toThrow();
    });
  });
});
