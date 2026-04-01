/**
 * Renderer-side handler for project management client tools.
 *
 * Handles both TICKET tools (get_ticket, move_ticket, escalate — when a ticket
 * context is provided) and PROJECT tools (list_projects, list_tickets, create_ticket,
 * update_ticket, start_ticket, stop_ticket).
 *
 * Used by Chat tab and Code tab so any interactive agent session can manage projects.
 */

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
  ticketId: TicketId,
  projectId: ProjectId
): Promise<ClientToolResult | null> {
  switch (toolName) {
    case 'get_ticket': {
      const ticket = $tickets.get()[ticketId];
      if (!ticket) return err('Ticket not found');
      const pipeline = await ticketApi.getPipeline(projectId);
      const column = pipeline.columns.find((c) => c.id === ticket.columnId);
      return ok({
        id: ticket.id,
        title: ticket.title,
        description: ticket.description || '',
        priority: ticket.priority,
        column: column?.label ?? ticket.columnId,
        pipeline: pipeline.columns.map((c) => c.label),
      });
    }
    case 'move_ticket': {
      const columnLabel = (toolArgs.column as string) ?? '';
      const pipeline = await ticketApi.getPipeline(projectId);
      const col = pipeline.columns.find((c) => c.label.toLowerCase() === columnLabel.toLowerCase());
      if (!col) {
        const valid = pipeline.columns.map((c) => c.label).join(', ');
        return err(`Unknown column: "${columnLabel}". Valid columns: ${valid}`);
      }
      await ticketApi.moveTicketToColumn(ticketId, col.id);
      return ok({ ok: true, column: col.label });
    }
    case 'escalate': {
      const message = (toolArgs.message as string) ?? '';
      if (!message) return err('Empty escalation message');
      return ok({ ok: true, message: 'Escalated to human operator' });
    }
    default:
      return null;
  }
}

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
        workspaceDir: p.workspaceDir,
        columns: (p.pipeline?.columns ?? []).map((c) => c.label),
      }));
      return ok({ projects });
    }
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
      }));
      return ok({ tickets: result });
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
    case 'read_brief': {
      const projectId = (toolArgs.project_id as string) ?? '';
      if (!projectId) return err('Missing project_id');
      const project = store.projects.find((p) => p.id === projectId);
      if (!project) return err(`Project not found: ${projectId}`);
      return ok({ brief: project.brief ?? '' });
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
        })),
      });
    }
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
    case 'read_initiative_brief': {
      const id = (toolArgs.initiative_id as string) ?? '';
      if (!id) return err('Missing initiative_id');
      const existing = $initiatives.get()[id];
      if (!existing) return err(`Initiative not found: ${id}`);
      return ok({ brief: existing.brief ?? '' });
    }
    default:
      return null;
  }
}

/**
 * Build a ClientToolCallHandler for interactive sessions (no ticket context).
 * Project-scoped, initiative, inbox, and brief tools are available.
 */
export function buildClientToolHandler(): ClientToolCallHandler {
  return async (toolName: string, toolArgs: Record<string, unknown>) => {
    const initiativeResult = await handleInitiativeTools(toolName, toolArgs);
    if (initiativeResult) return initiativeResult;

    const inboxResult = await handleInboxTools(toolName, toolArgs);
    if (inboxResult) return inboxResult;

    const projectResult = await handleProjectTools(toolName, toolArgs);
    if (projectResult) return projectResult;

    return err(`Unknown tool: ${toolName}`);
  };
}

/**
 * Build a ClientToolCallHandler for a ticket-scoped session.
 * Ticket tools are available for the current ticket, and general project
 * management tools are also available for broader context.
 */
export function buildTicketToolHandler(
  ticketId: TicketId,
  projectId: ProjectId
): ClientToolCallHandler {
  return async (toolName: string, toolArgs: Record<string, unknown>) => {
    const ticketResult = await handleTicketTools(toolName, toolArgs, ticketId, projectId);
    if (ticketResult) return ticketResult;

    const initiativeResult = await handleInitiativeTools(toolName, toolArgs);
    if (initiativeResult) return initiativeResult;

    const inboxResult = await handleInboxTools(toolName, toolArgs);
    if (inboxResult) return inboxResult;

    const projectResult = await handleProjectTools(toolName, toolArgs);
    if (projectResult) return projectResult;

    return err(`Unknown tool: ${toolName}`);
  };
}
