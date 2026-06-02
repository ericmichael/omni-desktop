import { ipcMain, shell } from 'electron';
import type Store from 'electron-store';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import fs from 'fs/promises';
import { nanoid } from 'nanoid';
import type { ColumnRow, IProjectsRepo, ProjectsRepo, TicketRemap } from 'omni-projects-db';
import { commentId } from 'omni-projects-db';
import path from 'path';

import { getArtifactsDir, getContainerArtifactsDir } from '@/lib/artifacts';
import { resolveArtifactPath } from '@/lib/artifacts-fs';
import { getContainerFilesChanged } from '@/lib/container-files-changed';
import { detectContainerPullRequest, detectContainerPullRequests } from '@/lib/container-pull-request';
import { getContainerChangeSet, mirrorContainerChangesToHost } from '@/lib/container-sync';
import { getGitFilesChanged, resolveTicketDiffBase } from '@/lib/git-files-changed';
import { INBOX_SWEEP_INTERVAL_MS } from '@/lib/inbox-expiry';
import type { IWorkflowLoader, ProjectManagerDeps } from '@/lib/project-manager-deps';
import { runMigrations as runSchemaMigrations } from '@/lib/project-migrations';
import type { ProjectConfigDefaults } from '@/lib/project-to-config';
import { projectToConfig } from '@/lib/project-to-config';
import { resolvePipelineDefs } from '@/lib/resolve-pipeline-defs';
import { slugifyUnique } from '@/lib/slugify-unique';
import { type ArtifactStore, DockerArtifactStore, HostFsArtifactStore } from '@/main/artifact-store';
import { DbChangeWatcher } from '@/main/db-change-watcher';
import {
  commentToRow,
  inboxItemToRow,
  milestoneToRow,
  pageToRow,
  projectToRow,
  rowsToPipeline,
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
import { getMcpBinPath } from '@/main/mcp-config-manager';
import { registerMilestoneHandlers } from '@/main/milestone-handlers';
import { MilestoneManager, type MilestoneManagerStore } from '@/main/milestone-manager';
import { registerPageHandlers } from '@/main/page-handlers';
import { PageManager, type PageManagerStore } from '@/main/page-manager';
import type { ProcessManager } from '@/main/process-manager';
import { registerProjectHandlers } from '@/main/project-handlers';
import { SupervisorBridge } from '@/main/supervisor-bridge';
import { registerSupervisorHandlers } from '@/main/supervisor-handlers';
import { SupervisorOrchestrator } from '@/main/supervisor-orchestrator';
import { getDefaultWorkspaceDir, getOmniConfigDir, getProjectDir, getProjectPagesDir } from '@/main/util';
import { WorkflowLoader } from '@/main/workflow-loader';
import type { IIpcListener } from '@/shared/ipc-listener';
import type { ProjectConfig } from '@/shared/manifest';
import { DEFAULT_PIPELINE, SIMPLE_PIPELINE } from '@/shared/pipeline-defaults';
import { validateProjectSources } from '@/shared/project-source';
import type {
  ArtifactFileContent,
  ArtifactFileEntry,
  CodeTabId,
  ColumnId,
  ContainerPullRequest,
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
  StoreData,
  Task,
  Ticket,
  TicketId,
  TicketPriority,
} from '@/shared/types';
import { firstSource } from '@/shared/types';

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

// Operational constants (MAX_CONCURRENT_SUPERVISORS, MAX_CONTINUATION_TURNS,
// AUTO_DISPATCH_INTERVAL_MS) live in `@/main/supervisor-orchestrator`.
// Continuation, retries, and stall detection are owned by omni-code's
// ``/goal`` server function — there is no launcher-side retry queue or
// stall timer to manage here.

export class ProjectManager {
  private store: Store<StoreData>;
  private sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;

  /**
   * When set, all project data is persisted via this async repo (SQLite
   * locally, Postgres in cloud) and served from {@link cache}. The public
   * accessors stay synchronous by reading the in-memory projection; async is
   * confined to {@link init} (hydration) and {@link enqueuePersist}
   * (write-through). Absent → legacy electron-store mode (some tests).
   */
  private repo: IProjectsRepo | undefined;

  /**
   * In-memory read-model projection of all project data. Hydrated once from
   * {@link repo} in {@link init}, mutated synchronously on every write (so the
   * next read sees it), and re-hydrated when {@link changeWatcher} detects an
   * external (MCP-subprocess) write. Only populated when {@link repo} is set.
   */
  private cache: {
    projects: Project[];
    tickets: Ticket[];
    milestones: Milestone[];
    pages: Page[];
    inboxItems: InboxItem[];
    tasks: Task[];
    columns: Map<ProjectId, ColumnRow[]>;
    configs: Map<ProjectId, string | null>;
  } = {
    projects: [],
    tickets: [],
    milestones: [],
    pages: [],
    inboxItems: [],
    tasks: [],
    columns: new Map(),
    configs: new Map(),
  };

  /**
   * Synchronous SQLite handle used ONLY by {@link changeWatcher} for
   * `_change_seq` polling (not part of the async data contract). Absent in
   * Postgres mode, where external-write detection is LISTEN/NOTIFY instead.
   */
  private changeSeqRepo: ProjectsRepo | undefined;

  /** Host skills dir for this manager's projects (per-tenant on the server; default global). */
  private skillsDir: string | undefined;

  /** Serialized write-through persistence chain — see {@link enqueuePersist}. */
  private persistChain: Promise<void> = Promise.resolve();

  /** Resolves once the initial cache hydration + boot wiring completes. */
  readonly whenReady: Promise<void>;

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

  /** Cloud override for per-ticket artifact storage (Azure Files on ACI). */
  private artifactStoreFor?: (ticketId: TicketId) => ArtifactStore | null;

  /** Teams/cloud: the principal this instance serves (per-user WIP/review). */
  private currentPrincipal?: string;

  /** Teams/cloud: notify a member when assigned a ticket (cross-principal). */
  private onAssign?: (assignee: string, ticket: Ticket) => void;

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
      /** Optional async repo. When provided, project data is persisted here and cached in memory. */
      repo?: IProjectsRepo;
      /** Optional sync SQLite handle for the change-watcher (omit in Postgres mode). */
      changeSeqRepo?: ProjectsRepo;
      /** Host skills directory for this manager's projects (per-tenant on the server). */
      skillsDir?: string;
      /** Cloud override: resolve a per-ticket artifact store (e.g. Azure Files
       *  for ACI). When it returns a store, it wins over the host/docker default. */
      artifactStoreFor?: (ticketId: TicketId) => ArtifactStore | null;
      /** Teams/cloud: the principal this manager instance serves. Drives per-user
       *  WIP + weekly review ("my work"). Undefined in single-user/local mode. */
      currentPrincipal?: string;
      /** Teams/cloud: notify a member they were assigned a ticket (cross-principal). */
      onAssign?: (assignee: string, ticket: Ticket) => void;
    },
    deps?: Partial<ProjectManagerDeps>
  ) {
    this.store = arg.store;
    this.sendToWindow = arg.sendToWindow;
    this.skillsDir = arg.skillsDir;
    this.artifactStoreFor = arg.artifactStoreFor;
    this.currentPrincipal = arg.currentPrincipal;
    this.onAssign = arg.onAssign;
    this.processManager = arg.processManager;
    this.appControlManager = arg.appControlManager;
    this.repo = arg.repo;
    this.changeSeqRepo = arg.changeSeqRepo;
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
          void this.syncPipelineForProject(projectId);
        },
      });
    const pageStore: PageManagerStore = this.repo
      ? {
          getPages: () => this.cache.pages,
          setPages: (items) => {
            this.cache.pages = items;
            const rows = items.map(pageToRow);
            this.enqueuePersist(() => this.repo!.replaceAllPages(rows));
            this.noteLocalWriteAndBroadcast();
          },
          // Markdown doc bodies live in the DB (source of truth); PageManager
          // routes notebooks to disk regardless. Content reads/writes chain on
          // the persist queue so a write lands AFTER the page row it
          // references (the page_content→pages FK) and reads are
          // read-after-write consistent.
          getContent: (pageId) => {
            const p = this.persistChain.then(() => this.repo!.getPageContent(pageId));
            return p;
          },
          setContent: (pageId, body) => {
            const p = this.persistChain
              .then(() => this.repo!.setPageContent(pageId, body))
              // Note our own write so the SQLite change-watcher doesn't treat it
              // as external and re-emit it back to the writing editor.
              .then(() => this.changeWatcher?.noteLocalWrite())
              .catch((err) => {
                console.error('[ProjectManager] setPageContent failed:', err);
              });
            this.persistChain = p;
            return p;
          },
        }
      : {
          getPages: () => (this.store.get('pages') ?? []) as Page[],
          setPages: (items) => {
            this.store.set('pages', items);
            this.sendToWindow('store:changed', this.store.store);
          },
        };
    this.pages = new PageManager({
      store: pageStore,
      sendToWindow: this.sendToWindow,
    });
    const inboxStore: InboxManagerStore = this.repo
      ? {
          getInboxItems: () => this.cache.inboxItems,
          setInboxItems: (items) => {
            this.cache.inboxItems = items;
            const rows = items.map(inboxItemToRow);
            this.enqueuePersist(() => this.repo!.replaceAllInboxItems(rows));
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
      // Route inbox.promoteToProject through the full project-creation path
      // so the new project gets slug disambiguation, pipeline seeding, root
      // page, and project dir. Without this, the bare-insert fallback in
      // InboxManager creates a project that breaks on the next addTicket call.
      createProject: (input) => this.addProject(input),
    });

    const milestoneStore: MilestoneManagerStore = this.repo
      ? {
          getMilestones: () => this.cache.milestones,
          setMilestones: (items) => {
            this.cache.milestones = items;
            const rows = items.map(milestoneToRow);
            this.enqueuePersist(() => this.repo!.replaceAllMilestones(rows));
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
        getCurrentPrincipal: () => this.currentPrincipal,
        getPlatformCredentials: () => this.store.get('platform'),
        getCodeTabs: () => (this.store.get('codeTabs', []) ?? []) as Array<{ id: string; ticketId?: string }>,
        getPersistedTasks: () => (this.repo ? this.cache.tasks : (this.store.get('tasks', []) as Task[])),
        setPersistedTasks: (tasks) => {
          if (this.repo) {
            this.cache.tasks = tasks;
            const rows = tasks.map(taskToRow);
            this.enqueuePersist(() => this.repo!.replaceAllTasks(rows));
            this.noteLocalWriteAndBroadcast();
          } else {
            this.store.set('tasks', tasks);
            this.sendToWindow('store:changed', this.store.store);
          }
        },
        // Per-row task writes — supervisor uses these for the high-frequency
        // transition path. Falls back to setPersistedTasks (above) when the
        // repo is absent (legacy electron-store mode in tests).
        upsertPersistedTask: this.repo
          ? (task: Task) => {
              this.cache.tasks = [...this.cache.tasks.filter((t) => t.id !== task.id), task];
              this.enqueuePersist(() => this.repo!.upsertTask(taskToRow(task)));
              this.noteLocalWriteAndBroadcast();
            }
          : undefined,
        deletePersistedTask: this.repo
          ? (taskId) => {
              this.cache.tasks = this.cache.tasks.filter((t) => t.id !== taskId);
              this.enqueuePersist(() => this.repo!.deleteTask(taskId));
              this.noteLocalWriteAndBroadcast();
            }
          : undefined,
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
        getAgentArtifactsDir: (ticketId) => this.getAgentArtifactsDir(ticketId),
      },
      workflowLoader: this.workflowLoader,
      sendToWindow: this.sendToWindow,
      bridge: this.bridge,
      processManager: this.processManager,
      appControlManager: this.appControlManager,
    });

    this.whenReady = this.init();
  }

  /**
   * Hydrate the in-memory projection, wire external-change detection, restore
   * supervisor tasks, and start the auto-dispatch + inbox-sweep loops. Async
   * so the cache is populated from {@link repo} before anything reads it; the
   * constructor kicks this off and exposes the promise as {@link whenReady}.
   * For SqliteProjectsRepo the awaits resolve on microtasks (no real I/O), so
   * the cache is ready before any IPC handler runs on a later macrotask.
   */
  private init = async (): Promise<void> => {
    if (this.repo) {
      try {
        await this.hydrate();
      } catch (err) {
        console.error('[ProjectManager] initial hydrate failed:', err);
      }
      if (this.changeSeqRepo) {
        // External (MCP-subprocess) writes bump _change_seq → re-hydrate the
        // projection AND re-emit content for any DB-backed page an editor is
        // watching (the watcher is page-agnostic; the renderer drops echoes).
        this.changeWatcher = new DbChangeWatcher(this.changeSeqRepo, () => {
          void this.refreshFromExternal();
          void this.pages.reemitWatchedContent();
        });
        this.changeWatcher.start();
      }
    }
    // restorePersistedTasks reads tasks through the supervisor store adapter,
    // which now reads the cache — so it must run after hydration.
    this.supervisors.restorePersistedTasks();
    this.supervisors.startAutoDispatch();
    this.startInboxSweep();
    if (this.repo) {
      this.broadcastStoreSnapshot();
    }
  };

  /** Re-load the entire projection from the repo (after an external write). */
  /** Re-load the projection (change-watcher in SQLite, LISTEN/NOTIFY in cloud). */
  refreshFromExternal = async (): Promise<void> => {
    try {
      await this.hydrate();
      this.broadcastStoreSnapshot();
    } catch (err) {
      console.error('[ProjectManager] refresh after external change failed:', err);
    }
  };

  /** Load all project data from the repo into {@link cache}. */
  private hydrate = async (): Promise<void> => {
    const repo = this.repo;
    if (!repo) {
      return;
    }
    const [projRows, msRows, pageRows, inboxRows, taskRows] = await Promise.all([
      repo.listProjects(),
      repo.listAllMilestones(),
      repo.listAllPages(),
      repo.listAllInboxItems(),
      repo.listAllTasks(),
    ]);
    this.cache.projects = projRows.map(rowToProject);
    this.cache.milestones = msRows.map(rowToMilestone);
    this.cache.pages = pageRows.map(rowToPage);
    this.cache.inboxItems = inboxRows.map(rowToInboxItem);
    this.cache.tasks = taskRows.map(rowToTask);

    const tickRows = await repo.listAllTickets();
    this.cache.tickets = await Promise.all(
      tickRows.map(async (row) => rowToTicket(row, await repo.listCommentsByTicket(row.id)))
    );

    const columns = new Map<ProjectId, ColumnRow[]>();
    const configs = new Map<ProjectId, string | null>();
    for (const p of this.cache.projects) {
      columns.set(p.id, await repo.listColumns(p.id));
      configs.set(p.id, await repo.getProjectConfig(p.id));
    }
    this.cache.columns = columns;
    this.cache.configs = configs;
  };

  /**
   * Queue a write-through persistence task. The cache is already updated
   * synchronously by the caller; this flushes the change to the repo in order.
   * `noteLocalWrite` runs after the write so the change-watcher attributes the
   * resulting `_change_seq` bump to us (not an external process).
   */
  private enqueuePersist = (task: () => Promise<void>): void => {
    this.persistChain = this.persistChain.then(async () => {
      try {
        await task();
        this.changeWatcher?.noteLocalWrite();
      } catch (err) {
        console.error('[ProjectManager] persist failed:', err);
      }
    });
  };

  /** Await all queued persistence — used by cleanup and any durability barrier. */
  flushPersists = (): Promise<void> => this.persistChain;

  /**
   * Read the `ProjectConfig` for a project. Reads the persisted JSON column
   * via `repo.getProjectConfig` when available; falls back to deriving via
   * `projectToConfig` for resilience. Returns `null` for unknown projects
   * or when running without a SQLite repo (legacy electron-store mode).
   */
  getProjectConfig = (projectId: ProjectId): ProjectConfig | null => {
    const project = this.getProjects().find((p) => p.id === projectId);
    if (!project) {
      return null;
    }
    if (this.repo) {
      const stored = this.cache.configs.get(projectId);
      if (stored) {
        try {
          return JSON.parse(stored) as ProjectConfig;
        } catch {
          // Fall through to derive — corrupt JSON in the column shouldn't break reads.
        }
      }
    }
    return projectToConfig(project, this.getProjectConfigDefaults());
  };

  /** Resolve the defaults `projectToConfig` needs from the launcher's environment. */
  private getProjectConfigDefaults = (): ProjectConfigDefaults => ({
    skillsDir: this.skillsDir ?? path.join(getOmniConfigDir(), 'skills'),
    projectsMcpCliPath: getMcpBinPath(),
    defaultDockerImage: 'omni-sandbox:latest',
  });

  /**
   * Public accessor used by IPC wiring to resolve a project's working
   * directory. Derives the path from `ProjectConfig.manifest.entries['.']`
   * when the project has a local-dir workspace entry; otherwise falls back
   * to the legacy slug-based resolver (Personal / context-only / git-remote
   * projects don't have a host-side workspace dir to return).
   */
  getProjectDir = (projectId: ProjectId): string | null => {
    const project = this.getProjects().find((p) => p.id === projectId);
    if (!project) {
      return null;
    }
    const config = this.getProjectConfig(projectId);
    const root = config?.manifest.entries?.['.'];
    if (root && root.type === 'local_dir') {
      return root.src;
    }
    return this.getProjectDirPath(project);
  };

  // #region Broadcast helpers

  /**
   * Assemble a full StoreData snapshot from the in-memory projection merged
   * with the electron-store settings. Mirrors db-store-bridge's
   * `buildStoreSnapshot`, but reads the cache instead of the (now async) repo
   * so it stays synchronous. Each project gets its pipeline attached from the
   * cached columns.
   */
  private buildSnapshotFromCache = (): StoreData => {
    const projects = this.cache.projects.map((p) => {
      const cols = this.cache.columns.get(p.id);
      return cols && cols.length > 0 ? { ...p, pipeline: rowsToPipeline(cols) } : p;
    });
    return {
      ...this.store.store,
      projects,
      tickets: this.cache.tickets,
      milestones: this.cache.milestones,
      pages: this.cache.pages,
      inboxItems: this.cache.inboxItems,
      tasks: this.cache.tasks,
    };
  };

  /** Broadcast a full store snapshot to the renderer (projection + electron-store merged). */
  private broadcastStoreSnapshot = (): void => {
    if (this.repo) {
      this.sendToWindow('store:changed', this.buildSnapshotFromCache());
    } else {
      this.sendToWindow('store:changed', this.store.store);
    }
  };

  /**
   * After a local write: broadcast the updated projection. The `_change_seq`
   * self-notification suppression now happens in {@link enqueuePersist} (after
   * the async write actually lands), so this just refreshes the UI.
   */
  private noteLocalWriteAndBroadcast = (): void => {
    this.broadcastStoreSnapshot();
  };

  /**
   * Build a full StoreData snapshot. Used by MainProcessManager to serve
   * `store:get` and `store:get-key` requests.
   */
  getStoreSnapshot = (): StoreData => {
    if (this.repo) {
      return this.buildSnapshotFromCache();
    }
    return this.store.store;
  };

  // #endregion

  // #region Projects (persisted in SQLite when repo is set, else electron-store)

  private getProjects = (): Project[] => {
    if (this.repo) {
      return this.cache.projects;
    }
    return this.store.get('projects', []);
  };

  private setProjects = (projects: Project[]): void => {
    if (this.repo) {
      const repo = this.repo;
      this.cache.projects = projects;
      // Recompute `config` for every project so the manifest stays in sync
      // with the source fields. `replaceAllProjects` leaves the column
      // untouched on upsert (it's not in the SET clause), so we rewrite it
      // explicitly here.
      const defaults = this.getProjectConfigDefaults();
      const configs = projects.map((p) => [p.id, JSON.stringify(projectToConfig(p, defaults))] as const);
      for (const [id, cfg] of configs) {
        this.cache.configs.set(id, cfg);
      }
      // Snapshot rows synchronously so a later mutation of the array can't
      // alter what gets persisted once the queued write runs.
      const rows = projects.map(projectToRow);
      this.enqueuePersist(async () => {
        await repo.replaceAllProjects(rows);
        for (const [id, cfg] of configs) {
          await repo.setProjectConfig(id, cfg);
        }
      });
      this.noteLocalWriteAndBroadcast();
    } else {
      this.store.set('projects', projects);
      this.sendToWindow('store:changed', this.store.store);
    }
  };

  addProject = (input: Omit<Project, 'id' | 'createdAt'>): Project => {
    // Disambiguate slug against existing rows to prevent SQLITE_CONSTRAINT
    // crashes when two labels slugify to the same value. The caller-supplied
    // slug is the candidate; the launcher appends `-2`, `-3`, … as needed.
    const existing = this.getProjects();
    const takenSlugs = new Set(existing.map((p) => p.slug));
    const slug = slugifyUnique(input.slug, (s) => takenSlugs.has(s));
    const project: Project = {
      ...input,
      slug,
      id: nanoid(),
      createdAt: Date.now(),
    };
    const projects = [...existing, project];
    this.setProjects(projects);
    // Ensure the host-side workspace dir exists so the first agent launch
    // doesn't fail the `isDirectory(workspaceDir)` check in AgentProcess.
    // Personal projects use the (already-ensured) workspace root; local-source
    // projects use a user-supplied existing dir; git-remote projects clone
    // inside the container — so only context-only named projects need this.
    if (!project.isPersonal && project.sources.length === 0) {
      mkdirSync(this.getProjectDirPath(project), { recursive: true });
    }
    // Seed the project's root page through PageManager. The root page's body
    // is the project brief that used to live in `<projectDir>/context.md`;
    // PageManager seeds it with the brief template under
    // `<config>/pages/<projectId>/<rootId>.md`.
    const rootPage = this.pages.seedRootPage(project);
    void this.pages.writeContent(rootPage.id, DEFAULT_BRIEF_TEMPLATE).catch(() => {});
    // Seed pipeline_columns immediately with the source-appropriate defaults
    // so tickets created before FLEET.md loads have a valid FK target.
    void this.syncPipelineForProject(project.id);
    // Eagerly load FLEET.md from the first source so the pipeline is ready
    // when the UI fetches it. Personal / context-only projects (no source)
    // have no FLEET.md and no workflow to load — they use SIMPLE_COLUMNS.
    // Multi-source projects load FLEET.md from the first source only; mixing
    // workflows across sources would need explicit precedence rules we
    // haven't defined yet.
    const primarySource = project.sources[0];
    if (primarySource?.kind === 'local') {
      const workspaceDir = this.getProjectDir(project.id) ?? primarySource.workspaceDir;
      void this.workflowLoader.load(project.id, workspaceDir).then(() => this.syncPipelineForProject(project.id));
    } else if (primarySource?.kind === 'git-remote') {
      void this.workflowLoader
        .loadFromRemote(project.id, primarySource.repoUrl, primarySource.defaultBranch)
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
    if (patch.sources) {
      validateProjectSources(patch.sources);
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

  /**
   * Get the project's working-directory path — i.e. where agents and the
   * sandbox run, NOT where pages live. Personal projects use the workspace
   * root; named projects use `Projects/<slug>/`. Pages are resolved
   * separately via `PageManager`'s projectId-keyed layout.
   */
  private getProjectDirPath = (project: Project): string => {
    if (project.isPersonal) {
      return getDefaultWorkspaceDir();
    }
    return getProjectDir(project.slug);
  };

  /**
   * Read the project's brief — i.e. the body of the root page. Returns ''
   * when the project has no root page or the file is missing.
   *
   * Historically this read `<projectDir>/context.md` directly. The brief
   * now lives at `<config>/pages/<projectId>/<rootId>.md` (the root page's
   * regular file), so we route through PageManager.
   */
  readContext = (projectId: ProjectId): Promise<string> => {
    const rootPage = this.pages.getByProject(projectId).find((p) => p.isRoot);
    if (!rootPage) {
      return Promise.resolve('');
    }
    return this.pages.readContent(rootPage.id);
  };

  /** Write the project's brief — the body of the root page. */
  writeContext = async (projectId: ProjectId, content: string): Promise<void> => {
    const rootPage = this.pages.getByProject(projectId).find((p) => p.isRoot);
    if (!rootPage) {
      return;
    }
    await this.pages.writeContent(rootPage.id, content);
  };

  /**
   * List files in the project's working directory. Skips `context.md`
   * since legacy projects may still have one left over from when the
   * brief lived in the working dir; the brief now lives in
   * `<config>/pages/<projectId>/<rootId>.md`.
   */
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
          // Legacy artifact — hide from the UI.
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

  /** Get first 200 chars of the project brief (root page body) for preview. */
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

    const source = firstSource(project);
    if (source?.kind === 'local') {
      const workspaceDir = this.getProjectDir(projectId) ?? source.workspaceDir;
      await this.workflowLoader.load(projectId, workspaceDir);
    } else if (source?.kind === 'git-remote') {
      await this.workflowLoader.loadFromRemote(projectId, source.repoUrl, source.defaultBranch);
    }
    await this.syncPipelineForProject(projectId);
  };

  /**
   * Resolve the pipeline column defs for a project (FLEET.md → source-based
   * defaults) and write them to SQLite via `repo.syncColumnsForProject`. Adds
   * a system-style ticket comment when a gate column is removed and a ticket
   * is remapped to a non-gate column. No-op when running without a SQLite
   * repo (legacy electron-store mode used only by some tests).
   */
  private syncPipelineForProject = async (projectId: ProjectId): Promise<void> => {
    const repo = this.repo;
    if (!repo) {
      return;
    }

    const project = this.cache.projects.find((p) => p.id === projectId);
    if (!project) {
      return;
    }

    const hasExisting = (this.cache.columns.get(projectId)?.length ?? 0) > 0;
    const defs = resolvePipelineDefs({
      hasSource: project.sources.length > 0,
      hasExisting,
      workflow: this.workflowLoader.getConfig(projectId),
    });
    if (!defs) {
      return;
    }

    // The remap is a transaction in the repo (columns + ticket reassignment),
    // so serialize it on the persist chain and re-hydrate the affected slice
    // of the projection afterwards. `await` the chain so callers that await
    // this method see the cache already updated.
    await (this.persistChain = this.persistChain.then(async () => {
      let changed = false;
      try {
        const result = await repo.syncColumnsForProject(projectId, defs);

        // Gate-lost comments — written before re-hydrate so the refreshed
        // tickets carry them.
        for (const remap of result.remappedTickets) {
          if (remap.gateLost) {
            await this.appendGateLostComment(repo, projectId, remap);
          }
        }

        // Columns and ticket column_ids changed in the DB — refresh both for
        // this project in the cache.
        this.cache.columns.set(projectId, await repo.listColumns(projectId));
        const tickRows = await repo.listTicketsByProject(projectId);
        const refreshed = await Promise.all(
          tickRows.map(async (r) => rowToTicket(r, await repo.listCommentsByTicket(r.id)))
        );
        const byId = new Map(refreshed.map((t) => [t.id, t]));
        this.cache.tickets = this.cache.tickets.map((t) => byId.get(t.id) ?? t);

        this.changeWatcher?.noteLocalWrite();
        changed = result.inserted.length > 0 || result.removed.length > 0 || result.remappedTickets.length > 0;
      } catch (err) {
        console.warn(`[ProjectManager] syncColumnsForProject failed for ${projectId}:`, err);
        return;
      }
      if (changed) {
        this.broadcastStoreSnapshot();
      }
    }));
  };

  /**
   * Append a `[Pipeline change]` comment to a ticket whose gate column was
   * removed. The comment is authored as `agent` because the ticket_comments
   * CHECK constraint only permits `agent`/`human`; the prefix makes the
   * provenance obvious in the discussion view and in `get_ticket_comments`
   * output. Called from within the serialized persist block of
   * {@link syncPipelineForProject}, so it awaits the repo write directly.
   */
  private appendGateLostComment = async (
    repo: IProjectsRepo,
    projectId: ProjectId,
    remap: TicketRemap
  ): Promise<void> => {
    const content = `[Pipeline change] This ticket was in the gate column "${remap.fromLabel}", which was removed from FLEET.md. It has been remapped to "${remap.toLabel}". Please re-evaluate whether human review is still needed.`;
    try {
      await repo.upsertComment({
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
    // The cached pipeline_columns are the source of truth —
    // `syncPipelineForProject` keeps them in sync with FLEET.md / defaults.
    if (this.repo) {
      const rows = this.cache.columns.get(projectId) ?? [];
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
    return project && project.sources.length > 0 ? DEFAULT_PIPELINE : SIMPLE_PIPELINE;
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
      return this.cache.tickets;
    }
    return this.store.get('tickets', []);
  };

  private setTickets = (tickets: Ticket[]): void => {
    if (this.repo) {
      const repo = this.repo;
      this.cache.tickets = tickets;
      // Snapshot rows synchronously (immune to later mutation of the array).
      const rows = tickets.map(ticketToRow);
      const commentSets = tickets
        .filter((t) => t.comments && t.comments.length > 0)
        .map((t) => [t.id, t.comments!.map((c) => commentToRow(c, t.id))] as const);
      this.enqueuePersist(async () => {
        await repo.replaceAllTickets(rows);
        for (const [ticketId, commentRows] of commentSets) {
          await repo.replaceCommentsForTicket(ticketId, commentRows);
        }
      });
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
    if (this.repo) {
      const repo = this.repo;
      // Per-row write: avoids the read-all → mutate → write-all pattern that
      // races with MCP and re-churns every other ticket in the table on each
      // edit. `upsertTicket` is a single INSERT ON CONFLICT touching exactly
      // this row.
      this.cache.tickets = [...this.cache.tickets, ticket];
      this.enqueuePersist(async () => {
        await repo.upsertTicket(ticketToRow(ticket));
        if (ticket.comments && ticket.comments.length > 0) {
          await repo.replaceCommentsForTicket(
            ticket.id,
            ticket.comments.map((c) => commentToRow(c, ticket.id))
          );
        }
      });
      this.noteLocalWriteAndBroadcast();
    } else {
      const tickets = this.getTickets();
      tickets.push(ticket);
      this.setTickets(tickets);
    }
    return ticket;
  };

  updateTicket = (id: TicketId, patch: Partial<Omit<Ticket, 'id' | 'projectId' | 'createdAt'>>): void => {
    if (this.repo) {
      const repo = this.repo;
      const current = this.cache.tickets.find((t) => t.id === id);
      if (!current) {
        return;
      }
      const next: Ticket = { ...current, ...patch, updatedAt: Date.now() };
      this.cache.tickets = this.cache.tickets.map((t) => (t.id === id ? next : t));
      this.enqueuePersist(async () => {
        await repo.upsertTicket(ticketToRow(next));
        if (patch.comments) {
          // Only re-sync comments when the patch actually includes them. The
          // old `setTickets` path replayed every ticket's comments on every
          // edit — that's where the write amplification came from.
          await repo.replaceCommentsForTicket(
            id,
            patch.comments.map((c) => commentToRow(c, id))
          );
        }
      });
      this.noteLocalWriteAndBroadcast();
      return;
    }
    const tickets = this.getTickets();
    const index = tickets.findIndex((t) => t.id === id);
    if (index === -1) {
      return;
    }
    tickets[index] = { ...tickets[index]!, ...patch, updatedAt: Date.now() };
    this.setTickets(tickets);
  };

  /**
   * Assign (or unassign) a ticket to a team member. Ownership stays with the
   * team — `assignee` is an additive, optional pointer that drives the "my work"
   * filters (WIP, weekly review) and nothing else. `null`/empty clears it. Any
   * team member may reassign; the ticket never leaves the team. A dedicated
   * method (not `updateTicket` over IPC) so clearing survives JSON transport,
   * where an `undefined` field would be dropped.
   */
  assignTicket = (id: TicketId, assignee: string | null): void => {
    this.updateTicket(id, { assignee: assignee || undefined });
    // Notify the assignee (teams/cloud) — skip self-assignment.
    if (assignee && assignee !== this.currentPrincipal && this.onAssign) {
      const ticket = (this.repo ? this.cache.tickets : this.getTickets()).find((t) => t.id === id);
      if (ticket) {
        this.onAssign(assignee, ticket);
      }
    }
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

    if (this.repo) {
      const repo = this.repo;
      // Per-row delete. `ticket_comments` cascades automatically via the
      // FK; supervisor `tasks.ticket_id` is SET NULL so tasks survive.
      this.cache.tickets = this.cache.tickets.filter((t) => t.id !== id);
      this.enqueuePersist(() => repo.deleteTicket(id));
      this.noteLocalWriteAndBroadcast();
      return;
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

  /**
   * The artifacts dir *as the agent should write it*, resolved by the same
   * substrate check the reader (`resolveArtifactStore`) uses, so the agent
   * writes exactly where the launcher reads: a running container →
   * `/workspace/.omni-artifacts/<id>`; otherwise the host dir. Surfaced to
   * autopilot agents via the supervisor prompt.
   */
  getAgentArtifactsDir = (ticketId: TicketId): string => {
    const ticket = this.getTicketById(ticketId);
    const containerId = ticket ? (this.processManager?.getProjectContainerId(ticket.projectId) ?? null) : null;
    return containerId ? getContainerArtifactsDir(ticketId) : getArtifactsDir(getOmniConfigDir(), ticketId);
  };

  /**
   * Pick the artifact store for a ticket by its sandbox substrate: a running
   * devbox container → read from the container (`/artifacts` volume) via
   * `DockerArtifactStore`; otherwise the host dir. (Cloud/ACI injects an
   * Azure Files store in the server build via `artifactStoreFor`.)
   */
  private resolveArtifactStore = (ticketId: TicketId): ArtifactStore => {
    const injected = this.artifactStoreFor?.(ticketId);
    if (injected) {
      return injected;
    }
    const ticket = this.getTicketById(ticketId);
    const containerId = ticket ? (this.processManager?.getProjectContainerId(ticket.projectId) ?? null) : null;
    return containerId ? new DockerArtifactStore(containerId) : new HostFsArtifactStore(getOmniConfigDir());
  };

  listArtifacts = (ticketId: TicketId, dirPath?: string): Promise<ArtifactFileEntry[]> =>
    this.resolveArtifactStore(ticketId).list(ticketId, dirPath);

  readArtifact = (ticketId: TicketId, relativePath: string): Promise<ArtifactFileContent> =>
    this.resolveArtifactStore(ticketId).read(ticketId, relativePath);

  writeArtifact = (ticketId: TicketId, relativePath: string, data: Buffer): Promise<void> =>
    this.resolveArtifactStore(ticketId).write(ticketId, relativePath, data);

  openArtifactExternal = async (ticketId: TicketId, relativePath: string): Promise<void> => {
    // Host-fs only: opening in an external app needs a real host path. For
    // container substrates this is a no-op until artifact materialization lands.
    const fullPath = resolveArtifactPath(this.getArtifactsRoot(ticketId), relativePath);
    await shell.openPath(fullPath);
  };

  // #endregion

  // #region Files changed (git diff)

  getFilesChanged = async (ticketId: TicketId, sourceId: string): Promise<DiffResponse> => {
    const empty: DiffResponse = { totalFiles: 0, totalAdditions: 0, totalDeletions: 0, hasChanges: false, files: [] };

    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      return empty;
    }

    const project = this.getProjects().find((p) => p.id === ticket.projectId);
    if (!project) {
      return empty;
    }

    // Find the named source by id on the project.
    const source = project.sources.find((s) => s.id === sourceId);

    // Container-backed model: for local sources with a running session,
    // the agent's work lives in /workspace/<mountName>. Diff against
    // the ``omni/seed`` tag set up by devbox.yml's init step.
    if (source?.kind === 'local') {
      const containerId = this.processManager?.getProjectContainerId(project.id) ?? null;
      if (containerId) {
        return getContainerFilesChanged({ containerId, mountName: source.mountName });
      }
    }

    // Host-side fallback (legacy worktree flow, currently unused by
    // entry-based seeding but kept until the supervisor's per-ticket
    // worktree machinery is rebuilt in container-land).
    let task: Task | undefined;
    if (ticket.supervisorTaskId) {
      task = this.supervisors.tasks.get(ticket.supervisorTaskId)?.task;
    }
    if (!task) {
      for (const [, entry] of this.supervisors.tasks) {
        if (entry.task.ticketId === ticketId) {
          task = entry.task;
          break;
        }
      }
    }
    if (!task) {
      const storedTasks = this.repo ? this.cache.tasks : (this.store.get('tasks') ?? []);
      task = storedTasks.find((t: Task) => t.ticketId === ticketId);
    }

    const worktreePath = ticket.worktreePath ?? task?.worktreePath;
    let gitDir: string;
    if (worktreePath) {
      gitDir = worktreePath;
    } else {
      if (source?.kind !== 'local') {
        return empty; // git-remote diffs happen inside the container, not locally
      }
      gitDir = source.workspaceDir;
    }

    const milestoneBranch = ticket.milestoneId ? this.milestones.getById(ticket.milestoneId)?.branch : undefined;
    let preferredBase: string | undefined;
    if (worktreePath) {
      preferredBase = this.milestones.resolveTicketBranch(ticket) ?? task?.branch;
    } else if (ticket.branch && milestoneBranch && ticket.branch !== milestoneBranch) {
      preferredBase = milestoneBranch;
    }

    const mergeBase = await resolveTicketDiffBase(gitDir, preferredBase);
    return getGitFilesChanged({ gitDir, mergeBase });
  };

  getCodeTabFilesChanged = async (tabId: CodeTabId, sourceId: string): Promise<DiffResponse> => {
    const empty: DiffResponse = { totalFiles: 0, totalAdditions: 0, totalDeletions: 0, hasChanges: false, files: [] };
    const tab = ((this.store.get('codeTabs') ?? []) as Array<{
      id: string;
      projectId: ProjectId | null;
      workspaceDir?: string;
    }>).find((t) => t.id === tabId);
    if (!tab) {
      return empty;
    }

    const project = tab.projectId ? this.getProjects().find((p) => p.id === tab.projectId) : undefined;
    const source = project?.sources.find((s) => s.id === sourceId);
    if (source) {
      const containerId = this.processManager?.getProcessContainerId(tabId) ?? null;
      if (containerId) {
        return getContainerFilesChanged({ containerId, mountName: source.mountName });
      }
      if (source.kind === 'local') {
        return getGitFilesChanged({ gitDir: source.workspaceDir, mergeBase: 'HEAD' }).catch(() => empty);
      }
    }

    if (!project && tab.workspaceDir && sourceId === tab.workspaceDir) {
      return getGitFilesChanged({ gitDir: tab.workspaceDir, mergeBase: 'HEAD' }).catch(() => empty);
    }

    return empty;
  };

  applyCodeTabSourceChanges = async (tabId: CodeTabId, sourceId: string): Promise<PrMergeResult> => {
    const tab = ((this.store.get('codeTabs') ?? []) as Array<{
      id: string;
      projectId: ProjectId | null;
    }>).find((t) => t.id === tabId);
    if (!tab?.projectId) {
      return { ok: false, error: 'Code tab is not attached to a project' };
    }
    const project = this.getProjects().find((p) => p.id === tab.projectId);
    if (!project) {
      return { ok: false, error: 'Project not found' };
    }
    const source = project.sources.find((s) => s.id === sourceId);
    if (!source) {
      return { ok: false, error: `Source not found: ${sourceId}` };
    }
    if (source.kind !== 'local') {
      return { ok: false, error: 'Applying changes to host is only supported for local sources' };
    }
    const containerId = this.processManager?.getProcessContainerId(tabId) ?? null;
    if (!containerId) {
      return { ok: false, error: 'No running sandbox for this code tab' };
    }
    const result = await mirrorContainerChangesToHost(containerId, source.mountName, source.workspaceDir);
    if (!result.ok) {
      return { ok: false, error: result.error ?? 'Sync failed' };
    }
    if (result.copied === 0 && result.removed === 0) {
      return { ok: false, error: 'No changes to apply' };
    }
    return { ok: true, mergeCommitSha: 'sync' };
  };

  /** Resolve a code tab's project + running container, or null if unavailable. */
  private codeTabPrContext = (tabId: CodeTabId): { project: Project; containerId: string } | null => {
    const tab = ((this.store.get('codeTabs') ?? []) as Array<{
      id: string;
      projectId: ProjectId | null;
    }>).find((t) => t.id === tabId);
    if (!tab?.projectId) {
      return null;
    }
    const project = this.getProjects().find((p) => p.id === tab.projectId);
    if (!project) {
      return null;
    }
    const containerId = this.processManager?.getProcessContainerId(tabId) ?? null;
    if (!containerId) {
      return null;
    }
    return { project, containerId };
  };

  /**
   * Detect an open GitHub/Azure PR for one source's branch in a code tab's
   * container. Mirror of {@link detectPullRequest} for the code-tab surface
   * (per-source — used by the Files Changed view). Best-effort → null.
   */
  detectCodeTabPullRequest = async (
    tabId: CodeTabId,
    sourceId: string
  ): Promise<ContainerPullRequest | null> => {
    const ctx = this.codeTabPrContext(tabId);
    const source = ctx?.project.sources.find((s) => s.id === sourceId);
    if (!ctx || !source) {
      return null;
    }
    return detectContainerPullRequest(ctx.containerId, source.mountName);
  };

  /**
   * Detect open PRs across *all* of a code tab's sources (one per source that
   * has one). Used by the deck banner — a multi-source project can have a PR per
   * repo. Best-effort → empty array.
   */
  detectCodeTabPullRequests = async (tabId: CodeTabId): Promise<ContainerPullRequest[]> => {
    const ctx = this.codeTabPrContext(tabId);
    if (!ctx) {
      return [];
    }
    const found: ContainerPullRequest[] = [];
    for (const source of ctx.project.sources) {
      found.push(...(await detectContainerPullRequests(ctx.containerId, source.mountName)));
    }
    return found;
  };

  /**
   * Detect open PRs for the singleton chat session's workspace. The chat runs
   * under the ``"chat"`` process key against ``store.workspaceDir`` (no project,
   * so a single source mounted at the workspace basename → at most one PR).
   * Returns an array for a uniform banner contract. Best-effort → empty array.
   */
  detectChatPullRequests = async (): Promise<ContainerPullRequest[]> => {
    const containerId = this.processManager?.getProcessContainerId('chat') ?? null;
    if (!containerId) {
      return [];
    }
    const workspaceDir = this.store.get('workspaceDir') as string | undefined;
    if (!workspaceDir) {
      return [];
    }
    const mountName = path.basename(workspaceDir) || 'workspace';
    return detectContainerPullRequests(containerId, mountName);
  };

  // #endregion

  // #region Sync to host

  /**
   * Report whether one source has container changes to sync to its host. The
   * container is authoritative, so there's no conflict concept — ``ready`` just
   * means "there's something to mirror." Requires a running container.
   */
  checkPrMerge = async (ticketId: TicketId, sourceId: string): Promise<PrMergeCheck> => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      return { ready: false, reason: 'Ticket not found' };
    }
    const project = this.getProjects().find((p) => p.id === ticket.projectId);
    if (!project) {
      return { ready: false, reason: 'Project not found' };
    }
    const source = project.sources.find((s) => s.id === sourceId);
    if (!source) {
      return { ready: false, reason: `Source not found: ${sourceId}` };
    }
    if (source.kind !== 'local') {
      return { ready: false, reason: 'Sync to host is only supported for local sources' };
    }

    const containerId = this.processManager?.getProjectContainerId(project.id) ?? null;
    if (!containerId) {
      return { ready: false, reason: 'No running session for this project' };
    }
    const { copy, remove } = await getContainerChangeSet(containerId, source.mountName);
    const changed = copy.length + remove.length;
    if (changed === 0) {
      return { ready: false, reason: 'No changes to sync' };
    }
    return {
      ready: true,
      base: 'host workspace',
      feature: `container/${source.mountName}`,
      hasConflicts: false,
      conflictingFiles: [],
      ahead: changed,
    };
  };

  /**
   * Mirror one source's changed-vs-seed container files onto its host workspace
   * ("sync to host"). Idempotent and repeatable — the container is
   * authoritative, so re-running re-copies the current files. Stamps
   * ``prMergedAt[sourceId]`` with the last-sync time. Requires a running
   * container.
   */
  mergePrTicket = async (ticketId: TicketId, sourceId: string): Promise<PrMergeResult> => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      return { ok: false, error: 'Ticket not found' };
    }
    const project = this.getProjects().find((p) => p.id === ticket.projectId);
    if (!project) {
      return { ok: false, error: 'Project not found' };
    }
    const source = project.sources.find((s) => s.id === sourceId);
    if (!source) {
      return { ok: false, error: `Source not found: ${sourceId}` };
    }
    if (source.kind !== 'local') {
      return { ok: false, error: 'Sync to host is only supported for local sources' };
    }

    const containerId = this.processManager?.getProjectContainerId(project.id) ?? null;
    if (!containerId) {
      return { ok: false, error: 'No running session for this project' };
    }
    const result = await mirrorContainerChangesToHost(containerId, source.mountName, source.workspaceDir);
    if (!result.ok) {
      return { ok: false, error: result.error ?? 'Sync failed' };
    }
    if (result.copied === 0 && result.removed === 0) {
      return { ok: false, error: 'No changes to sync' };
    }
    this.updateTicket(ticketId, {
      prMergedAt: { ...(ticket.prMergedAt ?? {}), [sourceId]: Date.now() },
    });
    return { ok: true, mergeCommitSha: 'sync' };
  };

  /**
   * Detect an open GitHub PR for one source's branch by running ``gh pr view``
   * inside the project's running container. Returns ``null`` when there's no
   * running container, no PR, or the source can't have one (plain directory /
   * no remote). Best-effort — never throws.
   */
  detectPullRequest = async (
    ticketId: TicketId,
    sourceId: string
  ): Promise<ContainerPullRequest | null> => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      return null;
    }
    const project = this.getProjects().find((p) => p.id === ticket.projectId);
    if (!project) {
      return null;
    }
    const source = project.sources.find((s) => s.id === sourceId);
    if (!source) {
      return null;
    }
    const containerId = this.processManager?.getProjectContainerId(project.id) ?? null;
    if (!containerId) {
      return null;
    }
    const pr = await detectContainerPullRequest(containerId, source.mountName);
    return pr;
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
    // Also clear any deferred-cleanup flag since the ticket is active again.
    const ticket2 = this.getTicketById(ticketId);
    if (ticket2?.resolution && !this.isTerminalColumn(ticket.projectId, columnId)) {
      this.updateTicket(ticketId, {
        resolution: undefined,
        resolvedAt: undefined,
        archivedAt: undefined,
        cleanupPending: undefined,
      });
    }

    // Reconciliation: stop supervisor and clean up workspace when ticket moves to a terminal column
    if (this.isTerminalColumn(ticket.projectId, columnId)) {
      const entry = this.supervisors.machines.get(ticketId);
      if (entry) {
        console.log(
          `[ProjectManager] Ticket ${ticketId} moved to terminal column "${columnId}" — stopping supervisor and cleaning up workspace.`
        );
        // Do the stop + cleanup inside a single ticket lock. We bypass
        // `stopSupervisor` (which takes its own lock) to avoid a nested
        // deadlock; the stop is inlined here.
        void this.supervisors.withTicketLock(ticketId, async () => {
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
    if (this.isFirstColumn(ticket.projectId, columnId)) {
      const entry = this.supervisors.machines.get(ticketId);
      if (entry) {
        console.log(`[ProjectManager] Ticket ${ticketId} moved to backlog — stopping supervisor.`);
        void this.supervisors.stopSupervisor(ticketId);
      }
    }

    // Stop supervisor (preserve workspace) when entering a gated column.
    if (column.gate) {
      const entry = this.supervisors.machines.get(ticketId);
      if (entry) {
        console.log(`[ProjectManager] Ticket ${ticketId} entered gated column "${columnId}" — stopping supervisor.`);
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
   * the fs side-effects (v10 brief → root-page file) that can't run in
   * the pure module.
   *
   * The v10 brief used to write `<projectDir>/context.md`; it now writes
   * `<config>/pages/<projectId>/<rootId>.md` so the brief stays attached
   * to the root page row, decoupled from any working directory.
   */
  static migrateToSupervisor(store: Store<StoreData>): void {
    runSchemaMigrations(store as unknown as Parameters<typeof runSchemaMigrations>[0], {
      newId: () => nanoid(),
      now: () => Date.now(),
      writeProjectContextBrief: (project) => {
        try {
          const pages = (store.get('pages', []) as Page[]).filter((p) => p.projectId === project.id && p.isRoot);
          const rootPage = pages[0];
          if (!rootPage) {
            return;
          }
          const dir = getProjectPagesDir(project.id);
          const filePath = path.join(dir, `${rootPage.id}.md`);
          if (existsSync(filePath)) {
            return;
          }
          mkdirSync(dir, { recursive: true });
          writeFileSync(filePath, project.brief ?? DEFAULT_BRIEF_TEMPLATE, 'utf-8');
        } catch (err) {
          console.warn(`[ProjectManager] v10: failed to write brief for ${project.id}:`, err);
        }
      },
      ensurePersonalProjectDir: () => {
        // Historical v12: previously seeded a `context.md` in the workspace
        // root for the Personal project. The brief now lives with the root
        // page under `<config>/pages/<projectId>/`, so the Personal-special-
        // case directory write is no longer needed. Keeping the hook
        // present (no-op) so the migration runner's signature is stable.
      },
      repairProjectRoots: () => {
        ProjectManager.repairProjectRoots(store);
      },
    });
    // Run the repair pass once more after migrations return so idempotent
    // boots (schemaVersion already at head) still fix any drift.
    ProjectManager.repairProjectRoots(store);
  }

  private static repairProjectRoots(store: Store<StoreData>): void {
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
    }

    if (repairedPages.length > 0) {
      store.set('pages', [...pages, ...repairedPages]);
      console.log(`[ProjectManager] repaired ${repairedPages.length} missing root pages`);
    }
  }

  // #endregion

  exit = async (): Promise<void> => {
    this.changeWatcher?.stop();
    this.supervisors.stopAutoDispatch();
    if (this.inboxSweepTimer) {
      clearInterval(this.inboxSweepTimer);
      this.inboxSweepTimer = null;
    }
    // Drain any queued write-through persistence before tearing down.
    await this.flushPersists();
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
  /** Optional async repo. When provided, project data is persisted here and cached in memory. */
  repo?: IProjectsRepo;
  /** Optional sync SQLite handle for the change-watcher (omit in Postgres mode). */
  changeSeqRepo?: ProjectsRepo;
}) => {
  const { ipc, sendToWindow, store, processManager, appControlManager, repo, changeSeqRepo } = arg;

  // Run migration
  ProjectManager.migrateToSupervisor(store);

  const projectManager = new ProjectManager({
    store,
    sendToWindow,
    processManager,
    appControlManager,
    repo,
    changeSeqRepo,
  });
  const { supervisors, milestones, inbox, pages, bridge } = projectManager;
  // Cache hydration + restorePersistedTasks now run inside ProjectManager.init()
  // (the constructor kicks it off; awaited via projectManager.whenReady).

  // Per-module IPC handler registration. Each helper returns the channel
  // names it registered so the cleanup loop below can remove them all in
  // one pass without a 50-line removeHandler block.
  // Single-manager (Electron) wiring: every resolver returns the one manager.
  const channels = [
    ...registerProjectHandlers(ipc, () => projectManager),
    ...registerSupervisorHandlers(ipc, () => supervisors),
    ...registerMilestoneHandlers(ipc, () => milestones),
    ...registerPageHandlers(
      ipc,
      () => pages,
      (_event, projectId) => projectManager.getProjectDir(projectId)
    ),
    ...registerInboxHandlers(ipc, () => inbox),
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
