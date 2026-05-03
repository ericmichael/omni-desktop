import type { DatabaseSync } from 'node:sqlite';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InboxRow,ProjectsRepo  } from 'omni-projects-db';
import { DEFAULT_COLUMNS, defaultColumnId, inboxId, pageId, projectId, ticketId, tx, writePageContent } from 'omni-projects-db';
import { z } from 'zod';

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
const err = (message: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true as const });

function serializeItem(item: InboxRow) {
  return {
    id: item.id,
    title: item.title,
    note: item.note ?? '',
    status: item.status,
    project_id: item.project_id,
    shaping: item.shaping ? JSON.parse(item.shaping) : null,
    later_at: item.later_at,
    promoted_to: item.promoted_to ? JSON.parse(item.promoted_to) : null,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function registerInboxTools(server: McpServer, db: DatabaseSync, repo: ProjectsRepo, pagesDir: string): void {
  server.tool(
    'list_inbox',
    'List inbox items, optionally filtered by status. Default: active items (new + shaped, excluding promoted).',
    {
      status: z.enum(['new', 'shaped', 'later']).optional().describe(
        'Filter by status. Omit to list default inbox (new + shaped, excluding promoted).'
      ),
    },
    async ({ status }) => {
      let sql: string;
      const params: unknown[] = [];

      if (status) {
        sql = 'SELECT * FROM inbox_items WHERE status = ? AND promoted_to IS NULL ORDER BY created_at DESC';
        params.push(status);
      } else {
        sql = "SELECT * FROM inbox_items WHERE status IN ('new','shaped') AND promoted_to IS NULL ORDER BY created_at DESC";
      }

      const items = db.prepare(sql).all(...params) as InboxRow[];
      return json({ items: items.map(serializeItem) });
    }
  );

  server.tool(
    'create_inbox_item',
    'Add a new item to the inbox. Use for capturing raw ideas, requests, or any unstructured input.',
    {
      title: z.string().describe('Short title for the inbox item.'),
      description: z.string().optional().describe('Optional longer description.'),
      project_id: z.string().optional().describe('Optional project ID to associate with.'),
    },
    async ({ title, description, project_id }) => {
      const id = inboxId();
      db.prepare(
        'INSERT INTO inbox_items (id, title, note, project_id) VALUES (?, ?, ?, ?)'
      ).run(id, title, description ?? null, project_id ?? null);
      repo.bumpChangeSeq();

      return json({ id, title });
    }
  );

  server.tool(
    'update_inbox_item',
    'Update an inbox item — edit title, description, assign to a project, shape it, or park it.',
    {
      item_id: z.string().describe('The inbox item ID to update'),
      title: z.string().optional().describe('Updated title'),
      description: z.string().optional().describe('Updated description'),
      status: z.enum(['new', 'shaped', 'later']).optional().describe('New status.'),
      project_id: z.string().optional().describe('Assign to a project'),
      outcome: z.string().optional().describe('What success looks like. Passing this shapes the item.'),
      appetite: z.enum(['small', 'medium', 'large', 'xl']).optional().describe('Rough effort sizing.'),
      not_doing: z.string().optional().describe('Explicitly out-of-scope work.'),
    },
    async ({ item_id, title, description, status, project_id, outcome, appetite, not_doing }) => {
      const item = repo.getInboxItem(item_id);
      if (!item) {
return err(`Inbox item not found: ${item_id}`);
}

      const sets: string[] = [];
      const params: unknown[] = [];

      if (title !== undefined) {
 sets.push('title = ?'); params.push(title); 
}
      if (description !== undefined) {
 sets.push('note = ?'); params.push(description); 
}
      if (project_id !== undefined) {
 sets.push('project_id = ?'); params.push(project_id || null); 
}

      // Shape the item if shaping fields provided
      if (outcome !== undefined || appetite !== undefined || not_doing !== undefined) {
        const existing = item.shaping ? JSON.parse(item.shaping) : {};
        const shaping = {
          outcome: outcome ?? existing.outcome ?? '',
          appetite: appetite ?? existing.appetite ?? 'medium',
          ...(not_doing !== undefined ? { notDoing: not_doing } : existing.notDoing ? { notDoing: existing.notDoing } : {}),
        };
        sets.push('shaping = ?');
        params.push(JSON.stringify(shaping));
        // Auto-transition to shaped if not already
        if (!status && item.status === 'new') {
          sets.push('status = ?');
          params.push('shaped');
        }
      }

      if (status !== undefined) {
        sets.push('status = ?');
        params.push(status);
        if (status === 'later') {
          sets.push("later_at = datetime('now')");
        }
      }

      if (sets.length === 0) {
return json({ ok: true });
}

      sets.push("updated_at = datetime('now')");
      params.push(item_id);
      db.prepare(`UPDATE inbox_items SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      repo.bumpChangeSeq();

      return json({ ok: true });
    }
  );

  server.tool(
    'delete_inbox_item',
    'Remove an inbox item.',
    { item_id: z.string().describe('The inbox item ID to delete') },
    async ({ item_id }) => {
      const result = db.prepare('DELETE FROM inbox_items WHERE id = ?').run(item_id);
      if (result.changes === 0) {
return err(`Inbox item not found: ${item_id}`);
}
      repo.bumpChangeSeq();
      return json({ ok: true });
    }
  );

  server.tool(
    'inbox_to_tickets',
    'Promote an inbox item into a ticket on a project.',
    {
      item_id: z.string().describe('The inbox item ID to promote'),
      project_id: z.string().describe('The project to create the ticket in'),
      milestone_id: z.string().optional().describe('Optional milestone to assign the new ticket to.'),
    },
    async ({ item_id, project_id, milestone_id }) => {
      const item = repo.getInboxItem(item_id);
      if (!item) {
return err(`Inbox item not found: ${item_id}`);
}

      const cols = repo.listColumns(project_id);
      const firstCol = cols[0];
      if (!firstCol) {
return err(`Project not found or has no pipeline: ${project_id}`);
}

      const tktId = ticketId();

      tx(db, () => {
        db.prepare(`
          INSERT INTO tickets (id, project_id, milestone_id, column_id, title, description, priority)
          VALUES (?, ?, ?, ?, ?, ?, 'medium')
        `).run(tktId, project_id, milestone_id ?? null, firstCol.id, item.title, item.note ?? '');

        const promotion = JSON.stringify({ kind: 'ticket', id: tktId, at: new Date().toISOString() });
        db.prepare(`
          UPDATE inbox_items SET promoted_to = ?, updated_at = datetime('now') WHERE id = ?
        `).run(promotion, item_id);

        repo.bumpChangeSeq();
      });

      return json({ ok: true, ticket_ids: [tktId] });
    }
  );

  server.tool(
    'inbox_to_project',
    'Promote an inbox item into a new project.',
    {
      item_id: z.string().describe('The inbox item ID to promote.'),
      label: z.string().optional().describe('Optional label for the new project.'),
    },
    async ({ item_id, label }) => {
      const item = repo.getInboxItem(item_id);
      if (!item) {
return err(`Inbox item not found: ${item_id}`);
}

      const projLabel = label || item.title;
      const slug = slugify(projLabel);

      const existing = repo.getProjectBySlug(slug);
      if (existing) {
return err(`A project with slug "${slug}" already exists.`);
}

      const projId = projectId();

      tx(db, () => {
        db.prepare(
          'INSERT INTO projects (id, label, slug) VALUES (?, ?, ?)'
        ).run(projId, projLabel, slug);

        for (let i = 0; i < DEFAULT_COLUMNS.length; i++) {
          const col = DEFAULT_COLUMNS[i]!;
          db.prepare(
            'INSERT INTO pipeline_columns (id, project_id, label, description, sort_order, gate) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(defaultColumnId(projId, col.logicalId), projId, col.label, null, i, col.gate ? 1 : 0);
        }

        const rootId = pageId();
        db.prepare(
          'INSERT INTO pages (id, project_id, parent_id, title, sort_order, is_root) VALUES (?, ?, NULL, ?, 0, 1)'
        ).run(rootId, projId, projLabel);
        writePageContent(pagesDir, slug, rootId, `# ${projLabel}\n`);

        const promotion = JSON.stringify({ kind: 'project', id: projId, at: new Date().toISOString() });
        db.prepare(`
          UPDATE inbox_items SET promoted_to = ?, updated_at = datetime('now') WHERE id = ?
        `).run(promotion, item_id);

        repo.bumpChangeSeq();
      });

      return json({ ok: true, project_id: projId, label: projLabel, slug });
    }
  );
}
