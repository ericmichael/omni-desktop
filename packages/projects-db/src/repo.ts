import type { DatabaseSync } from 'node:sqlite';

import { defaultColumnId } from './defaults.js';
import type { ColumnSyncInput, ColumnSyncResult } from './repo-interface.js';
import { tx, txDeferred } from './tx.js';
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
 * Synchronous SQLite repository wrapping pre-compiled prepared statements for
 * all project data CRUD. Every write method bumps the change sequence for
 * cross-process notification.
 *
 * This is the sync core: the Electron desktop app, the MCP server, and the
 * one-time JSON→SQLite migration all use it directly. The launcher's
 * backend-agnostic data layer talks to it through `SqliteProjectsRepo`
 * (sqlite-repo.ts), which adapts these sync methods to the async
 * {@link IProjectsRepo} contract that Postgres also satisfies.
 */
export class ProjectsRepo {
  private stmts: ReturnType<typeof prepareStatements>;

  constructor(private db: DatabaseSync) {
    this.stmts = prepareStatements(db);
  }

  // ---- Change tracking ----

  getChangeSeq(): number {
    const row = this.stmts.getChangeSeq.get() as { seq: number } | undefined;
    return row?.seq ?? 0;
  }

  bumpChangeSeq(): void {
    this.stmts.bumpChangeSeq.run();
  }

  // ---- Projects ----

  listProjects(): ProjectRow[] {
    return this.stmts.listProjects.all() as ProjectRow[];
  }

  getProject(id: string): ProjectRow | undefined {
    return this.stmts.getProject.get(id) as ProjectRow | undefined;
  }

  getProjectBySlug(slug: string): ProjectRow | undefined {
    return this.stmts.getProjectBySlug.get(slug) as ProjectRow | undefined;
  }

  upsertProject(row: ProjectRow): void {
    this.stmts.upsertProject.run(
      row.id, row.label, row.slug, row.workspace_dir,
      row.is_personal, row.auto_dispatch, row.sources, row.sandbox_profile,
      row.due_date, row.pinned_at,
      row.created_at, row.updated_at,
    );
    this.bumpChangeSeq();
  }

  deleteProject(id: string): void {
    this.stmts.deleteProject.run(id);
    this.bumpChangeSeq();
  }

  /**
   * Read the `config` column for a project. Returns the raw JSON string —
   * caller is responsible for `JSON.parse` and shape validation. Returns
   * `null` for rows that haven't been backfilled yet (v3 migration adds the
   * column; rows from before that have NULL).
   */
  getProjectConfig(id: string): string | null {
    const row = this.stmts.getProjectConfig.get(id) as { config: string | null } | undefined;
    return row?.config ?? null;
  }

  /**
   * Write the `config` column for a project. Pass a JSON-stringified
   * `ProjectConfig`. Bumps `_change_seq` so the watcher fires.
   */
  setProjectConfig(id: string, configJson: string | null): void {
    this.stmts.setProjectConfig.run(configJson, id);
    this.bumpChangeSeq();
  }

  /**
   * Sync the projects table to `rows` without destroying child data.
   *
   * Earlier versions did `DELETE FROM projects` + reinsert inside the tx —
   * which wiped every ticket, milestone, page, pipeline column, task and
   * comment via ON DELETE CASCADE before re-creating the project rows. Any
   * routine update (renaming a project, assigning a workspace, toggling
   * auto-dispatch) destroyed all related data.
   *
   * Diff-and-upsert preserves children: a project row that exists in both
   * old and new is upserted (no cascade fires); a project missing from the
   * new set is explicitly deleted (cascade fires only for the removed row).
   */
  replaceAllProjects(rows: ProjectRow[]): void {
    txDeferred(this.db, () => {
      const incoming = new Set(rows.map((r) => r.id));
      const existing = this.stmts.listAllProjectIds.all() as Array<{ id: string }>;
      for (const { id } of existing) {
        if (!incoming.has(id)) {
          this.stmts.deleteProject.run(id);
        }
      }
      for (const row of rows) {
        this.stmts.upsertProject.run(
          row.id, row.label, row.slug, row.workspace_dir,
          row.is_personal, row.auto_dispatch, row.sources, row.sandbox_profile,
          row.due_date, row.pinned_at,
          row.created_at, row.updated_at,
        );
      }
      this.bumpChangeSeq();
    });
  }

  // ---- Pipeline columns ----

  listColumns(projectId: string): ColumnRow[] {
    return this.stmts.listColumns.all(projectId) as ColumnRow[];
  }

  upsertColumn(row: ColumnRow): void {
    this.stmts.upsertColumn.run(
      row.id, row.project_id, row.label, row.description, row.sort_order, row.gate,
    );
    this.bumpChangeSeq();
  }

  deleteColumnsForProject(projectId: string): void {
    this.stmts.deleteColumnsForProject.run(projectId);
    this.bumpChangeSeq();
  }

  replaceColumnsForProject(projectId: string, rows: ColumnRow[]): void {
    tx(this.db, () => {
      this.stmts.deleteColumnsForProject.run(projectId);
      for (const row of rows) {
        this.stmts.upsertColumn.run(
          row.id, row.project_id, row.label, row.description, row.sort_order, row.gate,
        );
      }
      this.bumpChangeSeq();
    });
  }

  /**
   * Sync the pipeline columns for a project. Idempotent.
   *
   * Remap policy for tickets whose current column is being removed:
   *   1. Same SQLite id in the new set → no-op (label/sort/gate may change).
   *   2. Same label (case-insensitive) → rebind to the new id.
   *   3. Bucket fallback:
   *        - was first column → new first column
   *        - was last column  → new last column
   *        - was a gate       → new first gate, else new first middle column
   *        - was middle       → new first middle column
   *
   * `gateLost = true` when the old column was a gate and the new target is
   * not — caller should surface the change (e.g. ticket comment).
   *
   * Order under FK enforcement: upsert new columns → UPDATE tickets →
   * DELETE removed columns. All within a single transaction.
   */
  syncColumnsForProject(projectId: string, defs: ColumnSyncInput[]): ColumnSyncResult {
    if (defs.length === 0) {
      throw new Error('syncColumnsForProject: defs must not be empty');
    }

    const newRows: ColumnRow[] = defs.map((d, i) => ({
      id: defaultColumnId(projectId, d.logicalId),
      project_id: projectId,
      label: d.label,
      description: d.description ?? null,
      sort_order: i,
      gate: d.gate ? 1 : 0,
    }));

    const result: ColumnSyncResult = { inserted: [], removed: [], remappedTickets: [] };

    tx(this.db, () => {
      const oldRows = this.listColumns(projectId);
      const oldById = new Map(oldRows.map((r) => [r.id, r]));
      const newById = new Map(newRows.map((r) => [r.id, r]));
      const newByLabelLower = new Map(newRows.map((r) => [r.label.toLowerCase(), r]));

      // Bucket targets in the new pipeline
      const firstNew = newRows[0]!;
      const lastNew = newRows[newRows.length - 1]!;
      const firstGateNew = newRows.find((r) => r.gate === 1);
      const middleNew = newRows.find((r, i) => i > 0 && i < newRows.length - 1) ?? firstNew;

      // 1a. Free up labels held by columns about to be removed. The
      // schema enforces UNIQUE(project_id, label) so a new column reusing
      // an old label would otherwise trip on upsert before the old row is
      // deleted. Rename to a guaranteed-unique placeholder; the row gets
      // dropped later in this same tx.
      for (const oldRow of oldRows) {
        if (!newById.has(oldRow.id)) {
          this.stmts.updateColumnLabel.run(`__obsolete__${oldRow.id}`, oldRow.id);
        }
      }

      // 1b. Upsert new columns (FK targets need to exist before remap)
      for (const row of newRows) {
        if (!oldById.has(row.id)) {
          result.inserted.push(row.id);
        }
        this.stmts.upsertColumn.run(
          row.id, row.project_id, row.label, row.description, row.sort_order, row.gate,
        );
      }

      // 2. Remap tickets whose column was removed
      const tickets = this.listTicketsByProject(projectId);
      const oldFirst = oldRows[0];
      const oldLast = oldRows[oldRows.length - 1];

      for (const t of tickets) {
        if (newById.has(t.column_id)) {
          continue; // already valid
        }

        const oldCol = oldById.get(t.column_id);
        let target: ColumnRow;

        if (oldCol) {
          // Try label match first
          const byLabel = newByLabelLower.get(oldCol.label.toLowerCase());
          if (byLabel) {
            target = byLabel;
          } else if (oldCol.id === oldFirst?.id) {
            target = firstNew;
          } else if (oldCol.id === oldLast?.id) {
            target = lastNew;
          } else if (oldCol.gate === 1) {
            target = firstGateNew ?? middleNew;
          } else {
            target = middleNew;
          }
        } else {
          // Old column wasn't even in pipeline_columns — orphan from earlier
          // launcher versions. Drop it in the first column.
          target = firstNew;
        }

        const gateLost = oldCol?.gate === 1 && target.gate !== 1;

        this.stmts.updateTicketColumn.run(target.id, t.id);
        result.remappedTickets.push({
          ticketId: t.id,
          fromColumnId: t.column_id,
          toColumnId: target.id,
          fromLabel: oldCol?.label ?? t.column_id,
          toLabel: target.label,
          gateLost,
        });
      }

      // 3. Delete columns no longer in the new set (FK now safe)
      for (const oldRow of oldRows) {
        if (!newById.has(oldRow.id)) {
          this.stmts.deleteColumnById.run(oldRow.id);
          result.removed.push(oldRow.id);
        }
      }

      this.bumpChangeSeq();
    });

    return result;
  }

  // ---- Tickets ----

  listAllTickets(): TicketRow[] {
    return this.stmts.listAllTickets.all() as TicketRow[];
  }

  listTicketsByProject(projectId: string): TicketRow[] {
    return this.stmts.listTicketsByProject.all(projectId) as TicketRow[];
  }

  getTicket(id: string): TicketRow | undefined {
    return this.stmts.getTicket.get(id) as TicketRow | undefined;
  }

  upsertTicket(row: TicketRow): void {
    this.stmts.upsertTicket.run(
      row.id, row.project_id, row.milestone_id, row.column_id,
      row.title, row.description, row.priority, row.branch,
      row.blocked_by, row.shaping, row.resolution, row.resolved_at,
      row.archived_at, row.column_changed_at,
      row.use_worktree, row.worktree_path, row.worktree_name,
      row.supervisor_session_id, row.phase, row.phase_changed_at,
      row.supervisor_task_id, row.token_usage, row.runs,
      row.pr_review, row.pr_merged_at,
      row.created_at, row.updated_at,
    );
    this.bumpChangeSeq();
  }

  deleteTicket(id: string): void {
    this.stmts.deleteTicket.run(id);
    this.bumpChangeSeq();
  }

  /**
   * Sync the tickets table to `rows` without destroying child data
   * (comments, supervisor tasks). See `replaceAllProjects` for the
   * rationale — the legacy delete-all+reinsert pattern wiped
   * `ticket_comments` via CASCADE on every ticket write.
   */
  replaceAllTickets(rows: TicketRow[]): void {
    txDeferred(this.db, () => {
      const incoming = new Set(rows.map((r) => r.id));
      const existing = this.stmts.listAllTicketIds.all() as Array<{ id: string }>;
      for (const { id } of existing) {
        if (!incoming.has(id)) {
          this.stmts.deleteTicket.run(id);
        }
      }
      for (const row of rows) {
        this.stmts.upsertTicket.run(
          row.id, row.project_id, row.milestone_id, row.column_id,
          row.title, row.description, row.priority, row.branch,
          row.blocked_by, row.shaping, row.resolution, row.resolved_at,
          row.archived_at, row.column_changed_at,
          row.use_worktree, row.worktree_path, row.worktree_name,
          row.supervisor_session_id, row.phase, row.phase_changed_at,
          row.supervisor_task_id, row.token_usage, row.runs,
          row.pr_review, row.pr_merged_at,
          row.created_at, row.updated_at,
        );
      }
      this.bumpChangeSeq();
    });
  }

  // ---- Comments ----

  listCommentsByTicket(ticketId: string): CommentRow[] {
    return this.stmts.listCommentsByTicket.all(ticketId) as CommentRow[];
  }

  upsertComment(row: CommentRow): void {
    this.stmts.upsertComment.run(row.id, row.ticket_id, row.author, row.content, row.created_at);
    this.bumpChangeSeq();
  }

  deleteComment(id: string): void {
    this.stmts.deleteComment.run(id);
    this.bumpChangeSeq();
  }

  deleteCommentsForTicket(ticketId: string): void {
    this.stmts.deleteCommentsForTicket.run(ticketId);
    this.bumpChangeSeq();
  }

  replaceCommentsForTicket(ticketId: string, rows: CommentRow[]): void {
    tx(this.db, () => {
      this.stmts.deleteCommentsForTicket.run(ticketId);
      for (const row of rows) {
        this.stmts.upsertComment.run(row.id, row.ticket_id, row.author, row.content, row.created_at);
      }
      this.bumpChangeSeq();
    });
  }

  // ---- Milestones ----

  listAllMilestones(): MilestoneRow[] {
    return this.stmts.listAllMilestones.all() as MilestoneRow[];
  }

  listMilestonesByProject(projectId: string): MilestoneRow[] {
    return this.stmts.listMilestonesByProject.all(projectId) as MilestoneRow[];
  }

  getMilestone(id: string): MilestoneRow | undefined {
    return this.stmts.getMilestone.get(id) as MilestoneRow | undefined;
  }

  upsertMilestone(row: MilestoneRow): void {
    this.stmts.upsertMilestone.run(
      row.id, row.project_id, row.title, row.description,
      row.branch, row.brief, row.status, row.due_date,
      row.completed_at, row.pinned_at,
      row.created_at, row.updated_at,
    );
    this.bumpChangeSeq();
  }

  deleteMilestone(id: string): void {
    this.stmts.deleteMilestone.run(id);
    this.bumpChangeSeq();
  }

  /**
   * Sync the milestones table to `rows` without breaking ticket links.
   * Milestone deletes use SET NULL on `tickets.milestone_id`, but the
   * legacy delete-all+reinsert pattern severed every ticket's milestone
   * link on every milestone write. Diff-and-upsert only fires SET NULL
   * for milestones actually being removed.
   */
  replaceAllMilestones(rows: MilestoneRow[]): void {
    txDeferred(this.db, () => {
      const incoming = new Set(rows.map((r) => r.id));
      const existing = this.stmts.listAllMilestoneIds.all() as Array<{ id: string }>;
      for (const { id } of existing) {
        if (!incoming.has(id)) {
          this.stmts.deleteMilestone.run(id);
        }
      }
      for (const row of rows) {
        this.stmts.upsertMilestone.run(
          row.id, row.project_id, row.title, row.description,
          row.branch, row.brief, row.status, row.due_date,
          row.completed_at, row.pinned_at,
          row.created_at, row.updated_at,
        );
      }
      this.bumpChangeSeq();
    });
  }

  // ---- Pages ----

  listAllPages(): PageRow[] {
    return this.stmts.listAllPages.all() as PageRow[];
  }

  listPagesByProject(projectId: string): PageRow[] {
    return this.stmts.listPagesByProject.all(projectId) as PageRow[];
  }

  getPage(id: string): PageRow | undefined {
    return this.stmts.getPage.get(id) as PageRow | undefined;
  }

  upsertPage(row: PageRow): void {
    this.stmts.upsertPage.run(
      row.id, row.project_id, row.parent_id, row.title,
      row.icon, row.sort_order, row.is_root, row.kind,
      row.properties, row.created_at, row.updated_at,
    );
    this.bumpChangeSeq();
  }

  deletePage(id: string): void {
    this.stmts.deletePage.run(id);
    this.bumpChangeSeq();
  }

  /**
   * Sync the pages table to `rows`. Deferred FKs let us upsert parent/
   * child pages in any order — `pages.parent_id` self-references the same
   * table and the legacy pattern of delete-all + reinsert could fail or
   * silently null parent pointers depending on row order.
   */
  replaceAllPages(rows: PageRow[]): void {
    txDeferred(this.db, () => {
      const incoming = new Set(rows.map((r) => r.id));
      const existing = this.stmts.listAllPageIds.all() as Array<{ id: string }>;
      for (const { id } of existing) {
        if (!incoming.has(id)) {
          this.stmts.deletePage.run(id);
        }
      }
      for (const row of rows) {
        this.stmts.upsertPage.run(
          row.id, row.project_id, row.parent_id, row.title,
          row.icon, row.sort_order, row.is_root, row.kind,
          row.properties, row.created_at, row.updated_at,
        );
      }
      this.bumpChangeSeq();
    });
  }

  // ---- Page content (markdown doc bodies) ----

  getPageContent(pageId: string): string | null {
    const row = this.stmts.getPageContent.get(pageId) as { body: string } | undefined;
    return row?.body ?? null;
  }

  setPageContent(pageId: string, body: string): void {
    this.stmts.setPageContent.run(pageId, body);
    this.bumpChangeSeq();
  }

  // ---- Inbox items ----

  listAllInboxItems(): InboxRow[] {
    return this.stmts.listAllInboxItems.all() as InboxRow[];
  }

  getInboxItem(id: string): InboxRow | undefined {
    return this.stmts.getInboxItem.get(id) as InboxRow | undefined;
  }

  upsertInboxItem(row: InboxRow): void {
    this.stmts.upsertInboxItem.run(
      row.id, row.title, row.note, row.project_id,
      row.status, row.shaping, row.later_at, row.promoted_to,
      row.created_at, row.updated_at,
    );
    this.bumpChangeSeq();
  }

  deleteInboxItem(id: string): void {
    this.stmts.deleteInboxItem.run(id);
    this.bumpChangeSeq();
  }

  /**
   * Sync the inbox table to `rows`. No child tables reference inbox_items,
   * so diff-and-upsert is purely for consistency with the other replaceAll
   * methods and to avoid unnecessary row churn on every write.
   */
  replaceAllInboxItems(rows: InboxRow[]): void {
    txDeferred(this.db, () => {
      const incoming = new Set(rows.map((r) => r.id));
      const existing = this.stmts.listAllInboxItemIds.all() as Array<{ id: string }>;
      for (const { id } of existing) {
        if (!incoming.has(id)) {
          this.stmts.deleteInboxItem.run(id);
        }
      }
      for (const row of rows) {
        this.stmts.upsertInboxItem.run(
          row.id, row.title, row.note, row.project_id,
          row.status, row.shaping, row.later_at, row.promoted_to,
          row.created_at, row.updated_at,
        );
      }
      this.bumpChangeSeq();
    });
  }

  // ---- Tasks ----

  listAllTasks(): TaskRow[] {
    return this.stmts.listAllTasks.all() as TaskRow[];
  }

  listTasksByProject(projectId: string): TaskRow[] {
    return this.stmts.listTasksByProject.all(projectId) as TaskRow[];
  }

  getTask(id: string): TaskRow | undefined {
    return this.stmts.getTask.get(id) as TaskRow | undefined;
  }

  upsertTask(row: TaskRow): void {
    this.stmts.upsertTask.run(
      row.id, row.project_id, row.task_description, row.status,
      row.created_at, row.branch, row.worktree_path, row.worktree_name,
      row.session_id, row.ticket_id, row.last_urls,
    );
    this.bumpChangeSeq();
  }

  deleteTask(id: string): void {
    this.stmts.deleteTask.run(id);
    this.bumpChangeSeq();
  }

  /**
   * Sync the tasks table to `rows`. No child tables reference tasks, but
   * we still use diff-and-upsert so a routine "save supervisor state"
   * doesn't churn every task row's identity.
   */
  replaceAllTasks(rows: TaskRow[]): void {
    txDeferred(this.db, () => {
      const incoming = new Set(rows.map((r) => r.id));
      const existing = this.stmts.listAllTaskIds.all() as Array<{ id: string }>;
      for (const { id } of existing) {
        if (!incoming.has(id)) {
          this.stmts.deleteTask.run(id);
        }
      }
      for (const row of rows) {
        this.stmts.upsertTask.run(
          row.id, row.project_id, row.task_description, row.status,
          row.created_at, row.branch, row.worktree_path, row.worktree_name,
          row.session_id, row.ticket_id, row.last_urls,
        );
      }
      this.bumpChangeSeq();
    });
  }
}

// ---- Prepared statement compilation ----

function prepareStatements(db: DatabaseSync) {
  return {
    // Change tracking
    getChangeSeq: db.prepare('SELECT seq FROM _change_seq WHERE id = 1'),
    bumpChangeSeq: db.prepare('UPDATE _change_seq SET seq = seq + 1, updated_at = datetime(\'now\') WHERE id = 1'),

    // Projects
    listProjects: db.prepare('SELECT * FROM projects ORDER BY created_at'),
    getProject: db.prepare('SELECT * FROM projects WHERE id = ?'),
    getProjectBySlug: db.prepare('SELECT * FROM projects WHERE slug = ?'),
    upsertProject: db.prepare(`
      INSERT INTO projects (id, label, slug, workspace_dir, is_personal, auto_dispatch, sources, sandbox_profile, due_date, pinned_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label, slug = excluded.slug, workspace_dir = excluded.workspace_dir,
        is_personal = excluded.is_personal, auto_dispatch = excluded.auto_dispatch,
        sources = excluded.sources, sandbox_profile = excluded.sandbox_profile,
        due_date = excluded.due_date, pinned_at = excluded.pinned_at,
        updated_at = excluded.updated_at
    `),
    deleteProject: db.prepare('DELETE FROM projects WHERE id = ?'),
    deleteAllProjects: db.prepare('DELETE FROM projects'),
    listAllProjectIds: db.prepare('SELECT id FROM projects'),
    getProjectConfig: db.prepare('SELECT config FROM projects WHERE id = ?'),
    setProjectConfig: db.prepare('UPDATE projects SET config = ?, updated_at = datetime(\'now\') WHERE id = ?'),

    // Pipeline columns
    listColumns: db.prepare('SELECT * FROM pipeline_columns WHERE project_id = ? ORDER BY sort_order'),
    upsertColumn: db.prepare(`
      INSERT INTO pipeline_columns (id, project_id, label, description, sort_order, gate)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label, description = excluded.description,
        sort_order = excluded.sort_order, gate = excluded.gate
    `),
    deleteColumnsForProject: db.prepare('DELETE FROM pipeline_columns WHERE project_id = ?'),
    deleteColumnById: db.prepare('DELETE FROM pipeline_columns WHERE id = ?'),
    updateColumnLabel: db.prepare('UPDATE pipeline_columns SET label = ? WHERE id = ?'),
    updateTicketColumn: db.prepare(`
      UPDATE tickets SET column_id = ?, column_changed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `),

    // Tickets
    listAllTickets: db.prepare('SELECT * FROM tickets ORDER BY created_at'),
    listTicketsByProject: db.prepare('SELECT * FROM tickets WHERE project_id = ? ORDER BY created_at'),
    getTicket: db.prepare('SELECT * FROM tickets WHERE id = ?'),
    upsertTicket: db.prepare(`
      INSERT INTO tickets (
        id, project_id, milestone_id, column_id, title, description, priority, branch,
        blocked_by, shaping, resolution, resolved_at, archived_at, column_changed_at,
        use_worktree, worktree_path, worktree_name, supervisor_session_id,
        phase, phase_changed_at, supervisor_task_id, token_usage, runs,
        pr_review, pr_merged_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id, milestone_id = excluded.milestone_id,
        column_id = excluded.column_id, title = excluded.title, description = excluded.description,
        priority = excluded.priority, branch = excluded.branch, blocked_by = excluded.blocked_by,
        shaping = excluded.shaping, resolution = excluded.resolution, resolved_at = excluded.resolved_at,
        archived_at = excluded.archived_at, column_changed_at = excluded.column_changed_at,
        use_worktree = excluded.use_worktree, worktree_path = excluded.worktree_path,
        worktree_name = excluded.worktree_name, supervisor_session_id = excluded.supervisor_session_id,
        phase = excluded.phase, phase_changed_at = excluded.phase_changed_at,
        supervisor_task_id = excluded.supervisor_task_id, token_usage = excluded.token_usage,
        runs = excluded.runs,
        pr_review = excluded.pr_review, pr_merged_at = excluded.pr_merged_at,
        updated_at = excluded.updated_at
    `),
    deleteTicket: db.prepare('DELETE FROM tickets WHERE id = ?'),
    deleteAllTickets: db.prepare('DELETE FROM tickets'),
    listAllTicketIds: db.prepare('SELECT id FROM tickets'),

    // Comments
    listCommentsByTicket: db.prepare('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at'),
    upsertComment: db.prepare(`
      INSERT INTO ticket_comments (id, ticket_id, author, content, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        author = excluded.author, content = excluded.content
    `),
    deleteComment: db.prepare('DELETE FROM ticket_comments WHERE id = ?'),
    deleteCommentsForTicket: db.prepare('DELETE FROM ticket_comments WHERE ticket_id = ?'),

    // Milestones
    listAllMilestones: db.prepare('SELECT * FROM milestones ORDER BY created_at'),
    listMilestonesByProject: db.prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY created_at'),
    getMilestone: db.prepare('SELECT * FROM milestones WHERE id = ?'),
    upsertMilestone: db.prepare(`
      INSERT INTO milestones (id, project_id, title, description, branch, brief, status, due_date, completed_at, pinned_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id, title = excluded.title, description = excluded.description,
        branch = excluded.branch, brief = excluded.brief, status = excluded.status,
        due_date = excluded.due_date, completed_at = excluded.completed_at,
        pinned_at = excluded.pinned_at, updated_at = excluded.updated_at
    `),
    deleteMilestone: db.prepare('DELETE FROM milestones WHERE id = ?'),
    deleteAllMilestones: db.prepare('DELETE FROM milestones'),
    listAllMilestoneIds: db.prepare('SELECT id FROM milestones'),

    // Pages
    listAllPages: db.prepare('SELECT * FROM pages ORDER BY sort_order'),
    listPagesByProject: db.prepare('SELECT * FROM pages WHERE project_id = ? ORDER BY sort_order'),
    getPage: db.prepare('SELECT * FROM pages WHERE id = ?'),
    upsertPage: db.prepare(`
      INSERT INTO pages (id, project_id, parent_id, title, icon, sort_order, is_root, kind, properties, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id, parent_id = excluded.parent_id,
        title = excluded.title, icon = excluded.icon, sort_order = excluded.sort_order,
        is_root = excluded.is_root, kind = excluded.kind, properties = excluded.properties,
        updated_at = excluded.updated_at
    `),
    deletePage: db.prepare('DELETE FROM pages WHERE id = ?'),
    deleteAllPages: db.prepare('DELETE FROM pages'),
    listAllPageIds: db.prepare('SELECT id FROM pages'),

    // Page content
    getPageContent: db.prepare('SELECT body FROM page_content WHERE page_id = ?'),
    setPageContent: db.prepare(`
      INSERT INTO page_content (page_id, body) VALUES (?, ?)
      ON CONFLICT(page_id) DO UPDATE SET body = excluded.body, updated_at = datetime('now')
    `),

    // Inbox items
    listAllInboxItems: db.prepare('SELECT * FROM inbox_items ORDER BY created_at DESC'),
    getInboxItem: db.prepare('SELECT * FROM inbox_items WHERE id = ?'),
    upsertInboxItem: db.prepare(`
      INSERT INTO inbox_items (id, title, note, project_id, status, shaping, later_at, promoted_to, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, note = excluded.note, project_id = excluded.project_id,
        status = excluded.status, shaping = excluded.shaping, later_at = excluded.later_at,
        promoted_to = excluded.promoted_to, updated_at = excluded.updated_at
    `),
    deleteInboxItem: db.prepare('DELETE FROM inbox_items WHERE id = ?'),
    deleteAllInboxItems: db.prepare('DELETE FROM inbox_items'),
    listAllInboxItemIds: db.prepare('SELECT id FROM inbox_items'),

    // Tasks
    listAllTasks: db.prepare('SELECT * FROM tasks ORDER BY created_at'),
    listTasksByProject: db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at'),
    getTask: db.prepare('SELECT * FROM tasks WHERE id = ?'),
    upsertTask: db.prepare(`
      INSERT INTO tasks (id, project_id, task_description, status, created_at, branch, worktree_path, worktree_name, session_id, ticket_id, last_urls)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id, task_description = excluded.task_description,
        status = excluded.status, branch = excluded.branch, worktree_path = excluded.worktree_path,
        worktree_name = excluded.worktree_name, session_id = excluded.session_id,
        ticket_id = excluded.ticket_id, last_urls = excluded.last_urls
    `),
    deleteTask: db.prepare('DELETE FROM tasks WHERE id = ?'),
    deleteAllTasks: db.prepare('DELETE FROM tasks'),
    listAllTaskIds: db.prepare('SELECT id FROM tasks'),
  };
}
