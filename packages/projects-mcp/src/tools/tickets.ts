import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DatabaseSync } from 'node:sqlite';
import type { ProjectsRepo } from 'omni-projects-db';
import { ticketId } from 'omni-projects-db';
import type { TicketRow, ColumnRow, CommentRow } from 'omni-projects-db';
import { z } from 'zod';

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
const err = (message: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true as const });

function ticketPayload(t: TicketRow, cols: ColumnRow[], comments: CommentRow[]) {
  const column = cols.find(c => c.id === t.column_id);
  return {
    id: t.id,
    project_id: t.project_id,
    milestone_id: t.milestone_id,
    title: t.title,
    description: t.description,
    priority: t.priority,
    column: column?.label ?? t.column_id,
    pipeline: cols.map(c => c.label),
    blocked_by: JSON.parse(t.blocked_by),
    branch: t.branch,
    shaping: t.shaping ? JSON.parse(t.shaping) : null,
    resolution: t.resolution,
    archived_at: t.archived_at,
    created_at: t.created_at,
    updated_at: t.updated_at,
    comments: comments.map(c => ({
      id: c.id,
      author: c.author,
      content: c.content,
      created_at: c.created_at,
    })),
  };
}

export function registerTicketTools(server: McpServer, db: DatabaseSync, repo: ProjectsRepo): void {
  server.tool(
    'get_ticket',
    "Get a ticket's state including title, description, priority, current column, and pipeline columns.",
    { ticket_id: z.string().describe('The ticket ID to look up.') },
    async ({ ticket_id }) => {
      const ticket = repo.getTicket(ticket_id);
      if (!ticket) return err(`Ticket not found: ${ticket_id}`);

      const cols = repo.listColumns(ticket.project_id);
      const comments = repo.listCommentsByTicket(ticket_id);

      return json(ticketPayload(ticket, cols, comments));
    }
  );

  server.tool(
    'create_ticket',
    'Create a new ticket in a project. It will be placed in the first pipeline column.',
    {
      project_id: z.string().describe('The project to create the ticket in'),
      title: z.string().describe('Ticket title'),
      description: z.string().optional().describe('Ticket description'),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('Ticket priority (default: medium)'),
      milestone_id: z.string().optional().describe('Optional milestone ID to group this ticket under.'),
    },
    async ({ project_id, title, description, priority, milestone_id }) => {
      const cols = repo.listColumns(project_id);
      const firstCol = cols[0];
      if (!firstCol) return err(`Project not found or has no pipeline: ${project_id}`);

      const id = ticketId();
      db.prepare(`
        INSERT INTO tickets (id, project_id, milestone_id, column_id, title, description, priority)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, project_id, milestone_id ?? null, firstCol.id, title, description ?? '', priority ?? 'medium');
      repo.bumpChangeSeq();

      return json({ id, title, column: firstCol.label });
    }
  );

  server.tool(
    'update_ticket',
    "Update a ticket's title, description, priority, branch, or dependencies.",
    {
      ticket_id: z.string().describe('The ticket ID to update'),
      title: z.string().optional().describe('New title'),
      description: z.string().optional().describe('New description'),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('New priority'),
      branch: z.string().optional().describe('Git branch for this ticket.'),
      add_blocked_by: z.array(z.string()).optional().describe('Ticket IDs to add as blockers.'),
      remove_blocked_by: z.array(z.string()).optional().describe('Ticket IDs to remove as blockers.'),
    },
    async ({ ticket_id, title, description, priority, branch, add_blocked_by, remove_blocked_by }) => {
      const ticket = repo.getTicket(ticket_id);
      if (!ticket) return err(`Ticket not found: ${ticket_id}`);

      const sets: string[] = [];
      const params: unknown[] = [];

      if (title !== undefined) { sets.push('title = ?'); params.push(title); }
      if (description !== undefined) { sets.push('description = ?'); params.push(description); }
      if (priority !== undefined) { sets.push('priority = ?'); params.push(priority); }
      if (branch !== undefined) { sets.push('branch = ?'); params.push(branch || null); }

      if (add_blocked_by || remove_blocked_by) {
        const current = new Set<string>(JSON.parse(ticket.blocked_by));
        for (const id of add_blocked_by ?? []) current.add(id);
        for (const id of remove_blocked_by ?? []) current.delete(id);
        sets.push('blocked_by = ?');
        params.push(JSON.stringify([...current]));
      }

      if (sets.length === 0) return json({ ok: true });

      sets.push("updated_at = datetime('now')");
      params.push(ticket_id);
      db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      repo.bumpChangeSeq();

      return json({ ok: true });
    }
  );

  server.tool(
    'move_ticket',
    'Move a ticket to a different pipeline column. Use exact column labels from the pipeline.',
    {
      ticket_id: z.string().describe('The ticket ID to move'),
      column: z.string().describe('The target column label (e.g. "In Progress", "Done")'),
    },
    async ({ ticket_id, column }) => {
      const ticket = repo.getTicket(ticket_id);
      if (!ticket) return err(`Ticket not found: ${ticket_id}`);

      const cols = repo.listColumns(ticket.project_id);

      const target = cols.find(c => c.label.toLowerCase() === column.toLowerCase());
      if (!target) {
        const valid = cols.map(c => c.label).join(', ');
        return err(`Unknown column: "${column}". Valid columns: ${valid}`);
      }

      db.prepare(`
        UPDATE tickets SET column_id = ?, column_changed_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `).run(target.id, ticket_id);
      repo.bumpChangeSeq();

      return json({ ok: true, column: target.label });
    }
  );

  server.tool(
    'archive_ticket',
    'Archive a resolved ticket so it drops out of active project views.',
    { ticket_id: z.string().describe('The ticket ID to archive') },
    async ({ ticket_id }) => {
      const ticket = repo.getTicket(ticket_id);
      if (!ticket) return err(`Ticket not found: ${ticket_id}`);

      db.prepare(`
        UPDATE tickets SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
      `).run(ticket_id);
      repo.bumpChangeSeq();

      return json({ ok: true });
    }
  );

  server.tool(
    'unarchive_ticket',
    'Restore an archived ticket back into active project views.',
    { ticket_id: z.string().describe('The ticket ID to unarchive') },
    async ({ ticket_id }) => {
      const ticket = repo.getTicket(ticket_id);
      if (!ticket) return err(`Ticket not found: ${ticket_id}`);

      db.prepare(`
        UPDATE tickets SET archived_at = NULL, updated_at = datetime('now') WHERE id = ?
      `).run(ticket_id);
      repo.bumpChangeSeq();

      return json({ ok: true });
    }
  );

  server.tool(
    'list_tickets',
    'List tickets in a project, optionally filtered by column or priority.',
    {
      project_id: z.string().describe('The project ID to list tickets for'),
      milestone_id: z.string().optional().describe('Optional milestone ID to filter by'),
      column: z.string().optional().describe('Optional column label to filter by'),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('Optional priority to filter by'),
    },
    async ({ project_id, milestone_id, column, priority }) => {
      const cols = repo.listColumns(project_id);

      if (cols.length === 0) {
        const exists = repo.getProject(project_id);
        if (!exists) return err(`Project not found: ${project_id}`);
      }

      let sql = 'SELECT * FROM tickets WHERE project_id = ? AND archived_at IS NULL';
      const params: unknown[] = [project_id];

      if (milestone_id) { sql += ' AND milestone_id = ?'; params.push(milestone_id); }
      if (priority) { sql += ' AND priority = ?'; params.push(priority); }
      if (column) {
        const col = cols.find(c => c.label.toLowerCase() === column.toLowerCase());
        if (col) { sql += ' AND column_id = ?'; params.push(col.id); }
      }

      sql += ' ORDER BY created_at';
      const tickets = db.prepare(sql).all(...params) as TicketRow[];

      return json({
        tickets: tickets.map(t => {
          const col = cols.find(c => c.id === t.column_id);
          return {
            id: t.id,
            title: t.title,
            description: t.description,
            priority: t.priority,
            column: col?.label ?? t.column_id,
            milestone_id: t.milestone_id,
            blocked_by: JSON.parse(t.blocked_by),
            created_at: t.created_at,
            updated_at: t.updated_at,
          };
        }),
      });
    }
  );

  server.tool(
    'search_tickets',
    'Search across all tickets by keyword. Matches against title and description.',
    {
      query: z.string().describe('Search query — matched case-insensitively against ticket title and description.'),
      project_id: z.string().optional().describe('Optional project ID to limit search scope.'),
    },
    async ({ query, project_id }) => {
      const pattern = `%${query}%`;
      let sql = 'SELECT t.*, pc.label as column_label FROM tickets t JOIN pipeline_columns pc ON pc.id = t.column_id WHERE (t.title LIKE ? OR t.description LIKE ?)';
      const params: unknown[] = [pattern, pattern];

      if (project_id) { sql += ' AND t.project_id = ?'; params.push(project_id); }
      sql += ' ORDER BY t.updated_at DESC LIMIT 50';

      const tickets = db.prepare(sql).all(...params) as (TicketRow & { column_label: string })[];

      return json({
        tickets: tickets.map(t => ({
          id: t.id,
          project_id: t.project_id,
          title: t.title,
          description: t.description,
          priority: t.priority,
          column: t.column_label,
          created_at: t.created_at,
          updated_at: t.updated_at,
        })),
      });
    }
  );
}
