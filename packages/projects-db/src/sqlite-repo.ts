/**
 * Async adapter over the synchronous {@link ProjectsRepo}, satisfying the
 * backend-agnostic {@link IProjectsRepo} contract.
 *
 * `node:sqlite` is synchronous, but the shared contract is async so that the
 * Postgres backend can implement it too. This adapter is the SQLite side of
 * that seam: each method delegates straight to the sync repo and resolves with
 * the result — no extra I/O, no thread hop, behaviour identical to calling the
 * sync repo directly. Used by the Electron desktop app and the single-tenant
 * local server.
 *
 * The underlying sync repo remains accessible via {@link sync} for the few
 * SQLite-only paths (change-seq polling in db-change-watcher, the one-time
 * JSON migration) that aren't part of the cross-backend contract.
 */
import type { ProjectsRepo } from './repo.js';
import type { ColumnSyncInput, ColumnSyncResult, IProjectsRepo } from './repo-interface.js';
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

export class SqliteProjectsRepo implements IProjectsRepo {
  constructor(public readonly sync: ProjectsRepo) {}

  // ---- Projects ----
  async listProjects(): Promise<ProjectRow[]> {
    return this.sync.listProjects();
  }
  async getProject(id: string): Promise<ProjectRow | undefined> {
    return this.sync.getProject(id);
  }
  async getProjectBySlug(slug: string): Promise<ProjectRow | undefined> {
    return this.sync.getProjectBySlug(slug);
  }
  async upsertProject(row: ProjectRow): Promise<void> {
    this.sync.upsertProject(row);
  }
  async deleteProject(id: string): Promise<void> {
    this.sync.deleteProject(id);
  }
  async getProjectConfig(id: string): Promise<string | null> {
    return this.sync.getProjectConfig(id);
  }
  async setProjectConfig(id: string, configJson: string | null): Promise<void> {
    this.sync.setProjectConfig(id, configJson);
  }
  async replaceAllProjects(rows: ProjectRow[]): Promise<void> {
    this.sync.replaceAllProjects(rows);
  }

  // ---- Pipeline columns ----
  async listColumns(projectId: string): Promise<ColumnRow[]> {
    return this.sync.listColumns(projectId);
  }
  async upsertColumn(row: ColumnRow): Promise<void> {
    this.sync.upsertColumn(row);
  }
  async deleteColumnsForProject(projectId: string): Promise<void> {
    this.sync.deleteColumnsForProject(projectId);
  }
  async replaceColumnsForProject(projectId: string, rows: ColumnRow[]): Promise<void> {
    this.sync.replaceColumnsForProject(projectId, rows);
  }
  async syncColumnsForProject(projectId: string, defs: ColumnSyncInput[]): Promise<ColumnSyncResult> {
    return this.sync.syncColumnsForProject(projectId, defs);
  }

  // ---- Tickets ----
  async listAllTickets(): Promise<TicketRow[]> {
    return this.sync.listAllTickets();
  }
  async listTicketsByProject(projectId: string): Promise<TicketRow[]> {
    return this.sync.listTicketsByProject(projectId);
  }
  async getTicket(id: string): Promise<TicketRow | undefined> {
    return this.sync.getTicket(id);
  }
  async upsertTicket(row: TicketRow): Promise<void> {
    this.sync.upsertTicket(row);
  }
  async deleteTicket(id: string): Promise<void> {
    this.sync.deleteTicket(id);
  }
  async replaceAllTickets(rows: TicketRow[]): Promise<void> {
    this.sync.replaceAllTickets(rows);
  }

  // ---- Comments ----
  async listCommentsByTicket(ticketId: string): Promise<CommentRow[]> {
    return this.sync.listCommentsByTicket(ticketId);
  }
  async upsertComment(row: CommentRow): Promise<void> {
    this.sync.upsertComment(row);
  }
  async deleteComment(id: string): Promise<void> {
    this.sync.deleteComment(id);
  }
  async deleteCommentsForTicket(ticketId: string): Promise<void> {
    this.sync.deleteCommentsForTicket(ticketId);
  }
  async replaceCommentsForTicket(ticketId: string, rows: CommentRow[]): Promise<void> {
    this.sync.replaceCommentsForTicket(ticketId, rows);
  }

  // ---- Milestones ----
  async listAllMilestones(): Promise<MilestoneRow[]> {
    return this.sync.listAllMilestones();
  }
  async listMilestonesByProject(projectId: string): Promise<MilestoneRow[]> {
    return this.sync.listMilestonesByProject(projectId);
  }
  async getMilestone(id: string): Promise<MilestoneRow | undefined> {
    return this.sync.getMilestone(id);
  }
  async upsertMilestone(row: MilestoneRow): Promise<void> {
    this.sync.upsertMilestone(row);
  }
  async deleteMilestone(id: string): Promise<void> {
    this.sync.deleteMilestone(id);
  }
  async replaceAllMilestones(rows: MilestoneRow[]): Promise<void> {
    this.sync.replaceAllMilestones(rows);
  }

  // ---- Pages ----
  async listAllPages(): Promise<PageRow[]> {
    return this.sync.listAllPages();
  }
  async listPagesByProject(projectId: string): Promise<PageRow[]> {
    return this.sync.listPagesByProject(projectId);
  }
  async getPage(id: string): Promise<PageRow | undefined> {
    return this.sync.getPage(id);
  }
  async upsertPage(row: PageRow): Promise<void> {
    this.sync.upsertPage(row);
  }
  async deletePage(id: string): Promise<void> {
    this.sync.deletePage(id);
  }
  async replaceAllPages(rows: PageRow[]): Promise<void> {
    this.sync.replaceAllPages(rows);
  }
  async getPageContent(pageId: string): Promise<string | null> {
    return this.sync.getPageContent(pageId);
  }
  async setPageContent(pageId: string, body: string): Promise<void> {
    this.sync.setPageContent(pageId, body);
  }

  // ---- Inbox items ----
  async listAllInboxItems(): Promise<InboxRow[]> {
    return this.sync.listAllInboxItems();
  }
  async getInboxItem(id: string): Promise<InboxRow | undefined> {
    return this.sync.getInboxItem(id);
  }
  async upsertInboxItem(row: InboxRow): Promise<void> {
    this.sync.upsertInboxItem(row);
  }
  async deleteInboxItem(id: string): Promise<void> {
    this.sync.deleteInboxItem(id);
  }
  async replaceAllInboxItems(rows: InboxRow[]): Promise<void> {
    this.sync.replaceAllInboxItems(rows);
  }

  // ---- Tasks ----
  async listAllTasks(): Promise<TaskRow[]> {
    return this.sync.listAllTasks();
  }
  async listTasksByProject(projectId: string): Promise<TaskRow[]> {
    return this.sync.listTasksByProject(projectId);
  }
  async getTask(id: string): Promise<TaskRow | undefined> {
    return this.sync.getTask(id);
  }
  async upsertTask(row: TaskRow): Promise<void> {
    this.sync.upsertTask(row);
  }
  async deleteTask(id: string): Promise<void> {
    this.sync.deleteTask(id);
  }
  async replaceAllTasks(rows: TaskRow[]): Promise<void> {
    this.sync.replaceAllTasks(rows);
  }
}
