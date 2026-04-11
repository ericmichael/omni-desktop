/**
 * Renderer-side handler for project management client tools.
 *
 * Handles TICKET tools (get_ticket, move_ticket, escalate, notify, add_ticket_comment),
 * read-only context tools (list_tickets, search_tickets, list_initiatives, read_brief,
 * read_initiative_brief, get_ticket_comments, get_ticket_history, get_pipeline),
 * and write tools (create/update/start/stop tickets, briefs, initiatives, inbox).
 *
 * Used by Chat tab and Code tab so any interactive agent session can manage projects.
 */

import { nanoid } from 'nanoid';

import type { ClientToolCallHandler } from '@/renderer/omniagents-ui/App';
import { $inboxItems, inboxApi } from '@/renderer/features/Inbox/state';
import { $initiatives, initiativeApi } from '@/renderer/features/Initiatives/state';
import { $tickets, ticketApi } from '@/renderer/features/Tickets/state';
import { persistedStoreApi } from '@/renderer/services/store';
import type { InitiativeId, TicketId, ProjectId, InboxItemId, Pipeline } from '@/shared/types';

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
      if (!lookupId) return err('No ticket_id provided and no current ticket context');
      const ticket = $tickets.get()[lookupId];
      if (!ticket) return err(`Ticket not found: ${lookupId}`);
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
      if (!currentTicketId || !currentProjectId) return err('No current ticket context for move_ticket');
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
      if (!message) return err('Empty escalation message');
      return ok({ ok: true, message: 'Escalated to human operator' });
    }
    case 'notify': {
      const message = (toolArgs.message as string) ?? '';
      if (!message) return err('Empty notification message');
      return ok({ ok: true, message: 'Notification sent' });
    }
    case 'add_ticket_comment': {
      const commentTicketId = (toolArgs.ticket_id as string as TicketId) || currentTicketId;
      if (!commentTicketId) return err('No ticket_id provided and no current ticket context');
      const content = (toolArgs.content as string) ?? '';
      if (!content) return err('Missing content');
      const ticket = $tickets.get()[commentTicketId];
      if (!ticket) return err(`Ticket not found: ${commentTicketId}`);
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
      if (!projectId) return err('Missing project_id');
      const project = store.projects.find((p) => p.id === projectId);
      if (!project) return err(`Project not found: ${projectId}`);
      let pipeline: Pipeline;
      try {
        pipeline = await ticketApi.getPipeline(projectId);
      } catch {
        return err(`Failed to load pipeline for project: ${projectId}`);
      }
      let tickets = store.tickets.filter((t) => t.projectId === projectId);
      const initiativeFilter = toolArgs.initiative_id as string | undefined;
      if (initiativeFilter) tickets = tickets.filter((t) => t.initiativeId === initiativeFilter);
      const columnFilter = toolArgs.column as string | undefined;
      if (columnFilter) {
        const col = pipeline.columns.find((c) => c.label.toLowerCase() === columnFilter.toLowerCase());
        if (col) tickets = tickets.filter((t) => t.columnId === col.id);
      }
      const priorityFilter = toolArgs.priority as string | undefined;
      if (priorityFilter) tickets = tickets.filter((t) => t.priority === priorityFilter);
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
      if (!query) return err('Missing query');
      const q = query.toLowerCase();
      const projectFilter = toolArgs.project_id as string | undefined;
      let tickets = store.tickets;
      if (projectFilter) tickets = tickets.filter((t) => t.projectId === projectFilter);
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
    case 'list_initiatives': {
      const projectId = (toolArgs.project_id as string) ?? '';
      if (!projectId) return err('Missing project_id');
      await initiativeApi.fetchInitiatives(projectId);
      const items = Object.values($initiatives.get()).filter((i) => i.projectId === projectId);
      return ok({
        initiatives: items.map((i) => ({
          id: i.id,
          title: i.title,
          description: i.description || '',
          branch: i.branch || null,
          status: i.status,
          is_default: i.isDefault ?? false,
          created_at: new Date(i.createdAt).toISOString(),
          updated_at: new Date(i.updatedAt).toISOString(),
        })),
      });
    }
    case 'read_brief': {
      const projectId = (toolArgs.project_id as string) ?? '';
      if (!projectId) return err('Missing project_id');
      const project = store.projects.find((p) => p.id === projectId);
      if (!project) return err(`Project not found: ${projectId}`);
      return ok({ brief: project.brief ?? '' });
    }
    case 'read_initiative_brief': {
      const id = (toolArgs.initiative_id as string) ?? '';
      if (!id) return err('Missing initiative_id');
      const existing = $initiatives.get()[id];
      if (!existing) return err(`Initiative not found: ${id}`);
      return ok({ brief: existing.brief ?? '' });
    }
    case 'get_ticket_comments': {
      const tid = (toolArgs.ticket_id as string) ?? '';
      if (!tid) return err('Missing ticket_id');
      const ticket = $tickets.get()[tid as TicketId];
      if (!ticket) return err(`Ticket not found: ${tid}`);
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
      if (!tid) return err('Missing ticket_id');
      const ticket = $tickets.get()[tid as TicketId];
      if (!ticket) return err(`Ticket not found: ${tid}`);
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
      if (!projectId) return err('Missing project_id');
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
        workspaceDir: p.source.kind === 'local' ? p.source.workspaceDir : p.source.repoUrl,
        columns: (p.pipeline?.columns ?? []).map((c) => c.label),
      }));
      return ok({ projects });
    }
    case 'create_ticket': {
      const projectId = (toolArgs.project_id as string) ?? '';
      const title = (toolArgs.title as string) ?? '';
      if (!projectId || !title) return err('Missing project_id or title');
      const project = store.projects.find((p) => p.id === projectId);
      if (!project) return err(`Project not found: ${projectId}`);
      const created = await ticketApi.addTicket({
        projectId,
        initiativeId: (toolArgs.initiative_id as string) || undefined,
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
      if (!targetId) return err('Missing ticket_id');
      const target = store.tickets.find((t) => t.id === targetId);
      if (!target) return err(`Ticket not found: ${targetId}`);
      const patch: Record<string, unknown> = {};
      if (toolArgs.title) patch.title = toolArgs.title;
      if (toolArgs.description !== undefined) patch.description = toolArgs.description;
      if (toolArgs.priority) patch.priority = toolArgs.priority;
      if (toolArgs.branch !== undefined) patch.branch = toolArgs.branch;
      // Dependency management
      if (toolArgs.add_blocked_by || toolArgs.remove_blocked_by) {
        const current = new Set(target.blockedBy ?? []);
        for (const id of (toolArgs.add_blocked_by as string[]) ?? []) current.add(id);
        for (const id of (toolArgs.remove_blocked_by as string[]) ?? []) current.delete(id);
        patch.blockedBy = [...current];
      }
      await ticketApi.updateTicket(targetId as TicketId, patch);
      return ok({ ok: true });
    }
    case 'start_ticket': {
      const targetId = (toolArgs.ticket_id as string) ?? '';
      if (!targetId) return err('Missing ticket_id');
      try {
        await ticketApi.startSupervisor(targetId as TicketId);
        return ok({ ok: true });
      } catch (e) {
        return err(String(e));
      }
    }
    case 'stop_ticket': {
      const targetId = (toolArgs.ticket_id as string) ?? '';
      if (!targetId) return err('Missing ticket_id');
      try {
        await ticketApi.stopSupervisor(targetId as TicketId);
        return ok({ ok: true });
      } catch (e) {
        return err(String(e));
      }
    }
    case 'update_brief': {
      const projectId = (toolArgs.project_id as string) ?? '';
      const content = (toolArgs.content as string) ?? '';
      if (!projectId) return err('Missing project_id');
      const project = store.projects.find((p) => p.id === projectId);
      if (!project) return err(`Project not found: ${projectId}`);
      await ticketApi.updateProject(projectId as ProjectId, { brief: content });
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
      let items = Object.values($inboxItems.get());
      const statusFilter = toolArgs.status as string | undefined;
      if (statusFilter) items = items.filter((i) => i.status === statusFilter);
      return ok({
        items: items.map((i) => ({
          id: i.id,
          title: i.title,
          description: i.description || '',
          status: i.status,
          project_id: i.projectId || null,
          created_at: new Date(i.createdAt).toISOString(),
          updated_at: new Date(i.updatedAt).toISOString(),
        })),
      });
    }
    case 'create_inbox_item': {
      const title = (toolArgs.title as string) ?? '';
      if (!title) return err('Missing title');
      const created = await inboxApi.addItem({
        title,
        description: (toolArgs.description as string) || undefined,
        projectId: (toolArgs.project_id as string) || undefined,
        status: 'open',
      });
      return ok({ id: created.id, title: created.title });
    }
    case 'update_inbox_item': {
      const itemId = (toolArgs.item_id as string) ?? '';
      if (!itemId) return err('Missing item_id');
      const existing = $inboxItems.get()[itemId];
      if (!existing) return err(`Inbox item not found: ${itemId}`);
      const patch: Record<string, unknown> = {};
      if (toolArgs.title !== undefined) patch.title = toolArgs.title;
      if (toolArgs.description !== undefined) patch.description = toolArgs.description;
      if (toolArgs.status !== undefined) patch.status = toolArgs.status;
      if (toolArgs.project_id !== undefined) patch.projectId = toolArgs.project_id;
      await inboxApi.updateItem(itemId as InboxItemId, patch);
      return ok({ ok: true });
    }
    case 'delete_inbox_item': {
      const itemId = (toolArgs.item_id as string) ?? '';
      if (!itemId) return err('Missing item_id');
      await inboxApi.removeItem(itemId as InboxItemId);
      return ok({ ok: true });
    }
    case 'inbox_to_tickets': {
      const itemId = (toolArgs.item_id as string) ?? '';
      const projectId = (toolArgs.project_id as string) ?? '';
      const ticketDefs = toolArgs.tickets as Array<{ title: string; description?: string; priority?: string }>;
      if (!itemId || !projectId || !ticketDefs?.length) {
        return err('Missing item_id, project_id, or tickets');
      }
      const store = persistedStoreApi.$atom.get();
      if (!store.projects.find((p) => p.id === projectId)) {
        return err(`Project not found: ${projectId}`);
      }
      const createdIds: string[] = [];
      for (const def of ticketDefs) {
        const created = await ticketApi.addTicket({
          projectId,
          title: def.title,
          description: def.description ?? '',
          priority: (def.priority as 'low' | 'medium' | 'high' | 'critical') ?? 'medium',
          blockedBy: [],
        });
        createdIds.push(created.id);
      }
      await inboxApi.updateItem(itemId as InboxItemId, {
        status: 'done',
        linkedTicketIds: createdIds,
      });
      return ok({ ok: true, ticket_ids: createdIds });
    }
    default:
      return null;
  }
}

async function handleInitiativeTools(
  toolName: string,
  toolArgs: Record<string, unknown>
): Promise<ClientToolResult | null> {
  switch (toolName) {
    case 'create_initiative': {
      const projectId = (toolArgs.project_id as string) ?? '';
      const title = (toolArgs.title as string) ?? '';
      if (!projectId || !title) return err('Missing project_id or title');
      const store = persistedStoreApi.$atom.get();
      if (!store.projects.find((p) => p.id === projectId)) return err(`Project not found: ${projectId}`);
      const created = await initiativeApi.addInitiative({
        projectId,
        title,
        description: (toolArgs.description as string) ?? '',
        status: 'active',
        ...(toolArgs.branch ? { branch: toolArgs.branch as string } : {}),
      });
      return ok({ id: created.id, title: created.title });
    }
    case 'update_initiative': {
      const id = (toolArgs.initiative_id as string) ?? '';
      if (!id) return err('Missing initiative_id');
      const existing = $initiatives.get()[id];
      if (!existing) return err(`Initiative not found: ${id}`);
      const patch: Record<string, unknown> = {};
      if (toolArgs.title !== undefined) patch.title = toolArgs.title;
      if (toolArgs.description !== undefined) patch.description = toolArgs.description;
      if (toolArgs.branch !== undefined) patch.branch = toolArgs.branch;
      if (toolArgs.status !== undefined) patch.status = toolArgs.status;
      if (toolArgs.brief !== undefined) patch.brief = toolArgs.brief;
      await initiativeApi.updateInitiative(id as InitiativeId, patch);
      return ok({ ok: true });
    }
    default:
      return null;
  }
}

/**
 * Build a ClientToolCallHandler for interactive sessions.
 * All tools are available. When ticketId/projectId are provided,
 * ticket-scoped tools (move_ticket, escalate, notify) use that context.
 */
export function buildClientToolHandler(opts?: {
  ticketId?: TicketId;
  projectId?: ProjectId;
}): ClientToolCallHandler {
  return async (toolName: string, toolArgs: Record<string, unknown>) => {
    const ticketResult = await handleTicketTools(toolName, toolArgs, opts?.ticketId, opts?.projectId);
    if (ticketResult) return ticketResult;

    const contextResult = await handleReadonlyContextTools(toolName, toolArgs);
    if (contextResult) return contextResult;

    const initiativeResult = await handleInitiativeTools(toolName, toolArgs);
    if (initiativeResult) return initiativeResult;

    const inboxResult = await handleInboxTools(toolName, toolArgs);
    if (inboxResult) return inboxResult;

    const projectResult = await handleProjectTools(toolName, toolArgs);
    if (projectResult) return projectResult;

    return err(`Unknown tool: ${toolName}`);
  };
}
