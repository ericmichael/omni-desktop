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
 *
 * Does NOT own (yet — still in ProjectManager):
 *   - `machines` / `tasks` / `runStartedAt` / `ticketLocks` state
 *   - Ticket machine factory + callbacks
 *   - Auto-dispatch loop
 *   - `handleMachineRunEnd` / `handleClientToolCall`
 *   - `ensureSupervisorInfra` / `startSupervisor` / `stopSupervisor` / `sendSupervisorMessage`
 *   - Supervisor prompt assembly
 *   - Task persistence + startup cleanup
 */

import type { ISandbox, ITicketMachine, IWorkflowLoader } from '@/lib/project-manager-deps';
import type { FailureClass } from '@/lib/run-end';
import { isActivePhase } from '@/shared/ticket-phase';
import type { ColumnId, Project, ProjectId, Ticket, TicketId } from '@/shared/types';

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
}

// ---------------------------------------------------------------------------
// Host surface — behavior the orchestrator needs from its collaborators.
//
// Several of these are temporary callbacks while PM still owns the `machines`
// map, withTicketLock, and lifecycle entry points. They disappear as those
// concerns migrate in subsequent sprints.
// ---------------------------------------------------------------------------

export interface SupervisorOrchestratorHost {
  // Machines map access — removed in C2c.3 when ownership transfers.
  getMachineEntry(ticketId: TicketId): MachineEntry | undefined;
  iterateMachines(): Iterable<[TicketId, MachineEntry]>;

  // Ticket lookups + pipeline semantics — PM retains ticket CRUD long-term.
  getTicketById(ticketId: TicketId): Ticket | undefined;
  isTerminalColumn(projectId: ProjectId, columnId: ColumnId): boolean;

  // Per-ticket async mutex — moves in C2c.3 with machines map.
  withTicketLock<T>(ticketId: TicketId, fn: () => Promise<T>): Promise<T>;

  // Lifecycle entry points still owned by PM — removed in C2c.4/C2c.5.
  ensureSupervisorInfra(ticketId: TicketId): Promise<unknown>;
  startMachineRun(
    ticketId: TicketId,
    prompt: string,
    opts?: { sessionId?: string; variables?: Record<string, unknown> }
  ): void;
  buildRunVariables(ticketId: TicketId, mode?: 'autopilot' | 'interactive'): Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface SupervisorOrchestratorDeps {
  store: SupervisorOrchestratorStore;
  host: SupervisorOrchestratorHost;
  workflowLoader: IWorkflowLoader;
}

// ---------------------------------------------------------------------------
// SupervisorOrchestrator
// ---------------------------------------------------------------------------

export class SupervisorOrchestrator {
  private stallCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: SupervisorOrchestratorDeps) {}

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
    for (const [ticketId, entry] of this.deps.host.iterateMachines()) {
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
    const entry = this.deps.host.getMachineEntry(ticketId);
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
    return this.deps.host.withTicketLock(ticketId, async () => {
      const ticket = this.deps.host.getTicketById(ticketId);
      const entry = this.deps.host.getMachineEntry(ticketId);
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
          hookOk = await this.deps.workflowLoader.runHook(
            ticket.projectId,
            'before_run',
            project.source?.workspaceDir
          );
        } else {
          const hookScript = this.deps.workflowLoader.getConfig(ticket.projectId).hooks?.before_run;
          if (hookScript) {
            const currentEntry = this.deps.host.getMachineEntry(ticketId);
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
        await this.deps.host.ensureSupervisorInfra(ticketId);
        this.deps.host.startMachineRun(ticketId, prompt, { sessionId, variables });
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
    const entry = this.deps.host.getMachineEntry(ticketId);
    if (entry) {
      entry.machine.cancelRetryTimer();
    }
  }

  /** Cancel all pending retry timers — called from PM.exit(). */
  cancelAllRetries(): void {
    for (const [, entry] of this.deps.host.iterateMachines()) {
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

    for (const [ticketId, entry] of this.deps.host.iterateMachines()) {
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
        void this.deps.host.withTicketLock(ticketId, async () => {
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
}
