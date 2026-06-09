/**
 * Backend-agnostic contract for project-data persistence.
 *
 * Two implementations satisfy this interface:
 *   - `SqliteProjectsRepo` (sqlite-repo.ts) — thin async adapter over the
 *     synchronous `ProjectsRepo`. Used by the Electron desktop app and the
 *     single-tenant local server (one `projects.db` file).
 *   - `PgProjectsRepo` (future) — Postgres-backed, constructed with a
 *     `tenantId` so every query is tenant-scoped by construction, backed by
 *     row-level security. Used by the multi-tenant cloud deployment.
 *
 * The methods are **async** even though SQLite is synchronous: Postgres
 * drivers are async, so the contract has to be `Promise`-returning for both
 * backends to satisfy it. The SQLite adapter just wraps its sync calls.
 *
 * Tenancy is NOT expressed in these signatures — it's baked into the
 * implementation instance (the SQLite repo is single-tenant; the Pg repo
 * closes over a tenant). Callers never pass a tenant id, so they cannot
 * accidentally read across tenants.
 *
 * Change-tracking (`getChangeSeq`/`bumpChangeSeq`) is intentionally absent:
 * it's a SQLite-specific cross-process notification mechanism (the
 * `_change_seq` table polled by db-change-watcher). Postgres uses LISTEN/
 * NOTIFY instead, so it doesn't belong in the shared data contract.
 */
import type {
  ColumnRow,
  CommentRow,
  InboxRow,
  MilestoneRow,
  PageRow,
  ProjectRow,
  TaskRow,
  TicketRow,
} from './types.js';

/**
 * Pipeline column definition. The `logicalId`
 * is the user-facing id; the persisted primary key is derived from
 * `${projectId}__${logicalId}`.
 */
export interface ColumnSyncInput {
  logicalId: string;
  label: string;
  description?: string | null;
  gate?: boolean;
}

/**
 * Per-ticket remap record returned by `syncColumnsForProject`. The launcher
 * uses `gateLost` to decide whether to attach a "needs human review" comment
 * — a ticket sitting in a gate column got remapped to a non-gate column.
 */
export interface TicketRemap {
  ticketId: string;
  fromColumnId: string;
  toColumnId: string;
  fromLabel: string;
  toLabel: string;
  gateLost: boolean;
}

export interface ColumnSyncResult {
  inserted: string[];
  removed: string[];
  remappedTickets: TicketRemap[];
}

export interface IProjectsRepo {
  // ---- Projects ----
  listProjects(): Promise<ProjectRow[]>;
  getProject(id: string): Promise<ProjectRow | undefined>;
  getProjectBySlug(slug: string): Promise<ProjectRow | undefined>;
  upsertProject(row: ProjectRow): Promise<void>;
  deleteProject(id: string): Promise<void>;
  getProjectConfig(id: string): Promise<string | null>;
  setProjectConfig(id: string, configJson: string | null): Promise<void>;
  replaceAllProjects(rows: ProjectRow[]): Promise<void>;

  // ---- Pipeline columns ----
  listColumns(projectId: string): Promise<ColumnRow[]>;
  upsertColumn(row: ColumnRow): Promise<void>;
  deleteColumnsForProject(projectId: string): Promise<void>;
  replaceColumnsForProject(projectId: string, rows: ColumnRow[]): Promise<void>;
  syncColumnsForProject(projectId: string, defs: ColumnSyncInput[]): Promise<ColumnSyncResult>;

  // ---- Tickets ----
  listAllTickets(): Promise<TicketRow[]>;
  listTicketsByProject(projectId: string): Promise<TicketRow[]>;
  getTicket(id: string): Promise<TicketRow | undefined>;
  upsertTicket(row: TicketRow): Promise<void>;
  deleteTicket(id: string): Promise<void>;
  replaceAllTickets(rows: TicketRow[]): Promise<void>;

  // ---- Comments ----
  listCommentsByTicket(ticketId: string): Promise<CommentRow[]>;
  upsertComment(row: CommentRow): Promise<void>;
  deleteComment(id: string): Promise<void>;
  deleteCommentsForTicket(ticketId: string): Promise<void>;
  replaceCommentsForTicket(ticketId: string, rows: CommentRow[]): Promise<void>;

  // ---- Milestones ----
  listAllMilestones(): Promise<MilestoneRow[]>;
  listMilestonesByProject(projectId: string): Promise<MilestoneRow[]>;
  getMilestone(id: string): Promise<MilestoneRow | undefined>;
  upsertMilestone(row: MilestoneRow): Promise<void>;
  deleteMilestone(id: string): Promise<void>;
  replaceAllMilestones(rows: MilestoneRow[]): Promise<void>;

  // ---- Pages ----
  listAllPages(): Promise<PageRow[]>;
  listPagesByProject(projectId: string): Promise<PageRow[]>;
  getPage(id: string): Promise<PageRow | undefined>;
  upsertPage(row: PageRow): Promise<void>;
  deletePage(id: string): Promise<void>;
  replaceAllPages(rows: PageRow[]): Promise<void>;
  /** Markdown doc body. Returns null when the page has no stored content yet. */
  getPageContent(pageId: string): Promise<string | null>;
  setPageContent(pageId: string, body: string): Promise<void>;

  // ---- Inbox items ----
  listAllInboxItems(): Promise<InboxRow[]>;
  getInboxItem(id: string): Promise<InboxRow | undefined>;
  upsertInboxItem(row: InboxRow): Promise<void>;
  deleteInboxItem(id: string): Promise<void>;
  replaceAllInboxItems(rows: InboxRow[]): Promise<void>;

  // ---- Tasks ----
  listAllTasks(): Promise<TaskRow[]>;
  listTasksByProject(projectId: string): Promise<TaskRow[]>;
  getTask(id: string): Promise<TaskRow | undefined>;
  upsertTask(row: TaskRow): Promise<void>;
  deleteTask(id: string): Promise<void>;
  replaceAllTasks(rows: TaskRow[]): Promise<void>;
}
