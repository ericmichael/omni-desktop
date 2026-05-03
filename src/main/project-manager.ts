import { execFile } from 'child_process';
import { ipcMain, shell } from 'electron';
import type Store from 'electron-store';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import fs from 'fs/promises';
import { nanoid } from 'nanoid';
import type { ProjectsRepo, TicketRemap } from 'omni-projects-db';
import { commentId } from 'omni-projects-db';
import path from 'path';
import { promisify } from 'util';

import { getArtifactsDir } from '@/lib/artifacts';
import { listArtifactEntries, readArtifactFile, resolveArtifactPath } from '@/lib/artifacts-fs';
import { getGitFilesChanged, resolveTicketDiffBase } from '@/lib/git-files-changed';
import { INBOX_SWEEP_INTERVAL_MS } from '@/lib/inbox-expiry';
import { checkMerge, mergeBranch } from '@/lib/pr-merge';
import type { IWorkflowLoader, ProjectManagerDeps } from '@/lib/project-manager-deps';
import { runMigrations as runSchemaMigrations } from '@/lib/project-migrations';
import { resolvePipelineDefs } from '@/lib/resolve-pipeline-defs';
import { type HistoryRow, parseSessionHistoryRows } from '@/lib/session-history';
import { DbChangeWatcher } from '@/main/db-change-watcher';
import {
  buildStoreSnapshot,
  commentToRow,
  inboxItemToRow,
  milestoneToRow,
  pageToRow,
  projectToRow,
  rowToInboxItem,
  rowToMilestone,
  rowToPage,
  rowToProject,
  rowToTask,
  rowToTicket,
  taskToRow,
  ticketToRow,
} from '@/main/db-store-bridge';
import { registerInboxHandlers } from '@/main/inbox-handlers';
import { InboxManager, type InboxManagerStore } from '@/main/inbox-manager';
import { registerMilestoneHandlers } from '@/main/milestone-handlers';
import { MilestoneManager, type MilestoneManagerStore } from '@/main/milestone-manager';
import { registerPageHandlers } from '@/main/page-handlers';
import { PageManager, type PageManagerStore } from '@/main/page-manager';
import type { ProcessManager } from '@/main/process-manager';
import { registerProjectHandlers } from '@/main/project-handlers';
import { SupervisorBridge } from '@/main/supervisor-bridge';
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
  PrMergeCheck,
  PrMergeResult,
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

  /** When set, all project data is read/written via SQLite instead of electron-store. */
  private repo: ProjectsRepo | undefined;

  /** When set, detects MCP server writes and refreshes the UI. */
  private changeWatcher: DbChangeWatcher | undefined;

  /** Workflow file loader (FLEET.md) per project. */
  private workflowLoader: IWorkflowLoader;

  /** Interval handle for inbox expiry sweep. */
  private inboxSweepTimer: ReturnType<typeof setInterval> | null = null;

  /** Bridge to the renderer's column registry. Drives SUBMIT/stop/send. */
  readonly bridge: SupervisorBridge;

  /** Optional ProcessManager — used to stop Code tab sandboxes during cleanup. */
  private processManager?: ProcessManager;

  /** Optional AppControlManager — when set, autopilot agents get the `app_*` client tools. */
  private appControlManager?: import('@/main/app-control-manager').AppControlManager;

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
    arg: {
      store: Store<StoreData>;
      sendToWindow: ProjectManager['sendToWindow'];
      processManager?: ProcessManager;
      appControlManager?: import('@/main/app-control-manager').AppControlManager;
      /** Optional: shared SQLite repo. When provided, project data is stored in SQLite. */
      repo?: ProjectsRepo;
    },
    deps?: Partial<ProjectManagerDeps>
  ) {
    this.store = arg.store;
    this.sendToWindow = arg.sendToWindow;
    this.processManager = arg.processManager;
    this.appControlManager = arg.appControlManager;
    this.repo = arg.repo;
    // Set up cross-process change detection when using SQLite
    if (this.repo) {
      this.changeWatcher = new DbChangeWatcher(this.repo, () => {
        this.broadcastStoreSnapshot();
      });
      this.changeWatcher.start();
    }
    this.bridge = deps?.bridge ?? new SupervisorBridge(arg.sendToWindow);
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
          // SQLite is the source of truth — re-sync pipeline_columns from
          // the new FLEET.md and remap any orphaned tickets. The store
          // snapshot broadcast carries the new pipeline to the renderer.
          this.syncPipelineForProject(projectId);
        },
      });
    const pageStore: PageManagerStore = this.repo
      ? {
          getPages: () => this.repo!.listAllPages().map(rowToPage),
          setPages: (items) => {
            this.repo!.replaceAllPages(items.map(pageToRow));
            this.noteLocalWriteAndBroadcast();
          },
          getProjects: () => this.getProjects(),
        }
      : {
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
    const inboxStore: InboxManagerStore = this.repo
      ? {
          getInboxItems: () => this.repo!.listAllInboxItems().map(rowToInboxItem),
          setInboxItems: (items) => {
            this.repo!.replaceAllInboxItems(items.map(inboxItemToRow));
            this.noteLocalWriteAndBroadcast();
          },
          getTickets: () => this.getTickets(),
          setTickets: (tickets) => this.setTickets(tickets),
          getProjects: () => this.getProjects(),
          setProjects: (projects) => this.setProjects(projects),
          getPipeline: (projectId) => this.getPipeline(projectId),
        }
      : {
          getInboxItems: () => (this.store.get('inboxItems') ?? []) as InboxItem[],
          setInboxItems: (items) => {
            this.store.set('inboxItems', items);
            this.sendToWindow('store:changed', this.store.store);
          },
          getTickets: () => this.getTickets(),
          setTickets: (tickets) => this.setTickets(tickets),
          getProjects: () => this.getProjects(),
          setProjects: (projects) => this.setProjects(projects),
          getPipeline: (projectId) => this.getPipeline(projectId),
        };
    this.inbox = new InboxManager({
      store: inboxStore,
      newId: () => nanoid(),
      now: () => Date.now(),
    });

    const milestoneStore: MilestoneManagerStore = this.repo
      ? {
          getMilestones: () => this.repo!.listAllMilestones().map(rowToMilestone),
          setMilestones: (items) => {
            this.repo!.replaceAllMilestones(items.map(milestoneToRow));
            this.noteLocalWriteAndBroadcast();
          },
          getTickets: () => this.getTickets(),
          setTickets: (tickets) => this.setTickets(tickets),
        }
      : {
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
        getPersistedTasks: () =>
          this.repo
            ? this.repo.listAllTasks().map(rowToTask)
            : (this.store.get('tasks', []) as Task[]),
        setPersistedTasks: (tasks) => {
          if (this.repo) {
            this.repo.replaceAllTasks(tasks.map(taskToRow));
            this.noteLocalWriteAndBroadcast();
          } else {
            this.store.set('tasks', tasks);
            this.sendToWindow('store:changed', this.store.store);
          }
        },
        getOmniConfigDir: () => getOmniConfigDir(),
      },
      host: {
        getTicketById: (ticketId) => this.getTicketById(ticketId),
        getTicketsByProject: (projectId) => this.getTicketsByProject(projectId),
        updateTicket: (ticketId, patch) => this.updateTicket(ticketId, patch),
        isTerminalColumn: (projectId, columnId) => this.isTerminalColumn(projectId, columnId),
        getColumn: (projectId, columnId) => this.getColumn(projectId, columnId),
        getPipeline: (projectId) => this.getPipeline(projectId),
        resolveTicketBranch: (ticket) => this.milestones.resolveTicketBranch(ticket),
        getNextTicket: (projectId) => this.getNextTicket(projectId),
        moveTicketToColumn: (ticketId, columnId) => this.moveTicketToColumn(ticketId, columnId),
        updateProject: (projectId, patch) => this.updateProject(projectId, patch),
        getPagesByProject: (projectId) => this.pages.getByProject(projectId),
        getProjectDirPath: (project) => this.getProjectDirPath(project),
      },
      workflowLoader: this.workflowLoader,
      sendToWindow: this.sendToWindow,
      bridge: this.bridge,
      processManager: this.processManager,
      appControlManager: this.appControlManager,
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

  // #region Broadcast helpers

  /** Broadcast a full store snapshot to the renderer (SQLite + electron-store merged). */
  private broadcastStoreSnapshot = (): void => {
    if (this.repo) {
      this.sendToWindow('store:changed', buildStoreSnapshot(this.repo, this.store));
    } else {
      this.sendToWindow('store:changed', this.store.store);
    }
  };

  /** After a local SQLite write: suppress self-notification and broadcast. */
  private noteLocalWriteAndBroadcast = (): void => {
    this.changeWatcher?.noteLocalWrite();
    this.broadcastStoreSnapshot();
  };

  /**
   * Build a full StoreData snapshot. Used by MainProcessManager to serve
   * `store:get` and `store:get-key` requests.
   */
  getStoreSnapshot = (): StoreData => {
    if (this.repo) {
      return buildStoreSnapshot(this.repo, this.store);
    }
    return this.store.store;
  };

  // #endregion

  // #region Projects (persisted in SQLite when repo is set, else electron-store)

  private getProjects = (): Project[] => {
    if (this.repo) {
      return this.repo.listProjects().map(rowToProject);
    }
    return this.store.get('projects', []);
  };

  private setProjects = (projects: Project[]): void => {
    if (this.repo) {
      this.repo.replaceAllProjects(projects.map(projectToRow));
      this.noteLocalWriteAndBroadcast();
    } else {
      this.store.set('projects', projects);
      this.sendToWindow('store:changed', this.store.store);
    }
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
    // Seed pipeline_columns immediately with the source-appropriate defaults
    // so tickets created before FLEET.md loads have a valid FK target.
    this.syncPipelineForProject(project.id);
    // Eagerly load FLEET.md so the pipeline is ready when the UI fetches it.
    // Personal / context-only projects (no source) have no FLEET.md and no
    // workflow to load — they use SIMPLE_COLUMNS and run no hooks.
    if (project.source?.kind === 'local') {
      void this.workflowLoader
        .load(project.id, project.source.workspaceDir)
        .then(() => this.syncPipelineForProject(project.id));
    } else if (project.source?.kind === 'git-remote') {
      void this.workflowLoader
        .loadFromRemote(project.id, project.source.repoUrl, project.source.defaultBranch)
        .then(() => this.syncPipelineForProject(project.id));
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
    this.syncPipelineForProject(projectId);
  };

  /**
   * Resolve the pipeline column defs for a project (FLEET.md → source-based
   * defaults) and write them to SQLite via `repo.syncColumnsForProject`. Adds
   * a system-style ticket comment when a gate column is removed and a ticket
   * is remapped to a non-gate column. No-op when running without a SQLite
   * repo (legacy electron-store mode used only by some tests).
   */
  private syncPipelineForProject = (projectId: ProjectId): void => {
    if (!this.repo) {
      return;
    }

    const project = this.getProjects().find((p) => p.id === projectId);
    if (!project) {
      return;
    }

    const hasExisting = this.repo.listColumns(projectId).length > 0;
    const defs = resolvePipelineDefs({
      hasSource: !!project.source,
      hasExisting,
      workflow: this.workflowLoader.getConfig(projectId),
    });
    if (!defs) {
      return;
    }

    let result;
    try {
      result = this.repo.syncColumnsForProject(projectId, defs);
    } catch (err) {
      console.warn(`[ProjectManager] syncColumnsForProject failed for ${projectId}:`, err);
      return;
    }

    for (const remap of result.remappedTickets) {
      if (remap.gateLost) {
        this.appendGateLostComment(projectId, remap);
      }
    }

    if (result.inserted.length || result.removed.length || result.remappedTickets.length) {
      this.noteLocalWriteAndBroadcast();
    }
  };

  /**
   * Append a `[Pipeline change]` comment to a ticket whose gate column was
   * removed. The comment is authored as `agent` because the ticket_comments
   * CHECK constraint only permits `agent`/`human`; the prefix makes the
   * provenance obvious in the discussion view and in `get_ticket_comments`
   * output.
   */
  private appendGateLostComment = (projectId: ProjectId, remap: TicketRemap): void => {
    if (!this.repo) {
return;
}
    const content = `[Pipeline change] This ticket was in the gate column "${remap.fromLabel}", which was removed from FLEET.md. It has been remapped to "${remap.toLabel}". Please re-evaluate whether human review is still needed.`;
    try {
      this.repo.upsertComment({
        id: commentId(),
        ticket_id: remap.ticketId,
        author: 'agent',
        content,
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      console.warn(`[ProjectManager] failed to append gate-lost comment to ${remap.ticketId} in ${projectId}:`, err);
    }
  };

  getPipeline = (projectId: ProjectId): Pipeline => {
    // SQLite pipeline_columns is the source of truth — `syncPipelineForProject`
    // keeps it in sync with FLEET.md or the source-based defaults.
    if (this.repo) {
      const rows = this.repo.listColumns(projectId);
      if (rows.length > 0) {
        return {
          columns: rows.map((r) => ({
            id: r.id as ColumnId,
            label: r.label,
            ...(r.description ? { description: r.description } : {}),
            ...(r.gate ? { gate: true } : {}),
          })),
        };
      }
    }

    // Legacy electron-store path / fallback before SQLite sync runs.
    const workflowPipeline = this.workflowLoader.getConfig(projectId).pipeline;
    if (workflowPipeline && workflowPipeline.columns.length > 0) {
      return {
        columns: workflowPipeline.columns.map((col) => ({
          id: col.id,
          label: col.label,
          ...(col.gate ? { gate: true } : {}),
        })),
      };
    }
    const project = this.getProjects().find((p) => p.id === projectId);
    if (project?.pipeline) {
      return project.pipeline;
    }
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

  // #endregion

  // #region Tickets (persisted in SQLite when repo is set, else electron-store)

  private getTickets = (): Ticket[] => {
    if (this.repo) {
      return this.repo.listAllTickets().map((row) => {
        const comments = this.repo!.listCommentsByTicket(row.id);
        return rowToTicket(row, comments);
      });
    }
    return this.store.get('tickets', []);
  };

  private setTickets = (tickets: Ticket[]): void => {
    if (this.repo) {
      this.repo.replaceAllTickets(tickets.map(ticketToRow));
      // Also sync inline comments to the comments table
      for (const ticket of tickets) {
        if (ticket.comments && ticket.comments.length > 0) {
          this.repo.replaceCommentsForTicket(
            ticket.id,
            ticket.comments.map((c) => commentToRow(c, ticket.id))
          );
        }
      }
      this.noteLocalWriteAndBroadcast();
    } else {
      this.store.set('tickets', tickets);
      this.sendToWindow('store:changed', this.store.store);
    }
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
    // Stop supervisor state if active, ask renderer to release its column binding,
    // and stop the Code tab's sandbox if one is still running.
    const machineEntry = this.supervisors.machines.get(id);
    if (machineEntry) {
      void this.bridge.dispose(id).catch(() => {});
      if (machineEntry.tabId && this.processManager) {
        void this.processManager.stop(machineEntry.tabId).catch(() => {});
      }
      machineEntry.state.dispose();
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
      const storedTasks = this.repo
        ? this.repo.listAllTasks().map(rowToTask)
        : (this.store.get('tasks') ?? []);
      task = storedTasks.find((t: Task) => t.ticketId === ticketId);
    }

    // Determine the gitDir: the ticket's worktree if it has one, else the
    // project workspace (which is bind-mounted into the supervisor container
    // in direct mode, so the agent's commits land here).
    const worktreePath = ticket.worktreePath ?? task?.worktreePath;
    let gitDir: string;
    if (worktreePath) {
      gitDir = worktreePath;
    } else {
      const project = this.getProjects().find((p) => p.id === ticket.projectId);
      if (!project || project.source?.kind !== 'local') {
        return empty; // git-remote diffs happen inside the container, not locally
      }
      gitDir = project.source.workspaceDir;
    }

    // Resolve the base branch the ticket's work would land in:
    //  - Worktree mode: the worktree was branched from `effectiveBranch`, so
    //    that's the base — `<effectiveBranch>..HEAD` is the ticket's PR diff.
    //  - Direct mode: when the ticket has its own branch off a milestone
    //    branch, the milestone branch is the base (mirrors `resolvePrBranches`).
    //    Otherwise the work goes on the milestone branch (or trunk) directly,
    //    so we leave preferredBase undefined and let the helper pick trunk.
    const milestoneBranch = ticket.milestoneId
      ? this.milestones.getById(ticket.milestoneId)?.branch
      : undefined;
    let preferredBase: string | undefined;
    if (worktreePath) {
      preferredBase = this.milestones.resolveTicketBranch(ticket) ?? task?.branch;
    } else if (ticket.branch && milestoneBranch && ticket.branch !== milestoneBranch) {
      preferredBase = milestoneBranch;
    }

    const mergeBase = await resolveTicketDiffBase(gitDir, preferredBase);
    return getGitFilesChanged({ gitDir, mergeBase });
  };

  // #endregion

  // #region Local PR flow (approve / merge)

  /**
   * Resolve the base + feature branch for a ticket's merge. The base is the
   * milestone branch (falling back to `main` when the milestone has none);
   * the feature branch is `ticket/<worktreeName>` created by `createWorktree`.
   */
  private resolvePrBranches = (ticket: Ticket): { base?: string; feature?: string; reason?: string } => {
    const project = this.getProjects().find((p) => p.id === ticket.projectId);
    if (!project) {
      return { reason: 'Project not found' };
    }
    if (project.source?.kind !== 'local') {
      return { reason: 'Merge is only supported for projects with a local git repo' };
    }
    if (!ticket.worktreeName) {
      return { reason: 'Ticket has no worktree yet — nothing to merge' };
    }
    const feature = `ticket/${ticket.worktreeName}`;
    const milestone = ticket.milestoneId ? this.milestones.getById(ticket.milestoneId) : undefined;
    const base = milestone?.branch ?? 'main';
    return { base, feature };
  };

  setPrReview = (ticketId: TicketId, review: 'approved' | 'changes_requested' | null): void => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      return;
    }
    this.updateTicket(ticketId, {
      prReview: review === null ? undefined : { status: review, at: Date.now() },
    });
  };

  checkPrMerge = async (ticketId: TicketId): Promise<PrMergeCheck> => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      return { ready: false, reason: 'Ticket not found' };
    }
    const project = this.getProjects().find((p) => p.id === ticket.projectId);
    const { base, feature, reason } = this.resolvePrBranches(ticket);
    if (!base || !feature || !project || project.source?.kind !== 'local') {
      return { ready: false, reason: reason ?? 'Merge inputs unavailable' };
    }
    const res = await checkMerge(project.source.workspaceDir, base, feature);
    return {
      ready: true,
      base,
      feature,
      hasConflicts: res.hasConflicts,
      conflictingFiles: res.conflictingFiles,
      ahead: res.ahead,
    };
  };

  mergePrTicket = async (ticketId: TicketId): Promise<PrMergeResult> => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      return { ok: false, error: 'Ticket not found' };
    }
    if (ticket.prReview?.status !== 'approved') {
      return { ok: false, error: 'Ticket must be approved before merging' };
    }
    if (ticket.prMergedAt !== undefined) {
      return { ok: false, error: 'Ticket is already merged' };
    }
    const project = this.getProjects().find((p) => p.id === ticket.projectId);
    const { base, feature, reason } = this.resolvePrBranches(ticket);
    if (!base || !feature || !project || project.source?.kind !== 'local') {
      return { ok: false, error: reason ?? 'Merge inputs unavailable' };
    }
    const title = ticket.title?.trim() || 'ticket';
    const message = `Merge ${feature} into ${base}\n\n${title}`;
    const res = await mergeBranch(project.source.workspaceDir, base, feature, message);
    if (!res.ok) {
      return { ok: false, error: res.error ?? 'Merge failed' };
    }
    // Stamp the merged timestamp only. Do NOT auto-move the ticket or trigger
    // worktree cleanup — both stay under user control. The user moves the
    // ticket to a terminal column when they're ready, and cleanup is
    // initiated explicitly via the "Clean up worktree" button (dirty case)
    // or naturally on column move (clean case).
    this.updateTicket(ticketId, { prMergedAt: Date.now() });
    return { ok: true, mergeCommitSha: res.mergeCommitSha! };
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

    // Clear resolution/archive when moving away from terminal column (reopen).
    // Also clear any deferred-cleanup flag + PR review since the ticket is active again.
    const ticket2 = this.getTicketById(ticketId);
    if (ticket2?.resolution && !this.isTerminalColumn(ticket.projectId, columnId)) {
      this.updateTicket(ticketId, {
        resolution: undefined,
        resolvedAt: undefined,
        archivedAt: undefined,
        cleanupPending: undefined,
        prReview: undefined,
      });
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
        // Do the stop + cleanup inside a single ticket lock. We bypass
        // `stopSupervisor` (which takes its own lock) to avoid a nested
        // deadlock; the stop is inlined here.
        void this.supervisors.withTicketLock(ticketId, async () => {
          entry.state.cancelRetryTimer();
          try {
            await this.bridge.stop(ticketId);
          } catch (err) {
            console.warn(`[ProjectManager] bridge.stop failed for ${ticketId}:`, err);
          }
          entry.state.setRunId(null);
          if (entry.state.getPhase() !== 'idle') {
            entry.state.forcePhase('idle');
          }
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
    this.changeWatcher?.stop();
    this.supervisors.stopStallDetection();
    this.supervisors.stopAutoDispatch();
    if (this.inboxSweepTimer) {
      clearInterval(this.inboxSweepTimer);
      this.inboxSweepTimer = null;
    }
    this.supervisors.cancelAllRetries();
    this.workflowLoader.dispose();
    await this.pages.dispose();

    // Dispose all supervisor state records + release renderer column bindings.
    for (const [ticketId, entry] of this.supervisors.machines) {
      try {
        await this.bridge.dispose(ticketId);
      } catch {
        // Best-effort during shutdown
      }
      entry.state.dispose();
      this.supervisors.machines.delete(ticketId);
    }

    await this.supervisors.exitAllTasks();
    this.supervisors.dispose();
    this.bridge.disposeAll();
  };
}

export const createProjectManager = (arg: {
  ipc: IIpcListener;
  sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
  store: Store<StoreData>;
  processManager?: ProcessManager;
  appControlManager?: import('@/main/app-control-manager').AppControlManager;
  /** Optional: shared SQLite repo. When provided, project data is stored in SQLite. */
  repo?: ProjectsRepo;
}) => {
  const { ipc, sendToWindow, store, processManager, appControlManager, repo } = arg;

  // Run migration
  ProjectManager.migrateToSupervisor(store);

  const projectManager = new ProjectManager({ store, sendToWindow, processManager, appControlManager, repo });
  const { supervisors, milestones, inbox, pages, bridge } = projectManager;
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
    ...bridge.registerIpc(ipc),
  ];

  const cleanup = async () => {
    await projectManager.exit();
    for (const channel of channels) {
      ipcMain.removeHandler(channel);
    }
  };

  return [projectManager, cleanup] as const;
};
