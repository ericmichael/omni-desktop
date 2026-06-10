import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { inboxId, type InboxRow, type IProjectsRepo, nowTimestamp, ticketId } from 'omni-projects-db';
import { z } from 'zod';

import { seedProject, slugify } from '../seed.js';

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
const err = (message: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true as const });

function serializeItem(item: InboxRow) {
  return {
    id: item.id,
    title: item.title,
    note: item.note ?? '',
    status: item.status,
    project_id: item.project_id,
    later_at: item.later_at,
    promoted_to: item.promoted_to ? JSON.parse(item.promoted_to) : null,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

export function registerInboxTools(server: McpServer, repo: IProjectsRepo): void {
  server.tool(
    'list_inbox',
    'List inbox items, optionally filtered by status. Default: active items (new, excluding promoted).',
    {
      status: z.enum(['new', 'later']).optional().describe(
        'Filter by status. Omit to list default inbox (new, excluding promoted).'
      ),
    },
    async ({ status }) => {
      const all = await repo.listAllInboxItems();
      const items = all.filter((it) => {
        if (it.promoted_to) return false;
        if (status) return it.status === status;
        return it.status === 'new';
      });
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
      const now = nowTimestamp();
      await repo.upsertInboxItem({
        id,
        title,
        note: description ?? null,
        project_id: project_id ?? null,
        status: 'new',
        later_at: null,
        promoted_to: null,
        created_at: now,
        updated_at: now,
      });

      return json({ id, title });
    }
  );

  server.tool(
    'update_inbox_item',
    'Update an inbox item — edit title, description, assign to a project, or park it. Put done-criteria and out-of-scope notes in the description; that text carries into the ticket on promotion.',
    {
      item_id: z.string().describe('The inbox item ID to update'),
      title: z.string().optional().describe('Updated title'),
      description: z.string().optional().describe('Updated description'),
      status: z.enum(['new', 'later']).optional().describe('New status.'),
      project_id: z.string().optional().describe('Assign to a project'),
    },
    async ({ item_id, title, description, status, project_id }) => {
      const item = await repo.getInboxItem(item_id);
      if (!item) return err(`Inbox item not found: ${item_id}`);

      const next = { ...item };
      if (title !== undefined) next.title = title;
      if (description !== undefined) next.note = description;
      if (project_id !== undefined) next.project_id = project_id || null;

      if (status !== undefined) {
        next.status = status;
        if (status === 'later') {
          next.later_at = nowTimestamp();
        }
      }

      next.updated_at = nowTimestamp();
      await repo.upsertInboxItem(next);

      return json({ ok: true });
    }
  );

  server.tool(
    'delete_inbox_item',
    'Remove an inbox item.',
    { item_id: z.string().describe('The inbox item ID to delete') },
    async ({ item_id }) => {
      const item = await repo.getInboxItem(item_id);
      if (!item) return err(`Inbox item not found: ${item_id}`);
      await repo.deleteInboxItem(item_id);
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
      const item = await repo.getInboxItem(item_id);
      if (!item) return err(`Inbox item not found: ${item_id}`);

      const cols = await repo.listColumns(project_id);
      const firstCol = cols[0];
      if (!firstCol) return err(`Project not found or has no pipeline: ${project_id}`);

      const tktId = ticketId();
      const now = nowTimestamp();
      // Create the durable artifact (ticket) first, then mark the item
      // promoted — IProjectsRepo has no cross-statement transaction.
      await repo.upsertTicket({
        id: tktId,
        project_id,
        milestone_id: milestone_id ?? null,
        column_id: firstCol.id,
        title: item.title,
        description: item.note ?? '',
        priority: 'medium',
        branch: null,
        blocked_by: '[]',
        resolution: null,
        resolved_at: null,
        archived_at: null,
        column_changed_at: null,
        use_worktree: 0,
        worktree_path: null,
        worktree_name: null,
        supervisor_session_id: null,
        phase: null,
        phase_changed_at: null,
        supervisor_task_id: null,
        token_usage: null,
        runs: '[]',
        pr_review: null,
        pr_merged_at: null,
        assignee: null,
        created_at: now,
        updated_at: now,
      });

      await repo.upsertInboxItem({
        ...item,
        promoted_to: JSON.stringify({ kind: 'ticket', id: tktId, at: new Date().toISOString() }),
        updated_at: nowTimestamp(),
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
      const item = await repo.getInboxItem(item_id);
      if (!item) return err(`Inbox item not found: ${item_id}`);

      const projLabel = label || item.title;
      const slug = slugify(projLabel);

      const existing = await repo.getProjectBySlug(slug);
      if (existing) return err(`A project with slug "${slug}" already exists.`);

      const seeded = await seedProject(repo, { label: projLabel });

      await repo.upsertInboxItem({
        ...item,
        promoted_to: JSON.stringify({ kind: 'project', id: seeded.id, at: new Date().toISOString() }),
        updated_at: nowTimestamp(),
      });

      return json({ ok: true, project_id: seeded.id, label: seeded.label, slug: seeded.slug });
    }
  );
}
