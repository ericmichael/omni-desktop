import { execFile } from 'child_process';
import { ipcMain, shell } from 'electron';
import type Store from 'electron-store';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import fs from 'fs/promises';
import { nanoid } from 'nanoid';
import path from 'path';
import { promisify } from 'util';

import { getArtifactsDir } from '@/lib/artifacts';
import { listArtifactEntries, readArtifactFile, resolveArtifactPath } from '@/lib/artifacts-fs';
import { getGitFilesChanged, resolveWorkspaceMergeBase, resolveWorktreeMergeBase } from '@/lib/git-files-changed';
import { INBOX_SWEEP_INTERVAL_MS } from '@/lib/inbox-expiry';
import type { IMachineFactory, ISandboxFactory, IWorkflowLoader, ProjectManagerDeps } from '@/lib/project-manager-deps';
import { runMigrations as runSchemaMigrations } from '@/lib/project-migrations';
import { type HistoryRow, parseSessionHistoryRows } from '@/lib/session-history';
import { AgentProcess } from '@/main/agent-process';
import { registerInboxHandlers } from '@/main/inbox-handlers';
import { InboxManager, type InboxManagerStore } from '@/main/inbox-manager';
import { registerMilestoneHandlers } from '@/main/milestone-handlers';
import { MilestoneManager, type MilestoneManagerStore } from '@/main/milestone-manager';
import { registerPageHandlers } from '@/main/page-handlers';
import { PageManager, type PageManagerStore } from '@/main/page-manager';
import type { ProcessManager } from '@/main/process-manager';
import { registerProjectHandlers } from '@/main/project-handlers';
import { registerSupervisorHandlers } from '@/main/supervisor-handlers';
import { SupervisorOrchestrator } from '@/main/supervisor-orchestrator';
import { ensureDirectory, getDefaultWorkspaceDir, getOmniConfigDir, getProjectDir } from '@/main/util';
import { WorkflowLoader } from '@/main/workflow-loader';
import type { IIpcListener } from '@/shared/ipc-listener';
import { DEFAULT_PIPELINE, SIMPLE_PIPELINE } from '@/shared/pipeline-defaults';
import type {
  ArtifactFileContent,
  ArtifactFileEntry,
  ColumnId,
  DiffResponse,
  InboxItem,
  IpcRendererEvents,
  Milestone,
  MilestoneId,
  Page,
  Pipeline,
  Project,
  ProjectId,
  SessionMessage,
  StoreData,
  Task,
  Ticket,
  TicketId,
  TicketPriority,
} from '@/shared/types';

const execFileAsync = promisify(execFile);

const DEFAULT_BRIEF_TEMPLATE = `## Problem


## Appetite


## Solution direction


## Open questions
- [ ]

## Decisions


## Out of scope

`;

// Worktree helpers (generateWorktreeName, createWorktree, removeWorktree,
// ADJECTIVES/NOUNS) moved to `@/main/worktree-ops` in Sprint C2c.4.
// `checkGitRepo` moved too — it is imported from the new module and re-exported
// via the IPC handler.

// Operational constants (MAX_CONCURRENT_SUPERVISORS, STALL_TIMEOUT_MS, etc.)
// now live in `@/main/supervisor-orchestrator` and are re-imported at the top
// of this file while the retry / stall / auto-dispatch methods still reside
// in ProjectManager. classifyRunEndReason / decideRunEndAction imported from
// @/lib/run-end.

export class ProjectManager {
  private store: Store<StoreData>;
  private sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;

  /** Workflow file loader (FLEET.md) per project. */
  private workflowLoader: IWorkflowLoader;

  /** Interval handle for inbox expiry sweep. */
  private inboxSweepTimer: ReturnType<typeof setInterval> | null = null;

  /** Injectable factories for testing. Always set — defaults to a real-AgentProcess factory. */
  private sandboxFactory: ISandboxFactory;
  private machineFactory?: IMachineFactory;

  /** Optional ProcessManager — when set, supervisor reuses Code tab sandboxes. */
  private processManager?: ProcessManager;

  /** Page lifecycle owner — CRUD, file I/O, root-page seeding, watcher. */
  readonly pages: PageManager;

  /** Inbox lifecycle owner — CRUD, shape, defer, promote, sweep, gc. */
  readonly inbox: InboxManager;

  /** Milestone lifecycle owner — CRUD, completedAt stamping, orphan-ticket clear, branch fallback. */
  readonly milestones: MilestoneManager;

  /**
   * Supervisor lifecycle owner. Owns machines, retry queue, stall detection,
   * infra provisioning, dispatch preflight + auto-dispatch loop, task
   * persistence + boot recovery, tool dispatch, and supervisor prompt
   * assembly. Sprint C2c moved every concern listed above out of
   * ProjectManager into this class; only the IPC wiring still funnels
   * through PM.
   */
  readonly supervisors: SupervisorOrchestrator;

  constructor(
    arg: { store: Store<StoreData>; sendToWindow: ProjectManager['sendToWindow']; processManager?: ProcessManager },
    deps?: Partial<ProjectManagerDeps>
  ) {
    this.store = arg.store;
    this.sendToWindow = arg.sendToWindow;
    this.processManager = arg.processManager;
    // Let ProcessManager fall back to supervisor sandbox status for ticket-linked tabs.
    // The orchestrator may not exist yet at this point in the constructor — defer
    // the lookup with an arrow function.
    if (this.processManager) {
      this.processManager.statusFallback = (processId) => this.supervisors.getSupervisorStatusForCodeTab(processId);
    }
    this.workflowLoader =
      deps?.workflowLoader ??
      new WorkflowLoader({
        onChange: (projectId, workflow) => {
          console.log(
            `[ProjectManager] FLEET.md reloaded for project ${projectId}${
              workflow.promptTemplate ? ' (has custom prompt)' : ''
            }${
              workflow.config.supervisor ? ' (has supervisor config)' : ''
            }${workflow.config.hooks ? ' (has hooks)' : ''}`
          );
          // Push updated pipeline to the renderer so the UI reflects FLEET.md changes
          const pipeline = this.getPipeline(projectId);
          this.sendToWindow('project:pipeline', projectId, pipeline);

          // Migrate tickets whose columnId no longer exists in the new pipeline
          this.migrateOrphanedTickets(projectId, pipeline);
        },
      });
    this.sandboxFactory = deps?.sandboxFactory ?? {
      create: (opts) => new AgentProcess(opts),
    };
    this.machineFactory = deps?.machineFactory;

    const pageStore: PageManagerStore = {
      getPages: () => (this.store.get('pages') ?? []) as Page[],
      setPages: (items) => {
        this.store.set('pages', items);
        this.sendToWindow('store:changed', this.store.store);
      },
      getProjects: () => this.getProjects(),
    };
    this.pages = new PageManager({
      store: pageStore,
      sendToWindow: this.sendToWindow,
      resolveProjectDir: (project) => this.getProjectDirPath(project),
    });
    const inboxStore: InboxManagerStore = {
      getInboxItems: () => (this.store.get('inboxItems') ?? []) as InboxItem[],
      setInboxItems: (items) => {
        this.store.set('inboxItems', items);
        this.sendToWindow('store:changed', this.store.store);
      },
      getTickets: () => this.getTickets(),
      setTickets: (tickets) => this.setTickets(tickets),
      getProjects: () => this.getProjects(),
      setProjects: (projects) => this.setProjects(projects),
    };
    this.inbox = new InboxManager({
      store: inboxStore,
      newId: () => nanoid(),
      now: () => Date.now(),
    });

    const milestoneStore: MilestoneManagerStore = {
      getMilestones: () => (this.store.get('milestones') ?? []) as Milestone[],
      setMilestones: (items) => {
        this.store.set('milestones', items);
        this.sendToWindow('store:changed', this.store.store);
      },
      getTickets: () => this.getTickets(),
      setTickets: (tickets) => this.setTickets(tickets),
    };
    this.milestones = new MilestoneManager({
      store: milestoneStore,
      newId: () => nanoid(),
      now: () => Date.now(),
    });

    this.supervisors = new SupervisorOrchestrator({
      store: {
        getTickets: () => this.getTickets(),
        setTickets: (tickets) => this.setTickets(tickets),
        getProjects: () => this.getProjects(),
        getWipLimit: () => this.store.get('wipLimit') ?? 3,
        getSandboxBackend: () => this.store.get('sandboxBackend'),
        getPlatformCredentials: () => this.store.get('platform'),
        getCodeTabs: () => (this.store.get('codeTabs', []) ?? []) as Array<{ id: string; ticketId?: string }>,
        getPersistedTasks: () => this.store.get('tasks', []) as Task[],
        setPersistedTasks: (tasks) => {
          this.store.set('tasks', tasks);
          this.sendToWindow('store:changed', this.store.store);
        },
      },
      host: {
        getTicketById: (ticketId) => this.getTicketById(ticketId),
        getTicketsByProject: (projectId) => this.getTicketsByProject(projectId),
        addTicket: (input) => this.addTicket(input),
        updateTicket: (ticketId, patch) => this.updateTicket(ticketId, patch),
        isTerminalColumn: (projectId, columnId) => this.isTerminalColumn(projectId, columnId),
        getColumn: (projectId, columnId) => this.getColumn(projectId, columnId),
        getPipeline: (projectId) => this.getPipeline(projectId),
        resolveTicketBranch: (ticket) => this.milestones.resolveTicketBranch(ticket),
        getNextTicket: (projectId) => this.getNextTicket(projectId),
        moveTicketToColumn: (ticketId, columnId) => this.moveTicketToColumn(ticketId, columnId),
        updateProject: (projectId, patch) => this.updateProject(projectId, patch),
        getMilestonesByProject: (projectId) => this.milestones.getByProject(projectId),
        getMilestoneById: (milestoneId) => this.milestones.getById(milestoneId),
        getPagesByProject: (projectId) => this.pages.getByProject(projectId),
        getPageById: (pageId) => this.pages.getById(pageId),
        readPageContent: (pageId) => this.pages.readContent(pageId),
        getProjectDirPath: (project) => this.getProjectDirPath(project),
      },
      workflowLoader: this.workflowLoader,
      sendToWindow: this.sendToWindow,
      sandboxFactory: this.sandboxFactory,
      machineFactory: this.machineFactory,
      processManager: this.processManager,
    });

    this.supervisors.startStallDetection();
    this.supervisors.startAutoDispatch();
    this.startInboxSweep();
  }

  /** Public accessor used by IPC wiring to resolve a project's working directory. */
  getProjectDir = (projectId: ProjectId): string | null => {
    const project = this.getProjects().find((p) => p.id === projectId);
    return project ? this.getProjectDirPath(project) : null;
  };

  // #region Projects (persisted in electron-store)

  private getProjects = (): Project[] => {
    return this.store.get('projects', []);
  };

  private setProjects = (projects: Project[]): void => {
    this.store.set('projects', projects);
    this.sendToWindow('store:changed', this.store.store);
  };

  addProject = (input: Omit<Project, 'id' | 'createdAt'>): Project => {
    const project: Project = {
      ...input,
      id: nanoid(),
      createdAt: Date.now(),
    };
    const projects = this.getProjects();
    projects.push(project);
    this.setProjects(projects);
    // Seed the project's root page through PageManager.
    this.pages.seedRootPage(project);
    // Create project directory and context.md
    void this.ensureProjectDir(project);
    // Eagerly load FLEET.md so the pipeline is ready when the UI fetches it.
    // Personal / context-only projects (no source) have no FLEET.md and no
    // workflow to load — they use SIMPLE_PIPELINE and run no hooks. See getPipeline().
    if (project.source?.kind === 'local') {
      void this.workflowLoader.load(project.id, project.source.workspaceDir);
    } else if (project.source?.kind === 'git-remote') {
      void this.workflowLoader.loadFromRemote(project.id, project.source.repoUrl, project.source.defaultBranch);
    }
    return project;
  };

  updateProject = (id: ProjectId, patch: Partial<Omit<Project, 'id' | 'createdAt'>>): void => {
    const projects = this.getProjects();
    const index = projects.findIndex((p) => p.id === id);
    if (index === -1) {
      return;
    }
    projects[index] = { ...projects[index]!, ...patch };
    this.setProjects(projects);
  };

  removeProject = async (id: ProjectId): Promise<void> => {
    await this.supervisors.removeAllTasksForProject(id);
    const projects = this.getProjects().filter((p) => p.id !== id);
    this.setProjects(projects);
    const remainingTickets = this.getTickets().filter((t) => t.projectId !== id);
    this.setTickets(remainingTickets);
    this.milestones.removeAllForProject(id);
    this.pages.removeAllForProject(id);
  };

  // #endregion

  // #region Project directories & context files

  /** Get the project directory path. Personal projects use workspace root; others use Projects/<slug>/. */
  private getProjectDirPath = (project: Project): string => {
    if (project.isPersonal) {
      return getDefaultWorkspaceDir();
    }
    return getProjectDir(project.slug);
  };

  /** Ensure the project directory and context.md exist on disk. */
  private ensureProjectDir = async (project: Project): Promise<void> => {
    const dir = this.getProjectDirPath(project);
    await ensureDirectory(dir);
    const contextPath = path.join(dir, 'context.md');
    try {
      await fs.access(contextPath);
    } catch {
      // Write default context template
      await fs.writeFile(contextPath, DEFAULT_BRIEF_TEMPLATE, 'utf-8');
    }
  };

  /** Read context.md for a project. Returns empty string if file doesn't exist. */
  readContext = async (projectId: ProjectId): Promise<string> => {
    const project = this.getProjects().find((p) => p.id === projectId);
    if (!project) {
      return '';
    }
    const contextPath = path.join(this.getProjectDirPath(project), 'context.md');
    try {
      return await fs.readFile(contextPath, 'utf-8');
    } catch {
      return '';
    }
  };

  /** Write context.md for a project. Creates the directory if needed. */
  writeContext = async (projectId: ProjectId, content: string): Promise<void> => {
    const project = this.getProjects().find((p) => p.id === projectId);
    if (!project) {
      return;
    }
    const dir = this.getProjectDirPath(project);
    await ensureDirectory(dir);
    await fs.writeFile(path.join(dir, 'context.md'), content, 'utf-8');
  };

  /** List files in the project folder (excluding context.md). */
  listProjectFiles = async (projectId: ProjectId): Promise<ArtifactFileEntry[]> => {
    const project = this.getProjects().find((p) => p.id === projectId);
    if (!project) {
      return [];
    }
    const dir = this.getProjectDirPath(project);

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const results: ArtifactFileEntry[] = [];

      for (const entry of entries) {
        if (entry.name === 'context.md') {
          continue;
        }
        const fullPath = path.join(dir, entry.name);
        try {
          const stat = await fs.stat(fullPath);
          results.push({
            relativePath: entry.name,
            name: entry.name,
            isDirectory: entry.isDirectory(),
            size: stat.size,
            modifiedAt: stat.mtimeMs,
          });
        } catch {
          // Skip entries we can't stat
        }
      }

      results.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      return results;
    } catch {
      return [];
    }
  };

  /** Get first 200 chars of context.md for preview. */
  getContextPreview = async (projectId: ProjectId): Promise<string> => {
    const content = await this.readContext(projectId);
    return content.slice(0, 200);
  };

  /** Open a file from the project folder in the OS default application. */
  openProjectFile = async (projectId: ProjectId, relativePath: string): Promise<void> => {
    const project = this.getProjects().find((p) => p.id === projectId);
    if (!project) {
      return;
    }
    const dir = this.getProjectDirPath(project);
    const fullPath = path.resolve(dir, relativePath);
    // Validate no directory traversal — must use separator-terminated prefix
    // to prevent sibling directory bypass (e.g. dir="/tmp/proj" matching "/tmp/proj-evil/secret")
    const normalizedDir = dir.endsWith(path.sep) ? dir : dir + path.sep;
    if (!fullPath.startsWith(normalizedDir) && fullPath !== dir) {
      throw new Error('Path traversal not allowed');
    }
    await shell.openPath(fullPath);
  };

  // #endregion

  // #region Pipeline helpers

  /** Load FLEET.md for a project if not already loaded. */
  ensureWorkflowLoaded = async (projectId: ProjectId): Promise<void> => {
    if (this.workflowLoader.get(projectId)) {
      return;
    }
    const project = this.getProjects().find((p) => p.id === projectId);
    if (!project) {
      return;
    }

    if (project.source?.kind === 'local') {
      await this.workflowLoader.load(projectId, project.source?.workspaceDir);
    } else if (project.source?.kind === 'git-remote') {
      await this.workflowLoader.loadFromRemote(projectId, project.source?.repoUrl, project.source?.defaultBranch);
    }
    // Migrate any tickets with stale columnIds after first load
    const pipeline = this.getPipeline(projectId);
    this.migrateOrphanedTickets(projectId, pipeline);
  };

  getPipeline = (projectId: ProjectId): Pipeline => {
    // Priority: FLEET.md pipeline → project.pipeline → DEFAULT_PIPELINE
    const workflowPipeline = this.workflowLoader.getConfig(projectId).pipeline;
    if (workflowPipeline && workflowPipeline.columns.length > 0) {
      return {
        columns: workflowPipeline.columns.map((col) => ({
          id: col.id,
          label: col.label,
        })),
      };
    }
    const project = this.getProjects().find((p) => p.id === projectId);
    if (project?.pipeline) {
      return project.pipeline;
    }
    // Projects with a linked repo get the full dev pipeline; others get the simple one
    return project?.source ? DEFAULT_PIPELINE : SIMPLE_PIPELINE;
  };

  private getColumn = (projectId: ProjectId, columnId: ColumnId) => {
    const pipeline = this.getPipeline(projectId);
    return pipeline.columns.find((c) => c.id === columnId);
  };

  /** The first column in the pipeline (where new tickets land). */
  private getFirstColumnId = (projectId: ProjectId): ColumnId => {
    const pipeline = this.getPipeline(projectId);
    return pipeline.columns[0]?.id ?? 'backlog';
  };

  /** The last column in the pipeline (terminal — stops supervisor). */
  private getTerminalColumnId = (projectId: ProjectId): ColumnId => {
    const pipeline = this.getPipeline(projectId);
    return pipeline.columns[pipeline.columns.length - 1]?.id ?? 'completed';
  };

  /** Check if a column is the terminal (last) column for a project. */
  private isTerminalColumn = (projectId: ProjectId, columnId: ColumnId): boolean => {
    return columnId === this.getTerminalColumnId(projectId);
  };

  /** Check if a column is the first (backlog) column for a project. */
  private isFirstColumn = (projectId: ProjectId, columnId: ColumnId): boolean => {
    return columnId === this.getFirstColumnId(projectId);
  };

  /** Move tickets whose columnId no longer exists in the pipeline to the first column. */
  private migrateOrphanedTickets = (projectId: ProjectId, pipeline: Pipeline): void => {
    const columnIds = new Set(pipeline.columns.map((c) => c.id));
    const firstColumnId = pipeline.columns[0]?.id;
    if (!firstColumnId) {
      return;
    }

    const tickets = this.getTickets();
    let changed = false;
    for (const ticket of tickets) {
      if (ticket.projectId === projectId && ticket.columnId && !columnIds.has(ticket.columnId)) {
        console.log(
          `[ProjectManager] Migrating ticket ${ticket.id} from orphaned column "${ticket.columnId}" to "${firstColumnId}"`
        );
        ticket.columnId = firstColumnId;
        changed = true;
      }
    }
    if (changed) {
      this.setTickets(tickets);
    }
  };

  // #endregion

  // #region Tickets (persisted in electron-store)

  private getTickets = (): Ticket[] => {
    return this.store.get('tickets', []);
  };

  private setTickets = (tickets: Ticket[]): void => {
    this.store.set('tickets', tickets);
    this.sendToWindow('store:changed', this.store.store);
  };

  private getTicketById = (ticketId: TicketId): Ticket | undefined => {
    return this.getTickets().find((t) => t.id === ticketId);
  };

  addTicket = (
    input: Omit<Ticket, 'id' | 'createdAt' | 'updatedAt' | 'columnId'> & { milestoneId?: MilestoneId }
  ): Ticket => {
    const now = Date.now();
    const ticket: Ticket = {
      ...input,
      id: nanoid(),
      columnId: this.getFirstColumnId(input.projectId),
      createdAt: now,
      updatedAt: now,
    };
    const tickets = this.getTickets();
    tickets.push(ticket);
    this.setTickets(tickets);
    return ticket;
  };

  updateTicket = (id: TicketId, patch: Partial<Omit<Ticket, 'id' | 'projectId' | 'createdAt'>>): void => {
    const tickets = this.getTickets();
    const index = tickets.findIndex((t) => t.id === id);
    if (index === -1) {
      return;
    }
    tickets[index] = { ...tickets[index]!, ...patch, updatedAt: Date.now() };
    this.setTickets(tickets);
  };

  removeTicket = (id: TicketId): void => {
    // Stop machine if running
    const machineEntry = this.supervisors.machines.get(id);
    if (machineEntry) {
      void machineEntry.machine.dispose();
      void machineEntry.sandbox?.exit();
      this.supervisors.machines.delete(id);
    }

    const tickets = this.getTickets().filter((t) => t.id !== id);
    this.setTickets(tickets);
  };

  getTicketsByProject = (projectId: ProjectId): Ticket[] => {
    return this.getTickets().filter((t) => t.projectId === projectId);
  };

  getTasks = (): Task[] => this.supervisors.listTasks();

  private static PRIORITY_ORDER: Record<TicketPriority, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  getNextTicket = (projectId: ProjectId): Ticket | null => {
    const tickets = this.getTicketsByProject(projectId);
    const ticketMap = new Map(tickets.map((t) => [t.id, t]));

    const isBlocked = (ticket: Ticket): boolean => {
      return ticket.blockedBy.some((blockerId) => {
        const blocker = ticketMap.get(blockerId);
        // A ticket is blocked if the blocker is not in the terminal column
        return blocker && !this.isTerminalColumn(projectId, blocker.columnId);
      });
    };

    const firstColumnId = this.getFirstColumnId(projectId);
    const candidates = tickets.filter((t) => t.columnId === firstColumnId && !isBlocked(t));
    candidates.sort((a, b) => {
      const priorityDiff = ProjectManager.PRIORITY_ORDER[a.priority] - ProjectManager.PRIORITY_ORDER[b.priority];
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      return a.createdAt - b.createdAt;
    });

    return candidates[0] ?? null;
  };

  // #endregion

  // #region Inbox sweep (auto-expire stale inbox pages → later)

  /**
   * Sweep stale inbox items — delegates to `InboxManager.sweepExpired()`.
   * Called on startup and on an hourly interval. Keeps the inbox from
   * turning into a graveyard of forgotten captures.
   */
  sweepExpiredInboxItems = (): void => {
    const changed = this.inbox.sweepExpired();
    if (changed > 0) {
      console.log(`[ProjectManager] Swept ${changed} expired inbox items → later`);
    }
  };

  private startInboxSweep = (): void => {
    this.sweepExpiredInboxItems();
    this.inboxSweepTimer = setInterval(() => this.sweepExpiredInboxItems(), INBOX_SWEEP_INTERVAL_MS);
  };

  // #endregion

  // Milestones — reach via `pm.milestones.*` directly. The PM-side delegators
  // were dropped in Sprint C3.

  // #region Artifacts

  private getArtifactsRoot = (ticketId: TicketId): string => {
    return getArtifactsDir(getOmniConfigDir(), ticketId);
  };

  listArtifacts = async (ticketId: TicketId, dirPath?: string): Promise<ArtifactFileEntry[]> => {
    return listArtifactEntries(this.getArtifactsRoot(ticketId), dirPath);
  };

  readArtifact = async (ticketId: TicketId, relativePath: string): Promise<ArtifactFileContent> => {
    return readArtifactFile(this.getArtifactsRoot(ticketId), relativePath);
  };

  openArtifactExternal = async (ticketId: TicketId, relativePath: string): Promise<void> => {
    const fullPath = resolveArtifactPath(this.getArtifactsRoot(ticketId), relativePath);
    await shell.openPath(fullPath);
  };

  // #endregion

  // #region Files changed (git diff)

  getFilesChanged = async (ticketId: TicketId): Promise<DiffResponse> => {
    const empty: DiffResponse = { totalFiles: 0, totalAdditions: 0, totalDeletions: 0, hasChanges: false, files: [] };

    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      return empty;
    }

    // Find the task associated with this ticket (via supervisorTaskId or ticketId on task)
    let task: Task | undefined;
    if (ticket.supervisorTaskId) {
      task = this.supervisors.tasks.get(ticket.supervisorTaskId)?.task;
    }
    if (!task) {
      // Fallback: search all tasks for one matching this ticketId
      for (const [, entry] of this.supervisors.tasks) {
        if (entry.task.ticketId === ticketId) {
          task = entry.task;
          break;
        }
      }
    }
    if (!task) {
      // Also check persisted tasks in the store
      const storedTasks = this.store.get('tasks') ?? [];
      task = storedTasks.find((t) => t.ticketId === ticketId);
    }

    // Determine the git directory and merge base reference.
    // Case 1: task has a worktree → diff worktree against its base branch
    // Case 2: no worktree (supervisor mode) → diff project workspaceDir against upstream tracking branch
    const worktreePath = ticket.worktreePath ?? task?.worktreePath;
    const worktreeBranch = this.milestones.resolveTicketBranch(ticket) ?? task?.branch;

    let gitDir: string;
    let mergeBase: string;
    if (worktreePath && worktreeBranch) {
      gitDir = worktreePath;
      mergeBase = await resolveWorktreeMergeBase(gitDir, worktreeBranch);
    } else {
      // Supervisor mode: no worktree, diff the project workspace against its upstream
      const project = this.getProjects().find((p) => p.id === ticket.projectId);
      if (!project || project.source?.kind !== 'local') {
        return empty; // git-remote diffs happen inside the container, not locally
      }
      gitDir = project.source?.workspaceDir;
      mergeBase = await resolveWorkspaceMergeBase(gitDir);
    }

    return getGitFilesChanged({ gitDir, mergeBase });
  };

  // #endregion

  // #region Column movement

  resolveTicket = (ticketId: TicketId, resolution: import('@/shared/types').TicketResolution): void => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      return;
    }
    const patch: Partial<Ticket> = { resolution, archivedAt: undefined };
    if (ticket.resolvedAt === undefined) {
      patch.resolvedAt = Date.now();
    }
    this.updateTicket(ticketId, patch);
    const terminalColumnId = this.getTerminalColumnId(ticket.projectId);
    if (ticket.columnId !== terminalColumnId) {
      this.moveTicketToColumn(ticketId, terminalColumnId);
    }
  };

  moveTicketToColumn = (ticketId: TicketId, columnId: ColumnId): void => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      return;
    }

    const column = this.getColumn(ticket.projectId, columnId);
    if (!column) {
      return;
    }

    this.updateTicket(ticketId, { columnId, columnChangedAt: Date.now() });

    // Moving into the terminal column implicitly resolves the ticket as completed
    // unless it already has an explicit outcome like won't-do/duplicate/cancelled.
    const movedTicket = this.getTicketById(ticketId);
    if (movedTicket && this.isTerminalColumn(ticket.projectId, columnId) && !movedTicket.resolution) {
      const patch: Partial<Ticket> = { resolution: 'completed', archivedAt: undefined };
      if (movedTicket.resolvedAt === undefined) {
        patch.resolvedAt = Date.now();
      }
      this.updateTicket(ticketId, patch);
    }

    // Clear resolution/archive when moving away from terminal column (reopen)
    const ticket2 = this.getTicketById(ticketId);
    if (ticket2?.resolution && !this.isTerminalColumn(ticket.projectId, columnId)) {
      this.updateTicket(ticketId, { resolution: undefined, resolvedAt: undefined, archivedAt: undefined });
    }

    // Reconciliation: stop supervisor and clean up workspace when ticket moves to a terminal column
    if (this.isTerminalColumn(ticket.projectId, columnId)) {
      // Cancel any pending retry timer first to prevent re-dispatch races
      this.supervisors.cancelRetry(ticketId);
      const entry = this.supervisors.machines.get(ticketId);
      if (entry) {
        console.log(
          `[ProjectManager] Ticket ${ticketId} moved to terminal column "${columnId}" — stopping supervisor and cleaning up workspace.`
        );
        void this.supervisors.withTicketLock(ticketId, async () => {
          await entry.machine.stop();
          await this.supervisors.cleanupTicketWorkspace(ticketId);
        });
      } else {
        void this.supervisors.cleanupTicketWorkspace(ticketId);
      }
    }

    // Also stop if moving back to the first column (user is shelving the ticket).
    // Cancel any pending retry so an armed timer doesn't revive a shelved ticket.
    if (this.isFirstColumn(ticket.projectId, columnId)) {
      const entry = this.supervisors.machines.get(ticketId);
      if (entry) {
        console.log(`[ProjectManager] Ticket ${ticketId} moved to backlog — stopping supervisor.`);
        this.supervisors.cancelRetry(ticketId);
        void this.supervisors.stopSupervisor(ticketId);
      }
    }

    // Stop supervisor (preserve workspace) when entering a gated column.
    // Same retry-timer concern as the backlog path above.
    if (column.gate) {
      const entry = this.supervisors.machines.get(ticketId);
      if (entry) {
        console.log(`[ProjectManager] Ticket ${ticketId} entered gated column "${columnId}" — stopping supervisor.`);
        this.supervisors.cancelRetry(ticketId);
        void this.supervisors.stopSupervisor(ticketId);
      }
    }
  };

  // #endregion

  // #endregion

  // Supervisor lifecycle, task persistence, auto-dispatch, dispatch preflight,
  // tool dispatch, and supervisor prompt assembly all live in
  // SupervisorOrchestrator. Reach via `pm.supervisors.*` directly. The PM-side
  // delegators were dropped in Sprint C3.

  // #region Migration

  /**
   * Migrate the store through every schema version up to the current one.
   * Pure logic lives in `@/lib/project-migrations` — this wrapper injects
   * the fs side-effects (v10 brief → context.md, v12 Personal dir) that
   * can't run in the pure module.
   */
  static migrateToSupervisor(store: Store<StoreData>): void {
    runSchemaMigrations(store as unknown as Parameters<typeof runSchemaMigrations>[0], {
      newId: () => nanoid(),
      now: () => Date.now(),
      writeProjectContextBrief: (project) => {
        const dir = project.isPersonal ? getDefaultWorkspaceDir() : getProjectDir(project.slug ?? 'project');
        const contextPath = path.join(dir, 'context.md');
        try {
          if (existsSync(contextPath)) {
            return;
          }
          mkdirSync(dir, { recursive: true });
          writeFileSync(contextPath, project.brief ?? DEFAULT_BRIEF_TEMPLATE, 'utf-8');
        } catch (err) {
          console.warn(`[ProjectManager] v10: failed to write context.md for ${project.id}:`, err);
        }
      },
      ensurePersonalProjectDir: () => {
        try {
          mkdirSync(getDefaultWorkspaceDir(), { recursive: true });
          const contextPath = path.join(getDefaultWorkspaceDir(), 'context.md');
          if (!existsSync(contextPath)) {
            writeFileSync(contextPath, DEFAULT_BRIEF_TEMPLATE, 'utf-8');
          }
        } catch (err) {
          console.warn('[ProjectManager] v12: failed to ensure Personal project dir:', err);
        }
      },
      repairProjectRoots: () => {
        ProjectManager.repairProjectRootsAndContextFiles(store);
      },
    });
    // Run the repair pass once more after migrations return so idempotent
    // boots (schemaVersion already at head) still fix any drift.
    ProjectManager.repairProjectRootsAndContextFiles(store);
  }

  private static repairProjectRootsAndContextFiles(store: Store<StoreData>): void {
    const projects = store.get('projects', []) as Project[];
    const pages = store.get('pages', []) as Page[];
    const now = Date.now();

    const existingRootProjectIds = new Set(pages.filter((page) => page.isRoot).map((page) => page.projectId));
    const repairedPages: Page[] = [];

    for (const project of projects) {
      if (!existingRootProjectIds.has(project.id)) {
        repairedPages.push({
          id: nanoid(),
          projectId: project.id,
          parentId: null,
          title: project.label,
          sortOrder: 0,
          isRoot: true,
          createdAt: now,
          updatedAt: now,
        });
      }

      const dir = project.isPersonal ? getDefaultWorkspaceDir() : getProjectDir(project.slug);
      const contextPath = path.join(dir, 'context.md');
      try {
        if (!existsSync(contextPath)) {
          mkdirSync(dir, { recursive: true });
          writeFileSync(contextPath, DEFAULT_BRIEF_TEMPLATE, 'utf-8');
        }
      } catch (err) {
        console.warn(`[ProjectManager] failed to repair context.md for ${project.id}:`, err);
      }
    }

    if (repairedPages.length > 0) {
      store.set('pages', [...pages, ...repairedPages]);
      console.log(`[ProjectManager] repaired ${repairedPages.length} missing root pages`);
    }
  }

  // #endregion

  // #region Session history

  getSessionHistory = async (sessionId: string): Promise<SessionMessage[]> => {
    const dbPath = path.join(
      getOmniConfigDir(),
      'sandbox',
      'omniagents',
      'sessions',
      'omni_code',
      'omni',
      'sessions.db'
    );

    try {
      await fs.access(dbPath);
    } catch {
      return [];
    }

    const query = `SELECT id, msg_json, created_at FROM history WHERE session_id = '${sessionId.replace(/'/g, "''")}' ORDER BY id ASC`;

    try {
      const { stdout } = await execFileAsync('sqlite3', ['-json', dbPath, query], { maxBuffer: 10 * 1024 * 1024 });
      if (!stdout.trim()) {
        return [];
      }

      const rows = JSON.parse(stdout) as HistoryRow[];
      return parseSessionHistoryRows(rows);
    } catch (err) {
      console.error('[ProjectManager] Failed to query session history:', err);
      return [];
    }
  };

  // #endregion

  exit = async (): Promise<void> => {
    this.supervisors.stopStallDetection();
    this.supervisors.stopAutoDispatch();
    if (this.inboxSweepTimer) {
      clearInterval(this.inboxSweepTimer);
      this.inboxSweepTimer = null;
    }
    this.supervisors.cancelAllRetries();
    this.workflowLoader.dispose();
    await this.pages.dispose();

    // Dispose all machines
    for (const [ticketId, entry] of this.supervisors.machines) {
      await entry.machine.dispose();
      this.supervisors.machines.delete(ticketId);
    }

    await this.supervisors.exitAllTasks();
  };
}

export const createProjectManager = (arg: {
  ipc: IIpcListener;
  sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
  store: Store<StoreData>;
  processManager?: ProcessManager;
}) => {
  const { ipc, sendToWindow, store, processManager } = arg;

  // Run migration
  ProjectManager.migrateToSupervisor(store);

  const projectManager = new ProjectManager({ store, sendToWindow, processManager });
  const { supervisors, milestones, inbox, pages } = projectManager;
  supervisors.restorePersistedTasks();

  // Per-module IPC handler registration. Each helper returns the channel
  // names it registered so the cleanup loop below can remove them all in
  // one pass without a 50-line removeHandler block.
  const channels = [
    ...registerProjectHandlers(ipc, projectManager),
    ...registerSupervisorHandlers(ipc, supervisors),
    ...registerMilestoneHandlers(ipc, milestones),
    ...registerPageHandlers(ipc, pages, (projectId) => projectManager.getProjectDir(projectId)),
    ...registerInboxHandlers(ipc, inbox),
  ];

  const cleanup = async () => {
    await projectManager.exit();
    for (const channel of channels) {
      ipcMain.removeHandler(channel);
    }
  };

  return [projectManager, cleanup] as const;
};
