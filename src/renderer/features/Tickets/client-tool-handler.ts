/**
 * Renderer-side handler for project management client tools.
 *
 * Handles TICKET tools (get_ticket, move_ticket, escalate, notify, add_ticket_comment),
 * read-only context tools (list_tickets, search_tickets, list_milestones, read_brief,
 * read_milestone_brief, get_ticket_comments, get_ticket_history, get_pipeline),
 * and write tools (create/update/start/stop tickets, briefs, milestones, inbox).
 *
 * Used by Chat tab and Code tab so any interactive agent session can manage projects.
 */

import { nanoid } from 'nanoid';

import { listLiveApps, resolveAppHandle } from '@/renderer/features/AppControl/live-registry';
import { inboxApi } from '@/renderer/features/Inbox/state';
import { $milestones, milestoneApi } from '@/renderer/features/Initiatives/state';
import { pageApi } from '@/renderer/features/Pages/state';
import { requestPlanApproval } from '@/renderer/features/Tickets/plan-approval-bridge';
import { requestPreviewOpen } from '@/renderer/features/Tickets/preview-bridge';
import { $tickets, ticketApi } from '@/renderer/features/Tickets/state';
import type { ClientToolCallHandler } from '@/renderer/omniagents-ui/App';
import { emitter } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type { AppClickButton, AppConsoleLevel } from '@/shared/app-control-types';
import type {
  InboxItem,
  InboxItemId,
  InboxItemStatus,
  InboxShaping,
  MilestoneId,
  PageId,
  Pipeline,
  ProjectId,
  ProjectSource,
  TicketId,
} from '@/shared/types';

function parseInboxStatus(input: unknown): InboxItemStatus | undefined {
  if (input === 'new' || input === 'shaped' || input === 'later') {
return input;
}
  return undefined;
}

function parseAppetite(input: unknown): InboxShaping['appetite'] | undefined {
  if (input === 'small' || input === 'medium' || input === 'large' || input === 'xl') {
return input;
}
  return undefined;
}

/** Shape an InboxItem into the JSON contract the agent tools return. */
function serializeInboxItem(item: InboxItem) {
  return {
    id: item.id,
    title: item.title,
    note: item.note ?? '',
    status: item.status,
    project_id: item.projectId ?? null,
    shaping: item.shaping ?? null,
    later_at: item.laterAt ? new Date(item.laterAt).toISOString() : null,
    promoted_to: item.promotedTo ?? null,
    created_at: new Date(item.createdAt).toISOString(),
    updated_at: new Date(item.updatedAt).toISOString(),
  };
}

type ClientToolResult = Awaited<ReturnType<ClientToolCallHandler>>;

const ok = (result: Record<string, unknown>): ClientToolResult => ({ ok: true, result });
const err = (message: string): ClientToolResult => ({ ok: true, result: { error: message } });

async function handleTicketTools(
  toolName: string,
  toolArgs: Record<string, unknown>,
  currentTicketId?: TicketId,
  currentProjectId?: ProjectId
): Promise<ClientToolResult | null> {
  switch (toolName) {
    case 'get_ticket': {
      const lookupId = (toolArgs.ticket_id as string as TicketId) || currentTicketId;
      if (!lookupId) {
return err('No ticket_id provided and no current ticket context');
}
      const ticket = $tickets.get()[lookupId];
      if (!ticket) {
return err(`Ticket not found: ${lookupId}`);
}
      const pipeline = await ticketApi.getPipeline(ticket.projectId as ProjectId);
      const column = pipeline.columns.find((c) => c.id === ticket.columnId);
      const comments = (ticket.comments ?? []).map((c) => ({
        id: c.id,
        author: c.author,
        content: c.content,
        created_at: new Date(c.createdAt).toISOString(),
      }));
      const runs = (ticket.runs ?? []).map((r) => ({
        id: r.id,
        started_at: new Date(r.startedAt).toISOString(),
        ended_at: new Date(r.endedAt).toISOString(),
        end_reason: r.endReason,
        token_usage: r.tokenUsage ?? null,
      }));
      return ok({
        id: ticket.id,
        title: ticket.title,
        description: ticket.description || '',
        priority: ticket.priority,
        column: column?.label ?? ticket.columnId,
        pipeline: pipeline.columns.map((c) => c.label),
        blocked_by: ticket.blockedBy ?? [],
        branch: ticket.branch || null,
        use_worktree: ticket.useWorktree ?? false,
        worktree_path: ticket.worktreePath || null,
        phase: ticket.phase ?? null,
        run_count: runs.length,
        created_at: new Date(ticket.createdAt).toISOString(),
        updated_at: new Date(ticket.updatedAt).toISOString(),
        comments,
        runs,
      });
    }
    case 'move_ticket': {
      if (!currentTicketId || !currentProjectId) {
return err('No current ticket context for move_ticket');
}
      const columnLabel = (toolArgs.column as string) ?? '';
      const pipeline = await ticketApi.getPipeline(currentProjectId);
      const col = pipeline.columns.find((c) => c.label.toLowerCase() === columnLabel.toLowerCase());
      if (!col) {
        const valid = pipeline.columns.map((c) => c.label).join(', ');
        return err(`Unknown column: "${columnLabel}". Valid columns: ${valid}`);
      }
      await ticketApi.moveTicketToColumn(currentTicketId, col.id);
      return ok({ ok: true, column: col.label });
    }
    case 'escalate': {
      const message = (toolArgs.message as string) ?? '';
      if (!message) {
return err('Empty escalation message');
}
      return ok({ ok: true, message: 'Escalated to human operator' });
    }
    case 'notify': {
      const message = (toolArgs.message as string) ?? '';
      if (!message) {
return err('Empty notification message');
}
      return ok({ ok: true, message: 'Notification sent' });
    }
    case 'add_ticket_comment': {
      const commentTicketId = (toolArgs.ticket_id as string as TicketId) || currentTicketId;
      if (!commentTicketId) {
return err('No ticket_id provided and no current ticket context');
}
      const content = (toolArgs.content as string) ?? '';
      if (!content) {
return err('Missing content');
}
      const ticket = $tickets.get()[commentTicketId];
      if (!ticket) {
return err(`Ticket not found: ${commentTicketId}`);
}
      const comment = { id: nanoid(), author: 'agent' as const, content, createdAt: Date.now() };
      const existingComments = ticket.comments ?? [];
      await ticketApi.updateTicket(commentTicketId, { comments: [...existingComments, comment] });
      return ok({ ok: true, comment_id: comment.id });
    }
    default:
      return null;
  }
}

/** Read-only context tools — available to all sessions including autopilot. */
async function handleReadonlyContextTools(
  toolName: string,
  toolArgs: Record<string, unknown>
): Promise<ClientToolResult | null> {
  const store = persistedStoreApi.$atom.get();

  switch (toolName) {
    case 'list_tickets': {
      const projectId = (toolArgs.project_id as string) ?? '';
      if (!projectId) {
return err('Missing project_id');
}
      const project = store.projects.find((p) => p.id === projectId);
      if (!project) {
return err(`Project not found: ${projectId}`);
}
      let pipeline: Pipeline;
      try {
        pipeline = await ticketApi.getPipeline(projectId);
      } catch {
        return err(`Failed to load pipeline for project: ${projectId}`);
      }
      let tickets = store.tickets.filter((t) => t.projectId === projectId);
      const milestoneFilter = toolArgs.milestone_id as string | undefined;
      if (milestoneFilter) {
tickets = tickets.filter((t) => t.milestoneId === milestoneFilter);
}
      const columnFilter = toolArgs.column as string | undefined;
      if (columnFilter) {
        const col = pipeline.columns.find((c) => c.label.toLowerCase() === columnFilter.toLowerCase());
        if (col) {
tickets = tickets.filter((t) => t.columnId === col.id);
}
      }
      const priorityFilter = toolArgs.priority as string | undefined;
      if (priorityFilter) {
tickets = tickets.filter((t) => t.priority === priorityFilter);
}
      const result = tickets.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description || '',
        priority: t.priority,
        column: pipeline.columns.find((c) => c.id === t.columnId)?.label ?? t.columnId,
        phase: t.phase,
        blocked_by: t.blockedBy ?? [],
        created_at: new Date(t.createdAt).toISOString(),
        updated_at: new Date(t.updatedAt).toISOString(),
      }));
      return ok({ tickets: result });
    }
    case 'search_tickets': {
      const query = (toolArgs.query as string) ?? '';
      if (!query) {
return err('Missing query');
}
      const q = query.toLowerCase();
      const projectFilter = toolArgs.project_id as string | undefined;
      let tickets = store.tickets;
      if (projectFilter) {
tickets = tickets.filter((t) => t.projectId === projectFilter);
}
      const matches = tickets.filter(
        (t) => t.title.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q)
      );
      // Resolve column labels per project
      const pipelineCache: Record<string, Pipeline> = {};
      const result = await Promise.all(
        matches.map(async (t) => {
          if (!pipelineCache[t.projectId]) {
            try {
              pipelineCache[t.projectId] = await ticketApi.getPipeline(t.projectId);
            } catch {
              pipelineCache[t.projectId] = { columns: [] };
            }
          }
          const pl = pipelineCache[t.projectId]!;
          return {
            id: t.id,
            project_id: t.projectId,
            title: t.title,
            description: t.description || '',
            priority: t.priority,
            column: pl.columns.find((c) => c.id === t.columnId)?.label ?? t.columnId,
            phase: t.phase,
            created_at: new Date(t.createdAt).toISOString(),
            updated_at: new Date(t.updatedAt).toISOString(),
          };
        })
      );
      return ok({ tickets: result });
    }
    case 'list_milestones': {
      const projectId = (toolArgs.project_id as string) ?? '';
      if (!projectId) {
return err('Missing project_id');
}
      await milestoneApi.fetchMilestones(projectId);
      const items = Object.values($milestones.get()).filter((i) => i.projectId === projectId);
      return ok({
        milestones: items.map((i) => ({
          id: i.id,
          title: i.title,
          description: i.description || '',
          branch: i.branch || null,
          status: i.status,
          created_at: new Date(i.createdAt).toISOString(),
          updated_at: new Date(i.updatedAt).toISOString(),
        })),
      });
    }
    case 'read_milestone_brief': {
      const id = (toolArgs.milestone_id as string) ?? '';
      if (!id) {
return err('Missing milestone_id');
}
      const existing = $milestones.get()[id];
      if (!existing) {
return err(`Milestone not found: ${id}`);
}
      return ok({ brief: existing.brief ?? '' });
    }
    case 'get_ticket_comments': {
      const tid = (toolArgs.ticket_id as string) ?? '';
      if (!tid) {
return err('Missing ticket_id');
}
      const ticket = $tickets.get()[tid as TicketId];
      if (!ticket) {
return err(`Ticket not found: ${tid}`);
}
      return ok({
        comments: (ticket.comments ?? []).map((c) => ({
          id: c.id,
          author: c.author,
          content: c.content,
          created_at: new Date(c.createdAt).toISOString(),
        })),
      });
    }
    case 'get_ticket_history': {
      const tid = (toolArgs.ticket_id as string) ?? '';
      if (!tid) {
return err('Missing ticket_id');
}
      const ticket = $tickets.get()[tid as TicketId];
      if (!ticket) {
return err(`Ticket not found: ${tid}`);
}
      const runs = (ticket.runs ?? []).map((r) => ({
        id: r.id,
        started_at: new Date(r.startedAt).toISOString(),
        ended_at: new Date(r.endedAt).toISOString(),
        end_reason: r.endReason,
        token_usage: r.tokenUsage ?? null,
      }));
      return ok({
        ticket_id: ticket.id,
        phase: ticket.phase ?? null,
        run_count: runs.length,
        total_token_usage: ticket.tokenUsage ?? null,
        runs,
      });
    }
    case 'get_pipeline': {
      const projectId = (toolArgs.project_id as string) ?? '';
      if (!projectId) {
return err('Missing project_id');
}
      let pipeline: Pipeline;
      try {
        pipeline = await ticketApi.getPipeline(projectId);
      } catch {
        return err(`Failed to load pipeline for project: ${projectId}`);
      }
      return ok({
        columns: pipeline.columns.map((c) => ({
          id: c.id,
          label: c.label,
          description: c.description || null,
          gate: c.gate ?? false,
        })),
      });
    }
    case 'list_pages': {
      const projectId = (toolArgs.project_id as string) ?? '';
      if (!projectId) {
return err('Missing project_id');
}
      const store = persistedStoreApi.$atom.get();
      if (!store.projects.find((p) => p.id === projectId)) {
return err(`Project not found: ${projectId}`);
}
      await pageApi.fetchPages(projectId);
      const pages = store.pages.filter((p) => p.projectId === projectId);
      return ok({
        pages: pages.map((p) => ({
          id: p.id,
          title: p.title,
          icon: p.icon ?? null,
          parent_id: p.parentId,
          sort_order: p.sortOrder,
          is_root: p.isRoot ?? false,
          created_at: new Date(p.createdAt).toISOString(),
          updated_at: new Date(p.updatedAt).toISOString(),
        })),
      });
    }
    case 'read_page': {
      const pageId = (toolArgs.page_id as string) ?? '';
      if (!pageId) {
return err('Missing page_id');
}
      const store = persistedStoreApi.$atom.get();
      const page = store.pages.find((p) => p.id === pageId);
      if (!page) {
return err(`Page not found: ${pageId}`);
}
      const content = await pageApi.readContent(pageId as PageId);
      return ok({
        id: page.id,
        title: page.title,
        icon: page.icon ?? null,
        parent_id: page.parentId,
        is_root: page.isRoot ?? false,
        content,
      });
    }
    default:
      return null;
  }
}

/** Write-oriented project tools — only available in interactive sessions. */
async function handleProjectTools(
  toolName: string,
  toolArgs: Record<string, unknown>
): Promise<ClientToolResult | null> {
  const store = persistedStoreApi.$atom.get();

  switch (toolName) {
    case 'list_projects': {
      const projects = store.projects.map((p) => ({
        id: p.id,
        label: p.label,
        workspaceDir: p.source?.kind === 'local' ? p.source.workspaceDir : p.source?.kind === 'git-remote' ? p.source.repoUrl : '',
        columns: (p.pipeline?.columns ?? []).map((c) => c.label),
      }));
      return ok({ projects });
    }
    case 'create_project': {
      const label = (toolArgs.label as string) ?? '';
      if (!label) {
return err('Missing label');
}
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const workspaceDir = toolArgs.workspace_dir as string | undefined;
      const source: ProjectSource | undefined = workspaceDir
        ? { kind: 'local', workspaceDir }
        : undefined;
      const created = await ticketApi.addProject({ label, slug, source });
      const pipeline = await ticketApi.getPipeline(created.id);
      const rootPage = persistedStoreApi.$atom.get().pages.find(
        (p) => p.projectId === created.id && p.isRoot
      );
      return ok({
        id: created.id,
        label: created.label,
        slug: created.slug,
        workspace_dir: source?.kind === 'local' ? source.workspaceDir : null,
        pipeline: pipeline.columns.map((c) => c.label),
        root_page_id: rootPage?.id ?? null,
      });
    }
    case 'update_project': {
      const projectId = (toolArgs.project_id as string) ?? '';
      if (!projectId) {
return err('Missing project_id');
}
      const project = store.projects.find((p) => p.id === projectId);
      if (!project) {
return err(`Project not found: ${projectId}`);
}
      const patch: Record<string, unknown> = {};
      if (toolArgs.label !== undefined) {
        patch.label = toolArgs.label;
        patch.slug = (toolArgs.label as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      }
      if (toolArgs.workspace_dir !== undefined) {
        const dir = toolArgs.workspace_dir as string;
        patch.source = dir ? { kind: 'local', workspaceDir: dir } : undefined;
      }
      await ticketApi.updateProject(projectId as ProjectId, patch);
      return ok({ ok: true });
    }
    case 'delete_project': {
      const projectId = (toolArgs.project_id as string) ?? '';
      if (!projectId) {
return err('Missing project_id');
}
      const project = store.projects.find((p) => p.id === projectId);
      if (!project) {
return err(`Project not found: ${projectId}`);
}
      if (project.isPersonal) {
return err('Cannot delete the Personal project');
}
      await ticketApi.removeProject(projectId as ProjectId);
      return ok({ ok: true });
    }
    case 'create_ticket': {
      const projectId = (toolArgs.project_id as string) ?? '';
      const title = (toolArgs.title as string) ?? '';
      if (!projectId || !title) {
return err('Missing project_id or title');
}
      const project = store.projects.find((p) => p.id === projectId);
      if (!project) {
return err(`Project not found: ${projectId}`);
}
      const created = await ticketApi.addTicket({
        projectId,
        milestoneId: (toolArgs.milestone_id as string) || undefined,
        title,
        description: (toolArgs.description as string) ?? '',
        priority: ((toolArgs.priority as string) ?? 'medium') as 'low' | 'medium' | 'high' | 'critical',
        blockedBy: [],
      });
      const pipeline = await ticketApi.getPipeline(projectId);
      return ok({ id: created.id, title: created.title, column: pipeline.columns[0]?.label });
    }
    case 'update_ticket': {
      const targetId = (toolArgs.ticket_id as string) ?? '';
      if (!targetId) {
return err('Missing ticket_id');
}
      const target = store.tickets.find((t) => t.id === targetId);
      if (!target) {
return err(`Ticket not found: ${targetId}`);
}
      const patch: Record<string, unknown> = {};
      if (toolArgs.title) {
patch.title = toolArgs.title;
}
      if (toolArgs.description !== undefined) {
patch.description = toolArgs.description;
}
      if (toolArgs.priority) {
patch.priority = toolArgs.priority;
}
      if (toolArgs.branch !== undefined) {
patch.branch = toolArgs.branch;
}
      // Dependency management
      if (toolArgs.add_blocked_by || toolArgs.remove_blocked_by) {
        const current = new Set(target.blockedBy ?? []);
        for (const id of (toolArgs.add_blocked_by as string[]) ?? []) {
current.add(id);
}
        for (const id of (toolArgs.remove_blocked_by as string[]) ?? []) {
current.delete(id);
}
        patch.blockedBy = [...current];
      }
      await ticketApi.updateTicket(targetId as TicketId, patch);
      return ok({ ok: true });
    }
    case 'start_ticket': {
      const targetId = (toolArgs.ticket_id as string) ?? '';
      if (!targetId) {
return err('Missing ticket_id');
}
      try {
        await ticketApi.startSupervisor(targetId as TicketId);
        return ok({ ok: true });
      } catch (e) {
        return err(String(e));
      }
    }
    case 'stop_ticket': {
      const targetId = (toolArgs.ticket_id as string) ?? '';
      if (!targetId) {
return err('Missing ticket_id');
}
      try {
        await ticketApi.stopSupervisor(targetId as TicketId);
        return ok({ ok: true });
      } catch (e) {
        return err(String(e));
      }
    }
    case 'archive_ticket': {
      const targetId = (toolArgs.ticket_id as string) ?? '';
      if (!targetId) {
return err('Missing ticket_id');
}
      const target = store.tickets.find((t) => t.id === targetId);
      if (!target) {
return err(`Ticket not found: ${targetId}`);
}
      if (!target.resolution) {
return err('Only resolved tickets can be archived');
}
      await ticketApi.updateTicket(targetId as TicketId, { archivedAt: Date.now() });
      return ok({ ok: true });
    }
    case 'unarchive_ticket': {
      const targetId = (toolArgs.ticket_id as string) ?? '';
      if (!targetId) {
return err('Missing ticket_id');
}
      const target = store.tickets.find((t) => t.id === targetId);
      if (!target) {
return err(`Ticket not found: ${targetId}`);
}
      await ticketApi.updateTicket(targetId as TicketId, { archivedAt: undefined });
      return ok({ ok: true });
    }
    default:
      return null;
  }
}

async function handlePageTools(
  toolName: string,
  toolArgs: Record<string, unknown>
): Promise<ClientToolResult | null> {
  switch (toolName) {
    case 'create_page': {
      const projectId = (toolArgs.project_id as string) ?? '';
      const title = (toolArgs.title as string) ?? '';
      if (!projectId || !title) {
return err('Missing project_id or title');
}
      const store = persistedStoreApi.$atom.get();
      if (!store.projects.find((p) => p.id === projectId)) {
return err(`Project not found: ${projectId}`);
}
      const parentId = (toolArgs.parent_id as string as PageId) || null;
      const icon = toolArgs.icon as string | undefined;
      const created = await pageApi.addPage({
        projectId,
        parentId,
        title,
        sortOrder: Date.now(),
        ...(icon ? { icon } : {}),
      });
      const content = (toolArgs.content as string) || '';
      if (content.trim()) {
        await pageApi.writeContent(created.id, content);
      }
      return ok({ id: created.id, title: created.title, parent_id: parentId });
    }
    case 'update_page': {
      const pageId = (toolArgs.page_id as string) ?? '';
      if (!pageId) {
return err('Missing page_id');
}
      const store = persistedStoreApi.$atom.get();
      const page = store.pages.find((p) => p.id === pageId);
      if (!page) {
return err(`Page not found: ${pageId}`);
}
      // Metadata patch
      const metaPatch: Record<string, unknown> = {};
      if (toolArgs.title !== undefined) {
metaPatch.title = toolArgs.title;
}
      if (toolArgs.icon !== undefined) {
metaPatch.icon = toolArgs.icon;
}
      if (Object.keys(metaPatch).length > 0) {
        await pageApi.updatePage(pageId as PageId, metaPatch);
      }
      // Content
      if (toolArgs.content !== undefined) {
        await pageApi.writeContent(pageId as PageId, toolArgs.content as string);
      }
      // Pages no longer carry structured status/size/outcome fields — those
      // live on InboxItem now. This handler only edits the page itself.
      return ok({ ok: true });
    }
    default:
      return null;
  }
}

async function handleInboxTools(
  toolName: string,
  toolArgs: Record<string, unknown>
): Promise<ClientToolResult | null> {
  switch (toolName) {
    case 'list_inbox': {
      // Returns active inbox items by default. Passing `status` filters to a
      // specific lifecycle bucket; `include_promoted` adds tombstones.
      const store = persistedStoreApi.$atom.get();
      const statusFilter = parseInboxStatus(toolArgs.status);
      const includePromoted = toolArgs.include_promoted === true;
      let filtered = store.inboxItems.filter((i) => includePromoted || !i.promotedTo);
      if (statusFilter) {
        filtered = filtered.filter((i) => i.status === statusFilter);
      } else {
        filtered = filtered.filter((i) => i.status !== 'later');
      }
      return ok({ items: filtered.map(serializeInboxItem) });
    }
    case 'create_inbox_item': {
      const title = (toolArgs.title as string) ?? '';
      if (!title) {
return err('Missing title');
}
      const created = await inboxApi.add({
        title,
        note: (toolArgs.description as string) || undefined,
        projectId: (toolArgs.project_id as string) || null,
      });
      return ok({ id: created.id, title: created.title });
    }
    case 'update_inbox_item': {
      const itemId = (toolArgs.item_id as string) ?? '';
      if (!itemId) {
return err('Missing item_id');
}

      const patch: Parameters<typeof inboxApi.update>[1] = {};
      if (toolArgs.title !== undefined) {
patch.title = toolArgs.title as string;
}
      if (toolArgs.description !== undefined) {
patch.note = toolArgs.description as string;
}
      if (toolArgs.project_id !== undefined) {
patch.projectId = (toolArgs.project_id as string) || null;
}
      if (Object.keys(patch).length > 0) {
        await inboxApi.update(itemId as InboxItemId, patch);
      }

      // Shape block — if any shaping field is supplied, merge into a complete shaping call.
      if (
        toolArgs.outcome !== undefined ||
        toolArgs.appetite !== undefined ||
        toolArgs.not_doing !== undefined
      ) {
        const appetite = parseAppetite(toolArgs.appetite) ?? 'medium';
        const shaping: InboxShaping = {
          outcome: (toolArgs.outcome as string) ?? '',
          appetite,
        };
        if (typeof toolArgs.not_doing === 'string' && toolArgs.not_doing.trim()) {
          shaping.notDoing = toolArgs.not_doing as string;
        }
        await inboxApi.shape(itemId as InboxItemId, shaping);
      }

      // Explicit status transition.
      if (toolArgs.status === 'later') {
await inboxApi.defer(itemId as InboxItemId);
}
      if (toolArgs.status === 'new' || toolArgs.status === 'shaped') {
        await inboxApi.reactivate(itemId as InboxItemId);
      }
      return ok({ ok: true });
    }
    case 'delete_inbox_item': {
      const itemId = (toolArgs.item_id as string) ?? '';
      if (!itemId) {
return err('Missing item_id');
}
      await inboxApi.remove(itemId as InboxItemId);
      return ok({ ok: true });
    }
    case 'inbox_to_tickets': {
      const itemId = (toolArgs.item_id as string) ?? '';
      const projectId = (toolArgs.project_id as string) ?? '';
      if (!itemId || !projectId) {
return err('Missing item_id or project_id');
}
      const milestoneId = (toolArgs.milestone_id as string) || undefined;
      const ticket = await inboxApi.promoteToTicket(itemId as InboxItemId, {
        projectId: projectId as ProjectId,
        ...(milestoneId ? { milestoneId: milestoneId as MilestoneId } : {}),
      });
      return ok({ ok: true, ticket_ids: [ticket.id] });
    }
    case 'inbox_to_project': {
      const itemId = (toolArgs.item_id as string) ?? '';
      if (!itemId) {
return err('Missing item_id');
}
      const label = (toolArgs.label as string) ?? '';
      const project = await inboxApi.promoteToProject(itemId as InboxItemId, { label });
      return ok({ ok: true, project_id: project.id, label: project.label, slug: project.slug });
    }
    default:
      return null;
  }
}

async function handleMilestoneTools(
  toolName: string,
  toolArgs: Record<string, unknown>
): Promise<ClientToolResult | null> {
  const parseDueDate = (value: unknown): { kind: 'unset' | 'clear' | 'value' | 'invalid'; value?: number } => {
    if (value === undefined) {
return { kind: 'unset' };
}
    if (value === null || value === '') {
return { kind: 'clear' };
}
    if (typeof value !== 'string') {
return { kind: 'invalid' };
}
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? { kind: 'invalid' } : { kind: 'value', value: parsed };
  };

  switch (toolName) {
    case 'create_milestone': {
      const projectId = (toolArgs.project_id as string) ?? '';
      const title = (toolArgs.title as string) ?? '';
      if (!projectId || !title) {
return err('Missing project_id or title');
}
      const store = persistedStoreApi.$atom.get();
      if (!store.projects.find((p) => p.id === projectId)) {
return err(`Project not found: ${projectId}`);
}
      const dueDate = parseDueDate(toolArgs.due_date);
      if (dueDate.kind === 'invalid' || dueDate.kind === 'clear') {
        return err('Invalid due_date. Use an ISO date like 2026-04-30.');
      }
      const created = await milestoneApi.addMilestone({
        projectId,
        title,
        description: (toolArgs.description as string) ?? '',
        status: 'active',
        ...(toolArgs.branch ? { branch: toolArgs.branch as string } : {}),
        ...(dueDate.kind === 'value' ? { dueDate: dueDate.value } : {}),
      });
      return ok({ id: created.id, title: created.title });
    }
    case 'update_milestone': {
      const id = (toolArgs.milestone_id as string) ?? '';
      if (!id) {
return err('Missing milestone_id');
}
      const existing = $milestones.get()[id];
      if (!existing) {
return err(`Milestone not found: ${id}`);
}
      const patch: Record<string, unknown> = {};
      const dueDate = parseDueDate(toolArgs.due_date);
      if (dueDate.kind === 'invalid') {
return err('Invalid due_date. Use an ISO date like 2026-04-30, or empty string to clear it.');
}
      if (toolArgs.title !== undefined) {
patch.title = toolArgs.title;
}
      if (toolArgs.description !== undefined) {
patch.description = toolArgs.description;
}
      if (toolArgs.branch !== undefined) {
patch.branch = toolArgs.branch;
}
      if (toolArgs.status !== undefined) {
patch.status = toolArgs.status;
}
      if (toolArgs.brief !== undefined) {
patch.brief = toolArgs.brief;
}
      if (dueDate.kind === 'value') {
patch.dueDate = dueDate.value;
}
      if (dueDate.kind === 'clear') {
patch.dueDate = undefined;
}
      await milestoneApi.updateMilestone(id as MilestoneId, patch);
      return ok({ ok: true });
    }
    default:
      return null;
  }
}

async function handleUITools(
  toolName: string,
  toolArgs: Record<string, unknown>,
  tabId?: string,
): Promise<ClientToolResult | null> {
  switch (toolName) {
    case 'open_preview': {
      const url = (toolArgs.url as string) ?? '';
      if (!url) {
return err('Missing url');
}
      requestPreviewOpen(url, tabId);
      return ok({ ok: true, url });
    }
    case 'display_plan': {
      const title = (toolArgs.title as string) ?? 'Plan';
      const description = toolArgs.description as string | undefined;
      const rawSteps = toolArgs.steps as Array<{ title: string; description?: string }> | undefined;
      const steps = (rawSteps ?? []).map((s) => ({
        title: String(s?.title ?? ''),
        description: typeof s?.description === 'string' ? s.description : undefined,
      }));
      const approved = await requestPlanApproval({ title, description, steps });
      return ok({ approved });
    }
    default:
      return null;
  }
}

/**
 * App-control tools. Dispatches list/navigate/snapshot/click/fill/type/press
 * /screenshot/eval/console/reload/back/forward against the live webview
 * registry. Enforces scope: column-only for autopilot, column+global otherwise.
 */
async function handleAppControlTools(
  toolName: string,
  toolArgs: Record<string, unknown>,
  filter: { tabId?: string; allowGlobal: boolean },
  currentTicketId?: TicketId,
): Promise<ClientToolResult | null> {
  if (toolName === 'list_apps') {
    const apps = listLiveApps(filter).map((a) => ({
      id: a.appId,
      kind: a.kind,
      scope: a.scope,
      url: a.url ?? null,
      title: a.title ?? null,
      label: a.label,
      controllable: a.controllable,
    }));
    return ok({ apps });
  }

  // Browser-active-tab tools share the `app_id` scheme even though they don't
  // live under the `app_` prefix, so accept both families here.
  const BROWSER_APP_TOOLS = new Set([
    'browser_scroll',
    'browser_scroll_to_ref',
    'browser_inject_css',
    'browser_remove_inserted_css',
    'browser_find_in_page',
    'browser_wait_for',
    'browser_pdf',
    'browser_full_screenshot',
    'browser_set_viewport',
    'browser_set_user_agent',
    'browser_set_zoom',
    'browser_cookies_get',
    'browser_cookies_set',
    'browser_cookies_clear',
    'browser_storage_get',
    'browser_storage_set',
    'browser_storage_clear',
    'browser_network_log',
  ]);
  if (!toolName.startsWith('app_') && !BROWSER_APP_TOOLS.has(toolName)) {
    return null;
  }

  const appId = (toolArgs.app_id as string | undefined) ?? '';
  if (!appId) {
    return err('Missing app_id — call list_apps first to see available ids.');
  }
  const resolved = resolveAppHandle(appId, filter);
  if (!resolved) {
    return err(`Unknown or out-of-scope app: "${appId}". Call list_apps to see what's available.`);
  }
  if (!resolved.controllable) {
    return err(
      `App "${appId}" (${resolved.kind}) is not a web surface. Only browser/code/desktop/webview apps can be driven.`
    );
  }
  const handleId = resolved.handleId;

  try {
    switch (toolName) {
      case 'app_navigate': {
        const url = (toolArgs.url as string) ?? '';
        if (!url) {
          return err('Missing url');
        }
        await emitter.invoke('app:navigate', handleId, url);
        return ok({ ok: true });
      }
      case 'app_reload':
        await emitter.invoke('app:reload', handleId);
        return ok({ ok: true });
      case 'app_back':
        await emitter.invoke('app:back', handleId);
        return ok({ ok: true });
      case 'app_forward':
        await emitter.invoke('app:forward', handleId);
        return ok({ ok: true });
      case 'app_eval': {
        const code = (toolArgs.code as string) ?? '';
        if (!code) {
          return err('Missing code');
        }
        const value = await emitter.invoke('app:eval', handleId, code);
        return ok({ value: value ?? null });
      }
      case 'app_screenshot': {
        const path = await emitter.invoke(
          'app:screenshot',
          handleId,
          currentTicketId ? { artifactsSubdir: currentTicketId } : {}
        );
        return ok({ path });
      }
      case 'app_console': {
        const level = toolArgs.min_level as AppConsoleLevel | undefined;
        const entries = await emitter.invoke(
          'app:console',
          handleId,
          level ? { minLevel: level } : {}
        );
        return ok({ entries });
      }
      case 'app_snapshot': {
        const tree = await emitter.invoke('app:snapshot', handleId);
        return ok({ snapshot: tree });
      }
      case 'app_snapshot_diff': {
        const diff = await emitter.invoke('app:snapshot-diff', handleId);
        return ok(diff);
      }
      case 'app_click': {
        const ref = (toolArgs.ref as string) ?? '';
        if (!ref) {
          return err('Missing ref — get one from app_snapshot.');
        }
        const button = toolArgs.button as AppClickButton | undefined;
        await emitter.invoke('app:click', handleId, ref, button ? { button } : {});
        return ok({ ok: true });
      }
      case 'app_fill': {
        const ref = (toolArgs.ref as string) ?? '';
        const text = (toolArgs.text as string) ?? '';
        if (!ref) {
          return err('Missing ref');
        }
        await emitter.invoke('app:fill', handleId, ref, text);
        return ok({ ok: true });
      }
      case 'app_type': {
        const text = (toolArgs.text as string) ?? '';
        if (!text) {
          return err('Missing text');
        }
        await emitter.invoke('app:type', handleId, text);
        return ok({ ok: true });
      }
      case 'app_press': {
        const key = (toolArgs.key as string) ?? '';
        if (!key) {
          return err('Missing key');
        }
        await emitter.invoke('app:press', handleId, key);
        return ok({ ok: true });
      }
      case 'browser_scroll': {
        const opts = {
          dx: typeof toolArgs.dx === 'number' ? (toolArgs.dx as number) : undefined,
          dy: typeof toolArgs.dy === 'number' ? (toolArgs.dy as number) : undefined,
          toTop: toolArgs.to_top === true,
          toBottom: toolArgs.to_bottom === true,
        };
        await emitter.invoke('app:scroll', handleId, opts);
        return ok({ ok: true });
      }
      case 'browser_inject_css': {
        const css = (toolArgs.css as string) ?? '';
        if (!css) {
return err('Missing css');
}
        const key = await emitter.invoke('app:inject-css', handleId, css);
        return ok({ key });
      }
      case 'browser_remove_inserted_css': {
        const key = (toolArgs.key as string) ?? '';
        if (!key) {
return err('Missing key');
}
        await emitter.invoke('app:remove-inserted-css', handleId, key);
        return ok({ ok: true });
      }
      case 'browser_find_in_page': {
        const query = (toolArgs.query as string) ?? '';
        if (!query) {
return err('Missing query');
}
        const result = await emitter.invoke('app:find', handleId, query, {
          caseSensitive: toolArgs.case_sensitive === true,
          forward: toolArgs.forward !== false,
          findNext: toolArgs.find_next === true,
        });
        return ok({ matches: result.matches, active_ordinal: result.activeOrdinal });
      }
      case 'browser_wait_for': {
        try {
          const res = await emitter.invoke('app:wait-for', handleId, {
            selector: typeof toolArgs.selector === 'string' ? (toolArgs.selector as string) : undefined,
            urlIncludes:
              typeof toolArgs.url_includes === 'string' ? (toolArgs.url_includes as string) : undefined,
            networkIdle: toolArgs.network_idle === true,
            timeoutMs: typeof toolArgs.timeout_ms === 'number' ? (toolArgs.timeout_ms as number) : undefined,
          });
          return ok(res);
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      }
      case 'browser_scroll_to_ref': {
        const ref = (toolArgs.ref as string) ?? '';
        if (!ref) {
return err('Missing ref');
}
        await emitter.invoke('app:scroll-to-ref', handleId, ref);
        return ok({ ok: true });
      }
      case 'browser_pdf': {
        const path = await emitter.invoke(
          'app:pdf',
          handleId,
          {
            ...(currentTicketId ? { artifactsSubdir: currentTicketId } : {}),
            ...(typeof toolArgs.landscape === 'boolean' ? { landscape: toolArgs.landscape as boolean } : {}),
            ...(typeof toolArgs.print_background === 'boolean'
              ? { printBackground: toolArgs.print_background as boolean }
              : {}),
          }
        );
        return ok({ path });
      }
      case 'browser_full_screenshot': {
        const path = await emitter.invoke(
          'app:full-screenshot',
          handleId,
          currentTicketId ? { artifactsSubdir: currentTicketId } : {}
        );
        return ok({ path });
      }
      case 'browser_set_viewport': {
        if (toolArgs.clear === true) {
          await emitter.invoke('app:set-viewport', handleId, { clear: true });
          return ok({ ok: true });
        }
        const width = Number(toolArgs.width);
        const height = Number(toolArgs.height);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
          return err('browser_set_viewport needs positive `width` + `height`, or `clear: true`.');
        }
        await emitter.invoke('app:set-viewport', handleId, {
          width,
          height,
          ...(typeof toolArgs.device_scale_factor === 'number'
            ? { deviceScaleFactor: toolArgs.device_scale_factor as number }
            : {}),
          ...(typeof toolArgs.mobile === 'boolean' ? { mobile: toolArgs.mobile as boolean } : {}),
        });
        return ok({ ok: true });
      }
      case 'browser_set_user_agent': {
        const ua = (toolArgs.user_agent as string) ?? '';
        await emitter.invoke('app:set-user-agent', handleId, ua);
        return ok({ ok: true });
      }
      case 'browser_set_zoom': {
        const factor = Number(toolArgs.factor);
        if (!Number.isFinite(factor)) {
return err('Missing numeric factor');
}
        await emitter.invoke('app:set-zoom', handleId, factor);
        return ok({ ok: true });
      }
      case 'browser_cookies_get': {
        const cookies = await emitter.invoke('app:cookies-get', handleId, {
          ...(typeof toolArgs.url === 'string' ? { url: toolArgs.url as string } : {}),
          ...(typeof toolArgs.name === 'string' ? { name: toolArgs.name as string } : {}),
          ...(typeof toolArgs.domain === 'string' ? { domain: toolArgs.domain as string } : {}),
          ...(typeof toolArgs.path === 'string' ? { path: toolArgs.path as string } : {}),
        });
        return ok({ cookies });
      }
      case 'browser_cookies_set': {
        const url = (toolArgs.url as string) ?? '';
        const name = (toolArgs.name as string) ?? '';
        const value = (toolArgs.value as string) ?? '';
        if (!url || !name) {
return err('Missing url or name');
}
        await emitter.invoke('app:cookies-set', handleId, {
          url,
          name,
          value,
          ...(typeof toolArgs.domain === 'string' ? { domain: toolArgs.domain as string } : {}),
          ...(typeof toolArgs.path === 'string' ? { path: toolArgs.path as string } : {}),
          ...(typeof toolArgs.secure === 'boolean' ? { secure: toolArgs.secure as boolean } : {}),
          ...(typeof toolArgs.http_only === 'boolean' ? { httpOnly: toolArgs.http_only as boolean } : {}),
          ...(typeof toolArgs.expiration_date === 'number'
            ? { expirationDate: toolArgs.expiration_date as number }
            : {}),
          ...(typeof toolArgs.same_site === 'string'
            ? { sameSite: toolArgs.same_site as 'unspecified' | 'no_restriction' | 'lax' | 'strict' }
            : {}),
        });
        return ok({ ok: true });
      }
      case 'browser_cookies_clear': {
        const removed = await emitter.invoke('app:cookies-clear', handleId, {
          ...(typeof toolArgs.url === 'string' ? { url: toolArgs.url as string } : {}),
          ...(typeof toolArgs.name === 'string' ? { name: toolArgs.name as string } : {}),
        });
        return ok({ removed });
      }
      case 'browser_storage_get': {
        const which = toolArgs.which as 'local' | 'session';
        if (which !== 'local' && which !== 'session') {
return err('which must be "local" or "session"');
}
        const entries = await emitter.invoke('app:storage-get', handleId, which);
        return ok({ entries });
      }
      case 'browser_storage_set': {
        const which = toolArgs.which as 'local' | 'session';
        const entries = toolArgs.entries as Record<string, string> | undefined;
        if (which !== 'local' && which !== 'session') {
return err('which must be "local" or "session"');
}
        if (!entries || typeof entries !== 'object') {
return err('Missing entries object');
}
        await emitter.invoke('app:storage-set', handleId, which, entries);
        return ok({ ok: true });
      }
      case 'browser_storage_clear': {
        const which = toolArgs.which as 'local' | 'session';
        if (which !== 'local' && which !== 'session') {
return err('which must be "local" or "session"');
}
        await emitter.invoke('app:storage-clear', handleId, which);
        return ok({ ok: true });
      }
      case 'browser_network_log': {
        const entries = await emitter.invoke('app:network-log', handleId, {
          ...(typeof toolArgs.limit === 'number' ? { limit: toolArgs.limit as number } : {}),
          ...(typeof toolArgs.since === 'number' ? { since: toolArgs.since as number } : {}),
          ...(typeof toolArgs.url_includes === 'string' ? { urlIncludes: toolArgs.url_includes as string } : {}),
          ...(typeof toolArgs.status_min === 'number' ? { statusMin: toolArgs.status_min as number } : {}),
          ...(toolArgs.clear === true ? { clear: true } : {}),
        });
        return ok({ entries });
      }
      default:
        return null;
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Browser-surface tools. These operate on tabsets/tabs in the BrowserManager
 * directly — no app-control handle required.
 */
async function handleBrowserTools(
  toolName: string,
  toolArgs: Record<string, unknown>
): Promise<ClientToolResult | null> {
  try {
    switch (toolName) {
      case 'browser_list_tabsets': {
        const snapshot = await emitter.invoke('browser:get-state');
        const tabsets = Object.values(snapshot.tabsets).map((ts) => ({
          id: ts.id,
          profile_id: ts.profileId,
          active_tab_id: ts.activeTabId,
          tabs: ts.tabs.map((t) => ({
            id: t.id,
            url: t.url,
            title: t.title ?? null,
            pinned: !!t.pinned,
          })),
        }));
        return ok({ tabsets });
      }
      case 'browser_tab_create': {
        const tabsetId = (toolArgs.tabset_id as string) ?? '';
        if (!tabsetId) {
return err('Missing tabset_id');
}
        const tab = await emitter.invoke('browser:tab-create', tabsetId, {
          ...(typeof toolArgs.url === 'string' ? { url: toolArgs.url as string } : {}),
          ...(typeof toolArgs.activate === 'boolean' ? { activate: toolArgs.activate as boolean } : {}),
        });
        return ok({ tab_id: tab.id, url: tab.url });
      }
      case 'browser_tab_close': {
        const tabsetId = (toolArgs.tabset_id as string) ?? '';
        const tabId = (toolArgs.tab_id as string) ?? '';
        if (!tabsetId || !tabId) {
return err('Missing tabset_id or tab_id');
}
        await emitter.invoke('browser:tab-close', tabsetId, tabId);
        return ok({ ok: true });
      }
      case 'browser_tab_activate': {
        const tabsetId = (toolArgs.tabset_id as string) ?? '';
        const tabId = (toolArgs.tab_id as string) ?? '';
        if (!tabsetId || !tabId) {
return err('Missing tabset_id or tab_id');
}
        await emitter.invoke('browser:tab-activate', tabsetId, tabId);
        return ok({ ok: true });
      }
      case 'browser_tab_navigate': {
        const tabsetId = (toolArgs.tabset_id as string) ?? '';
        const tabId = (toolArgs.tab_id as string) ?? '';
        const url = (toolArgs.url as string) ?? '';
        if (!tabsetId || !tabId || !url) {
return err('Missing tabset_id, tab_id, or url');
}
        await emitter.invoke('browser:tab-navigate', tabsetId, tabId, url);
        return ok({ ok: true });
      }
      default:
        return null;
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Build a ClientToolCallHandler for interactive sessions.
 * All tools are available. When ticketId/projectId are provided,
 * ticket-scoped tools (move_ticket, escalate, notify) use that context.
 *
 * `allowGlobal` (default true) controls whether the caller can drive the
 * global dock apps via `app_*` tools. Autopilot sessions pass `false`.
 */
export function buildClientToolHandler(opts?: {
  ticketId?: TicketId;
  projectId?: ProjectId;
  tabId?: string;
  allowGlobal?: boolean;
}): ClientToolCallHandler {
  const allowGlobal = opts?.allowGlobal ?? true;
  return async (toolName: string, toolArgs: Record<string, unknown>) => {
    const ticketResult = await handleTicketTools(toolName, toolArgs, opts?.ticketId, opts?.projectId);
    if (ticketResult) {
return ticketResult;
}

    const contextResult = await handleReadonlyContextTools(toolName, toolArgs);
    if (contextResult) {
return contextResult;
}

    const milestoneResult = await handleMilestoneTools(toolName, toolArgs);
    if (milestoneResult) {
return milestoneResult;
}

    const pageResult = await handlePageTools(toolName, toolArgs);
    if (pageResult) {
return pageResult;
}

    const inboxResult = await handleInboxTools(toolName, toolArgs);
    if (inboxResult) {
return inboxResult;
}

    const projectResult = await handleProjectTools(toolName, toolArgs);
    if (projectResult) {
return projectResult;
}

    const uiResult = await handleUITools(toolName, toolArgs, opts?.tabId);
    if (uiResult) {
return uiResult;
}

    const browserResult = await handleBrowserTools(toolName, toolArgs);
    if (browserResult) {
return browserResult;
}

    const appResult = await handleAppControlTools(
      toolName,
      toolArgs,
      { tabId: opts?.tabId, allowGlobal },
      opts?.ticketId,
    );
    if (appResult) {
return appResult;
}

    return err(`Unknown tool: ${toolName}`);
  };
}
