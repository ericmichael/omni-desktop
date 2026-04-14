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
 * contract grows and shrinks as logic moves: `countActiveMachines` is a
 * temporary callback used while PM still owns the `machines` map, and will
 * disappear once ownership transfers.
 *
 * Currently owns:
 *   - Effective-config accessors (stall timeout, concurrency, retry, turns)
 *   - `canStartSupervisor` — global + per-column concurrency check
 *   - `getActiveWipTickets` — cross-project active-phase roll-up
 *   - `isAutoDispatchEnabled` — project flag + FLEET.md override
 *
 * Does NOT own (yet — still in ProjectManager):
 *   - `machines` / `tasks` / `runStartedAt` / `ticketLocks` state
 *   - Ticket machine factory + callbacks
 *   - Retry queue / stall detection / auto-dispatch loop
 *   - `handleMachineRunEnd` / `handleClientToolCall`
 *   - `ensureSupervisorInfra` / `startSupervisor` / `stopSupervisor` / `sendSupervisorMessage`
 *   - Supervisor prompt assembly
 *   - Task persistence + startup cleanup
 */

import type { IWorkflowLoader } from '@/lib/project-manager-deps';
import type { TicketPhase } from '@/shared/ticket-phase';
import { isActivePhase } from '@/shared/ticket-phase';
import type { ColumnId, Project, ProjectId, Ticket } from '@/shared/types';

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
// `countActiveMachines` / `countActiveMachinesInColumn` are temporary callbacks
// used while PM still owns the `machines` map. They disappear once the map
// moves into the orchestrator.
// ---------------------------------------------------------------------------

export interface SupervisorOrchestratorHost {
  countActiveMachines(): number;
  countActiveMachinesInColumn(projectId: ProjectId, columnId: ColumnId): number;
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
   * concurrency limits. Reads live machine counts through the host callbacks
   * — those disappear once the `machines` map moves into this class.
   */
  canStartSupervisor(projectId?: ProjectId, columnId?: ColumnId): boolean {
    if (this.deps.host.countActiveMachines() >= MAX_CONCURRENT_SUPERVISORS) {
      return false;
    }
    if (projectId && columnId) {
      const columnLimit = this.getColumnMaxConcurrent(projectId, columnId);
      if (columnLimit !== undefined) {
        return this.deps.host.countActiveMachinesInColumn(projectId, columnId) < columnLimit;
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
    return this.deps.store.getTickets().filter((t): t is Ticket & { phase: TicketPhase } => {
      return t.phase !== undefined && isActivePhase(t.phase);
    });
  }
}
