/**
 * Shared in-memory test fixtures for ProjectManager + SupervisorOrchestrator.
 *
 * Both `project-manager.test.ts` and `supervisor-orchestrator.test.ts` import
 * from this module so they can construct a real `ProjectManager` (with a
 * mock machine factory + stub sandbox factory + stub workflow loader) without
 * touching Docker, WebSockets, or the filesystem.
 *
 * No tests live here — only the DI stubs, seed builders, and the `orch()`
 * accessor. The split is so each test file can stay focused on its own
 * coverage area while sharing the boilerplate that has accreted across the
 * T1–T11 testing wave.
 */

import { vi } from 'vitest';

import type {
  IMachineFactory,
  ISandbox,
  ISandboxFactory,
  IStore,
  ITicketMachine,
  IWorkflowLoader,
  MachineCallbacks,
  ProjectManagerDeps,
} from '@/lib/project-manager-deps';
import type { WorkflowConfig } from '@/lib/workflow';
import { ProjectManager } from '@/main/project-manager';
import type { SupervisorOrchestrator } from '@/main/supervisor-orchestrator';
import type { TicketPhase } from '@/shared/ticket-phase';
import type { AgentProcessStatus, Pipeline, Project, StoreData, Ticket, TicketId, WithTimestamp } from '@/shared/types';

// ---------------------------------------------------------------------------
// Phase classifier mirrors (must stay in sync with shared/ticket-phase)
// ---------------------------------------------------------------------------

export const ACTIVE_PHASES: TicketPhase[] = [
  'provisioning',
  'connecting',
  'session_creating',
  'ready',
  'running',
  'continuing',
  'awaiting_input',
  'retrying',
];
export const STREAMING_PHASES: TicketPhase[] = ['running', 'continuing'];

// ---------------------------------------------------------------------------
// Store stub
// ---------------------------------------------------------------------------

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

export const makeStore = (overrides: Partial<StoreData> = {}): IStore => {
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

export type MockMachine = ITicketMachine & {
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
  sendMessage: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  recordActivity: ReturnType<typeof vi.fn>;
  cancelRetryTimer: ReturnType<typeof vi.fn>;
  scheduleRetryTimer: ReturnType<typeof vi.fn>;
};

export type MakeFactoryReturn = {
  factory: IMachineFactory;
  machines: Map<TicketId, MockMachine>;
  createdOrder: TicketId[];
};

export const makeMachineFactory = (): MakeFactoryReturn => {
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
        // eslint-disable-next-line @typescript-eslint/require-await
        createSession: vi.fn(async () => 'stub-session') as unknown as MockMachine['createSession'],
        // eslint-disable-next-line @typescript-eslint/require-await
        startRun: vi.fn(async () => ({ sessionId: 'stub-session' })) as unknown as MockMachine['startRun'],
        // eslint-disable-next-line @typescript-eslint/require-await
        sendMessage: vi.fn(async () => {}) as unknown as MockMachine['sendMessage'],
        // eslint-disable-next-line @typescript-eslint/require-await
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

export type MockSandbox = ISandbox & {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
};

export const makeSandboxFactory = (): { factory: ISandboxFactory; sandboxes: MockSandbox[] } => {
  const sandboxes: MockSandbox[] = [];
  const factory: ISandboxFactory = {
    create: (): ISandbox => {
      const sb: MockSandbox = {
        start: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/require-await
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

export const makeWorkflowLoader = (configOverride: Partial<WorkflowConfig> = {}): IWorkflowLoader => {
  const config: WorkflowConfig = { ...configOverride };
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    load: vi.fn(async () => ({})),
    // eslint-disable-next-line @typescript-eslint/require-await
    loadFromRemote: vi.fn(async () => ({})),
    get: vi.fn(() => null),
    getConfig: vi.fn(() => config),
    getPromptTemplate: vi.fn(() => 'stub prompt template'),
    // eslint-disable-next-line @typescript-eslint/require-await
    runHook: vi.fn(async () => true),
    dispose: vi.fn(),
  };
};

// ---------------------------------------------------------------------------
// sendToWindow capture
// ---------------------------------------------------------------------------

export const makeSendToWindow = (): {
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

export const TEST_PIPELINE: Pipeline = {
  columns: [
    { id: 'backlog', label: 'Backlog' },
    { id: 'in_progress', label: 'In Progress' },
    { id: 'review', label: 'Review' },
    { id: 'done', label: 'Done' },
  ],
};

export type SeedArgs = {
  projectId?: string;
  pipeline?: Pipeline;
  autoDispatch?: boolean;
  /** When set, the seeded project gets a local or git-remote source. */
  source?: { kind: 'local'; workspaceDir: string } | { kind: 'git-remote'; repoUrl: string; defaultBranch?: string };
  /** When set, overrides wipLimit (defaults to 100 so WIP doesn't block tests). */
  wipLimit?: number;
  tickets?: Array<Partial<Ticket> & { id: string; columnId?: string }>;
};

export const seedStore = (args: SeedArgs = {}): IStore => {
  const projectId = args.projectId ?? 'proj-1';
  const pipeline = args.pipeline ?? TEST_PIPELINE;
  const project: Project = {
    id: projectId,
    label: 'Test Project',
    createdAt: Date.now(),
    pipeline,
    autoDispatch: args.autoDispatch ?? false,
    source: args.source,
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
    ...(args.wipLimit !== undefined ? { wipLimit: args.wipLimit } : {}),
  });
};

// ---------------------------------------------------------------------------
// PM factory
// ---------------------------------------------------------------------------

export type PmCtx = {
  pm: ProjectManager;
  store: IStore;
  machines: Map<TicketId, MockMachine>;
  send: ReturnType<typeof makeSendToWindow>;
  workflow: IWorkflowLoader;
  machineFactory: IMachineFactory;
};

export const makePm = (
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

/**
 * Clean handle on the extracted SupervisorOrchestrator. Every supervisor-
 * lifecycle behavior the tests assert against is a real public method on the
 * orchestrator with a real dep contract.
 */
export const orch = (pm: ProjectManager): SupervisorOrchestrator =>
  (pm as unknown as { supervisors: SupervisorOrchestrator }).supervisors;
