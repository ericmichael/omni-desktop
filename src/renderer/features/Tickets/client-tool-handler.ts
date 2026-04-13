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

import type { ClientToolCallHandler } from '@/renderer/omniagents-ui/App';
import { $milestones, milestoneApi } from '@/renderer/features/Initiatives/state';
import { inboxApi } from '@/renderer/features/Inbox/state';
import { pageApi } from '@/renderer/features/Pages/state';
import { $tickets, ticketApi } from '@/renderer/features/Tickets/state';
import { requestPlanApproval } from '@/renderer/features/Tickets/plan-approval-bridge';
import { requestPreviewOpen } from '@/renderer/features/Tickets/preview-bridge';
import { persistedStoreApi } from '@/renderer/services/store';
import type {
  InboxItem,
  InboxItemId,
  InboxItemStatus,
  InboxShaping,
  MilestoneId,
  PageId,
  Pipeline,
  ProjectId,
  TicketId,
} from '@/shared/types';

function parseInboxStatus(input: unknown): InboxItemStatus | undefined {
  if (input === 'new' || input === 'shaped' || input === 'later') return input;
  return undefined;
}

function parseAppetite(input: unknown): InboxShaping['appetite'] | undefined {
  if (input === 'small' || input === 'medium' || input === 'large' || input === 'xl') return input;
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
      const milestoneFilter = toolArgs.milestone_id as string | undefined;
      if (milestoneFilter) tickets = tickets.filter((t) => t.milestoneId === milestoneFilter);
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
    case 'list_milestones': {
      const projectId = (toolArgs.project_id as string) ?? '';
      if (!projectId) return err('Missing project_id');
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
      if (!id) return err('Missing milestone_id');
      const existing = $milestones.get()[id];
      if (!existing) return err(`Milestone not found: ${id}`);
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
    case 'list_pages': {
      const projectId = (toolArgs.project_id as string) ?? '';
      if (!projectId) return err('Missing project_id');
      const store = persistedStoreApi.$atom.get();
      if (!store.projects.find((p) => p.id === projectId)) return err(`Project not found: ${projectId}`);
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
      if (!pageId) return err('Missing page_id');
      const store = persistedStoreApi.$atom.get();
      const page = store.pages.find((p) => p.id === pageId);
      if (!page) return err(`Page not found: ${pageId}`);
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
      if (!label) return err('Missing label');
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const workspaceDir = toolArgs.workspace_dir as string | undefined;
      const repoUrl = toolArgs.repo_url as string | undefined;
      if (workspaceDir && repoUrl) return err('Pass workspace_dir or repo_url, not both');
      let source: import('@/shared/types').ProjectSource | undefined;
      if (workspaceDir) {
        source = { kind: 'local', workspaceDir };
      } else if (repoUrl) {
        source = {
          kind: 'git-remote',
          repoUrl,
          ...(toolArgs.default_branch ? { defaultBranch: toolArgs.default_branch as string } : {}),
        };
      }
      const created = await ticketApi.addProject({ label, slug, source });
      const pipeline = await ticketApi.getPipeline(created.id);
      const rootPage = persistedStoreApi.$atom.get().pages.find(
        (p) => p.projectId === created.id && p.isRoot
      );
      return ok({
        id: created.id,
        label: created.label,
        slug: created.slug,
        source_kind: source?.kind ?? null,
        workspace_dir: source?.kind === 'local' ? source.workspaceDir : null,
        repo_url: source?.kind === 'git-remote' ? source.repoUrl : null,
        default_branch: source?.kind === 'git-remote' ? source.defaultBranch ?? null : null,
        pipeline: pipeline.columns.map((c) => c.label),
        root_page_id: rootPage?.id ?? null,
      });
    }
    case 'update_project': {
      const projectId = (toolArgs.project_id as string) ?? '';
      if (!projectId) return err('Missing project_id');
      const project = store.projects.find((p) => p.id === projectId);
      if (!project) return err(`Project not found: ${projectId}`);
      if (toolArgs.workspace_dir !== undefined && toolArgs.repo_url !== undefined) {
        return err('Pass workspace_dir or repo_url, not both');
      }
      const patch: Record<string, unknown> = {};
      if (toolArgs.label !== undefined) {
        patch.label = toolArgs.label;
        patch.slug = (toolArgs.label as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      }
      if (toolArgs.workspace_dir !== undefined) {
        const dir = toolArgs.workspace_dir as string;
        patch.source = dir ? { kind: 'local', workspaceDir: dir } : undefined;
      } else if (toolArgs.repo_url !== undefined) {
        const url = toolArgs.repo_url as string;
        patch.source = url
          ? { kind: 'git-remote', repoUrl: url, ...(toolArgs.default_branch ? { defaultBranch: toolArgs.default_branch as string } : {}) }
          : undefined;
      }
      await ticketApi.updateProject(projectId as ProjectId, patch);
      return ok({ ok: true });
    }
    case 'delete_project': {
      const projectId = (toolArgs.project_id as string) ?? '';
      if (!projectId) return err('Missing project_id');
      const project = store.projects.find((p) => p.id === projectId);
      if (!project) return err(`Project not found: ${projectId}`);
      if (project.isPersonal) return err('Cannot delete the Personal project');
      await ticketApi.removeProject(projectId as ProjectId);
      return ok({ ok: true });
    }
    case 'create_ticket': {
      const projectId = (toolArgs.project_id as string) ?? '';
      const title = (toolArgs.title as string) ?? '';
      if (!projectId || !title) return err('Missing project_id or title');
      const project = store.projects.find((p) => p.id === projectId);
      if (!project) return err(`Project not found: ${projectId}`);
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
      if (!projectId || !title) return err('Missing project_id or title');
      const store = persistedStoreApi.$atom.get();
      if (!store.projects.find((p) => p.id === projectId)) return err(`Project not found: ${projectId}`);
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
      if (!pageId) return err('Missing page_id');
      const store = persistedStoreApi.$atom.get();
      const page = store.pages.find((p) => p.id === pageId);
      if (!page) return err(`Page not found: ${pageId}`);
      // Metadata patch
      const metaPatch: Record<string, unknown> = {};
      if (toolArgs.title !== undefined) metaPatch.title = toolArgs.title;
      if (toolArgs.icon !== undefined) metaPatch.icon = toolArgs.icon;
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
      if (!title) return err('Missing title');
      const created = await inboxApi.add({
        title,
        note: (toolArgs.description as string) || undefined,
        projectId: (toolArgs.project_id as string) || null,
      });
      return ok({ id: created.id, title: created.title });
    }
    case 'update_inbox_item': {
      const itemId = (toolArgs.item_id as string) ?? '';
      if (!itemId) return err('Missing item_id');

      const patch: Parameters<typeof inboxApi.update>[1] = {};
      if (toolArgs.title !== undefined) patch.title = toolArgs.title as string;
      if (toolArgs.description !== undefined) patch.note = toolArgs.description as string;
      if (toolArgs.project_id !== undefined) patch.projectId = (toolArgs.project_id as string) || null;
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
      if (toolArgs.status === 'later') await inboxApi.defer(itemId as InboxItemId);
      if (toolArgs.status === 'new' || toolArgs.status === 'shaped') {
        await inboxApi.reactivate(itemId as InboxItemId);
      }
      return ok({ ok: true });
    }
    case 'delete_inbox_item': {
      const itemId = (toolArgs.item_id as string) ?? '';
      if (!itemId) return err('Missing item_id');
      await inboxApi.remove(itemId as InboxItemId);
      return ok({ ok: true });
    }
    case 'inbox_to_tickets': {
      const itemId = (toolArgs.item_id as string) ?? '';
      const projectId = (toolArgs.project_id as string) ?? '';
      if (!itemId || !projectId) return err('Missing item_id or project_id');
      const milestoneId = (toolArgs.milestone_id as string) || undefined;
      const ticket = await inboxApi.promoteToTicket(itemId as InboxItemId, {
        projectId: projectId as ProjectId,
        ...(milestoneId ? { milestoneId: milestoneId as MilestoneId } : {}),
      });
      return ok({ ok: true, ticket_ids: [ticket.id] });
    }
    default:
      return null;
  }
}

async function handleMilestoneTools(
  toolName: string,
  toolArgs: Record<string, unknown>
): Promise<ClientToolResult | null> {
  switch (toolName) {
    case 'create_milestone': {
      const projectId = (toolArgs.project_id as string) ?? '';
      const title = (toolArgs.title as string) ?? '';
      if (!projectId || !title) return err('Missing project_id or title');
      const store = persistedStoreApi.$atom.get();
      if (!store.projects.find((p) => p.id === projectId)) return err(`Project not found: ${projectId}`);
      const created = await milestoneApi.addMilestone({
        projectId,
        title,
        description: (toolArgs.description as string) ?? '',
        status: 'active',
        ...(toolArgs.branch ? { branch: toolArgs.branch as string } : {}),
      });
      return ok({ id: created.id, title: created.title });
    }
    case 'update_milestone': {
      const id = (toolArgs.milestone_id as string) ?? '';
      if (!id) return err('Missing milestone_id');
      const existing = $milestones.get()[id];
      if (!existing) return err(`Milestone not found: ${id}`);
      const patch: Record<string, unknown> = {};
      if (toolArgs.title !== undefined) patch.title = toolArgs.title;
      if (toolArgs.description !== undefined) patch.description = toolArgs.description;
      if (toolArgs.branch !== undefined) patch.branch = toolArgs.branch;
      if (toolArgs.status !== undefined) patch.status = toolArgs.status;
      if (toolArgs.brief !== undefined) patch.brief = toolArgs.brief;
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
      if (!url) return err('Missing url');
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
 * Build a ClientToolCallHandler for interactive sessions.
 * All tools are available. When ticketId/projectId are provided,
 * ticket-scoped tools (move_ticket, escalate, notify) use that context.
 */
export function buildClientToolHandler(opts?: {
  ticketId?: TicketId;
  projectId?: ProjectId;
  tabId?: string;
}): ClientToolCallHandler {
  return async (toolName: string, toolArgs: Record<string, unknown>) => {
    const ticketResult = await handleTicketTools(toolName, toolArgs, opts?.ticketId, opts?.projectId);
    if (ticketResult) return ticketResult;

    const contextResult = await handleReadonlyContextTools(toolName, toolArgs);
    if (contextResult) return contextResult;

    const milestoneResult = await handleMilestoneTools(toolName, toolArgs);
    if (milestoneResult) return milestoneResult;

    const pageResult = await handlePageTools(toolName, toolArgs);
    if (pageResult) return pageResult;

    const inboxResult = await handleInboxTools(toolName, toolArgs);
    if (inboxResult) return inboxResult;

    const projectResult = await handleProjectTools(toolName, toolArgs);
    if (projectResult) return projectResult;

    const uiResult = await handleUITools(toolName, toolArgs, opts?.tabId);
    if (uiResult) return uiResult;

    return err(`Unknown tool: ${toolName}`);
  };
}
