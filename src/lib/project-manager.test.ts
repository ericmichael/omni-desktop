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
import type {
  AgentProcessStatus,
  Pipeline,
  Project,
  StoreData,
  Ticket,
  TicketId,
  WithTimestamp,
} from '@/shared/types';
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

const defaultStoreData = (): StoreData => ({
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
} as unknown as StoreData);

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

  const tickets: Ticket[] = (args.tickets ?? []).map((t) => ({
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
  } as unknown as Ticket));

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
const internals = (pm: ProjectManager): {
  machines: Map<TicketId, { machine: MockMachine; sandbox: unknown }>;
  createMachine: (ticketId: TicketId) => MockMachine;
  handleMachineRunEnd: (ticketId: TicketId, reason: string) => Promise<void>;
  scheduleRetry: (
    ticketId: TicketId,
    failureClass: string,
    opts: { attempt?: number; continuationTurn?: number; error?: string }
  ) => void;
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

    it('skips stall checking for streaming phases', async () => {
      const { pm, machines } = makePm({ tickets: [{ id: 't1' }] });
      const mach = internals(pm).createMachine('t1');
      internals(pm).machines.set('t1', { machine: mach, sandbox: null });
      const mock = machines.get('t1')!;

      mock.phase = 'running';
      mock.lastActivityAt = Date.now() - (STALL_TIMEOUT_MS + 10_000);

      await vi.advanceTimersByTimeAsync(STALL_CHECK_INTERVAL_MS + 100);

      expect(mock.stop).not.toHaveBeenCalled();
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
