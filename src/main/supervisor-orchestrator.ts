/**
 * SupervisorOrchestrator — owns autopilot orchestration for tickets.
 *
 * The Code column owns the session id, the sandbox WebSocket, and every tool /
 * approval call. This orchestrator issues a narrow set of commands to the
 * column via `SupervisorBridge` (ensure column, start a ``/goal`` loop,
 * stop the loop, reset, dispose) and reacts to forwarded events
 * (run_started, run_end, token_usage, goal-update, disconnected).
 *
 * What lives here:
 *   - Phase records mirrored from ``ui.goal.update`` snapshots
 *   - Workspace / worktree provisioning + project hooks
 *   - Concurrency + WIP / dispatch-preflight validation
 *   - Auto-dispatch poll
 *   - Initial supervisor prompt assembly (`buildFullSupervisorPrompt`) —
 *     passed once at startGoal time as the loop's goal text. Continuation
 *     prompts are owned by the agent-side ``/goal`` server function (see
 *     omni-code's ``server_functions/goal.py``).
 *   - Task persistence for the UI task list
 *
 * What does NOT live here anymore:
 *   - Session id minting / tracking
 *   - Tool-call dispatch — the renderer's `buildClientToolHandler` handles
 *     everything
 *   - Variable building — the column builds its own via `buildSessionVariables`
 *   - Continuation, retry-on-error, and stall detection — all owned by
 *     omni-code's ``/goal`` loop
 */

import { existsSync, readFileSync } from 'fs';
import fs from 'fs/promises';
import { nanoid } from 'nanoid';
import { logicalColumnId } from 'omni-projects-db';
import path from 'path';

import type { IWindowSender, IWorkflowLoader } from '@/lib/project-manager-deps';
import { hasTemplateExpressions, renderTemplate, type TemplateVariables } from '@/lib/template';
import { claimsCollide, decideWorktreeAction, resolveWorkspaceClaim } from '@/lib/worktree';
import type { AppControlManager } from '@/main/app-control-manager';
import type { ProcessManager } from '@/main/process-manager';
import type { SupervisorBridge } from '@/main/supervisor-bridge';
import { buildSupervisorPrompt, type SupervisorContext } from '@/main/supervisor-prompt';
import { SupervisorState } from '@/main/supervisor-state';
import { getProjectPagesDir } from '@/main/util';
import { createWorktree, generateWorktreeName, isWorktreeDirty, removeWorktree } from '@/main/worktree-ops';
import { requireLocalWorkspaceDir } from '@/shared/project-source';
import { isActivePhase, type TicketPhase } from '@/shared/ticket-phase';
import type {
  CodeTabId,
  ColumnId,
  Page,
  Pipeline,
  PlatformCredentials,
  Project,
  ProjectId,
  SessionMessage,
  SupervisorBridgeEvent,
  Task,
  TaskId,
  Ticket,
  TicketId,
} from '@/shared/types';
import { firstSource } from '@/shared/types';
import type { ProjectSource } from '@/shared/types';

// ---------------------------------------------------------------------------
// Operational constants — referenced by SupervisorOrchestrator and eventually
// by the full set of lifecycle methods as they migrate in.
// ---------------------------------------------------------------------------

/** Maximum number of supervisors that can run concurrently across all projects. */
export const MAX_CONCURRENT_SUPERVISORS = 5;

/**
 * Maximum continuation turns. Used as the default ``max_turns`` arg
 * passed to omni-code's ``/goal`` server function when neither the
 * project's workflow config nor an explicit override sets one. The
 * agent-side loop is what enforces this budget — the launcher just
 * forwards the value at startGoal time.
 */
export const MAX_CONTINUATION_TURNS = 10;

/** Auto-dispatch poll interval — check every 30s for eligible tickets. */
export const AUTO_DISPATCH_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface SupervisorEntry {
  /** Phase record. Holds no session id — the Code column is authoritative. */
  state: SupervisorState;
  /** The Code tab driving this supervisor. Resolved from `store.getCodeTabs()`. */
  tabId: CodeTabId;
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
  /**
   * The principal whose WIP this is (teams/cloud). When set, WIP enforcement +
   * the "Right Now" rollup count only tickets assigned to this user. Undefined
   * in single-user/local mode → counts every active ticket (legacy behavior).
   */
  getCurrentPrincipal?(): string | undefined;
  getPlatformCredentials(): PlatformCredentials | undefined;
  getCodeTabs(): Array<{ id: string; ticketId?: string }>;
  getPersistedTasks(): Task[];
  setPersistedTasks(tasks: Task[]): void;
  /**
   * Per-row task write. Used by the high-frequency `persistTask` and
   * `removePersistedTask` paths to avoid the read-all/mutate/write-all
   * cycle. Optional for backward compatibility with stores that only
   * implement the bulk `setPersistedTasks` path (e.g. older test fakes).
   */
  upsertPersistedTask?(task: Task): void;
  deletePersistedTask?(taskId: TaskId): void;
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

  // Used by buildFullSupervisorPrompt to read the project's root page
  // (the brief) before issuing a run. The file path itself is resolved
  // off `ticket.projectId` via `getProjectPagesDir` — the host no longer
  // needs to expose a directory resolver for this.
  getPagesByProject(projectId: ProjectId): Page[];

  /** Agent-facing artifacts dir for a ticket, resolved per profile (host dir vs
   *  container `/workspace/.omni-artifacts/<id>`). Surfaced in the supervisor
   *  prompt; must match where the launcher's ArtifactStore reads. */
  getAgentArtifactsDir(ticketId: TicketId): string;
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface SupervisorOrchestratorDeps {
  store: SupervisorOrchestratorStore;
  host: SupervisorOrchestratorHost;
  workflowLoader: IWorkflowLoader;
  sendToWindow: IWindowSender;
  /**
   * Bridge to the renderer's column registry. The renderer owns every sandbox
   * WebSocket — SUBMIT / stop / send-message / session.ensure all go through
   * the live RPCClient inside a Code tab via this bridge. Main's orchestration
   * only reacts to forwarded events.
   */
  bridge: SupervisorBridge;
  /** ProcessManager — used to exec hooks in running sandbox containers (git-remote mode). */
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
  private autoDispatchTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Live supervisor state records keyed by ticket. Public so ProjectManager
   * and tests can reach in without a cast.
   */
  readonly machines = new Map<TicketId, SupervisorEntry>();

  /**
   * Wall-clock time each active run started, keyed by ticketId. Read in
   * handleMachineRunEnd so persisted TicketRun.startedAt reflects the
   * actual run start, not ticket.updatedAt (which can be bumped by any
   * intervening updateTicket call, e.g., onTokenUsage).
   */
  readonly runStartedAt = new Map<TicketId, number>();

  /** Per-ticket async mutex chain. */
  readonly ticketLocks = new Map<TicketId, Promise<void>>();

  /**
   * Persisted task metadata, keyed by taskId. Each entry shadows a persisted
   * `Task` record in the store. Sandbox lifecycle is owned by `ProcessManager`
   * (keyed by Code tab id); these entries are purely for UI listing and boot
   * recovery.
   */
  readonly tasks = new Map<TaskId, { task: Task }>();

  /** Unsubscribe from bridge events on dispose. */
  private offBridge: (() => void) | null = null;

  constructor(private readonly deps: SupervisorOrchestratorDeps) {
    this.offBridge = this.deps.bridge.onEvent((event) => this.handleBridgeEvent(event));
  }

  // -------------------------------------------------------------------------
  // Task persistence (in-memory + store)
  // -------------------------------------------------------------------------

  /** Insert or update a persisted task record. */
  private persistTask(task: Task): void {
    // Prefer per-row write when the store provides it — one SQL upsert
    // instead of read-all → mutate → write-all on every task transition.
    if (this.deps.store.upsertPersistedTask) {
      this.deps.store.upsertPersistedTask(task);
      return;
    }
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
    if (this.deps.store.deletePersistedTask) {
      this.deps.store.deletePersistedTask(taskId);
      return;
    }
    const tasks = this.deps.store.getPersistedTasks().filter((t) => t.id !== taskId);
    this.deps.store.setPersistedTasks(tasks);
  }

  /** Snapshot of all in-memory tasks (for IPC `project:get-tasks`). */
  listTasks(): Task[] {
    return Array.from(this.tasks.values()).map((entry) => entry.task);
  }

  // -------------------------------------------------------------------------
  // State factory
  // -------------------------------------------------------------------------

  /**
   * Build a `SupervisorState` wired to this orchestrator's phase callback.
   * The state record is NOT added to `this.machines`; callers register the
   * full `SupervisorEntry` once a Code tab is bound.
   */
  private createState(ticketId: TicketId): SupervisorState {
    return new SupervisorState(ticketId, {
      onPhaseChange: (tid, phase) => {
        this.deps.host.updateTicket(tid, { phase, phaseChangedAt: Date.now() });
        this.deps.sendToWindow('project:phase', tid, phase);
      },
    });
  }

  // -------------------------------------------------------------------------
  // Bridge event handler — dispatches forwarded sandbox events to orchestration
  // -------------------------------------------------------------------------

  private handleBridgeEvent(event: SupervisorBridgeEvent): void {
    const entry = this.machines.get(event.ticketId);
    if (!entry) {
      return;
    }
    const { state } = entry;

    switch (event.kind) {
      case 'run-started': {
        state.setRunId(event.runId);
        state.recordActivity();
        if (!state.isStreaming()) {
          state.transition('running');
        }
        this.runStartedAt.set(event.ticketId, Date.now());
        return;
      }
      case 'run-end': {
        state.setRunId(null);
        void this.handleMachineRunEnd(event.ticketId, event.reason);
        return;
      }
      case 'message': {
        state.recordActivity();
        const msg: SessionMessage = {
          id: Date.now(),
          role: event.toolName ? 'tool_call' : event.role === 'user' ? 'user' : 'assistant',
          content: event.content,
          toolName: event.toolName,
          createdAt: new Date().toISOString(),
        };
        this.deps.sendToWindow('project:supervisor-message', event.ticketId, msg);
        return;
      }
      case 'token-usage': {
        const ticket = this.deps.host.getTicketById(event.ticketId);
        if (!ticket) {
          return;
        }
        const prev = ticket.tokenUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        const updated = {
          inputTokens: prev.inputTokens + event.usage.inputTokens,
          outputTokens: prev.outputTokens + event.usage.outputTokens,
          totalTokens: prev.totalTokens + event.usage.totalTokens,
        };
        if (updated.totalTokens !== prev.totalTokens) {
          this.deps.host.updateTicket(event.ticketId, { tokenUsage: updated });
          this.deps.sendToWindow('project:token-usage', event.ticketId, updated);
        }
        return;
      }
      case 'disconnected': {
        // Column went away. Drop run identity; a future run will rehydrate on
        // the tab's next mount. Don't tear down the state — the user may
        // reopen the tab.
        state.setRunId(null);
        if (state.isStreaming()) {
          state.forcePhase('idle' as TicketPhase);
        }
        return;
      }
      case 'goal-update': {
        this.handleGoalUpdate(event.ticketId, event.snapshot);
        return;
      }
    }
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
   * Handle a ``run_end`` notification from a column. Continue / retry /
   * completion decisioning lives in omni-code's ``/goal`` server function;
   * the orchestrator's job here is narrow:
   *
   *   - Persist the run record for the ticket's run history.
   *   - Fire the after_run project hook (best-effort).
   *
   * Phase transitions come from ``handleGoalUpdate`` (the agent-side loop's
   * ``ui.goal.update`` broadcast), NOT from here — a single run ending
   * mid-loop doesn't mean the work is done.
   */
  handleMachineRunEnd = (ticketId: TicketId, reason: string): Promise<void> => {
    return this.withTicketLock(ticketId, async () => {
      console.log(`[SupervisorOrchestrator] Machine run ended for ${ticketId}: ${reason}`);

      const entry = this.machines.get(ticketId);
      if (!entry) {
        return;
      }

      const ticket = this.deps.host.getTicketById(ticketId);
      if (ticket) {
        // after_run hook (best-effort). Fires once per run regardless of
        // whether the /goal loop continues — semantics match the
        // pre-migration behavior.
        const project = this.deps.store.getProjects().find((p) => p.id === ticket.projectId);
        const afterSource = firstSource(project);
        if (afterSource?.kind === 'local') {
          void this.deps.workflowLoader.runHook(ticket.projectId, 'after_run', afterSource.workspaceDir);
        } else if (afterSource?.kind === 'git-remote') {
          const hookScript = this.deps.workflowLoader.getConfig(ticket.projectId).hooks?.after_run;
          if (hookScript && entry.tabId) {
            void this.execHookInContainer(entry.tabId, hookScript);
          }
        }

        // Persist run record. startedAt comes from runStartedAt — falling
        // back to updatedAt is a last-resort approximation, since
        // token-usage updates bump updatedAt and would otherwise collapse
        // startedAt onto endedAt.
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
    });
  };

  /**
   * Map a ``ui.goal.update`` snapshot from the agent-side ``/goal`` loop
   * onto the ticket's phase. Snapshot is null when the loop has fully
   * torn down (no goal set on the session); status ``active`` means a
   * turn is in flight or the tick is waiting; ``completed`` / ``cancelled``
   * are terminal.
   */
  handleGoalUpdate = (ticketId: TicketId, snapshot: import('@/shared/types').GoalSnapshotPayload | null): void => {
    const entry = this.machines.get(ticketId);
    if (!entry) {
      return;
    }
    const { state } = entry;

    if (!snapshot) {
      // Loop torn down — drop to idle unless the user explicitly stopped
      // us (state already idle in that path).
      if (state.getPhase() !== 'idle' && state.getPhase() !== 'completed') {
        state.forcePhase('idle' as TicketPhase);
      }
      return;
    }

    if (snapshot.status === 'completed') {
      console.log(
        `[SupervisorOrchestrator] /goal completed for ${ticketId}: ${snapshot.completion_reason ?? 'achieved'}`
      );
      if (state.getPhase() !== 'completed') {
        state.transition('completed' as TicketPhase);
      }
      return;
    }

    if (snapshot.status === 'cancelled') {
      console.log(`[SupervisorOrchestrator] /goal cancelled for ${ticketId}`);
      if (state.getPhase() !== 'idle' && state.getPhase() !== 'error') {
        state.forcePhase('idle' as TicketPhase);
      }
      return;
    }

    // status === 'active'
    state.recordActivity();
    if (!state.isStreaming() && state.isActive()) {
      state.transition('running' as TicketPhase);
    }
  };

  // -------------------------------------------------------------------------
  // Effective-config accessors — resolve workflow overrides against the
  // hard-coded defaults above.
  // -------------------------------------------------------------------------

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

  getEffectiveMaxContinuationTurns(projectId: ProjectId): number {
    return this.deps.workflowLoader.getConfig(projectId).supervisor?.max_continuation_turns ?? MAX_CONTINUATION_TURNS;
  }

  /**
   * Per-column concurrency limit from FLEET.md, or undefined if not set.
   * FLEET.md keys are logical ids (`spec`, `implementation`); SQLite column
   * ids are prefixed (`${projectId}__spec`). Strip the prefix before lookup.
   */
  getColumnMaxConcurrent(projectId: ProjectId, columnId: ColumnId): number | undefined {
    const logicalId = logicalColumnId(projectId, columnId);
    return this.deps.workflowLoader.getConfig(projectId).supervisor?.max_concurrent_by_column?.[logicalId];
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
      if (!entry.state.isActive()) {
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
    const principal = this.deps.store.getCurrentPrincipal?.();
    return this.deps.store.getTickets().filter((t) => {
      if (t.phase === undefined || !isActivePhase(t.phase)) {
        return false;
      }
      // Teams: WIP is personal — count only tickets assigned to this user.
      // Single-user/local (no principal): count all active (legacy behavior).
      return principal ? t.assignee === principal : true;
    });
  }

  /**
   * Detect a workspace collision with another actively-running supervisor.
   *
   * Two supervisors collide when they'd write to the same filesystem path:
   *   - direct-mode ticket on the same local project (both mount workspaceDir)
   *   - same persisted worktree path (defensive; reuse is keyed per-ticket)
   *
   * Worktree vs. worktree off the same base doesn't collide — each gets its
   * own `~/Omni/Worktrees/<name>` checkout and `ticket/<name>` branch. Remote
   * projects don't collide either; the container clones fresh.
   */
  findWorkspaceCollision(ticketId: TicketId): Ticket | null {
    const ticket = this.deps.host.getTicketById(ticketId);
    if (!ticket) {
      return null;
    }
    const project = this.deps.store.getProjects().find((p) => p.id === ticket.projectId);
    if (!project || firstSource(project)?.kind !== 'local') {
      return null;
    }
    const claim = resolveWorkspaceClaim(
      ticket,
      (firstSource(project) as Extract<ProjectSource, { kind: 'local' }> | undefined)?.workspaceDir
    );
    if (!claim) {
      return null;
    }
    for (const [otherId, entry] of this.machines) {
      if (otherId === ticketId || !entry.state.isActive()) {
        continue;
      }
      const other = this.deps.host.getTicketById(otherId);
      if (!other || other.projectId !== ticket.projectId) {
        continue;
      }
      const otherClaim = resolveWorkspaceClaim(
        other,
        (firstSource(project) as Extract<ProjectSource, { kind: 'local' }> | undefined)?.workspaceDir
      );
      if (otherClaim && claimsCollide(claim, otherClaim)) {
        return other;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Infra provisioning (C2c.4) — ensure sandbox + machine + session for a ticket
  // -------------------------------------------------------------------------

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
    const projectSource = firstSource(project);
    if (projectSource?.kind === 'git-remote') {
      const effectiveBranch = this.deps.host.resolveTicketBranch(ticket) ?? projectSource.defaultBranch;
      return {
        workspaceDir: '/home/user/workspace', // container-side path (not local)
        action: 'none',
        gitRepo: {
          url: projectSource.repoUrl,
          branch: effectiveBranch,
        },
      };
    }

    let workspaceDir = requireLocalWorkspaceDir(firstSource(project));
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
      worktreePath = await createWorktree(
        requireLocalWorkspaceDir(firstSource(project)),
        effectiveBranch!,
        worktreeName
      );
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
   * Ensure a Code column exists for this ticket and we have a SupervisorEntry
   * tracking its phase.
   *
   *   1. Resolve workspace (create / reuse git worktree for local projects).
   *   2. Run `after_create` hook when a new worktree is cut.
   *   3. Ask the bridge to ensure the Code tab is mounted + the actor is
   *      registered. The column boots its own session id via the normal
   *      chat-boot flow; main never touches it.
   *   4. Register the SupervisorEntry so forwarded events drive phase/retry.
   *
   * Idempotent.
   */
  ensureColumn = async (ticketId: TicketId, profileName?: string): Promise<SupervisorEntry> => {
    const ticket = this.deps.host.getTicketById(ticketId);
    if (!ticket) {
      throw new Error(`Ticket not found: ${ticketId}`);
    }

    const project = this.deps.store.getProjects().find((p) => p.id === ticket.projectId);
    if (!project) {
      throw new Error(`Project not found: ${ticket.projectId}`);
    }

    const resolvedWorkspace = await this.resolveTicketWorkspace(ticketId);
    const { workspaceDir, worktreePath, worktreeName, action } = resolvedWorkspace;

    if (action === 'create') {
      const afterCreateOk = await this.deps.workflowLoader.runHook(ticket.projectId, 'after_create', workspaceDir);
      if (!afterCreateOk) {
        if (worktreePath && worktreeName && firstSource(project)?.kind === 'local') {
          await removeWorktree(requireLocalWorkspaceDir(firstSource(project)), worktreePath, worktreeName);
        }
        throw new Error('after_create hook failed');
      }
    }

    const existing = this.machines.get(ticketId);
    const state = existing?.state ?? this.createState(ticketId);
    if (!existing) {
      state.forcePhase('provisioning' as TicketPhase);
    }

    try {
      await this.deps.bridge.ensureColumn({ ticketId, workspaceDir, profileName });
    } catch (err) {
      state.forcePhase('error' as TicketPhase);
      throw err;
    }

    const tab = this.deps.store.getCodeTabs().find((t) => t.ticketId === ticketId);
    const tabId = (tab?.id ?? '') as CodeTabId;

    const entry: SupervisorEntry = { state, tabId };
    this.machines.set(ticketId, entry);
    if (state.getPhase() === 'provisioning') {
      state.forcePhase('ready' as TicketPhase);
    }
    return entry;
  };

  // -------------------------------------------------------------------------
  // Lifecycle entry points (C2c.5)
  // -------------------------------------------------------------------------

  /**
   * Dispatch the autopilot loop through the column. Phase flips to
   * ``running`` synchronously — the agent-side ``/goal`` server function
   * (omni-code) owns the loop from here: it installs the periodic tick,
   * enqueues the initial framing prompt, classifies run-ends, and
   * broadcasts ``ui.goal.update`` snapshots which the orchestrator
   * mirrors back onto the ticket via ``handleGoalUpdate``. The launcher
   * no longer drives continuation, retry, or stall detection — those
   * concerns live in ``/goal``.
   */
  startMachineRun = (ticketId: TicketId): void => {
    const entry = this.machines.get(ticketId);
    if (!entry) {
      console.warn(`[SupervisorOrchestrator] startMachineRun: no entry for ${ticketId}`);
      return;
    }
    const { state } = entry;

    this.runStartedAt.set(ticketId, Date.now());
    state.recordActivity();

    const ticket = this.deps.host.getTicketById(ticketId);
    const maxTurns = ticket ? this.getEffectiveMaxContinuationTurns(ticket.projectId) : MAX_CONTINUATION_TURNS;

    // Compose the supervisor framing as the goal text. The column's
    // session.ensure path also sees ticket_id / project_id / workspace_dir
    // in session.variables (set via buildSessionVariables), so omni-code
    // tools can read structured ticket context without parsing this
    // prompt.
    const supervisorPrompt = this.buildFullSupervisorPrompt(ticketId);

    console.log(`[SupervisorOrchestrator] startMachineRun: bridge.startGoal for ${ticketId}`);
    state.transition('running' as TicketPhase);
    void this.deps.bridge
      .startGoal({
        ticketId,
        prompt: supervisorPrompt,
        maxTurns,
        runOverrides: {
          additionalInstructions: supervisorPrompt,
          safeToolOverrides: { safe_tool_patterns: ['.*'] },
        },
      })
      .catch((error) => {
        console.error(`[SupervisorOrchestrator] bridge.startGoal failed for ${ticketId}:`, error);
        if (state.isActive() && state.getPhase() !== 'error') {
          state.forcePhase('error' as TicketPhase);
        }
      });
  };

  /**
   * IPC entry point: ensure the Code column for a ticket exists (create tab
   * if missing, register SupervisorEntry). Idempotent; wraps `ensureColumn`
   * in the per-ticket lock.
   */
  ensureSupervisorInfraLocked = (ticketId: TicketId): Promise<void> => {
    return this.withTicketLock(ticketId, async () => {
      await this.ensureColumn(ticketId);
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
   * Flip a ticket into autopilot. Ensures a Code column exists, sets
   * `ticket.autopilot = true` (the column re-renders with catch-all
   * safe_tool_overrides and the supervisor prompt is passed alongside), then
   * submits the initial run prompt through the same `handleSubmit` path the
   * user's keyboard uses.
   */
  startSupervisor = (ticketId: TicketId, profileName?: string): Promise<void> => {
    return this.withTicketLock(ticketId, async () => {
      const preflightError = this.validateDispatchPreflight(ticketId);
      if (preflightError) {
        console.warn(`[SupervisorOrchestrator] Dispatch preflight failed for ${ticketId}: ${preflightError}`);
        throw new Error(preflightError);
      }

      const ticket = this.deps.host.getTicketById(ticketId)!;
      const project = this.deps.store.getProjects().find((p) => p.id === ticket.projectId)!;

      const projectSource = firstSource(project);
      if (projectSource?.kind === 'local') {
        await this.deps.workflowLoader.load(ticket.projectId, projectSource.workspaceDir);
        const hookOk = await this.deps.workflowLoader.runHook(
          ticket.projectId,
          'before_run',
          projectSource.workspaceDir
        );
        if (!hookOk) {
          console.warn(`[SupervisorOrchestrator] before_run hook failed for ${ticketId}. Aborting start.`);
          throw new Error('before_run hook failed');
        }
      } else if (projectSource?.kind === 'git-remote') {
        const effectiveBranch = this.deps.host.resolveTicketBranch(ticket) ?? projectSource.defaultBranch;
        await this.deps.workflowLoader.loadFromRemote(ticket.projectId, projectSource.repoUrl, effectiveBranch);
      }

      console.log(`[SupervisorOrchestrator] startSupervisor: ensureColumn for ${ticketId}...`);
      const entry = await this.ensureColumn(ticketId, profileName);

      const phase = entry.state.getPhase();
      if (phase === 'idle' || phase === 'error' || phase === 'completed') {
        entry.state.forcePhase('ready' as TicketPhase);
      }

      if (firstSource(project)?.kind === 'git-remote') {
        const hookScript = this.deps.workflowLoader.getConfig(ticket.projectId).hooks?.before_run;
        if (hookScript && entry.tabId && this.deps.processManager) {
          const hookOk = await this.execHookInContainer(entry.tabId, hookScript);
          if (!hookOk) {
            console.warn(
              `[SupervisorOrchestrator] before_run hook failed in container for ${ticketId}. Aborting start.`
            );
            throw new Error('before_run hook failed');
          }
        }
      }

      // Flip the autopilot flag so the column boots its next submit with
      // catch-all safe_tool_overrides. Setting it before startMachineRun
      // ensures the supervisorPrompt we send is paired with the right
      // approval policy at the column.
      this.deps.host.updateTicket(ticketId, { autopilot: true });

      console.log(`[SupervisorOrchestrator] startSupervisor: startMachineRun for ${ticketId}`);
      this.startMachineRun(ticketId);
    });
  };

  /**
   * Exec a shell hook inside the Code tab's sandbox container. No-op today;
   * ProcessManager doesn't expose execInContainer directly, so remote-mode
   * hook execution is a follow-up. Treat as success so the supervisor doesn't
   * abort — the hook still runs at the project-directory level where that
   * pathway is exercised.
   */

  private execHookInContainer(_tabId: CodeTabId, _command: string): Promise<boolean> {
    return Promise.resolve(true);
  }

  stopSupervisor = (ticketId: TicketId): Promise<void> => {
    return this.withTicketLock(ticketId, async () => {
      const entry = this.machines.get(ticketId);
      // Always flip autopilot off — even if the state record is gone, the
      // persisted flag needs to be cleared.
      if (this.deps.host.getTicketById(ticketId)?.autopilot) {
        this.deps.host.updateTicket(ticketId, { autopilot: false });
      }
      if (!entry) {
        return;
      }
      try {
        await this.deps.bridge.stopGoal(ticketId);
      } catch (err) {
        console.warn(`[SupervisorOrchestrator] bridge.stopGoal failed for ${ticketId}:`, err);
      }
      entry.state.setRunId(null);
      if (entry.state.getPhase() !== 'idle') {
        entry.state.forcePhase('idle' as TicketPhase);
      }
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
    if (ticket.worktreePath && firstSource(project)?.kind === 'local') {
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
    const removeSource = firstSource(project);
    if (removeSource?.kind === 'local') {
      const workspaceDir = ticket.worktreePath ?? removeSource.workspaceDir;
      await this.deps.workflowLoader.runHook(ticket.projectId, 'before_remove', workspaceDir);
    } else if (removeSource?.kind === 'git-remote') {
      const hookScript = this.deps.workflowLoader.getConfig(ticket.projectId).hooks?.before_remove;
      if (hookScript) {
        const machineEntry = this.machines.get(ticketId);
        if (machineEntry?.tabId) {
          await this.execHookInContainer(machineEntry.tabId, hookScript);
        }
      }
    }

    // Dispose state + tell renderer to drop the column binding.
    const machineEntry = this.machines.get(ticketId);
    if (machineEntry) {
      try {
        await this.deps.bridge.dispose(ticketId);
      } catch (err) {
        console.warn(`[SupervisorOrchestrator] bridge.dispose failed for ${ticketId}:`, err);
      }
      machineEntry.state.dispose();
      this.machines.delete(ticketId);
    }

    // Stop the sandbox process owned by the Code tab (if still running).
    if (machineEntry?.tabId && this.deps.processManager) {
      try {
        await this.deps.processManager.stop(machineEntry.tabId);
      } catch (err) {
        console.warn(`[SupervisorOrchestrator] processManager.stop failed for ${ticketId}:`, err);
      }
    }

    // Clear any persisted task record.
    if (taskId) {
      this.tasks.delete(taskId);
      this.removePersistedTask(taskId);
    }

    // Remove worktree (source of truth is the ticket, not the task)
    if (ticket.worktreePath && ticket.worktreeName && project && firstSource(project)?.kind === 'local') {
      await removeWorktree(requireLocalWorkspaceDir(firstSource(project)), ticket.worktreePath, ticket.worktreeName);
      this.deps.host.updateTicket(ticketId, {
        worktreePath: undefined,
        worktreeName: undefined,
        cleanupPending: undefined,
        autopilot: false,
      });
    } else if (ticket.cleanupPending) {
      this.deps.host.updateTicket(ticketId, { cleanupPending: undefined, autopilot: false });
    } else if (ticket.autopilot) {
      this.deps.host.updateTicket(ticketId, { autopilot: false });
    }

    console.log(`[SupervisorOrchestrator] Cleaned up workspace for ticket ${ticketId}.`);
  };

  /**
   * Retry deferred cleanup for a ticket whose worktree was dirty when it was
   * first resolved. Re-checks dirtiness; if still dirty, returns false and
   * leaves `cleanupPending` set. Otherwise runs full teardown and returns true.
   */
  finalizeTicketCleanup = (ticketId: TicketId): Promise<boolean> => {
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

  /**
   * Reset the ticket's chat session: stop any in-flight run and tell the
   * column to mint a fresh session id. Orthogonal to autopilot — resetting
   * does not flip `ticket.autopilot`.
   */
  resetSupervisorSession = (ticketId: TicketId): Promise<void> => {
    return this.withTicketLock(ticketId, async () => {
      try {
        await this.deps.bridge.stop(ticketId);
      } catch (err) {
        console.warn(`[SupervisorOrchestrator] bridge.stop failed for reset ${ticketId}:`, err);
      }
      const entry = this.machines.get(ticketId);
      if (entry) {
        entry.state.setRunId(null);
        if (entry.state.getPhase() !== 'idle') {
          entry.state.forcePhase('idle' as TicketPhase);
        }
      }
      try {
        await this.deps.bridge.reset(ticketId);
      } catch (err) {
        console.warn(`[SupervisorOrchestrator] bridge.reset failed for ${ticketId}:`, err);
      }
    });
  };

  /**
   * Forward a user-typed message to the ticket's Code column. If nothing is
   * streaming, send it as a fresh run. If a run is streaming, piggyback on
   * the existing run's input channel.
   */
  sendSupervisorMessage = (ticketId: TicketId, message: string): Promise<void> => {
    return this.withTicketLock(ticketId, async () => {
      const ticket = this.deps.host.getTicketById(ticketId);
      if (!ticket) {
        throw new Error(`Ticket not found: ${ticketId}`);
      }
      const entry = this.machines.get(ticketId);

      if (!entry) {
        if (!this.canStartSupervisor(ticket.projectId, ticket.columnId)) {
          throw new Error('Concurrency limit reached');
        }
        const collision = this.findWorkspaceCollision(ticketId);
        if (collision) {
          const hint = ticket.useWorktree === false ? ' Enable worktrees on this ticket to run them in parallel.' : '';
          throw new Error(`"${collision.title}" is already running in this workspace — stop it first.${hint}`);
        }
        await this.ensureColumn(ticketId);
      }

      const current = this.machines.get(ticketId);
      if (current?.state.isStreaming()) {
        try {
          await this.deps.bridge.send(ticketId, message);
        } catch (error) {
          console.error(`[SupervisorOrchestrator] bridge.send failed for ${ticketId}:`, error);
        }
        return;
      }

      // No run in flight — start one with the user's message as the prompt.
      // autopilot stays as-is (user-initiated messages should preserve mode).
      try {
        current?.state.recordActivity();
        await this.deps.bridge.run({ ticketId, prompt: message });
      } catch (error) {
        console.error(`[SupervisorOrchestrator] bridge.run failed for ${ticketId}:`, error);
      }
    });
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
        if (firstSource(project)?.kind === 'local') {
          await removeWorktree(
            requireLocalWorkspaceDir(firstSource(project)),
            ticket.worktreePath,
            ticket.worktreeName
          );
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
          if (firstSource(project)?.kind === 'local') {
            await removeWorktree(requireLocalWorkspaceDir(firstSource(project)), task.worktreePath, task.worktreeName);
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
    // Stop every Code tab sandbox tied to this project via the shared ProcessManager.
    const pm = this.deps.processManager;
    if (pm) {
      const codeTabs = this.deps.store.getCodeTabs() as Array<{ id: string; ticketId?: string }>;
      const tickets = this.deps.host.getTicketsByProject(projectId);
      const ticketIds = new Set(tickets.map((t) => t.id));
      const stops: Promise<void>[] = [];
      for (const tab of codeTabs) {
        if (tab.ticketId && ticketIds.has(tab.ticketId as TicketId)) {
          stops.push(pm.stop(tab.id).catch(() => {}));
        }
      }
      await Promise.allSettled(stops);
    }
    // Drop any in-memory task records for the project and persist.
    for (const [taskId, entry] of this.tasks) {
      if (entry.task.projectId === projectId) {
        this.tasks.delete(taskId);
      }
    }
    const remaining = this.deps.store.getPersistedTasks().filter((t) => t.projectId !== projectId);
    this.deps.store.setPersistedTasks(remaining);
  };

  /** Clear the task metadata map. Sandboxes are owned by ProcessManager, which is cleaned up separately. */
  exitAllTasks = (): Promise<void> => {
    this.tasks.clear();
    return Promise.resolve();
  };

  // -------------------------------------------------------------------------
  // Dispatch preflight + auto-dispatch loop (C2c.7)
  // -------------------------------------------------------------------------

  /** Number of supervisors currently active across all projects. */
  private getRunningSupervisorCount(): number {
    let count = 0;
    for (const [, entry] of this.machines) {
      if (entry.state.isActive()) {
        count++;
      }
    }
    return count;
  }

  /** Active supervisors in a specific column for a project. */
  private getRunningSupervisorCountByColumn(projectId: ProjectId, columnId: ColumnId): number {
    let count = 0;
    for (const [ticketId, entry] of this.machines) {
      if (!entry.state.isActive()) {
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
    if (project.sources.length === 0) {
      return `Project "${project.label}" has no repository — supervisors require a workspace or git remote`;
    }
    if (
      firstSource(project)?.kind === 'local' &&
      !(firstSource(project) as Extract<ProjectSource, { kind: 'local' }> | undefined)?.workspaceDir
    ) {
      return `Project "${project.label}" has no workspace directory configured`;
    }
    if (
      firstSource(project)?.kind === 'git-remote' &&
      !(firstSource(project) as Extract<ProjectSource, { kind: 'git-remote' }> | undefined)?.repoUrl
    ) {
      return `Project "${project.label}" has no repository URL configured`;
    }

    if (this.deps.host.isTerminalColumn(ticket.projectId, ticket.columnId)) {
      return `Ticket is in terminal column "${ticket.columnId}" — cannot start supervisor`;
    }

    // Check machine to prevent duplicate dispatch — allow starting from 'ready' (manual session)
    const machineEntry = this.machines.get(ticketId);
    if (machineEntry) {
      const phase = machineEntry.state.getPhase();
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

    const collision = this.findWorkspaceCollision(ticketId);
    if (collision) {
      const hint = ticket.useWorktree === false ? ' Enable worktrees on this ticket to run them in parallel.' : '';
      return `"${collision.title}" is already running in this workspace — stop it first.${hint}`;
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
      if (machineEntry && machineEntry.state.isActive()) {
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

  /**
   * Build the full supervisor prompt, incorporating FLEET.md custom prompt if present.
   */
  private buildFullSupervisorPrompt(ticketId: TicketId, attempt: number | null = null): string {
    const ticket = this.deps.host.getTicketById(ticketId)!;
    const project = this.deps.store.getProjects().find((p) => p.id === ticket.projectId)!;
    const pipeline = this.deps.host.getPipeline(ticket.projectId);

    // Gather context for the supervisor prompt
    const context: SupervisorContext = { artifactsDir: this.deps.host.getAgentArtifactsDir(ticketId) };

    // Project brief: read the root page's body. Routed through PageManager
    // so the lookup follows the same projectId-keyed layout the rest of the
    // app uses; the host promise is awaited synchronously via .then because
    // buildFullSupervisorPrompt itself is sync — we set the field on the
    // context object that hasn't been frozen yet.
    const rootPage = this.deps.host.getPagesByProject(ticket.projectId).find((p) => p.isRoot);
    if (rootPage) {
      const filePath = path.join(getProjectPagesDir(ticket.projectId), `${rootPage.id}.md`);
      try {
        if (existsSync(filePath)) {
          const brief = readFileSync(filePath, 'utf-8');
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
            columnId: logicalColumnId(ticket.projectId, ticket.columnId),
            branch: this.deps.host.resolveTicketBranch(ticket),
          },
          pipeline: {
            columns: pipeline.columns.map((c) => c.label).join(' → '),
          },
          project: (() => {
            const s = firstSource(project);
            const dir = s?.kind === 'local' ? s.workspaceDir : s?.kind === 'git-remote' ? s.repoUrl : '';
            return { label: project.label, workspaceDir: dir };
          })(),
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

  /** Release bridge subscription on shutdown. */
  dispose(): void {
    if (this.offBridge) {
      this.offBridge();
      this.offBridge = null;
    }
  }
}
