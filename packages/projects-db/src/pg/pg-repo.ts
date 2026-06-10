/**
 * Postgres-backed, tenant-scoped implementation of {@link IProjectsRepo}.
 *
 * Constructed with a `tenantId`; every operation runs in a transaction that
 * first sets `app.current_tenant`, so the row-level-security policies scope all
 * reads and writes to this tenant — a forgotten predicate cannot leak across
 * tenants. Writes also stamp `tenant_id` on inserted rows (RLS `WITH CHECK`
 * enforces it matches).
 *
 * Statements mirror the SQLite `ProjectsRepo` but use `$N` placeholders,
 * `EXCLUDED` upserts, and the denormalized `tenant_id` column. Row shapes are
 * identical to the SQLite path, so `db-store-bridge` is reused unchanged.
 */
import type { Pool, PoolClient } from 'pg';

import { defaultColumnId } from '../defaults.js';
import type { ColumnSyncInput, ColumnSyncResult, IProjectsRepo } from '../repo-interface.js';
import type {
  ColumnRow,
  CommentRow,
  InboxRow,
  MilestoneRow,
  PageRow,
  ProjectRow,
  TaskRow,
  TicketRow,
} from '../types.js';

export class PgProjectsRepo implements IProjectsRepo {
  constructor(
    private readonly pool: Pool,
    private readonly tenantId: string,
    /** This replica's id, tagged onto change notifications so it can ignore its own. */
    private readonly originId = ''
  ) {}

  /** Run `fn` in a tenant-scoped transaction (RLS keys off `app.current_tenant`). */
  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [this.tenantId]);
      // Tags the change-notify trigger so this replica ignores its own writes.
      await client.query("SELECT set_config('app.current_origin', $1, true)", [this.originId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback failure — surface the original error
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /** Convenience: a read that returns all rows of a single-statement query. */
  private rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.tx(async (c) => (await c.query(sql, params)).rows as T[]);
  }

  /** Convenience: a read that returns the first row or undefined. */
  private async one<T>(sql: string, params: unknown[]): Promise<T | undefined> {
    return this.tx(async (c) => ((await c.query(sql, params)).rows[0] as T | undefined));
  }

  // ---- Projects ----

  listProjects(): Promise<ProjectRow[]> {
    return this.rows<ProjectRow>('SELECT * FROM projects ORDER BY created_at');
  }

  getProject(id: string): Promise<ProjectRow | undefined> {
    return this.one<ProjectRow>('SELECT * FROM projects WHERE id = $1', [id]);
  }

  getProjectBySlug(slug: string): Promise<ProjectRow | undefined> {
    return this.one<ProjectRow>('SELECT * FROM projects WHERE slug = $1', [slug]);
  }

  async upsertProject(row: ProjectRow): Promise<void> {
    await this.tx((c) => this.upsertProjectIn(c, row));
  }

  private upsertProjectIn(c: PoolClient, row: ProjectRow): Promise<unknown> {
    return c.query(
      `INSERT INTO projects (tenant_id, id, label, slug, workspace_dir, is_personal, auto_dispatch, sources, sandbox_profile, due_date, pinned_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET
         label = EXCLUDED.label, slug = EXCLUDED.slug, workspace_dir = EXCLUDED.workspace_dir,
         is_personal = EXCLUDED.is_personal, auto_dispatch = EXCLUDED.auto_dispatch,
         sources = EXCLUDED.sources, sandbox_profile = EXCLUDED.sandbox_profile,
         due_date = EXCLUDED.due_date, pinned_at = EXCLUDED.pinned_at,
         updated_at = EXCLUDED.updated_at`,
      [
        this.tenantId, row.id, row.label, row.slug, row.workspace_dir,
        row.is_personal, row.auto_dispatch, row.sources, row.sandbox_profile,
        row.due_date, row.pinned_at, row.created_at, row.updated_at,
      ]
    );
  }

  async deleteProject(id: string): Promise<void> {
    await this.tx((c) => c.query('DELETE FROM projects WHERE id = $1', [id]));
  }

  async getProjectConfig(id: string): Promise<string | null> {
    const row = await this.one<{ config: string | null }>('SELECT config FROM projects WHERE id = $1', [id]);
    return row?.config ?? null;
  }

  async setProjectConfig(id: string, configJson: string | null): Promise<void> {
    await this.tx((c) =>
      c.query(`UPDATE projects SET config = $1, updated_at = ${"to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS.MS')"} WHERE id = $2`, [configJson, id])
    );
  }

  async replaceAllProjects(rows: ProjectRow[]): Promise<void> {
    await this.tx(async (c) => {
      const incoming = new Set(rows.map((r) => r.id));
      const existing = (await c.query('SELECT id FROM projects')).rows as Array<{ id: string }>;
      for (const { id } of existing) {
        if (!incoming.has(id)) {
          await c.query('DELETE FROM projects WHERE id = $1', [id]);
        }
      }
      for (const row of rows) {
        await this.upsertProjectIn(c, row);
      }
    });
  }

  // ---- Pipeline columns ----

  listColumns(projectId: string): Promise<ColumnRow[]> {
    return this.rows<ColumnRow>('SELECT tenant_id, id, project_id, label, description, sort_order, gate, max_concurrent, workflow::text AS workflow FROM pipeline_columns WHERE project_id = $1 ORDER BY sort_order', [projectId]);
  }

  async upsertColumn(row: ColumnRow): Promise<void> {
    await this.tx((c) => this.upsertColumnIn(c, row));
  }

  private upsertColumnIn(c: PoolClient, row: ColumnRow): Promise<unknown> {
    return c.query(
      `INSERT INTO pipeline_columns (tenant_id, id, project_id, label, description, sort_order, gate, max_concurrent, workflow)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         label = EXCLUDED.label, description = EXCLUDED.description,
         sort_order = EXCLUDED.sort_order, gate = EXCLUDED.gate,
         max_concurrent = EXCLUDED.max_concurrent, workflow = EXCLUDED.workflow`,
      [this.tenantId, row.id, row.project_id, row.label, row.description, row.sort_order, row.gate, row.max_concurrent, row.workflow]
    );
  }

  async deleteColumnsForProject(projectId: string): Promise<void> {
    await this.tx((c) => c.query('DELETE FROM pipeline_columns WHERE project_id = $1', [projectId]));
  }

  async replaceColumnsForProject(projectId: string, rows: ColumnRow[]): Promise<void> {
    await this.tx(async (c) => {
      await c.query('DELETE FROM pipeline_columns WHERE project_id = $1', [projectId]);
      for (const row of rows) {
        await this.upsertColumnIn(c, row);
      }
    });
  }

  /** Port of the SQLite remap policy — see ProjectsRepo.syncColumnsForProject. */
  async syncColumnsForProject(projectId: string, defs: ColumnSyncInput[]): Promise<ColumnSyncResult> {
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
      max_concurrent: d.maxConcurrent ?? null,
      workflow: d.workflow == null ? null : JSON.stringify(d.workflow),
    }));
    const result: ColumnSyncResult = { inserted: [], removed: [], remappedTickets: [] };

    return this.tx(async (c) => {
      const oldRows = (await c.query('SELECT tenant_id, id, project_id, label, description, sort_order, gate, max_concurrent, workflow::text AS workflow FROM pipeline_columns WHERE project_id = $1 ORDER BY sort_order', [projectId])).rows as ColumnRow[];
      const oldById = new Map(oldRows.map((r) => [r.id, r]));
      const newById = new Map(newRows.map((r) => [r.id, r]));
      const newByLabelLower = new Map(newRows.map((r) => [r.label.toLowerCase(), r]));

      const firstNew = newRows[0]!;
      const lastNew = newRows[newRows.length - 1]!;
      const firstGateNew = newRows.find((r) => r.gate === 1);
      const middleNew = newRows.find((r, i) => i > 0 && i < newRows.length - 1) ?? firstNew;

      // Free labels held by columns about to be removed (UNIQUE(project_id,label)).
      for (const oldRow of oldRows) {
        if (!newById.has(oldRow.id)) {
          await c.query('UPDATE pipeline_columns SET label = $1 WHERE id = $2', [`__obsolete__${oldRow.id}`, oldRow.id]);
        }
      }

      // Upsert new columns (FK targets must exist before remap).
      for (const row of newRows) {
        if (!oldById.has(row.id)) {
          result.inserted.push(row.id);
        }
        await this.upsertColumnIn(c, row);
      }

      // Remap tickets whose column was removed.
      const tickets = (await c.query('SELECT * FROM tickets WHERE project_id = $1 ORDER BY created_at', [projectId])).rows as TicketRow[];
      const oldFirst = oldRows[0];
      const oldLast = oldRows[oldRows.length - 1];

      for (const t of tickets) {
        if (newById.has(t.column_id)) {
          continue;
        }
        const oldCol = oldById.get(t.column_id);
        let target: ColumnRow;
        if (oldCol) {
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
          target = firstNew;
        }
        const gateLost = oldCol?.gate === 1 && target.gate !== 1;
        await c.query(
          `UPDATE tickets SET column_id = $1, column_changed_at = ${"to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS.MS')"}, updated_at = ${"to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS.MS')"} WHERE id = $2`,
          [target.id, t.id]
        );
        result.remappedTickets.push({
          ticketId: t.id,
          fromColumnId: t.column_id,
          toColumnId: target.id,
          fromLabel: oldCol?.label ?? t.column_id,
          toLabel: target.label,
          gateLost,
        });
      }

      // Delete columns no longer present (FK now safe).
      for (const oldRow of oldRows) {
        if (!newById.has(oldRow.id)) {
          await c.query('DELETE FROM pipeline_columns WHERE id = $1', [oldRow.id]);
          result.removed.push(oldRow.id);
        }
      }

      return result;
    });
  }

  // ---- Tickets ----

  listAllTickets(): Promise<TicketRow[]> {
    return this.rows<TicketRow>('SELECT * FROM tickets ORDER BY created_at');
  }

  listTicketsByProject(projectId: string): Promise<TicketRow[]> {
    return this.rows<TicketRow>('SELECT * FROM tickets WHERE project_id = $1 ORDER BY created_at', [projectId]);
  }

  getTicket(id: string): Promise<TicketRow | undefined> {
    return this.one<TicketRow>('SELECT * FROM tickets WHERE id = $1', [id]);
  }

  async upsertTicket(row: TicketRow): Promise<void> {
    await this.tx((c) => this.upsertTicketIn(c, row));
  }

  private upsertTicketIn(c: PoolClient, row: TicketRow): Promise<unknown> {
    return c.query(
      `INSERT INTO tickets (
         tenant_id, id, project_id, milestone_id, column_id, title, description, priority, branch,
         blocked_by, resolution, resolved_at, archived_at, column_changed_at,
         use_worktree, worktree_path, worktree_name, supervisor_session_id,
         phase, phase_changed_at, supervisor_task_id, token_usage, runs,
         pr_review, pr_merged_at, assignee, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
       ON CONFLICT (id) DO UPDATE SET
         project_id = EXCLUDED.project_id, milestone_id = EXCLUDED.milestone_id,
         column_id = EXCLUDED.column_id, title = EXCLUDED.title, description = EXCLUDED.description,
         priority = EXCLUDED.priority, branch = EXCLUDED.branch, blocked_by = EXCLUDED.blocked_by,
         resolution = EXCLUDED.resolution, resolved_at = EXCLUDED.resolved_at,
         archived_at = EXCLUDED.archived_at, column_changed_at = EXCLUDED.column_changed_at,
         use_worktree = EXCLUDED.use_worktree, worktree_path = EXCLUDED.worktree_path,
         worktree_name = EXCLUDED.worktree_name, supervisor_session_id = EXCLUDED.supervisor_session_id,
         phase = EXCLUDED.phase, phase_changed_at = EXCLUDED.phase_changed_at,
         supervisor_task_id = EXCLUDED.supervisor_task_id, token_usage = EXCLUDED.token_usage,
         runs = EXCLUDED.runs, pr_review = EXCLUDED.pr_review, pr_merged_at = EXCLUDED.pr_merged_at,
         assignee = EXCLUDED.assignee,
         updated_at = EXCLUDED.updated_at`,
      [
        this.tenantId, row.id, row.project_id, row.milestone_id, row.column_id,
        row.title, row.description, row.priority, row.branch,
        row.blocked_by, row.resolution, row.resolved_at,
        row.archived_at, row.column_changed_at,
        row.use_worktree, row.worktree_path, row.worktree_name, row.supervisor_session_id,
        row.phase, row.phase_changed_at, row.supervisor_task_id, row.token_usage, row.runs,
        row.pr_review, row.pr_merged_at, row.assignee, row.created_at, row.updated_at,
      ]
    );
  }

  async deleteTicket(id: string): Promise<void> {
    await this.tx((c) => c.query('DELETE FROM tickets WHERE id = $1', [id]));
  }

  async replaceAllTickets(rows: TicketRow[]): Promise<void> {
    await this.tx(async (c) => {
      const incoming = new Set(rows.map((r) => r.id));
      const existing = (await c.query('SELECT id FROM tickets')).rows as Array<{ id: string }>;
      for (const { id } of existing) {
        if (!incoming.has(id)) {
          await c.query('DELETE FROM tickets WHERE id = $1', [id]);
        }
      }
      for (const row of rows) {
        await this.upsertTicketIn(c, row);
      }
    });
  }

  // ---- Comments ----

  listCommentsByTicket(ticketId: string): Promise<CommentRow[]> {
    return this.rows<CommentRow>('SELECT * FROM ticket_comments WHERE ticket_id = $1 ORDER BY created_at', [ticketId]);
  }

  async upsertComment(row: CommentRow): Promise<void> {
    await this.tx((c) => this.upsertCommentIn(c, row));
  }

  private upsertCommentIn(c: PoolClient, row: CommentRow): Promise<unknown> {
    return c.query(
      `INSERT INTO ticket_comments (tenant_id, id, ticket_id, author, content, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET author = EXCLUDED.author, content = EXCLUDED.content`,
      [this.tenantId, row.id, row.ticket_id, row.author, row.content, row.created_at]
    );
  }

  async deleteComment(id: string): Promise<void> {
    await this.tx((c) => c.query('DELETE FROM ticket_comments WHERE id = $1', [id]));
  }

  async deleteCommentsForTicket(ticketId: string): Promise<void> {
    await this.tx((c) => c.query('DELETE FROM ticket_comments WHERE ticket_id = $1', [ticketId]));
  }

  async replaceCommentsForTicket(ticketId: string, rows: CommentRow[]): Promise<void> {
    await this.tx(async (c) => {
      await c.query('DELETE FROM ticket_comments WHERE ticket_id = $1', [ticketId]);
      for (const row of rows) {
        await this.upsertCommentIn(c, row);
      }
    });
  }

  // ---- Milestones ----

  listAllMilestones(): Promise<MilestoneRow[]> {
    return this.rows<MilestoneRow>('SELECT * FROM milestones ORDER BY created_at');
  }

  listMilestonesByProject(projectId: string): Promise<MilestoneRow[]> {
    return this.rows<MilestoneRow>('SELECT * FROM milestones WHERE project_id = $1 ORDER BY created_at', [projectId]);
  }

  getMilestone(id: string): Promise<MilestoneRow | undefined> {
    return this.one<MilestoneRow>('SELECT * FROM milestones WHERE id = $1', [id]);
  }

  async upsertMilestone(row: MilestoneRow): Promise<void> {
    await this.tx((c) => this.upsertMilestoneIn(c, row));
  }

  private upsertMilestoneIn(c: PoolClient, row: MilestoneRow): Promise<unknown> {
    return c.query(
      `INSERT INTO milestones (tenant_id, id, project_id, title, description, branch, brief, status, due_date, completed_at, pinned_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET
         project_id = EXCLUDED.project_id, title = EXCLUDED.title, description = EXCLUDED.description,
         branch = EXCLUDED.branch, brief = EXCLUDED.brief, status = EXCLUDED.status,
         due_date = EXCLUDED.due_date, completed_at = EXCLUDED.completed_at,
         pinned_at = EXCLUDED.pinned_at, updated_at = EXCLUDED.updated_at`,
      [
        this.tenantId, row.id, row.project_id, row.title, row.description, row.branch, row.brief,
        row.status, row.due_date, row.completed_at, row.pinned_at, row.created_at, row.updated_at,
      ]
    );
  }

  async deleteMilestone(id: string): Promise<void> {
    await this.tx((c) => c.query('DELETE FROM milestones WHERE id = $1', [id]));
  }

  async replaceAllMilestones(rows: MilestoneRow[]): Promise<void> {
    await this.tx(async (c) => {
      const incoming = new Set(rows.map((r) => r.id));
      const existing = (await c.query('SELECT id FROM milestones')).rows as Array<{ id: string }>;
      for (const { id } of existing) {
        if (!incoming.has(id)) {
          await c.query('DELETE FROM milestones WHERE id = $1', [id]);
        }
      }
      for (const row of rows) {
        await this.upsertMilestoneIn(c, row);
      }
    });
  }

  // ---- Pages ----

  listAllPages(): Promise<PageRow[]> {
    return this.rows<PageRow>('SELECT * FROM pages ORDER BY sort_order');
  }

  listPagesByProject(projectId: string): Promise<PageRow[]> {
    return this.rows<PageRow>('SELECT * FROM pages WHERE project_id = $1 ORDER BY sort_order', [projectId]);
  }

  getPage(id: string): Promise<PageRow | undefined> {
    return this.one<PageRow>('SELECT * FROM pages WHERE id = $1', [id]);
  }

  async upsertPage(row: PageRow): Promise<void> {
    await this.tx((c) => this.upsertPageIn(c, row));
  }

  private upsertPageIn(c: PoolClient, row: PageRow): Promise<unknown> {
    return c.query(
      `INSERT INTO pages (tenant_id, id, project_id, parent_id, title, icon, sort_order, is_root, kind, properties, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         project_id = EXCLUDED.project_id, parent_id = EXCLUDED.parent_id,
         title = EXCLUDED.title, icon = EXCLUDED.icon, sort_order = EXCLUDED.sort_order,
         is_root = EXCLUDED.is_root, kind = EXCLUDED.kind, properties = EXCLUDED.properties,
         updated_at = EXCLUDED.updated_at`,
      [
        this.tenantId, row.id, row.project_id, row.parent_id, row.title, row.icon,
        row.sort_order, row.is_root, row.kind, row.properties, row.created_at, row.updated_at,
      ]
    );
  }

  async deletePage(id: string): Promise<void> {
    await this.tx((c) => c.query('DELETE FROM pages WHERE id = $1', [id]));
  }

  async replaceAllPages(rows: PageRow[]): Promise<void> {
    await this.tx(async (c) => {
      const incoming = new Set(rows.map((r) => r.id));
      const existing = (await c.query('SELECT id FROM pages')).rows as Array<{ id: string }>;
      for (const { id } of existing) {
        if (!incoming.has(id)) {
          await c.query('DELETE FROM pages WHERE id = $1', [id]);
        }
      }
      for (const row of rows) {
        await this.upsertPageIn(c, row);
      }
    });
  }

  // ---- Page content ----

  async getPageContent(pageId: string): Promise<string | null> {
    const row = await this.one<{ body: string }>('SELECT body FROM page_content WHERE page_id = $1', [pageId]);
    return row?.body ?? null;
  }

  async setPageContent(pageId: string, body: string): Promise<void> {
    await this.tx((c) =>
      c.query(
        `INSERT INTO page_content (tenant_id, page_id, body) VALUES ($1, $2, $3)
         ON CONFLICT (page_id) DO UPDATE SET
           body = EXCLUDED.body,
           updated_at = to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS.MS')`,
        [this.tenantId, pageId, body]
      )
    );
  }

  // ---- Inbox items ----

  listAllInboxItems(): Promise<InboxRow[]> {
    return this.rows<InboxRow>('SELECT * FROM inbox_items ORDER BY created_at DESC');
  }

  getInboxItem(id: string): Promise<InboxRow | undefined> {
    return this.one<InboxRow>('SELECT * FROM inbox_items WHERE id = $1', [id]);
  }

  async upsertInboxItem(row: InboxRow): Promise<void> {
    await this.tx((c) => this.upsertInboxItemIn(c, row));
  }

  private upsertInboxItemIn(c: PoolClient, row: InboxRow): Promise<unknown> {
    return c.query(
      `INSERT INTO inbox_items (tenant_id, id, title, note, project_id, status, later_at, promoted_to, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title, note = EXCLUDED.note, project_id = EXCLUDED.project_id,
         status = EXCLUDED.status, later_at = EXCLUDED.later_at,
         promoted_to = EXCLUDED.promoted_to, updated_at = EXCLUDED.updated_at`,
      [
        this.tenantId, row.id, row.title, row.note, row.project_id, row.status,
        row.later_at, row.promoted_to, row.created_at, row.updated_at,
      ]
    );
  }

  async deleteInboxItem(id: string): Promise<void> {
    await this.tx((c) => c.query('DELETE FROM inbox_items WHERE id = $1', [id]));
  }

  async replaceAllInboxItems(rows: InboxRow[]): Promise<void> {
    await this.tx(async (c) => {
      const incoming = new Set(rows.map((r) => r.id));
      const existing = (await c.query('SELECT id FROM inbox_items')).rows as Array<{ id: string }>;
      for (const { id } of existing) {
        if (!incoming.has(id)) {
          await c.query('DELETE FROM inbox_items WHERE id = $1', [id]);
        }
      }
      for (const row of rows) {
        await this.upsertInboxItemIn(c, row);
      }
    });
  }

  // ---- Tasks ----

  listAllTasks(): Promise<TaskRow[]> {
    return this.rows<TaskRow>('SELECT * FROM tasks ORDER BY created_at');
  }

  listTasksByProject(projectId: string): Promise<TaskRow[]> {
    return this.rows<TaskRow>('SELECT * FROM tasks WHERE project_id = $1 ORDER BY created_at', [projectId]);
  }

  getTask(id: string): Promise<TaskRow | undefined> {
    return this.one<TaskRow>('SELECT * FROM tasks WHERE id = $1', [id]);
  }

  async upsertTask(row: TaskRow): Promise<void> {
    await this.tx((c) => this.upsertTaskIn(c, row));
  }

  private upsertTaskIn(c: PoolClient, row: TaskRow): Promise<unknown> {
    return c.query(
      `INSERT INTO tasks (tenant_id, id, project_id, task_description, status, created_at, branch, worktree_path, worktree_name, session_id, ticket_id, last_urls)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         project_id = EXCLUDED.project_id, task_description = EXCLUDED.task_description,
         status = EXCLUDED.status, branch = EXCLUDED.branch, worktree_path = EXCLUDED.worktree_path,
         worktree_name = EXCLUDED.worktree_name, session_id = EXCLUDED.session_id,
         ticket_id = EXCLUDED.ticket_id, last_urls = EXCLUDED.last_urls`,
      [
        this.tenantId, row.id, row.project_id, row.task_description, row.status, row.created_at,
        row.branch, row.worktree_path, row.worktree_name, row.session_id, row.ticket_id, row.last_urls,
      ]
    );
  }

  async deleteTask(id: string): Promise<void> {
    await this.tx((c) => c.query('DELETE FROM tasks WHERE id = $1', [id]));
  }

  async replaceAllTasks(rows: TaskRow[]): Promise<void> {
    await this.tx(async (c) => {
      const incoming = new Set(rows.map((r) => r.id));
      const existing = (await c.query('SELECT id FROM tasks')).rows as Array<{ id: string }>;
      for (const { id } of existing) {
        if (!incoming.has(id)) {
          await c.query('DELETE FROM tasks WHERE id = $1', [id]);
        }
      }
      for (const row of rows) {
        await this.upsertTaskIn(c, row);
      }
    });
  }
}
