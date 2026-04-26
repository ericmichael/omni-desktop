/**
 * Shared in-memory test fixtures for ProjectManager + SupervisorOrchestrator.
 *
 * Both `project-manager.test.ts` and `supervisor-orchestrator.test.ts` import
 * from this module so they can construct a real `ProjectManager` (with a
 * mock SupervisorBridge + stub workflow loader) without touching WebSockets
 * or the filesystem.
 */

import { vi } from 'vitest';

import type { IStore, IWorkflowLoader, ProjectManagerDeps } from '@/lib/project-manager-deps';
import type { WorkflowConfig } from '@/lib/workflow';
import { ProjectManager } from '@/main/project-manager';
import type { SupervisorBridge } from '@/main/supervisor-bridge';
import type {
  SupervisorEntry,
  SupervisorOrchestrator,
} from '@/main/supervisor-orchestrator';
import { SupervisorState } from '@/main/supervisor-state';
import type { TicketPhase } from '@/shared/ticket-phase';
import type {
  CodeTabId,
  Pipeline,
  Project,
  StoreData,
  SupervisorBridgeEvent,
  Ticket,
  TicketId,
} from '@/shared/types';

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
// Mock SupervisorBridge — records every dispatch, lets tests simulate events
// ---------------------------------------------------------------------------

export type MockBridge = {
  /** Underlying bridge passed to ProjectManager. */
  bridge: SupervisorBridge;
  /** All events emitted from the bridge to the orchestrator, in order. */
  eventsReceived: SupervisorBridgeEvent[];
  /** Fire a bridge event into every registered handler (simulates renderer → main). */
  emit: (event: SupervisorBridgeEvent) => void;
  /** Spies. */
  ensureColumn: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
};

export const makeMockBridge = (): MockBridge => {
  const handlers = new Set<(event: SupervisorBridgeEvent) => void>();
  const eventsReceived: SupervisorBridgeEvent[] = [];
  const ensureColumn = vi.fn(() => Promise.resolve());
  const run = vi.fn((arg: { ticketId: TicketId }): Promise<{ runId: string }> =>
    Promise.resolve({ runId: `run-${arg.ticketId}` })
  );
  const send = vi.fn(() => Promise.resolve());
  const stop = vi.fn(() => Promise.resolve());
  const reset = vi.fn(() => Promise.resolve());
  const dispose = vi.fn(() => Promise.resolve());

  const bridge: SupervisorBridge = {
    ensureColumn,
    run,
    send,
    stop,
    reset,
    dispose,
    registerIpc: vi.fn(() => []),
    onEvent: (handler: (event: SupervisorBridgeEvent) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    disposeAll: vi.fn(),
  } as unknown as SupervisorBridge;

  return {
    bridge,
    eventsReceived,
    emit: (event) => {
      eventsReceived.push(event);
      for (const h of handlers) {
        h(event);
      }
    },
    ensureColumn,
    run,
    send,
    stop,
    reset,
    dispose,
  };
};

// ---------------------------------------------------------------------------
// Test-only view of a supervisor entry — real SupervisorState + simulate helpers
// ---------------------------------------------------------------------------

export type MockEntry = {
  ticketId: TicketId;
  state: SupervisorState;
  /**
   * Mutable phase handle. Setting `phase` forces the state's phase — convenient
   * for tests that want to jump to e.g. `running` before simulating events.
   */
  get phase(): TicketPhase;
  set phase(p: TicketPhase);
  /** Mutable retry-attempt counter (state.retryAttempt). */
  get retryAttempt(): number;
  set retryAttempt(n: number);
  /** Mutable continuation-turn counter. */
  get continuationTurn(): number;
  set continuationTurn(n: number);
  /** Read-only view of `state.lastActivity`. */
  get lastActivityAt(): number;
  set lastActivityAt(t: number);
  getLastActivity: () => number;

  // --- Spies mapped to the bridge/state surface ------------------------------
  scheduleRetryTimer: ReturnType<typeof vi.spyOn>;
  cancelRetryTimer: ReturnType<typeof vi.spyOn>;
  recordActivity: ReturnType<typeof vi.spyOn>;
  stop: ReturnType<typeof vi.fn>;
  /** Bridge `run` spy — the startRun path. */
  startRun: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  forcePhase: ReturnType<typeof vi.spyOn>;

  // --- Event simulators ------------------------------------------------------
  simulateRunEnd: (reason: string) => void;
  simulateTokenUsage: (usage: { inputTokens: number; outputTokens: number; totalTokens: number }) => void;
};

/**
 * Install a new `SupervisorEntry` into the orchestrator for a ticket.
 * Returns a MockEntry with simulate helpers for driving bridge events.
 */
export const seedMachine = (ctx: { pm: ProjectManager; bridge: MockBridge }, ticketId: TicketId): MockEntry => {
  const orchestrator = orch(ctx.pm);
  const state = new SupervisorState(ticketId, {
    onPhaseChange: (tid, phase) => {
      // Mirror the orchestrator's real callback so phase updates reach the store
      // and IPC just like production. Safe because we installed the state under
      // `machines.set` below; the orchestrator's own createState hook isn't used.
      (orchestrator as unknown as { deps: { host: { updateTicket: (id: TicketId, patch: Partial<Ticket>) => void } } }).deps.host.updateTicket(tid, {
        phase,
        phaseChangedAt: Date.now(),
      });
    },
  });
  const entry: SupervisorEntry = { state, tabId: `tab-${ticketId}` as CodeTabId };
  orchestrator.machines.set(ticketId, entry);

  const scheduleRetryTimerSpy = vi.spyOn(state, 'scheduleRetryTimer');
  const cancelRetryTimerSpy = vi.spyOn(state, 'cancelRetryTimer');
  const recordActivitySpy = vi.spyOn(state, 'recordActivity');
  const forcePhaseSpy = vi.spyOn(state, 'forcePhase');

  const mock: MockEntry = {
    ticketId,
    state,
    get phase() {
      return state.getPhase();
    },
    set phase(p: TicketPhase) {
      state.forcePhase(p);
    },
    get retryAttempt() {
      return state.retryAttempt;
    },
    set retryAttempt(n: number) {
      state.retryAttempt = n;
    },
    get continuationTurn() {
      return state.continuationTurn;
    },
    set continuationTurn(n: number) {
      state.continuationTurn = n;
    },
    get lastActivityAt() {
      return state.lastActivity;
    },
    set lastActivityAt(t: number) {
      state.lastActivity = t;
    },
    getLastActivity: () => state.getLastActivity(),
    scheduleRetryTimer: scheduleRetryTimerSpy,
    cancelRetryTimer: cancelRetryTimerSpy,
    recordActivity: recordActivitySpy,
    forcePhase: forcePhaseSpy,
    stop: ctx.bridge.stop,
    startRun: ctx.bridge.run,
    sendMessage: ctx.bridge.send,
    dispose: ctx.bridge.dispose,
    simulateRunEnd: (reason: string) => {
      ctx.bridge.emit({ kind: 'run-end', ticketId, reason });
    },
    simulateTokenUsage: (usage) => {
      ctx.bridge.emit({ kind: 'token-usage', ticketId, usage });
    },
  };
  return mock;
};

// ---------------------------------------------------------------------------
// Workflow loader stub
// ---------------------------------------------------------------------------

export const makeWorkflowLoader = (configOverride: Partial<WorkflowConfig> = {}): IWorkflowLoader => {
  const config: WorkflowConfig = { ...configOverride };
  return {
    load: vi.fn(() => Promise.resolve({})),
    loadFromRemote: vi.fn(() => Promise.resolve({})),
    get: vi.fn(() => null),
    getConfig: vi.fn(() => config),
    getPromptTemplate: vi.fn(() => 'stub prompt template'),
    runHook: vi.fn(() => Promise.resolve(true)),
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
  /** Seeded MockEntry records by ticket id (populated by `seedMachine`). */
  machines: Map<TicketId, MockEntry>;
  send: ReturnType<typeof makeSendToWindow>;
  workflow: IWorkflowLoader;
  bridge: MockBridge;
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
  const bridge = makeMockBridge();
  const machines = new Map<TicketId, MockEntry>();

  const pm = new ProjectManager(
    {
      store: store as unknown as ConstructorParameters<typeof ProjectManager>[0]['store'],
      sendToWindow: send.fn as unknown as ConstructorParameters<typeof ProjectManager>[0]['sendToWindow'],
      processManager: opts.processManager as ConstructorParameters<typeof ProjectManager>[0]['processManager'],
    },
    {
      workflowLoader: workflow,
      bridge: bridge.bridge,
    }
  );

  return { pm, store, machines, send, workflow, bridge };
};

/**
 * Clean handle on the extracted SupervisorOrchestrator. Every supervisor-
 * lifecycle behavior the tests assert against is a real public method on the
 * orchestrator with a real dep contract.
 */
export const orch = (pm: ProjectManager): SupervisorOrchestrator =>
  (pm as unknown as { supervisors: SupervisorOrchestrator }).supervisors;

// ---------------------------------------------------------------------------
// Back-compat re-exports — old tests reference `MockMachine`
// ---------------------------------------------------------------------------
export type MockMachine = MockEntry;
