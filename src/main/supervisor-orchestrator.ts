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
 *
 * Does NOT own (yet — still in ProjectManager):
 *   - `tasks` map + persisted task list (registry adapter only — moves in C2c.6)
 *   - `handleClientToolCall` + supervisor prompt assembly (moves in C2c.8)
 *   - Auto-dispatch loop + `validateDispatchPreflight` (moves in C2c.7)
 *   - Task persistence + startup cleanup (moves in C2c.6)
 */

import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import { nanoid } from 'nanoid';

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
import { decideWorktreeAction } from '@/lib/worktree';
import type { AgentProcessMode } from '@/main/agent-process';
import { createPlatformClient } from '@/main/platform-mode';
import type { ProcessManager } from '@/main/process-manager';
import { type ClientFunctionResponder, TicketMachine } from '@/main/ticket-machine';
import { createWorktree, generateWorktreeName, removeWorktree } from '@/main/worktree-ops';
import { requireLocalWorkspaceDir } from '@/shared/project-source';
import { isActivePhase, type TicketPhase } from '@/shared/ticket-phase';
import type {
  AgentProcessStatus,
  CodeTabId,
  ColumnId,
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
  getProjects(): Project[];
  getWipLimit(): number;
  getSandboxBackend(): SandboxBackend | undefined;
  getPlatformCredentials(): PlatformCredentials | undefined;
  getCodeTabs(): Array<{ id: string; ticketId?: string }>;
}

/**
 * Task registry adapter — thin surface over PM's in-memory `tasks` Map and
 * persisted task list. Removed in C2c.6 when task ownership transfers into
 * the orchestrator wholesale.
 */
export interface SupervisorTaskRegistry {
  register(taskId: TaskId, task: Task, sandbox: ISandbox): void;
  get(taskId: TaskId): { task: Task; sandbox: ISandbox } | undefined;
  patchTask(taskId: TaskId, patch: Partial<Task>): void;
  /** Drop the task from the in-memory map and the persisted store. */
  unregister(taskId: TaskId): void;
}

// ---------------------------------------------------------------------------
// Host surface — behavior the orchestrator needs from its collaborators.
//
// Several of these are temporary callbacks while PM still owns the `machines`
// map, withTicketLock, and lifecycle entry points. They disappear as those
// concerns migrate in subsequent sprints.
// ---------------------------------------------------------------------------

export interface SupervisorOrchestratorHost {
  // Ticket lookups + pipeline semantics — PM retains ticket CRUD long-term.
  getTicketById(ticketId: TicketId): Ticket | undefined;
  updateTicket(ticketId: TicketId, patch: Partial<Ticket>): void;
  isTerminalColumn(projectId: ProjectId, columnId: ColumnId): boolean;
  getColumn(projectId: ProjectId, columnId: ColumnId): Pipeline['columns'][number] | undefined;
  /** Effective branch for a ticket (ticket.branch ?? milestone.branch). */
  resolveTicketBranch(ticket: Ticket): string | undefined;

  /** Dispatch preflight (concurrency + WIP + state). PM still owns it until C2c.7. */
  validateDispatchPreflight(ticketId: TicketId): string | null;
  buildRunVariables(ticketId: TicketId, mode?: 'autopilot' | 'interactive'): Record<string, unknown>;

  // Still owned by PM — moves in C2c.8 with handleClientToolCall /
  // buildContinuationPromptForTicket.
  buildContinuationPromptForTicket(ticketId: TicketId, turn: number, maxTurns: number): string;
  handleClientToolCall(
    ticketId: TicketId,
    functionName: string,
    args: Record<string, unknown>,
    respond: ClientFunctionResponder
  ): void;
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface SupervisorOrchestratorDeps {
  store: SupervisorOrchestratorStore;
  host: SupervisorOrchestratorHost;
  taskRegistry: SupervisorTaskRegistry;
  workflowLoader: IWorkflowLoader;
  sendToWindow: IWindowSender;
  sandboxFactory: ISandboxFactory;
  /** Optional machine factory for tests. Defaults to real TicketMachine. */
  machineFactory?: IMachineFactory;
  /** Optional ProcessManager — enables Code-tab sandbox reuse. */
  processManager?: ProcessManager;
}

// ---------------------------------------------------------------------------
// SupervisorOrchestrator
// ---------------------------------------------------------------------------

export class SupervisorOrchestrator {
  private stallCheckTimer: ReturnType<typeof setInterval> | null = null;

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

  constructor(private readonly deps: SupervisorOrchestratorDeps) {}

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
        this.deps.host.handleClientToolCall(tid, functionName, args, respond);
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
          const continuationPrompt = this.deps.host.buildContinuationPromptForTicket(
            ticketId,
            action.nextTurn + 1,
            maxTurns
          );
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
        const variables = this.deps.host.buildRunVariables(ticketId);

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

    const variables = this.deps.host.buildRunVariables(ticketId, 'interactive');

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
        const taskEntry = this.deps.taskRegistry.get(taskId);
        if (taskEntry) {
          const patch: Partial<Task> = { status };
          if (status.type === 'running') {
            patch.lastUrls = {
              uiUrl: status.data.uiUrl,
              codeServerUrl: status.data.codeServerUrl,
              noVncUrl: status.data.noVncUrl,
            };
          }
          this.deps.taskRegistry.patchTask(taskId, patch);
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

    this.deps.taskRegistry.register(taskId, task, sandbox);
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
   * Start the autonomous supervisor — sends the full supervisor prompt as the user turn.
   * Triggered by the Play button.
   */
  startSupervisor = (ticketId: TicketId): Promise<void> => {
    return this.withTicketLock(ticketId, async () => {
      const preflightError = this.deps.host.validateDispatchPreflight(ticketId);
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
      const variables = this.deps.host.buildRunVariables(ticketId);
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
   */
  cleanupTicketWorkspace = async (ticketId: TicketId): Promise<void> => {
    const ticket = this.deps.host.getTicketById(ticketId);
    if (!ticket) {
      return;
    }

    const project = this.deps.store.getProjects().find((p) => p.id === ticket.projectId);
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
      const taskEntry = this.deps.taskRegistry.get(taskId);
      if (taskEntry) {
        await taskEntry.sandbox.exit();
      }
      this.deps.taskRegistry.unregister(taskId);
    }

    // Remove worktree (source of truth is the ticket, not the task)
    if (ticket.worktreePath && ticket.worktreeName && project && project.source?.kind === 'local') {
      await removeWorktree(requireLocalWorkspaceDir(project.source), ticket.worktreePath, ticket.worktreeName);
      this.deps.host.updateTicket(ticketId, { worktreePath: undefined, worktreeName: undefined });
    }

    console.log(`[SupervisorOrchestrator] Cleaned up workspace for ticket ${ticketId}.`);
  };

  resetSupervisorSession = (ticketId: TicketId): Promise<void> => {
    return this.withTicketLock(ticketId, async () => {
      const entry = this.machines.get(ticketId);
      if (!entry) {
        return;
      }

      await entry.machine.stop();

      // Build fresh variables (includes FLEET.md custom prompt + client tools)
      const variables = this.deps.host.buildRunVariables(ticketId, 'interactive');

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
    const variables = ticket ? this.deps.host.buildRunVariables(ticketId, 'interactive') : undefined;

    try {
      const result = await entry.machine.startRun(message, { sessionId, variables });
      this.deps.host.updateTicket(ticketId, { supervisorSessionId: result.sessionId });
    } catch (error) {
      console.error(`[SupervisorOrchestrator] Machine message failed for ${ticketId}:`, error);
    }
  };
}
