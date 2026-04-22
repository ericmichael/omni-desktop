/**
 * SupervisorOrchestrator — owns the supervisor lifecycle for fleet tickets.
 *
 * Extracted from `ProjectManager` (Sprint C2c of the 6.3 decomposition). Mirrors
 * the narrow-adapter pattern established by `PageManager`, `InboxManager`, and
 * `MilestoneManager`: the orchestrator takes a typed `store` surface and a
 * `host` surface, so tests can construct it directly with plain in-memory fakes
 * instead of reaching into `ProjectManager` privates through a cast.
 *
 * The extraction is landing incrementally — each commit moves a slice of
 * behavior out of `project-manager.ts` with matching test migrations. The dep
 * contract grows and shrinks as logic moves: callbacks like `ensureSupervisorInfra`
 * and `startMachineRun` are temporary while PM still owns those methods and
 * will disappear once they migrate in.
 *
 * Currently owns:
 *   - Effective-config accessors (stall timeout, concurrency, retry, turns)
 *   - `canStartSupervisor` — global + per-column concurrency check
 *   - `getActiveWipTickets` — cross-project active-phase roll-up
 *   - `isAutoDispatchEnabled` — project flag + FLEET.md override
 *   - Retry queue (`scheduleRetry`, `handleRetryFired`, `cancelRetry`, `cancelAllRetries`)
 *   - Stall detection (`startStallDetection`, `stopStallDetection`, `checkForStalledSupervisors`)
 *   - `machines` / `runStartedAt` / `ticketLocks` state + `createMachine` + `withTicketLock`
 *   - `handleMachineRunEnd`
 *   - Infra provisioning (`ensureSupervisorInfra`, `resolveTicketWorkspace`, `ensureSession`)
 *   - Lifecycle entry points (`startSupervisor`, `stopSupervisor`, `sendSupervisorMessage`,
 *     `resetSupervisorSession`, `startMachineRun`, `cleanupTicketWorkspace`)
 *   - `tasks` map + persisted task list, `restorePersistedTasks`,
 *     `startupTerminalCleanup`, `resetStaleTicketStates`,
 *     `removeAllTasksForProject`, `exitAllTasks`, `listTasks`
 *   - `validateDispatchPreflight` + auto-dispatch loop
 *     (`autoDispatchTick`, `setAutoDispatch`, `startAutoDispatch`,
 *     `stopAutoDispatch`)
 *   - Tool dispatch (`handleClientToolCall`) + supervisor prompt assembly
 *     (`buildFullSupervisorPrompt`, `buildRunVariables`,
 *     `buildContinuationPromptForTicket`)
 */

import { randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import fs from 'fs/promises';
import { nanoid } from 'nanoid';
import path from 'path';

import { getAgentArtifactsDir } from '@/lib/artifacts';
import { buildAutopilotVariables, buildInteractiveVariables } from '@/lib/client-tools';
import { buildContinuationPrompt } from '@/lib/continuation-prompt';
import type { AppControlManager } from '@/main/app-control-manager';
import type { AppClickButton, AppConsoleLevel } from '@/shared/app-control-types';
import { makeAppHandleId } from '@/shared/app-control-types';
import type {
  IMachineFactory,
  ISandbox,
  ISandboxFactory,
  ITicketMachine,
  IWindowSender,
  IWorkflowLoader,
  MachineCallbacks,
} from '@/lib/project-manager-deps';
import { decideRunEndAction, type FailureClass } from '@/lib/run-end';
import { hasTemplateExpressions, renderTemplate, type TemplateVariables } from '@/lib/template';
import { decideWorktreeAction } from '@/lib/worktree';
import type { AgentProcessMode } from '@/main/agent-process';
import { createPlatformClient } from '@/main/platform-mode';
import type { ProcessManager } from '@/main/process-manager';
import { buildSupervisorPrompt, type SupervisorContext } from '@/main/supervisor-prompt';
import { type ClientFunctionResponder, TicketMachine } from '@/main/ticket-machine';
import { createWorktree, generateWorktreeName, isWorktreeDirty,removeWorktree } from '@/main/worktree-ops';
import { getLocalWorkspaceDir, requireLocalWorkspaceDir } from '@/shared/project-source';
import { isActivePhase, type TicketPhase } from '@/shared/ticket-phase';
import type {
  AgentProcessStatus,
  CodeTabId,
  ColumnId,
  Milestone,
  MilestoneId,
  Page,
  PageId,
  Pipeline,
  PlatformCredentials,
  Project,
  ProjectId,
  SandboxBackend,
  SessionMessage,
  Task,
  TaskId,
  Ticket,
  TicketId,
  TicketPriority,
  TokenUsage,
  WithTimestamp,
} from '@/shared/types';

// ---------------------------------------------------------------------------
// Operational constants — referenced by SupervisorOrchestrator and eventually
// by the full set of lifecycle methods as they migrate in.
// ---------------------------------------------------------------------------

/** Maximum number of supervisors that can run concurrently across all projects. */
export const MAX_CONCURRENT_SUPERVISORS = 5;

/** If no supervisor message is received within this window, the run is considered stalled. */
export const STALL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Safety-net timeout for streaming phases (running/continuing). Normally the
 * primary stall check skips streaming phases because legitimate long tool
 * calls can silence the message stream for minutes. But if the supervisor
 * crashes silently — no exit event, no run_end, no error — a streaming machine
 * would hang forever. This backstop fires only after a very long silence.
 */
export const STREAMING_STALL_TIMEOUT_MS = 30 * 60 * 1000;

/** How often to check for stalled supervisors. */
export const STALL_CHECK_INTERVAL_MS = 30_000;

/** Base delay for exponential backoff on failure-driven retries. */
export const RETRY_BASE_DELAY_MS = 10_000;

/** Maximum backoff delay for failure retries. */
export const MAX_RETRY_BACKOFF_MS = 5 * 60 * 1000;

/** Maximum retry attempts before giving up. */
export const MAX_RETRY_ATTEMPTS = 5;

/** Maximum continuation turns (successful run → re-check → continue). */
export const MAX_CONTINUATION_TURNS = 10;

/** Auto-dispatch poll interval — check every 30s for eligible tickets. */
export const AUTO_DISPATCH_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface MachineEntry {
  machine: ITicketMachine;
  sandbox: ISandbox | null;
}

export interface RetryOpts {
  attempt?: number;
  continuationTurn?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Narrow store surface — just the slices the orchestrator reads and writes.
// Grows as more state moves in.
// ---------------------------------------------------------------------------

export interface SupervisorOrchestratorStore {
  getTickets(): Ticket[];
  setTickets(tickets: Ticket[]): void;
  getProjects(): Project[];
  getWipLimit(): number;
  getSandboxBackend(): SandboxBackend | undefined;
  getPlatformCredentials(): PlatformCredentials | undefined;
  getCodeTabs(): Array<{ id: string; ticketId?: string }>;
  getPersistedTasks(): Task[];
  setPersistedTasks(tasks: Task[]): void;
  /** Host-side omni-code config directory (e.g. ~/.config/omni_code on macOS/Linux). */
  getOmniConfigDir(): string;
}

// ---------------------------------------------------------------------------
// Host surface — behavior the orchestrator needs from its collaborators.
//
// Several of these are temporary callbacks while PM still owns the `machines`
// map, withTicketLock, and lifecycle entry points. They disappear as those
// concerns migrate in subsequent sprints.
// ---------------------------------------------------------------------------

export interface SupervisorOrchestratorHost {
  // Ticket lookups + CRUD — PM retains the storage layer long-term.
  getTicketById(ticketId: TicketId): Ticket | undefined;
  getTicketsByProject(projectId: ProjectId): Ticket[];
  addTicket(input: Omit<Ticket, 'id' | 'createdAt' | 'updatedAt' | 'columnId'> & { milestoneId?: MilestoneId }): Ticket;
  updateTicket(ticketId: TicketId, patch: Partial<Ticket>): void;

  // Pipeline / column semantics
  isTerminalColumn(projectId: ProjectId, columnId: ColumnId): boolean;
  getColumn(projectId: ProjectId, columnId: ColumnId): Pipeline['columns'][number] | undefined;
  getPipeline(projectId: ProjectId): Pipeline;
  /** Effective branch for a ticket (ticket.branch ?? milestone.branch). */
  resolveTicketBranch(ticket: Ticket): string | undefined;

  // Auto-dispatch loop dependencies — PM owns project CRUD.
  getNextTicket(projectId: ProjectId): Ticket | null;
  moveTicketToColumn(ticketId: TicketId, columnId: ColumnId): void;
  updateProject(projectId: ProjectId, patch: { autoDispatch?: boolean }): void;

  // Read-side accessors used by the tool-dispatch + supervisor-prompt path
  // (C2c.8). PM still owns Milestone/Page storage via its delegate managers.
  getMilestonesByProject(projectId: ProjectId): Milestone[];
  getMilestoneById(milestoneId: MilestoneId): Milestone | undefined;
  getPagesByProject(projectId: ProjectId): Page[];
  getPageById(pageId: PageId): Page | undefined;
  readPageContent(pageId: PageId): Promise<string>;
  /** Resolves the on-disk project directory (Personal vs slug). */
  getProjectDirPath(project: Project): string;
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface SupervisorOrchestratorDeps {
  store: SupervisorOrchestratorStore;
  host: SupervisorOrchestratorHost;
  workflowLoader: IWorkflowLoader;
  sendToWindow: IWindowSender;
  sandboxFactory: ISandboxFactory;
  /** Optional machine factory for tests. Defaults to real TicketMachine. */
  machineFactory?: IMachineFactory;
  /** Optional ProcessManager — enables Code-tab sandbox reuse. */
  processManager?: ProcessManager;
  /**
   * Optional AppControlManager — when present, autopilot agents gain the
   * `app_*` client tools scoped to their ticket's code tab (column-only,
   * never global).
   */
  appControlManager?: AppControlManager;
}

// ---------------------------------------------------------------------------
// SupervisorOrchestrator
// ---------------------------------------------------------------------------

export class SupervisorOrchestrator {
  private stallCheckTimer: ReturnType<typeof setInterval> | null = null;
  private autoDispatchTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Live supervisor machines keyed by ticket. Public so ProjectManager
   * (which still owns several lifecycle entry points) and tests can
   * reach in without a cast. Becomes fully encapsulated after C2c.5.
   */
  readonly machines = new Map<TicketId, MachineEntry>();

  /**
   * Wall-clock time each active run started, keyed by ticketId. Read in
   * handleMachineRunEnd so persisted TicketRun.startedAt reflects the
   * actual run start, not ticket.updatedAt (which can be bumped by any
   * intervening updateTicket call, e.g., onTokenUsage).
   */
  readonly runStartedAt = new Map<TicketId, number>();

  /** Per-ticket async mutex chain. Public for the same reason as `machines`. */
  readonly ticketLocks = new Map<TicketId, Promise<void>>();

  /**
   * In-memory sandbox tasks keyed by taskId. Each entry pairs a `Task` record
   * (also persisted in the store) with the live `ISandbox` that owns the
   * underlying container/process. Public so ProjectManager's
   * `getFilesChanged` / `getTasks` / `removeProject` / `exit` paths can
   * iterate without a cast — same pattern as `machines`.
   */
  readonly tasks = new Map<TaskId, { task: Task; sandbox: ISandbox }>();

  constructor(private readonly deps: SupervisorOrchestratorDeps) {}

  // -------------------------------------------------------------------------
  // Task persistence (in-memory + store)
  // -------------------------------------------------------------------------

  /** Insert or update a persisted task record. */
  private persistTask(task: Task): void {
    const tasks = this.deps.store.getPersistedTasks();
    const index = tasks.findIndex((t) => t.id === task.id);
    if (index === -1) {
      tasks.push(task);
    } else {
      tasks[index] = task;
    }
    this.deps.store.setPersistedTasks(tasks);
  }

  /** Drop a persisted task by id. No-op if absent. */
  private removePersistedTask(taskId: TaskId): void {
    const tasks = this.deps.store.getPersistedTasks().filter((t) => t.id !== taskId);
    this.deps.store.setPersistedTasks(tasks);
  }

  /** Snapshot of all in-memory tasks (for IPC `project:get-tasks`). */
  listTasks(): Task[] {
    return Array.from(this.tasks.values()).map((entry) => entry.task);
  }

  // -------------------------------------------------------------------------
  // Machine factory
  // -------------------------------------------------------------------------

  /**
   * Build a ticket machine wired to this orchestrator's callbacks. Uses the
   * injected factory if provided (tests), otherwise constructs a real
   * `TicketMachine`. The returned machine is NOT added to `this.machines`
   * — callers (`ensureSupervisorInfra` in PM for now) place the entry when
   * sandbox provisioning has started.
   */
  createMachine(ticketId: TicketId): ITicketMachine {
    const callbacks: MachineCallbacks = {
      onPhaseChange: (tid, phase) => {
        this.deps.host.updateTicket(tid, { phase, phaseChangedAt: Date.now() });
        this.deps.sendToWindow('project:phase', tid, phase);
      },
      onMessage: (tid, msg: SessionMessage) => {
        this.deps.sendToWindow('project:supervisor-message', tid, msg);
      },
      onRunEnd: (tid, reason) => {
        void this.handleMachineRunEnd(tid, reason);
      },
      onTokenUsage: (tid, usage: TokenUsage) => {
        const ticket = this.deps.host.getTicketById(tid);
        if (!ticket) {
          return;
        }
        const prev = ticket.tokenUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        const updated = {
          inputTokens: prev.inputTokens + usage.inputTokens,
          outputTokens: prev.outputTokens + usage.outputTokens,
          totalTokens: prev.totalTokens + usage.totalTokens,
        };
        if (updated.totalTokens !== prev.totalTokens) {
          this.deps.host.updateTicket(tid, { tokenUsage: updated });
          this.deps.sendToWindow('project:token-usage', tid, updated);
        }
      },
      onClientRequest: (
        tid: TicketId,
        functionName: string,
        args: Record<string, unknown>,
        respond: ClientFunctionResponder
      ) => {
        // Auto-approve tool approval requests (project agents run unattended)
        if (functionName === 'ui.request_tool_approval') {
          respond(true, { approved: true, always_approve: true });
          return;
        }
        this.handleClientToolCall(tid, functionName, args, respond);
      },
    };

    if (this.deps.machineFactory) {
      return this.deps.machineFactory.create(ticketId, callbacks);
    }
    return new TicketMachine(ticketId, callbacks) as unknown as ITicketMachine;
  }

  // -------------------------------------------------------------------------
  // Per-ticket async mutex
  // -------------------------------------------------------------------------

  /**
   * Serialize async operations per ticket to prevent races between
   * start/stop/retry/stall-check for the same ticket.
   */
  withTicketLock<T>(ticketId: TicketId, fn: () => Promise<T>): Promise<T> {
    const prev = this.ticketLocks.get(ticketId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.ticketLocks.set(
      ticketId,
      next.then(
        () => {},
        () => {}
      )
    );
    return next;
  }

  // -------------------------------------------------------------------------
  // Run-end handling
  // -------------------------------------------------------------------------

  /**
   * Handle a run_end notification from a machine. Decides whether to continue,
   * retry, or stop based on the run end reason and ticket state.
   */
  handleMachineRunEnd = (ticketId: TicketId, reason: string): Promise<void> => {
    return this.withTicketLock(ticketId, async () => {
      console.log(`[SupervisorOrchestrator] Machine run ended for ${ticketId}: ${reason}`);

      const entry = this.machines.get(ticketId);
      if (!entry) {
        return;
      }
      const { machine } = entry;

      // Guard: ignore if machine was already stopped/transitioned (e.g., user clicked Stop)
      if (!machine.isStreaming()) {
        console.log(
          `[SupervisorOrchestrator] Ignoring run_end for ${ticketId} — machine in phase ${machine.getPhase()}`
        );
        return;
      }

      // Run after_run hook (best-effort)
      const ticket = this.deps.host.getTicketById(ticketId);
      if (ticket) {
        const project = this.deps.store.getProjects().find((p) => p.id === ticket.projectId);
        if (project?.source?.kind === 'local') {
          void this.deps.workflowLoader.runHook(ticket.projectId, 'after_run', project.source.workspaceDir);
        } else if (project?.source?.kind === 'git-remote') {
          const hookScript = this.deps.workflowLoader.getConfig(ticket.projectId).hooks?.after_run;
          if (hookScript) {
            const currentEntry = this.machines.get(ticketId);
            if (currentEntry?.sandbox) {
              void currentEntry.sandbox.execInContainer(hookScript, '/home/user/workspace');
            }
          }
        }
      }

      const maxTurns = ticket ? this.getEffectiveMaxContinuationTurns(ticket.projectId) : MAX_CONTINUATION_TURNS;

      const action = decideRunEndAction({
        reason,
        continuationTurn: machine.continuationTurn,
        maxContinuationTurns: maxTurns,
      });

      // Persist run record. startedAt comes from runStartedAt — falling back
      // to updatedAt is a last-resort approximation, since token-usage updates
      // bump updatedAt and would otherwise collapse startedAt onto endedAt.
      if (ticket) {
        const endedAt = Date.now();
        const runStartedAt = this.runStartedAt.get(ticketId) ?? ticket.updatedAt;
        const run = {
          id: nanoid(),
          startedAt: runStartedAt,
          endedAt,
          endReason: reason,
          tokenUsage: ticket.tokenUsage ? { ...ticket.tokenUsage } : undefined,
        };
        const existingRuns = ticket.runs ?? [];
        this.deps.host.updateTicket(ticketId, { runs: [...existingRuns, run] });
        this.runStartedAt.delete(ticketId);
      }

      switch (action.type) {
        case 'stopped':
          machine.transition('idle' as TicketPhase);
          return;

        case 'complete':
          console.log(`[SupervisorOrchestrator] Ticket ${ticketId} work complete.`);
          machine.transition('completed' as TicketPhase);
          return;

        case 'continue': {
          // Re-read ticket — the agent may have moved it during the run
          const freshTicket = this.deps.host.getTicketById(ticketId);
          if (freshTicket) {
            if (this.deps.host.isTerminalColumn(freshTicket.projectId, freshTicket.columnId)) {
              console.log(`[SupervisorOrchestrator] Ticket ${ticketId} is in terminal column — not continuing.`);
              machine.transition('completed' as TicketPhase);
              return;
            }
            const col = this.deps.host.getColumn(freshTicket.projectId, freshTicket.columnId);
            if (col?.gate) {
              console.log(
                `[SupervisorOrchestrator] Ticket ${ticketId} is in gated column "${freshTicket.columnId}" — not continuing.`
              );
              machine.transition('idle' as TicketPhase);
              return;
            }
          }

          machine.continuationTurn = action.nextTurn;
          machine.transition('continuing' as TicketPhase);
          machine.recordActivity();

          console.log(`[SupervisorOrchestrator] Continuing ticket ${ticketId} (turn ${action.nextTurn}/${maxTurns}).`);

          const sessionId = machine.getSessionId() ?? undefined;
          const continuationPrompt = this.buildContinuationPromptForTicket(ticketId, action.nextTurn + 1, maxTurns);
          // Brief delay to let the server's worker task finish cleanup (clear current_task)
          // before we send the next start_run, avoiding "Run already active" race.
          await new Promise<void>((r) => {
            setTimeout(r, 500);
          });
          this.startMachineRun(ticketId, continuationPrompt, { sessionId });
          return;
        }

        case 'retry':
          this.scheduleRetry(ticketId, action.failureClass, {
            attempt: machine.retryAttempt + 1,
            continuationTurn: machine.continuationTurn,
            error: reason,
          });
          return;
      }
    });
  };

  // -------------------------------------------------------------------------
  // Effective-config accessors — resolve workflow (FLEET.md) overrides against
  // the hard-coded defaults above.
  // -------------------------------------------------------------------------

  getEffectiveStallTimeout(projectId: ProjectId): number {
    return this.deps.workflowLoader.getConfig(projectId).supervisor?.stall_timeout_ms ?? STALL_TIMEOUT_MS;
  }

  /**
   * Effective max concurrent supervisors. Uses the minimum of the global limit
   * and the per-project limit (if set). When `projectId` is omitted the global
   * limit is returned directly.
   */
  getEffectiveMaxConcurrent(projectId?: ProjectId): number {
    if (!projectId) {
      return MAX_CONCURRENT_SUPERVISORS;
    }
    const projectLimit = this.deps.workflowLoader.getConfig(projectId).supervisor?.max_concurrent;
    if (projectLimit !== undefined) {
      return Math.min(projectLimit, MAX_CONCURRENT_SUPERVISORS);
    }
    return MAX_CONCURRENT_SUPERVISORS;
  }

  getEffectiveMaxRetries(projectId: ProjectId): number {
    return this.deps.workflowLoader.getConfig(projectId).supervisor?.max_retry_attempts ?? MAX_RETRY_ATTEMPTS;
  }

  getEffectiveMaxContinuationTurns(projectId: ProjectId): number {
    return this.deps.workflowLoader.getConfig(projectId).supervisor?.max_continuation_turns ?? MAX_CONTINUATION_TURNS;
  }

  /** Per-column concurrency limit from FLEET.md, or undefined if not set. */
  getColumnMaxConcurrent(projectId: ProjectId, columnId: ColumnId): number | undefined {
    return this.deps.workflowLoader.getConfig(projectId).supervisor?.max_concurrent_by_column?.[columnId];
  }

  /** Whether a project opts into auto-dispatch (project flag OR FLEET.md override). */
  isAutoDispatchEnabled(projectId: ProjectId): boolean {
    const project = this.deps.store.getProjects().find((p) => p.id === projectId);
    if (project?.autoDispatch) {
      return true;
    }
    return this.deps.workflowLoader.getConfig(projectId).supervisor?.auto_dispatch ?? false;
  }

  // -------------------------------------------------------------------------
  // Concurrency
  // -------------------------------------------------------------------------

  /**
   * Check if a new supervisor can be started within global and per-column
   * concurrency limits.
   */
  canStartSupervisor(projectId?: ProjectId, columnId?: ColumnId): boolean {
    let total = 0;
    let columnCount = 0;
    for (const [ticketId, entry] of this.machines) {
      if (!entry.machine.isActive()) {
        continue;
      }
      total++;
      if (projectId && columnId) {
        const ticket = this.deps.host.getTicketById(ticketId);
        if (ticket && ticket.projectId === projectId && ticket.columnId === columnId) {
          columnCount++;
        }
      }
    }
    if (total >= MAX_CONCURRENT_SUPERVISORS) {
      return false;
    }
    if (projectId && columnId) {
      const columnLimit = this.getColumnMaxConcurrent(projectId, columnId);
      if (columnLimit !== undefined) {
        return columnCount < columnLimit;
      }
    }
    return true;
  }

  /**
   * All tickets currently in an active supervisor phase across every project.
   * Used by the "Right Now" view and for WIP-limit enforcement in
   * `validateDispatchPreflight`.
   */
  getActiveWipTickets(): Ticket[] {
    return this.deps.store.getTickets().filter((t) => t.phase !== undefined && isActivePhase(t.phase));
  }

  // -------------------------------------------------------------------------
  // Retry queue (Symphony-inspired exponential backoff)
  // -------------------------------------------------------------------------

  /**
   * Schedule a retry for a ticket's supervisor after a failed run.
   *
   * Uses exponential backoff. `decideRunEndAction` only emits the retry action
   * for `error` and `stalled` reasons — `completed` / `max_turns` are handled
   * by the `continue` branch in `handleMachineRunEnd`, which dispatches the
   * next run directly without going through this queue.
   */
  scheduleRetry(ticketId: TicketId, failureClass: FailureClass, opts: RetryOpts): void {
    const entry = this.machines.get(ticketId);
    if (!entry) {
      return;
    }
    const { machine } = entry;

    const attempt = opts.attempt ?? 0;
    const continuationTurn = opts.continuationTurn ?? 0;

    machine.retryAttempt = attempt;
    machine.continuationTurn = continuationTurn;

    const ticket = this.deps.host.getTicketById(ticketId);
    const maxRetryAttempts = ticket ? this.getEffectiveMaxRetries(ticket.projectId) : MAX_RETRY_ATTEMPTS;

    if (attempt >= maxRetryAttempts) {
      console.log(
        `[SupervisorOrchestrator] Ticket ${ticketId} reached max retry attempts (${maxRetryAttempts}). Giving up.`
      );
      machine.transition('error');
      return;
    }

    const delayMs = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt), MAX_RETRY_BACKOFF_MS);

    console.log(
      `[SupervisorOrchestrator] Scheduling retry for ${ticketId} (attempt=${attempt}, turn=${continuationTurn}) ` +
        `in ${Math.round(delayMs / 1000)}s${opts.error ? ` (reason: ${opts.error})` : ''}`
    );

    machine.scheduleRetryTimer(delayMs, () => {
      void this.handleRetryFired(ticketId, failureClass, attempt, continuationTurn);
    });
  }

  /**
   * Handle a retry timer firing. Re-check ticket state and re-dispatch if
   * still eligible.
   */
  handleRetryFired(
    ticketId: TicketId,
    failureClass: FailureClass,
    attempt: number,
    continuationTurn: number
  ): Promise<void> {
    return this.withTicketLock(ticketId, async () => {
      const ticket = this.deps.host.getTicketById(ticketId);
      const entry = this.machines.get(ticketId);
      if (!ticket || !entry) {
        console.log(
          `[SupervisorOrchestrator] Retry fired for ${ticketId} but ticket/machine no longer exists. Releasing.`
        );
        return;
      }
      const { machine } = entry;

      // Don't retry if ticket is now in a terminal column
      if (this.deps.host.isTerminalColumn(ticket.projectId, ticket.columnId)) {
        console.log(
          `[SupervisorOrchestrator] Retry fired for ${ticketId} but ticket is in terminal column. Releasing.`
        );
        machine.transition('idle');
        return;
      }

      // Check concurrency (including per-column limits)
      if (!this.canStartSupervisor(ticket.projectId, ticket.columnId)) {
        console.log(`[SupervisorOrchestrator] No slots available for retry of ${ticketId}. Requeuing.`);
        this.scheduleRetry(ticketId, failureClass, {
          attempt: attempt + 1,
          continuationTurn,
          error: 'no available supervisor slots',
        });
        return;
      }

      // Re-dispatch
      console.log(
        `[SupervisorOrchestrator] Retry firing for ${ticketId} (${failureClass}, attempt=${attempt}, turn=${continuationTurn}). Re-dispatching.`
      );

      try {
        const project = this.deps.store.getProjects().find((p) => p.id === ticket.projectId);
        if (!project) {
          return;
        }

        let hookOk = true;
        if (project.source?.kind === 'local') {
          hookOk = await this.deps.workflowLoader.runHook(ticket.projectId, 'before_run', project.source?.workspaceDir);
        } else {
          const hookScript = this.deps.workflowLoader.getConfig(ticket.projectId).hooks?.before_run;
          if (hookScript) {
            const currentEntry = this.machines.get(ticketId);
            if (currentEntry?.sandbox) {
              hookOk = await currentEntry.sandbox.execInContainer(hookScript, '/home/user/workspace');
            }
          }
        }
        if (!hookOk) {
          console.warn(
            `[SupervisorOrchestrator] before_run hook failed during retry for ${ticketId}. Scheduling another retry.`
          );
          this.scheduleRetry(ticketId, 'error', {
            attempt: attempt + 1,
            continuationTurn,
            error: 'before_run hook failed',
          });
          return;
        }

        const sessionId = ticket.supervisorSessionId ?? undefined;
        const prompt = 'The previous run failed. Please review the current state and continue working on this ticket.';
        const variables = this.buildRunVariables(ticketId);

        machine.recordActivity();
        await this.ensureSupervisorInfra(ticketId);
        this.startMachineRun(ticketId, prompt, { sessionId, variables });
      } catch (error) {
        console.error(`[SupervisorOrchestrator] Retry dispatch failed for ${ticketId}:`, error);
        this.scheduleRetry(ticketId, 'error', {
          attempt: attempt + 1,
          continuationTurn,
          error: (error as Error).message,
        });
      }
    });
  }

  /** Cancel any pending retry timer for a single ticket. */
  cancelRetry(ticketId: TicketId): void {
    const entry = this.machines.get(ticketId);
    if (entry) {
      entry.machine.cancelRetryTimer();
    }
  }

  /** Cancel all pending retry timers — called from PM.exit(). */
  cancelAllRetries(): void {
    for (const [, entry] of this.machines) {
      entry.machine.cancelRetryTimer();
    }
  }

  // -------------------------------------------------------------------------
  // Stall detection
  // -------------------------------------------------------------------------

  /** Start the periodic stall-check timer. Idempotent. */
  startStallDetection(): void {
    if (this.stallCheckTimer) {
      return;
    }
    this.stallCheckTimer = setInterval(() => this.checkForStalledSupervisors(), STALL_CHECK_INTERVAL_MS);
  }

  /** Stop the stall-check timer. Idempotent. */
  stopStallDetection(): void {
    if (this.stallCheckTimer) {
      clearInterval(this.stallCheckTimer);
      this.stallCheckTimer = null;
    }
  }

  /**
   * One stall-check tick. Any active machine that hasn't recorded activity
   * within its effective timeout is stopped and handed to the retry queue.
   * Streaming phases get a much longer safety-net timeout because legitimate
   * long tool calls can silence the message stream for many minutes.
   */
  checkForStalledSupervisors(): void {
    const now = Date.now();

    for (const [ticketId, entry] of this.machines) {
      const { machine } = entry;
      const phase = machine.getPhase();

      if (!machine.isActive()) {
        continue;
      }
      // Skip phases that have their own timeouts or are waiting intentionally.
      // 'ready' means the session exists but no autonomous run was started — the user
      // may be using the workspace manually, so don't treat it as stalled.
      if (phase === 'retrying' || phase === 'awaiting_input' || phase === 'ready') {
        continue;
      }

      const ticket = this.deps.host.getTicketById(ticketId);
      const stallTimeout = machine.isStreaming()
        ? STREAMING_STALL_TIMEOUT_MS
        : ticket
          ? this.getEffectiveStallTimeout(ticket.projectId)
          : STALL_TIMEOUT_MS;

      const elapsed = now - machine.getLastActivity();
      if (elapsed > stallTimeout) {
        void this.withTicketLock(ticketId, async () => {
          // Re-check under lock
          if (!machine.isActive()) {
            return;
          }
          if (machine.getPhase() === 'retrying' || machine.getPhase() === 'awaiting_input') {
            return;
          }
          const elapsedNow = Date.now() - machine.getLastActivity();
          if (elapsedNow <= stallTimeout) {
            return;
          }

          console.warn(
            `[SupervisorOrchestrator] Supervisor stalled for ticket ${ticketId} in phase "${machine.getPhase()}" (${Math.round(elapsedNow / 1000)}s since last activity). Stopping and scheduling retry.`
          );
          await machine.stop();

          this.scheduleRetry(ticketId, 'stalled', {
            attempt: machine.retryAttempt + 1,
            continuationTurn: machine.continuationTurn,
            error: `stalled in phase ${machine.getPhase()} for ${Math.round(elapsedNow / 1000)}s`,
          });
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Infra provisioning (C2c.4) — ensure sandbox + machine + session for a ticket
  // -------------------------------------------------------------------------

  /** Check if a Code tab has a running sandbox for this ticket. */
  getCodeTabWsUrl(ticketId: TicketId): string | null {
    if (!this.deps.processManager) {
      return null;
    }
    const codeTabs = this.deps.store.getCodeTabs();
    return this.deps.processManager.getRunningWsUrlForTicket(ticketId, codeTabs);
  }

  /** Return the supervisor sandbox status for a Code tab linked to a ticket. */
  getSupervisorStatusForCodeTab(tabId: CodeTabId): WithTimestamp<AgentProcessStatus> | null {
    const codeTabs = this.deps.store.getCodeTabs();
    const tab = codeTabs.find((t) => t.id === tabId);
    if (!tab?.ticketId) {
      return null;
    }
    const entry = this.machines.get(tab.ticketId as TicketId);
    if (!entry?.sandbox) {
      return null;
    }
    return entry.sandbox.getStatus();
  }

  /**
   * Decide which workspace directory to mount for a ticket. Resolves or
   * creates a git worktree for local projects, or returns a container-side
   * path + repo metadata for git-remote projects.
   */
  resolveTicketWorkspace = async (
    ticketId: TicketId
  ): Promise<{
    workspaceDir: string;
    worktreePath?: string;
    worktreeName?: string;
    action: 'reuse' | 'create' | 'none';
    /** For git-remote projects: repo info so the container can clone. */
    gitRepo?: { url: string; branch?: string };
  }> => {
    const ticket = this.deps.host.getTicketById(ticketId);
    if (!ticket) {
      throw new Error(`Ticket not found: ${ticketId}`);
    }

    const project = this.deps.store.getProjects().find((p) => p.id === ticket.projectId);
    if (!project) {
      throw new Error(`Project not found: ${ticket.projectId}`);
    }

    // Git-remote projects: container clones the repo — no local workspace or worktrees
    if (project.source?.kind === 'git-remote') {
      const effectiveBranch = this.deps.host.resolveTicketBranch(ticket) ?? project.source?.defaultBranch;
      return {
        workspaceDir: '/home/user/workspace', // container-side path (not local)
        action: 'none',
        gitRepo: {
          url: project.source?.repoUrl,
          branch: effectiveBranch,
        },
      };
    }

    let workspaceDir = requireLocalWorkspaceDir(project.source);
    let worktreePath: string | undefined;
    let worktreeName: string | undefined;
    const effectiveBranch = this.deps.host.resolveTicketBranch(ticket);

    let worktreeExists = false;
    if (ticket.worktreePath) {
      try {
        await fs.access(ticket.worktreePath);
        worktreeExists = true;
      } catch {
        // worktreeExists stays false
      }
    }

    const wtAction = decideWorktreeAction(ticket, worktreeExists, effectiveBranch);
    if (wtAction.action === 'reuse') {
      worktreePath = wtAction.worktreePath;
      worktreeName = wtAction.worktreeName;
      workspaceDir = worktreePath;
      console.log(`[SupervisorOrchestrator] Reusing existing worktree "${worktreeName}" for ticket ${ticketId}`);
    } else if (wtAction.action === 'create') {
      worktreeName = generateWorktreeName();
      worktreePath = await createWorktree(requireLocalWorkspaceDir(project.source), effectiveBranch!, worktreeName);
      workspaceDir = worktreePath;
      this.deps.host.updateTicket(ticketId, { worktreePath, worktreeName });
    }

    return {
      workspaceDir,
      worktreePath,
      worktreeName,
      action: wtAction.action,
    };
  };

  /**
   * Ensure a session exists for the ticket. Generates the session ID upfront
   * and persists it on the ticket BEFORE the RPC completes, so the renderer
   * can include ?session= in the embedded UI URL immediately (progressive load).
   */
  private ensureSession = async (ticketId: TicketId): Promise<void> => {
    const ticket = this.deps.host.getTicketById(ticketId);
    if (!ticket) {
      return;
    }

    // If the machine is already in 'ready' state with a session, nothing to do
    const existingEntry = this.machines.get(ticketId);
    if (existingEntry?.machine.getPhase() === 'ready' && existingEntry.machine.getSessionId()) {
      return;
    }

    const entry = this.machines.get(ticketId);
    if (!entry) {
      return;
    }

    const variables = this.buildRunVariables(ticketId, 'interactive');

    const sessionId = randomUUID();

    try {
      console.log(`[SupervisorOrchestrator] Creating session ${sessionId} for ticket ${ticketId}`);
      await entry.machine.createSession(variables, sessionId);
      console.log(`[SupervisorOrchestrator] Session created: ${sessionId} for ticket ${ticketId}`);
      // Only publish the session ID after it actually exists in the server,
      // so the renderer's getSessionHistory call won't fail on a non-existent session.
      this.deps.host.updateTicket(ticketId, { supervisorSessionId: sessionId });
    } catch (error) {
      console.error(`[SupervisorOrchestrator] Failed to create session for ${ticketId}:`, error);
      // Clear the optimistic session ID since creation failed
      this.deps.host.updateTicket(ticketId, { supervisorSessionId: undefined });
      // Recover from stuck connecting/session_creating phase so the UI doesn't show
      // "Connecting…" indefinitely. Reset to idle so the user can retry.
      const phase = entry.machine.getPhase();
      if (phase === 'connecting' || phase === 'session_creating') {
        entry.machine.forcePhase('idle' as TicketPhase);
      }
    }
  };

  /**
   * Ensure sandbox + machine infrastructure exists for a ticket.
   * Idempotent — if a machine is already provisioned with a running sandbox, returns immediately.
   * Returns only after the sandbox is running and a session is established.
   */
  ensureSupervisorInfra = async (
    ticketId: TicketId
  ): Promise<{ machine: ITicketMachine; sandbox: ISandbox | null }> => {
    const ticket = this.deps.host.getTicketById(ticketId);
    if (!ticket) {
      throw new Error(`Ticket not found: ${ticketId}`);
    }

    const project = this.deps.store.getProjects().find((p) => p.id === ticket.projectId);
    if (!project) {
      throw new Error(`Project not found: ${ticket.projectId}`);
    }

    // Idempotent: if machine already exists with a running sandbox, ensure session and return
    const existing = this.machines.get(ticketId);
    if (existing) {
      const sbStatus = existing.sandbox?.getStatus();
      // Machine is using a Code tab sandbox (sandbox === null) — check if still viable
      const isRunning = existing.sandbox ? sbStatus?.type === 'running' : this.getCodeTabWsUrl(ticketId) !== null;

      if (isRunning) {
        const phase = existing.machine.getPhase();

        // Already streaming — don't interfere
        if (existing.machine.isStreaming()) {
          console.log(
            `[SupervisorOrchestrator] ensureSupervisorInfra: machine ${ticketId} already streaming (${phase}), returning.`
          );
          return existing;
        }

        // Machine has a session and is ready — reuse as-is
        if (phase === 'ready' && existing.machine.getSessionId()) {
          console.log(
            `[SupervisorOrchestrator] ensureSupervisorInfra: machine ${ticketId} already ready with session, returning.`
          );
          return existing;
        }

        // Machine is in a non-streaming state without a session — re-provision
        const wsUrl =
          existing.sandbox && sbStatus?.type === 'running' ? sbStatus.data.wsUrl! : this.getCodeTabWsUrl(ticketId)!;
        console.log(
          `[SupervisorOrchestrator] ensureSupervisorInfra: re-provisioning ${ticketId} from phase "${phase}".`
        );
        existing.machine.forcePhase('provisioning' as TicketPhase);
        existing.machine.setWsUrl(wsUrl);
        await this.ensureSession(ticketId);
        return existing;
      }
      // Existing sandbox not running — clean up stale machine and create fresh
      console.log(
        `[SupervisorOrchestrator] ensureSupervisorInfra: stale machine for ${ticketId} (sandbox status: ${sbStatus?.type ?? 'unknown'}, phase: ${existing.machine.getPhase()}). Cleaning up.`
      );
      await existing.machine.dispose();
      this.machines.delete(ticketId);
    }

    // Check if a Code tab already has a running sandbox for this ticket.
    // If so, reuse it instead of spinning up a second container.
    const codeTabWsUrl = this.getCodeTabWsUrl(ticketId);
    if (codeTabWsUrl) {
      console.log(
        `[SupervisorOrchestrator] ensureSupervisorInfra: reusing Code tab sandbox for ${ticketId} (ws: ${codeTabWsUrl})`
      );
      const machine = this.createMachine(ticketId);
      machine.transition('provisioning' as TicketPhase);

      // We don't own the sandbox — the Code tab's ProcessManager entry owns the lifecycle.
      this.machines.set(ticketId, { machine, sandbox: null });

      machine.setWsUrl(codeTabWsUrl);
      await this.ensureSession(ticketId);

      return { machine, sandbox: null };
    }

    // No Code tab sandbox available — create a dedicated supervisor sandbox.
    const machine = this.createMachine(ticketId);
    machine.transition('provisioning' as TicketPhase);

    // Deferred: resolves when sandbox becomes 'running'
    let resolveReady!: (wsUrl: string) => void;
    let rejectReady!: (err: Error) => void;
    const sandboxReady = new Promise<string>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const startTimeout = setTimeout(() => {
      rejectReady(new Error('Sandbox start timeout (120s)'));
    }, 120_000);

    const resolvedWorkspace = await this.resolveTicketWorkspace(ticketId);
    const workspaceDir = resolvedWorkspace.workspaceDir;
    const taskId = nanoid();
    const { worktreePath, worktreeName, action } = resolvedWorkspace;

    // Run after_create hook only when a new worktree was created (not on reuse)
    if (action === 'create') {
      const afterCreateOk = await this.deps.workflowLoader.runHook(ticket.projectId, 'after_create', workspaceDir);
      if (!afterCreateOk) {
        clearTimeout(startTimeout);
        if (worktreePath && worktreeName) {
          await removeWorktree(requireLocalWorkspaceDir(project.source), worktreePath, worktreeName);
        }
        machine.transition('error' as TicketPhase);
        throw new Error('after_create hook failed');
      }
    }

    const task: Task = {
      id: taskId,
      projectId: ticket.projectId,
      taskDescription: `Supervisor for: ${ticket.title}`,
      status: { type: 'starting', timestamp: Date.now() },
      createdAt: Date.now(),
      ticketId,
      branch: this.deps.host.resolveTicketBranch(ticket),
      worktreePath,
      worktreeName,
    };

    const sandboxBackend = this.deps.store.getSandboxBackend();
    const platformClient = createPlatformClient(this.deps.store.getPlatformCredentials());
    const mode: AgentProcessMode =
      sandboxBackend === 'platform'
        ? 'platform'
        : sandboxBackend === 'docker'
          ? 'sandbox'
          : sandboxBackend === 'podman'
            ? 'podman'
            : sandboxBackend === 'vm'
              ? 'vm'
              : sandboxBackend === 'local'
                ? 'local'
                : 'none';
    const sandbox = this.deps.sandboxFactory.create({
      mode,
      platformClient: platformClient ?? undefined,
      ipcRawOutput: () => {},
      onStatusChange: (status) => {
        const taskEntry = this.tasks.get(taskId);
        if (taskEntry) {
          const patch: Partial<Task> = { status };
          if (status.type === 'running') {
            patch.lastUrls = {
              uiUrl: status.data.uiUrl,
              codeServerUrl: status.data.codeServerUrl,
              noVncUrl: status.data.noVncUrl,
            };
          }
          taskEntry.task = { ...taskEntry.task, ...patch };
          this.persistTask(taskEntry.task);
        }
        this.deps.sendToWindow('project:task-status', taskId, status);

        // Forward to linked Code tab so the UI connects to the supervisor's sandbox
        // instead of launching a separate one.
        const codeTabs = this.deps.store.getCodeTabs();
        const codeTab = codeTabs.find((t) => t.ticketId === ticketId);
        if (codeTab) {
          this.deps.sendToWindow('agent-process:status', codeTab.id as CodeTabId, status);
        }

        // Resolve/reject the startup promise (only effective on first call)
        if (status.type === 'running') {
          resolveReady(status.data.wsUrl!);
        } else if (status.type === 'error') {
          rejectReady(new Error('Sandbox failed to start'));
        }
      },
    });

    this.tasks.set(taskId, { task, sandbox });
    this.persistTask(task);
    this.deps.host.updateTicket(ticketId, { supervisorTaskId: taskId });

    this.machines.set(ticketId, { machine, sandbox });

    sandbox.start({
      workspaceDir,
      sandboxVariant: 'work',
      sandboxConfig: project.sandbox,
      gitRepo: resolvedWorkspace.gitRepo,
    });

    // Await sandbox readiness
    let wsUrl: string;
    try {
      wsUrl = await sandboxReady;
    } catch (error) {
      clearTimeout(startTimeout);
      machine.transition('error' as TicketPhase);
      throw error;
    }
    clearTimeout(startTimeout);

    // Set WS URL and ensure session
    machine.setWsUrl(wsUrl);
    await this.ensureSession(ticketId);

    return { machine, sandbox };
  };

  // -------------------------------------------------------------------------
  // Lifecycle entry points (C2c.5)
  // -------------------------------------------------------------------------

  /**
   * Send a start_run RPC to the machine. Stamps the wall-clock start time so
   * the eventual TicketRun record reflects the real run start, not whichever
   * `updateTicket` call most recently bumped `updatedAt`.
   */
  startMachineRun = (
    ticketId: TicketId,
    prompt: string,
    opts?: { sessionId?: string; variables?: Record<string, unknown> }
  ): void => {
    const entry = this.machines.get(ticketId);
    if (!entry) {
      console.warn(`[SupervisorOrchestrator] startMachineRun: no machine entry for ${ticketId}`);
      return;
    }

    this.runStartedAt.set(ticketId, Date.now());

    console.log(
      `[SupervisorOrchestrator] startMachineRun: starting run for ${ticketId} (phase: ${entry.machine.getPhase()})`
    );
    void entry.machine.startRun(prompt, { sessionId: opts?.sessionId, variables: opts?.variables }).then(
      (result) => {
        this.deps.host.updateTicket(ticketId, { supervisorSessionId: result.sessionId });
      },
      (error) => {
        console.error(`[SupervisorOrchestrator] Machine start failed for ${ticketId}:`, error);
        if (entry.machine.isActive() && entry.machine.getPhase() !== 'error') {
          entry.machine.transition('error');
        }
      }
    );
  };

  /**
   * IPC entry point: ensure supervisor infrastructure exists for a ticket.
   * Wraps `ensureSupervisorInfra` in the per-ticket lock so concurrent IPC
   * calls don't race against the lifecycle methods.
   */
  ensureSupervisorInfraLocked = (ticketId: TicketId): Promise<void> => {
    return this.withTicketLock(ticketId, async () => {
      await this.ensureSupervisorInfra(ticketId);
    });
  };

  /**
   * IPC entry point: resolve (or create) the on-disk workspace directory
   * for a ticket. Wraps `resolveTicketWorkspace` in the per-ticket lock.
   */
  getTicketWorkspaceLocked = (ticketId: TicketId): Promise<string> => {
    return this.withTicketLock(ticketId, async () => {
      const resolved = await this.resolveTicketWorkspace(ticketId);
      return resolved.workspaceDir;
    });
  };

  /**
   * Start the autonomous supervisor — sends the full supervisor prompt as the user turn.
   * Triggered by the Play button.
   */
  startSupervisor = (ticketId: TicketId): Promise<void> => {
    return this.withTicketLock(ticketId, async () => {
      const preflightError = this.validateDispatchPreflight(ticketId);
      if (preflightError) {
        console.warn(`[SupervisorOrchestrator] Dispatch preflight failed for ${ticketId}: ${preflightError}`);
        throw new Error(preflightError);
      }

      const ticket = this.deps.host.getTicketById(ticketId)!;
      const project = this.deps.store.getProjects().find((p) => p.id === ticket.projectId)!;

      // Load FLEET.md workflow (from local dir or git remote)
      if (project.source?.kind === 'local') {
        await this.deps.workflowLoader.load(ticket.projectId, project.source.workspaceDir);

        const hookOk = await this.deps.workflowLoader.runHook(
          ticket.projectId,
          'before_run',
          project.source.workspaceDir
        );
        if (!hookOk) {
          console.warn(`[SupervisorOrchestrator] before_run hook failed for ${ticketId}. Aborting start.`);
          throw new Error('before_run hook failed');
        }
      } else if (project.source?.kind === 'git-remote') {
        const effectiveBranch = this.deps.host.resolveTicketBranch(ticket) ?? project.source.defaultBranch;
        await this.deps.workflowLoader.loadFromRemote(ticket.projectId, project.source.repoUrl, effectiveBranch);
      }

      console.log(`[SupervisorOrchestrator] startSupervisor: ensureSupervisorInfra for ${ticketId}...`);
      const { machine, sandbox } = await this.ensureSupervisorInfra(ticketId);
      console.log(
        `[SupervisorOrchestrator] startSupervisor: ensureSupervisorInfra done. Phase: ${machine.getPhase()}, sessionId: ${machine.getSessionId()}`
      );

      // For git-remote projects, run before_run hook inside the container via sandbox exec
      if (project.source?.kind === 'git-remote') {
        const hookScript = this.deps.workflowLoader.getConfig(ticket.projectId).hooks?.before_run;
        if (hookScript && sandbox) {
          const hookOk = await sandbox.execInContainer(hookScript, '/home/user/workspace');
          if (!hookOk) {
            console.warn(
              `[SupervisorOrchestrator] before_run hook failed in container for ${ticketId}. Aborting start.`
            );
            throw new Error('before_run hook failed');
          }
        }
      }

      const sessionId = machine.getSessionId() ?? undefined;
      const variables = this.buildRunVariables(ticketId);
      console.log(
        `[SupervisorOrchestrator] startSupervisor: calling startMachineRun for ${ticketId} (sessionId: ${sessionId})`
      );
      this.startMachineRun(ticketId, 'Begin working on this ticket.', { sessionId, variables });
    });
  };

  stopSupervisor = (ticketId: TicketId): Promise<void> => {
    return this.withTicketLock(ticketId, async () => {
      const entry = this.machines.get(ticketId);
      if (!entry) {
        return;
      }
      await entry.machine.stop();
    });
  };

  /**
   * Clean up a ticket's workspace: stop and remove its container, delete its
   * worktree, and run the before_remove hook. Called when a ticket reaches a
   * terminal column.
   *
   * If the worktree has uncommitted changes, cleanup is deferred — the ticket
   * is marked `cleanupPending` and the worktree + sandbox stay alive so the
   * user or agent can commit/discard. Call `finalizeTicketCleanup` once the
   * worktree is clean to finish the teardown.
   */
  cleanupTicketWorkspace = async (ticketId: TicketId): Promise<void> => {
    const ticket = this.deps.host.getTicketById(ticketId);
    if (!ticket) {
      return;
    }

    const project = this.deps.store.getProjects().find((p) => p.id === ticket.projectId);

    // Defer cleanup when the worktree has unsaved work. The sandbox + supervisor
    // stay alive so the user or agent can drive the worktree to a clean state.
    if (ticket.worktreePath && project?.source?.kind === 'local') {
      const dirty = await isWorktreeDirty(ticket.worktreePath);
      if (dirty) {
        console.log(
          `[SupervisorOrchestrator] Worktree for ticket ${ticketId} has uncommitted changes — deferring cleanup.`
        );
        if (!ticket.cleanupPending) {
          this.deps.host.updateTicket(ticketId, { cleanupPending: true });
        }
        return;
      }
    }

    const taskId = ticket.supervisorTaskId;

    // Run before_remove hook
    if (project?.source?.kind === 'local') {
      const workspaceDir = ticket.worktreePath ?? project.source.workspaceDir;
      await this.deps.workflowLoader.runHook(ticket.projectId, 'before_remove', workspaceDir);
    } else if (project?.source?.kind === 'git-remote') {
      const hookScript = this.deps.workflowLoader.getConfig(ticket.projectId).hooks?.before_remove;
      if (hookScript) {
        const machineEntry = this.machines.get(ticketId);
        if (machineEntry?.sandbox) {
          await machineEntry.sandbox.execInContainer(hookScript, '/home/user/workspace');
        }
      }
    }

    // Dispose machine if still registered
    const machineEntry = this.machines.get(ticketId);
    if (machineEntry) {
      await machineEntry.machine.dispose();
      this.machines.delete(ticketId);
    }

    // Stop and exit the container
    if (taskId) {
      const taskEntry = this.tasks.get(taskId);
      if (taskEntry) {
        await taskEntry.sandbox.exit();
      }
      this.tasks.delete(taskId);
      this.removePersistedTask(taskId);
    }

    // Remove worktree (source of truth is the ticket, not the task)
    if (ticket.worktreePath && ticket.worktreeName && project && project.source?.kind === 'local') {
      await removeWorktree(requireLocalWorkspaceDir(project.source), ticket.worktreePath, ticket.worktreeName);
      this.deps.host.updateTicket(ticketId, {
        worktreePath: undefined,
        worktreeName: undefined,
        cleanupPending: undefined,
      });
    } else if (ticket.cleanupPending) {
      this.deps.host.updateTicket(ticketId, { cleanupPending: undefined });
    }

    console.log(`[SupervisorOrchestrator] Cleaned up workspace for ticket ${ticketId}.`);
  };

  /**
   * Retry deferred cleanup for a ticket whose worktree was dirty when it was
   * first resolved. Re-checks dirtiness; if still dirty, returns false and
   * leaves `cleanupPending` set. Otherwise runs full teardown and returns true.
   */
  finalizeTicketCleanup = async (ticketId: TicketId): Promise<boolean> => {
    return this.withTicketLock(ticketId, async () => {
      const ticket = this.deps.host.getTicketById(ticketId);
      if (!ticket) {
        return false;
      }
      await this.cleanupTicketWorkspace(ticketId);
      const after = this.deps.host.getTicketById(ticketId);
      return !after?.cleanupPending;
    });
  };

  resetSupervisorSession = (ticketId: TicketId): Promise<void> => {
    return this.withTicketLock(ticketId, async () => {
      const entry = this.machines.get(ticketId);
      if (!entry) {
        return;
      }

      await entry.machine.stop();

      // Build fresh variables (includes FLEET.md custom prompt + client tools)
      const variables = this.buildRunVariables(ticketId, 'interactive');

      // Ensure WS URL is set
      if (entry.sandbox) {
        const sbStatus = entry.sandbox.getStatus();
        if (sbStatus?.type === 'running' && sbStatus.data.wsUrl) {
          entry.machine.setWsUrl(sbStatus.data.wsUrl);
        }
      } else {
        const wsUrl = this.getCodeTabWsUrl(ticketId);
        if (wsUrl) {
          entry.machine.setWsUrl(wsUrl);
        }
      }

      // Create a new session, then update the ticket so the renderer
      // only switches to the new session URL after it actually exists.
      const newSessionId = randomUUID();
      await entry.machine.createSession(variables, newSessionId);
      this.deps.host.updateTicket(ticketId, { supervisorSessionId: newSessionId });
    });
  };

  sendSupervisorMessage = (ticketId: TicketId, message: string): Promise<void> => {
    return this.withTicketLock(ticketId, async () => {
      const entry = this.machines.get(ticketId);
      if (!entry) {
        // No active machine — check concurrency before spinning up
        const ticket = this.deps.host.getTicketById(ticketId);
        if (!ticket) {
          throw new Error(`Ticket not found: ${ticketId}`);
        }
        if (!this.canStartSupervisor(ticket.projectId, ticket.columnId)) {
          throw new Error('Concurrency limit reached');
        }

        await this.ensureSupervisorInfra(ticketId);
        await this.sendUserRunMessage(ticketId, message);
        return;
      }

      const phase = entry.machine.getPhase();

      if (phase === 'idle' || phase === 'error' || phase === 'ready' || phase === 'awaiting_input') {
        await this.sendUserRunMessage(ticketId, message);
      } else if (entry.machine.isStreaming()) {
        try {
          await entry.machine.sendMessage(message);
        } catch (error) {
          console.error(`[SupervisorOrchestrator] Machine send_user_message failed for ${ticketId}:`, error);
        }
      }
    });
  };

  /** Start a run with the user's message as the prompt. */
  private sendUserRunMessage = async (ticketId: TicketId, message: string): Promise<void> => {
    const entry = this.machines.get(ticketId);
    if (!entry) {
      return;
    }

    if (entry.sandbox) {
      const sbStatus = entry.sandbox.getStatus();
      if (sbStatus?.type === 'running' && sbStatus.data.wsUrl) {
        entry.machine.setWsUrl(sbStatus.data.wsUrl);
      }
    } else {
      const wsUrl = this.getCodeTabWsUrl(ticketId);
      if (wsUrl) {
        entry.machine.setWsUrl(wsUrl);
      }
    }

    const sessionId = entry.machine.getSessionId() ?? undefined;

    const ticket = this.deps.host.getTicketById(ticketId);
    const variables = ticket ? this.buildRunVariables(ticketId, 'interactive') : undefined;

    try {
      const result = await entry.machine.startRun(message, { sessionId, variables });
      this.deps.host.updateTicket(ticketId, { supervisorSessionId: result.sessionId });
    } catch (error) {
      console.error(`[SupervisorOrchestrator] Machine message failed for ${ticketId}:`, error);
    }
  };

  // -------------------------------------------------------------------------
  // Boot / shutdown (C2c.6)
  // -------------------------------------------------------------------------

  /**
   * Boot-time recovery: mark stranded persisted tasks as `exited`, reset
   * stale ticket phases, and sweep stale workspaces for tickets that are
   * already in a terminal column. Called once from `createProjectManager`.
   */
  restorePersistedTasks = (): void => {
    const tasks = this.deps.store.getPersistedTasks();
    const updated: Task[] = [];
    for (const task of tasks) {
      if (task.status.type !== 'exited' && task.status.type !== 'error') {
        updated.push({ ...task, status: { type: 'exited', timestamp: Date.now() } });
      } else {
        updated.push(task);
      }
    }
    this.deps.store.setPersistedTasks(updated);

    // Reset stale supervisor states on tickets
    this.resetStaleTicketStates();

    // Startup sweep: clean up stale workspaces for tickets already in terminal columns
    void this.startupTerminalCleanup();
  };

  /**
   * Startup sweep: find persisted tasks whose tickets are in terminal
   * columns (or whose tickets no longer exist) and clean up their worktrees.
   * Prevents stale workspaces from accumulating across restarts.
   */
  private startupTerminalCleanup = async (): Promise<void> => {
    const tickets = this.deps.store.getTickets();
    let cleaned = 0;

    for (const ticket of tickets) {
      if (!this.deps.host.isTerminalColumn(ticket.projectId, ticket.columnId)) {
        continue;
      }

      // Clean up worktree from the ticket
      if (ticket.worktreePath && ticket.worktreeName) {
        const project = this.deps.store.getProjects().find((p) => p.id === ticket.projectId);
        if (project?.source?.kind === 'local') {
          await removeWorktree(requireLocalWorkspaceDir(project.source), ticket.worktreePath, ticket.worktreeName);
        }
        this.deps.host.updateTicket(ticket.id, { worktreePath: undefined, worktreeName: undefined });
        cleaned++;
      }

      // Clean up orphaned task record
      if (ticket.supervisorTaskId) {
        this.removePersistedTask(ticket.supervisorTaskId);
      }
    }

    // Also clean up orphaned tasks with no matching ticket
    const persisted = this.deps.store.getPersistedTasks();
    const ticketIds = new Set(tickets.map((t) => t.id));
    for (const task of persisted) {
      if (task.ticketId && !ticketIds.has(task.ticketId)) {
        if (task.worktreePath && task.worktreeName) {
          const project = this.deps.store.getProjects().find((p) => p.id === task.projectId);
          if (project?.source?.kind === 'local') {
            await removeWorktree(requireLocalWorkspaceDir(project.source), task.worktreePath, task.worktreeName);
          }
        }
        this.removePersistedTask(task.id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(
        `[SupervisorOrchestrator] Startup cleanup: removed ${cleaned} stale workspace(s) for terminal tickets.`
      );
    }
  };

  /**
   * Reset every non-`idle`, non-`completed` ticket phase to `idle` on boot.
   * Error states from a previous session are stale because in-memory retry
   * counters are gone — leaving them surfaced would confuse the user. Only
   * `completed` persists because the work is genuinely done. (Pinned by
   * tests so a future change to this rule must update both.)
   */
  private resetStaleTicketStates = (): void => {
    const tickets = this.deps.store.getTickets();
    let dirty = false;
    const patched = tickets.map((ticket) => {
      if (ticket.phase && ticket.phase !== 'idle' && ticket.phase !== 'completed') {
        dirty = true;
        return { ...ticket, phase: 'idle' as const };
      }
      return ticket;
    });

    if (dirty) {
      this.deps.store.setTickets(patched);
    }
  };

  /**
   * Tear down every in-memory task for a project: exit each sandbox, drop
   * the in-memory entries, then clear matching persisted tasks. Called by
   * `ProjectManager.removeProject`.
   */
  removeAllTasksForProject = async (projectId: ProjectId): Promise<void> => {
    for (const [taskId, entry] of this.tasks) {
      if (entry.task.projectId === projectId) {
        await entry.sandbox.exit();
        this.tasks.delete(taskId);
      }
    }
    const remaining = this.deps.store.getPersistedTasks().filter((t) => t.projectId !== projectId);
    this.deps.store.setPersistedTasks(remaining);
  };

  /** Exit every in-memory sandbox and clear the map. Called from PM.exit(). */
  exitAllTasks = async (): Promise<void> => {
    const exits = [...this.tasks.values()].map((entry) => entry.sandbox.exit());
    await Promise.allSettled(exits);
    this.tasks.clear();
  };

  // -------------------------------------------------------------------------
  // Dispatch preflight + auto-dispatch loop (C2c.7)
  // -------------------------------------------------------------------------

  /** Number of supervisors currently active across all projects. */
  private getRunningSupervisorCount(): number {
    let count = 0;
    for (const [, entry] of this.machines) {
      if (entry.machine.isActive()) {
        count++;
      }
    }
    return count;
  }

  /** Active supervisors in a specific column for a project. */
  private getRunningSupervisorCountByColumn(projectId: ProjectId, columnId: ColumnId): number {
    let count = 0;
    for (const [ticketId, entry] of this.machines) {
      if (!entry.machine.isActive()) {
        continue;
      }
      const ticket = this.deps.host.getTicketById(ticketId);
      if (ticket && ticket.projectId === projectId && ticket.columnId === columnId) {
        count++;
      }
    }
    return count;
  }

  /**
   * Dispatch preflight: validate that we can start a supervisor for this
   * ticket. Returns an error string if validation fails, or null if OK.
   */
  validateDispatchPreflight(ticketId: TicketId): string | null {
    const ticket = this.deps.host.getTicketById(ticketId);
    if (!ticket) {
      return `Ticket not found: ${ticketId}`;
    }

    const project = this.deps.store.getProjects().find((p) => p.id === ticket.projectId);
    if (!project) {
      return `Project not found: ${ticket.projectId}`;
    }

    // Personal / context-only projects have no source and cannot run supervisors:
    // there's no workspace to mount and no workflow to execute. Reject explicitly
    // so the user sees a clear message instead of a downstream mount failure.
    if (!project.source) {
      return `Project "${project.label}" has no repository — supervisors require a workspace or git remote`;
    }
    if (project.source.kind === 'local' && !project.source.workspaceDir) {
      return `Project "${project.label}" has no workspace directory configured`;
    }
    if (project.source.kind === 'git-remote' && !project.source.repoUrl) {
      return `Project "${project.label}" has no repository URL configured`;
    }

    if (this.deps.host.isTerminalColumn(ticket.projectId, ticket.columnId)) {
      return `Ticket is in terminal column "${ticket.columnId}" — cannot start supervisor`;
    }

    // Check machine to prevent duplicate dispatch — allow starting from 'ready' (manual session)
    const machineEntry = this.machines.get(ticketId);
    if (machineEntry) {
      const phase = machineEntry.machine.getPhase();
      if (phase !== 'idle' && phase !== 'ready' && phase !== 'error' && phase !== 'completed') {
        return `Ticket ${ticketId} is already active (phase: ${phase})`;
      }
    }

    if (!this.canStartSupervisor(ticket.projectId, ticket.columnId)) {
      const columnLimit = this.getColumnMaxConcurrent(ticket.projectId, ticket.columnId);
      if (columnLimit !== undefined) {
        const columnCount = this.getRunningSupervisorCountByColumn(ticket.projectId, ticket.columnId);
        if (columnCount >= columnLimit) {
          return `Per-column concurrency limit reached for "${ticket.columnId}" (${columnCount}/${columnLimit})`;
        }
      }
      return `Concurrency limit reached (${MAX_CONCURRENT_SUPERVISORS} supervisors running). Stop another supervisor first.`;
    }

    // WIP limit check (cognitive limit, cross-project)
    const wipLimit = this.deps.store.getWipLimit();
    const activeWip = this.getActiveWipTickets();
    // Don't count the ticket itself if it's already active (e.g. retrying)
    const wipCount = activeWip.filter((t) => t.id !== ticketId).length;
    if (wipCount >= wipLimit) {
      return `WIP_LIMIT:${wipLimit}`;
    }

    return null;
  }

  /** Set auto-dispatch on/off for a project. Persists the setting on the project. */
  setAutoDispatch = (projectId: ProjectId, enabled: boolean): void => {
    this.deps.host.updateProject(projectId, { autoDispatch: enabled });
    if (enabled) {
      // Fire an immediate tick when enabling
      void this.autoDispatchTick();
    }
  };

  /** Start the auto-dispatch poll. Idempotent. */
  startAutoDispatch = (): void => {
    if (this.autoDispatchTimer) {
      return;
    }
    this.autoDispatchTimer = setInterval(() => this.autoDispatchTick(), AUTO_DISPATCH_INTERVAL_MS);
  };

  /** Stop the auto-dispatch poll. Idempotent. */
  stopAutoDispatch = (): void => {
    if (this.autoDispatchTimer) {
      clearInterval(this.autoDispatchTimer);
      this.autoDispatchTimer = null;
    }
  };

  /**
   * One auto-dispatch tick: for each project with auto-dispatch enabled,
   * find the next eligible ticket and start its supervisor.
   */
  autoDispatchTick = async (): Promise<void> => {
    const projects = this.deps.store.getProjects();

    for (const project of projects) {
      if (!this.isAutoDispatchEnabled(project.id)) {
        continue;
      }

      // Check if we have global capacity
      if (this.getRunningSupervisorCount() >= MAX_CONCURRENT_SUPERVISORS) {
        break;
      }

      // Find the next eligible ticket (priority-sorted, not blocked, in backlog)
      const nextTicket = this.deps.host.getNextTicket(project.id);
      if (!nextTicket) {
        continue;
      }

      // Skip if already active
      const machineEntry = this.machines.get(nextTicket.id);
      if (machineEntry && machineEntry.machine.isActive()) {
        continue;
      }

      // Check global + per-column WIP limits
      if (!this.canStartSupervisor(project.id, nextTicket.columnId)) {
        continue;
      }

      // Move from first column to second column (first active column) to start work
      const pipeline = this.deps.host.getPipeline(project.id);
      const firstColumnId = pipeline.columns[0]?.id;
      const terminalColumnId = pipeline.columns[pipeline.columns.length - 1]?.id;
      const firstActiveColumn = pipeline.columns.find((c) => c.id !== firstColumnId && c.id !== terminalColumnId);
      const originalColumnId = nextTicket.columnId;
      if (firstActiveColumn) {
        this.deps.host.moveTicketToColumn(nextTicket.id, firstActiveColumn.id);
      }

      try {
        console.log(
          `[SupervisorOrchestrator] Auto-dispatching ticket ${nextTicket.id} ("${nextTicket.title}") for project ${project.label}`
        );
        await this.startSupervisor(nextTicket.id);
      } catch (error) {
        // Revert the column move so the ticket is re-picked on the next tick
        // instead of being stranded in column 2 with no running supervisor.
        if (firstActiveColumn && originalColumnId !== firstActiveColumn.id) {
          this.deps.host.moveTicketToColumn(nextTicket.id, originalColumnId);
        }
        console.warn(`[SupervisorOrchestrator] Auto-dispatch failed for ${nextTicket.id}:`, (error as Error).message);
      }
    }
  };

  // -------------------------------------------------------------------------
  // Tool dispatch + supervisor prompt assembly (C2c.8)
  // -------------------------------------------------------------------------

  /**
   * Handle a client tool call from the agent. The agent calls tools like
   * get_ticket / move_ticket / escalate via the existing WebSocket RPC
   * (client_request with function="tool.call") instead of a separate MCP server.
   */
  handleClientToolCall(
    ticketId: TicketId,
    functionName: string,
    args: Record<string, unknown>,
    respond: ClientFunctionResponder
  ): void {
    console.log(
      `[SupervisorOrchestrator] handleClientToolCall: ticketId=${ticketId}, function=${functionName}, args=${JSON.stringify(args)}`
    );

    if (functionName !== 'tool.call') {
      // Not a tool call — ignore (other client_request functions handled elsewhere)
      return;
    }

    const toolName = args.tool as string | undefined;
    const toolArgs = (args.arguments ?? {}) as Record<string, unknown>;

    if (!toolName) {
      respond(false, { error: { message: 'Missing tool name' } });
      return;
    }

    const ticket = this.deps.host.getTicketById(ticketId);
    if (!ticket) {
      respond(false, { error: { message: 'Ticket not found' } });
      return;
    }

    const pipeline = this.deps.host.getPipeline(ticket.projectId);

    switch (toolName) {
      case 'get_ticket': {
        const lookupId = (toolArgs.ticket_id as string) || ticketId;
        const target = this.deps.host.getTicketById(lookupId);
        if (!target) {
          respond(false, { error: { message: `Ticket not found: ${lookupId}` } });
          return;
        }
        const targetPipeline = this.deps.host.getPipeline(target.projectId);
        const column = targetPipeline.columns.find((c) => c.id === target.columnId);
        const comments = (target.comments ?? []).map((c) => ({
          id: c.id,
          author: c.author,
          content: c.content,
          created_at: new Date(c.createdAt).toISOString(),
        }));
        const runs = (target.runs ?? []).map((r) => ({
          id: r.id,
          started_at: new Date(r.startedAt).toISOString(),
          ended_at: new Date(r.endedAt).toISOString(),
          end_reason: r.endReason,
          token_usage: r.tokenUsage ?? null,
        }));
        respond(true, {
          id: target.id,
          title: target.title,
          description: target.description || '',
          priority: target.priority,
          column: column?.label ?? target.columnId,
          pipeline: targetPipeline.columns.map((c) => c.label),
          blocked_by: target.blockedBy ?? [],
          branch: target.branch || null,
          use_worktree: target.useWorktree ?? false,
          worktree_path: target.worktreePath || null,
          phase: target.phase ?? null,
          run_count: runs.length,
          created_at: new Date(target.createdAt).toISOString(),
          updated_at: new Date(target.updatedAt).toISOString(),
          comments,
          runs,
        });
        break;
      }
      case 'move_ticket': {
        const columnLabel = (toolArgs.column as string) ?? '';
        const col = pipeline.columns.find((c) => c.label.toLowerCase() === columnLabel.toLowerCase());
        if (!col) {
          const valid = pipeline.columns.map((c) => c.label).join(', ');
          respond(false, { error: { message: `Unknown column: "${columnLabel}". Valid columns: ${valid}` } });
          return;
        }
        this.deps.host.moveTicketToColumn(ticketId, col.id);
        respond(true, { ok: true, column: col.label });
        break;
      }
      case 'escalate': {
        const message = (toolArgs.message as string) ?? '';
        if (!message) {
          respond(false, { error: { message: 'Empty escalation message' } });
          return;
        }
        this.deps.sendToWindow('toast:show', {
          level: 'warning',
          title: `Agent needs help: ${ticket.title}`,
          description: message,
        });
        const entry = this.machines.get(ticketId);
        if (entry?.machine.isStreaming()) {
          void entry.machine.stop().then(() => {
            entry.machine.forcePhase('awaiting_input');
            respond(true, { ok: true, message: 'Escalated to human operator' });
          });
        } else {
          respond(true, { ok: true, message: 'Escalated to human operator' });
        }
        break;
      }
      case 'notify': {
        const notifyMessage = (toolArgs.message as string) ?? '';
        if (!notifyMessage) {
          respond(false, { error: { message: 'Empty notification message' } });
          return;
        }
        this.deps.sendToWindow('toast:show', {
          level: 'info',
          title: `Agent note: ${ticket.title}`,
          description: notifyMessage,
        });
        respond(true, { ok: true, message: 'Notification sent' });
        break;
      }
      case 'add_ticket_comment': {
        const commentTicketId = (toolArgs.ticket_id as string) || ticketId;
        const content = (toolArgs.content as string) ?? '';
        if (!content) {
          respond(false, { error: { message: 'Missing content' } });
          return;
        }
        const commentTarget = this.deps.host.getTicketById(commentTicketId);
        if (!commentTarget) {
          respond(false, { error: { message: `Ticket not found: ${commentTicketId}` } });
          return;
        }
        const comment = { id: nanoid(), author: 'agent' as const, content, createdAt: Date.now() };
        const existingComments = commentTarget.comments ?? [];
        this.deps.host.updateTicket(commentTicketId, { comments: [...existingComments, comment] });
        respond(true, { ok: true, comment_id: comment.id });
        break;
      }
      // --- Read-only context tools (available to all sessions including autopilot) ---
      case 'get_ticket_comments': {
        const commentsTicketId = (toolArgs.ticket_id as string) ?? '';
        if (!commentsTicketId) {
          respond(false, { error: { message: 'Missing ticket_id' } });
          return;
        }
        const commentsTarget = this.deps.host.getTicketById(commentsTicketId);
        if (!commentsTarget) {
          respond(false, { error: { message: `Ticket not found: ${commentsTicketId}` } });
          return;
        }
        respond(true, {
          comments: (commentsTarget.comments ?? []).map((c) => ({
            id: c.id,
            author: c.author,
            content: c.content,
            created_at: new Date(c.createdAt).toISOString(),
          })),
        });
        break;
      }
      // --- Project-scoped tools (available in interactive sessions) ---
      case 'list_projects': {
        const projects = this.deps.store.getProjects().map((p) => {
          const pl = this.deps.host.getPipeline(p.id);
          return {
            id: p.id,
            label: p.label,
            workspaceDir: getLocalWorkspaceDir(p.source),
            columns: pl.columns.map((c) => c.label),
          };
        });
        respond(true, { projects });
        break;
      }
      case 'list_tickets': {
        const projectId = (toolArgs.project_id as string) ?? '';
        if (!projectId) {
          respond(false, { error: { message: 'Missing project_id' } });
          return;
        }
        const pl = this.deps.host.getPipeline(projectId);
        let tickets = this.deps.host.getTicketsByProject(projectId);
        const columnFilter = toolArgs.column as string | undefined;
        if (columnFilter) {
          const col = pl.columns.find((c) => c.label.toLowerCase() === columnFilter.toLowerCase());
          if (col) {
            tickets = tickets.filter((t) => t.columnId === col.id);
          }
        }
        const priorityFilter = toolArgs.priority as string | undefined;
        if (priorityFilter) {
          tickets = tickets.filter((t) => t.priority === priorityFilter);
        }
        const result = tickets.map((t) => ({
          id: t.id,
          title: t.title,
          description: t.description || '',
          priority: t.priority,
          column: pl.columns.find((c) => c.id === t.columnId)?.label ?? t.columnId,
          phase: t.phase,
          blocked_by: t.blockedBy ?? [],
          created_at: new Date(t.createdAt).toISOString(),
          updated_at: new Date(t.updatedAt).toISOString(),
        }));
        respond(true, { tickets: result });
        break;
      }
      case 'create_ticket': {
        const projectId = (toolArgs.project_id as string) ?? '';
        const title = (toolArgs.title as string) ?? '';
        if (!projectId || !title) {
          respond(false, { error: { message: 'Missing project_id or title' } });
          return;
        }
        const proj = this.deps.store.getProjects().find((p) => p.id === projectId);
        if (!proj) {
          respond(false, { error: { message: `Project not found: ${projectId}` } });
          return;
        }
        const newTicket = this.deps.host.addTicket({
          projectId,
          milestoneId: (toolArgs.milestone_id as string) || undefined,
          title,
          description: (toolArgs.description as string) ?? '',
          priority: (toolArgs.priority as TicketPriority) ?? 'medium',
          blockedBy: [],
        });
        respond(true, {
          id: newTicket.id,
          title: newTicket.title,
          column: this.deps.host.getPipeline(projectId).columns[0]?.label,
        });
        break;
      }
      case 'update_ticket': {
        const targetId = (toolArgs.ticket_id as string) ?? '';
        if (!targetId) {
          respond(false, { error: { message: 'Missing ticket_id' } });
          return;
        }
        const target = this.deps.host.getTicketById(targetId);
        if (!target) {
          respond(false, { error: { message: `Ticket not found: ${targetId}` } });
          return;
        }
        const patch: Record<string, unknown> = {};
        if (toolArgs.title) {
          patch.title = toolArgs.title;
        }
        if (toolArgs.description !== undefined) {
          patch.description = toolArgs.description;
        }
        if (toolArgs.priority) {
          patch.priority = toolArgs.priority;
        }
        if (toolArgs.branch !== undefined) {
          patch.branch = toolArgs.branch;
        }
        // Dependency management
        if (toolArgs.add_blocked_by || toolArgs.remove_blocked_by) {
          const current = new Set(target.blockedBy ?? []);
          for (const id of (toolArgs.add_blocked_by as string[]) ?? []) {
            current.add(id);
          }
          for (const id of (toolArgs.remove_blocked_by as string[]) ?? []) {
            current.delete(id);
          }
          patch.blockedBy = [...current];
        }
        this.deps.host.updateTicket(targetId, patch);
        respond(true, { ok: true });
        break;
      }
      case 'start_ticket': {
        const targetId = (toolArgs.ticket_id as string) ?? '';
        if (!targetId) {
          respond(false, { error: { message: 'Missing ticket_id' } });
          return;
        }
        void this.startSupervisor(targetId).then(
          () => respond(true, { ok: true }),
          (err) => respond(false, { error: { message: String(err) } })
        );
        break;
      }
      case 'stop_ticket': {
        const targetId = (toolArgs.ticket_id as string) ?? '';
        if (!targetId) {
          respond(false, { error: { message: 'Missing ticket_id' } });
          return;
        }
        void this.stopSupervisor(targetId).then(
          () => respond(true, { ok: true }),
          (err) => respond(false, { error: { message: String(err) } })
        );
        break;
      }
      // --- Read-only context tools (available to all sessions including autopilot) ---
      case 'list_milestones': {
        const projectId = (toolArgs.project_id as string) ?? '';
        if (!projectId) {
          respond(false, { error: { message: 'Missing project_id' } });
          return;
        }
        const items = this.deps.host.getMilestonesByProject(projectId);
        respond(true, {
          milestones: items.map((i) => ({
            id: i.id,
            title: i.title,
            description: i.description || '',
            branch: i.branch || null,
            status: i.status,
            created_at: new Date(i.createdAt).toISOString(),
            updated_at: new Date(i.updatedAt).toISOString(),
          })),
        });
        break;
      }
      case 'list_pages': {
        const projectId = (toolArgs.project_id as string) ?? '';
        if (!projectId) {
          respond(false, { error: { message: 'Missing project_id' } });
          return;
        }
        if (!this.deps.store.getProjects().find((p) => p.id === projectId)) {
          respond(false, { error: { message: `Project not found: ${projectId}` } });
          return;
        }
        const pages = this.deps.host.getPagesByProject(projectId);
        respond(true, {
          pages: pages.map((p) => ({
            id: p.id,
            title: p.title,
            icon: p.icon ?? null,
            parent_id: p.parentId,
            sort_order: p.sortOrder,
            is_root: p.isRoot ?? false,
            created_at: new Date(p.createdAt).toISOString(),
            updated_at: new Date(p.updatedAt).toISOString(),
          })),
        });
        break;
      }
      case 'read_page': {
        const pageId = (toolArgs.page_id as string) ?? '';
        if (!pageId) {
          respond(false, { error: { message: 'Missing page_id' } });
          return;
        }
        const page = this.deps.host.getPageById(pageId);
        if (!page) {
          respond(false, { error: { message: `Page not found: ${pageId}` } });
          return;
        }
        void this.deps.host.readPageContent(pageId).then(
          (content) =>
            respond(true, {
              id: page.id,
              title: page.title,
              icon: page.icon ?? null,
              parent_id: page.parentId,
              is_root: page.isRoot ?? false,
              content,
            }),
          () => respond(false, { error: { message: `Failed to read page content: ${pageId}` } })
        );
        break;
      }
      case 'read_milestone_brief': {
        const milestoneId = (toolArgs.milestone_id as string) ?? '';
        if (!milestoneId) {
          respond(false, { error: { message: 'Missing milestone_id' } });
          return;
        }
        const ms = this.deps.host.getMilestoneById(milestoneId);
        if (!ms) {
          respond(false, { error: { message: `Milestone not found: ${milestoneId}` } });
          return;
        }
        respond(true, { brief: ms.brief ?? '' });
        break;
      }
      case 'search_tickets': {
        const query = (toolArgs.query as string) ?? '';
        if (!query) {
          respond(false, { error: { message: 'Missing query' } });
          return;
        }
        const q = query.toLowerCase();
        const projectFilter = toolArgs.project_id as string | undefined;
        const allTickets = projectFilter
          ? this.deps.host.getTicketsByProject(projectFilter)
          : this.deps.store.getProjects().flatMap((p) => this.deps.host.getTicketsByProject(p.id));
        const matches = allTickets.filter(
          (t) => t.title.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q)
        );
        const searchResult = matches.map((t) => {
          const pl = this.deps.host.getPipeline(t.projectId);
          return {
            id: t.id,
            project_id: t.projectId,
            title: t.title,
            description: t.description || '',
            priority: t.priority,
            column: pl.columns.find((c) => c.id === t.columnId)?.label ?? t.columnId,
            phase: t.phase,
            created_at: new Date(t.createdAt).toISOString(),
            updated_at: new Date(t.updatedAt).toISOString(),
          };
        });
        respond(true, { tickets: searchResult });
        break;
      }
      case 'get_ticket_history': {
        const historyTicketId = (toolArgs.ticket_id as string) ?? '';
        if (!historyTicketId) {
          respond(false, { error: { message: 'Missing ticket_id' } });
          return;
        }
        const historyTarget = this.deps.host.getTicketById(historyTicketId);
        if (!historyTarget) {
          respond(false, { error: { message: `Ticket not found: ${historyTicketId}` } });
          return;
        }
        const historyRuns = (historyTarget.runs ?? []).map((r) => ({
          id: r.id,
          started_at: new Date(r.startedAt).toISOString(),
          ended_at: new Date(r.endedAt).toISOString(),
          end_reason: r.endReason,
          token_usage: r.tokenUsage ?? null,
        }));
        respond(true, {
          ticket_id: historyTarget.id,
          phase: historyTarget.phase ?? null,
          run_count: historyRuns.length,
          total_token_usage: historyTarget.tokenUsage ?? null,
          runs: historyRuns,
        });
        break;
      }
      case 'get_pipeline': {
        const pipelineProjectId = (toolArgs.project_id as string) ?? '';
        if (!pipelineProjectId) {
          respond(false, { error: { message: 'Missing project_id' } });
          return;
        }
        const pl = this.deps.host.getPipeline(pipelineProjectId);
        respond(true, {
          columns: pl.columns.map((c) => ({
            id: c.id,
            label: c.label,
            description: c.description || null,
            gate: c.gate ?? false,
          })),
        });
        break;
      }
      default:
        if (toolName === 'list_apps' || toolName.startsWith('app_')) {
          this.dispatchAppControlCall(ticketId, toolName, toolArgs, respond);
          return;
        }
        respond(false, { error: { message: `Unknown tool: ${toolName}` } });
    }
  }

  /**
   * Dispatch an `app_*` / `list_apps` call from an autopilot agent. Resolves
   * the caller's ticket → code tab, then column-scopes every lookup (autopilot
   * never reaches global dock apps). Returns an error result for out-of-scope
   * or non-controllable apps.
   */
  private dispatchAppControlCall(
    ticketId: TicketId,
    toolName: string,
    toolArgs: Record<string, unknown>,
    respond: ClientFunctionResponder
  ): void {
    const manager = this.deps.appControlManager;
    if (!manager) {
      respond(false, { error: { message: 'App control is not available in this session.' } });
      return;
    }

    // Resolve the code tab bound to this ticket. Autopilot is strictly
    // column-scoped — no global dock apps.
    const tab = this.deps.store.getCodeTabs().find((t) => t.ticketId === ticketId);
    if (!tab) {
      respond(false, {
        error: {
          message: 'No code tab is associated with this ticket — open the ticket in the Code deck first.',
        },
      });
      return;
    }
    const tabId = tab.id;

    if (toolName === 'list_apps') {
      const apps = manager
        .list()
        .filter((a) => a.scope === 'column' && a.tabId === tabId)
        .map((a) => ({
          id: a.appId,
          kind: a.kind,
          scope: a.scope,
          url: a.url ?? null,
          title: a.title ?? null,
          label: a.label,
          controllable: a.controllable,
        }));
      respond(true, { apps });
      return;
    }

    const appId = (toolArgs.app_id as string | undefined) ?? '';
    if (!appId) {
      respond(false, { error: { message: 'Missing app_id — call list_apps first.' } });
      return;
    }
    const handleId = makeAppHandleId('column', appId, tabId);
    const snapshot = manager.list().find((a) => a.handleId === handleId);
    if (!snapshot) {
      respond(false, {
        error: { message: `Unknown or out-of-scope app: "${appId}". Call list_apps to see what's available.` },
      });
      return;
    }
    if (!snapshot.controllable) {
      respond(false, {
        error: {
          message: `App "${appId}" (${snapshot.kind}) is not a web surface. Only browser/code/desktop/webview apps can be driven.`,
        },
      });
      return;
    }

    const run = async (): Promise<Record<string, unknown>> => {
      switch (toolName) {
        case 'app_navigate': {
          const url = (toolArgs.url as string) ?? '';
          if (!url) {
            throw new Error('Missing url');
          }
          await manager.navigate(handleId, url);
          return { ok: true };
        }
        case 'app_reload':
          await manager.reload(handleId);
          return { ok: true };
        case 'app_back':
          await manager.back(handleId);
          return { ok: true };
        case 'app_forward':
          await manager.forward(handleId);
          return { ok: true };
        case 'app_eval': {
          const code = (toolArgs.code as string) ?? '';
          if (!code) {
            throw new Error('Missing code');
          }
          const value = await manager.eval(handleId, code);
          return { value: value ?? null };
        }
        case 'app_screenshot': {
          const filepath = await manager.screenshot(handleId, { artifactsSubdir: ticketId });
          return { path: filepath };
        }
        case 'app_console': {
          const level = toolArgs.min_level as AppConsoleLevel | undefined;
          const entries = await manager.console(handleId, level ? { minLevel: level } : {});
          return { entries };
        }
        case 'app_snapshot': {
          const tree = await manager.snapshot(handleId);
          return { snapshot: tree };
        }
        case 'app_click': {
          const ref = (toolArgs.ref as string) ?? '';
          if (!ref) {
            throw new Error('Missing ref — get one from app_snapshot.');
          }
          const button = toolArgs.button as AppClickButton | undefined;
          await manager.click(handleId, ref, button ? { button } : {});
          return { ok: true };
        }
        case 'app_fill': {
          const ref = (toolArgs.ref as string) ?? '';
          const text = (toolArgs.text as string) ?? '';
          if (!ref) {
            throw new Error('Missing ref');
          }
          await manager.fill(handleId, ref, text);
          return { ok: true };
        }
        case 'app_type': {
          const text = (toolArgs.text as string) ?? '';
          if (!text) {
            throw new Error('Missing text');
          }
          await manager.type(handleId, text);
          return { ok: true };
        }
        case 'app_press': {
          const key = (toolArgs.key as string) ?? '';
          if (!key) {
            throw new Error('Missing key');
          }
          await manager.press(handleId, key);
          return { ok: true };
        }
        default:
          throw new Error(`Unhandled app tool: ${toolName}`);
      }
    };

    run().then(
      (result) => respond(true, result),
      (e) => respond(false, { error: { message: e instanceof Error ? e.message : String(e) } })
    );
  }

  /**
   * Build the full supervisor prompt, incorporating FLEET.md custom prompt if present.
   */
  private buildFullSupervisorPrompt(ticketId: TicketId, attempt: number | null = null): string {
    const ticket = this.deps.host.getTicketById(ticketId)!;
    const project = this.deps.store.getProjects().find((p) => p.id === ticket.projectId)!;
    const pipeline = this.deps.host.getPipeline(ticket.projectId);

    // Gather context for the supervisor prompt
    const context: SupervisorContext = {};

    // Project brief: read the root page's context.md (sync-safe since we pre-load it)
    const rootPage = this.deps.host.getPagesByProject(ticket.projectId).find((p) => p.isRoot);
    if (rootPage) {
      try {
        const dir = this.deps.host.getProjectDirPath(project);
        const contextPath = path.join(dir, 'context.md');
        if (existsSync(contextPath)) {
          const brief = readFileSync(contextPath, 'utf-8');
          if (brief.trim()) {
            context.projectBrief = brief.length > 500 ? `${brief.slice(0, 500)}\n…(truncated)` : brief;
          }
        }
      } catch {
        /* non-critical */
      }
    }

    // Recent comments (last 5)
    const comments = ticket.comments ?? [];
    if (comments.length > 0) {
      context.recentComments = comments
        .slice(-5)
        .reverse()
        .map((c) => ({ author: c.author, content: c.content }));
    }

    // Blocker titles
    if (ticket.blockedBy && ticket.blockedBy.length > 0) {
      const blockerTitles: string[] = [];
      for (const blockerId of ticket.blockedBy) {
        const blocker = this.deps.host.getTicketById(blockerId);
        if (blocker) {
          // Only include if blocker is not in a terminal column
          const blockerPipeline = this.deps.host.getPipeline(blocker.projectId);
          const lastCol = blockerPipeline.columns[blockerPipeline.columns.length - 1];
          if (blocker.columnId !== lastCol?.id) {
            blockerTitles.push(blocker.title);
          }
        }
      }
      if (blockerTitles.length > 0) {
        context.blockerTitles = blockerTitles;
      }
    }

    const basePrompt = buildSupervisorPrompt(ticket, project, pipeline, context);
    const customPrompt = this.deps.workflowLoader.getPromptTemplate(ticket.projectId);

    if (customPrompt) {
      let rendered = customPrompt;

      // Render template variables if the prompt contains {{ }} expressions
      if (hasTemplateExpressions(customPrompt)) {
        const vars: TemplateVariables = {
          ticket: {
            id: ticket.id,
            title: ticket.title,
            description: ticket.description || '(no description)',
            priority: ticket.priority,
            columnId: ticket.columnId,
            branch: this.deps.host.resolveTicketBranch(ticket),
          },
          pipeline: {
            columns: pipeline.columns.map((c) => c.label).join(' → '),
          },
          project: {
            label: project.label,
            workspaceDir:
              (project.source?.kind === 'local' ? project.source?.workspaceDir : project.source?.repoUrl) ?? '',
          },
          attempt,
        };

        try {
          rendered = renderTemplate(customPrompt, vars);
        } catch (err) {
          console.warn(
            `[SupervisorOrchestrator] Template render failed for ${ticketId}: ${(err as Error).message}. Using raw prompt.`
          );
          rendered = customPrompt;
        }
      }

      return `${basePrompt}\n\n## Project-Specific Instructions (from FLEET.md)\n\n${rendered}`;
    }

    return basePrompt;
  }

  /**
   * Build the full variables object for a session or run RPC call.
   * Includes the supervisor prompt and client tool definitions so the agent
   * can call project tools via the existing WebSocket connection.
   *
   * - 'autopilot': ticket tools only (automated runs, retries, continuations)
   * - 'interactive': broader project-management tools for human-driven ticket sessions
   */
  buildRunVariables(ticketId: TicketId, mode: 'autopilot' | 'interactive' = 'autopilot'): Record<string, unknown> {
    const ticket = this.deps.host.getTicketById(ticketId);
    const backend = this.deps.store.getSandboxBackend() ?? 'none';
    const opts = {
      projectId: ticket?.projectId,
      projectLabel: ticket ? this.deps.store.getProjects().find((p) => p.id === ticket.projectId)?.label : undefined,
      ticketId,
      artifactsDir: getAgentArtifactsDir(ticketId, backend, this.deps.store.getOmniConfigDir()),
    };
    const vars = mode === 'autopilot' ? buildAutopilotVariables(opts) : buildInteractiveVariables(opts);
    const supervisorPrompt = this.buildFullSupervisorPrompt(ticketId);
    const toolInstructions = (vars.additional_instructions as string) ?? '';
    return {
      ...vars,
      additional_instructions: toolInstructions ? `${supervisorPrompt}\n\n${toolInstructions}` : supervisorPrompt,
    };
  }

  /**
   * Wrapper around the pure `buildContinuationPrompt` helper that resolves the
   * ticket, pipeline, and FLEET.md continuation override from this instance's
   * state.
   */
  buildContinuationPromptForTicket(ticketId: TicketId, turn: number, maxTurns: number): string {
    const ticket = this.deps.host.getTicketById(ticketId);
    const customContinuation = ticket
      ? this.deps.workflowLoader.getConfig(ticket.projectId).supervisor?.continuation_prompt
      : undefined;
    const pipeline = ticket ? this.deps.host.getPipeline(ticket.projectId) : null;
    return buildContinuationPrompt({ ticket, pipeline, customContinuation, turn, maxTurns });
  }
}
