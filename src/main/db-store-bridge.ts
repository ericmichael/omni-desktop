/**
 * Bridge between the SQLite database (row types) and the launcher's in-memory
 * model types. Handles:
 *
 * - snake_case ↔ camelCase field mapping
 * - ISO string ↔ epoch milliseconds timestamp conversion
 * - JSON string ↔ parsed object conversion
 * - integer (0/1) ↔ boolean conversion
 *
 * Also provides `buildStoreSnapshot()` which assembles a full `StoreData` object
 * by reading project data from SQLite and non-project data from electron-store.
 * This is what gets broadcast via `store:changed` to the renderer.
 */
import type { ProjectsRepo } from 'omni-projects-db';
import { fromIso, toIso } from 'omni-projects-db';
import type {
  ProjectRow,
  ColumnRow,
  TicketRow,
  CommentRow,
  MilestoneRow,
  PageRow,
  InboxRow,
  TaskRow,
} from 'omni-projects-db';

import type {
  Column,
  ColumnId,
  InboxItem,
  InboxItemId,
  InboxPromotion,
  InboxShaping,
  Milestone,
  MilestoneId,
  Page,
  PageId,
  Pipeline,
  Project,
  ProjectId,
  ShapingData,
  StoreData,
  Task,
  TaskId,
  Ticket,
  TicketComment,
  TicketId,
  TicketPriority,
  TicketResolution,
  TokenUsage,
} from '@/shared/types';
import type { TicketPhase } from '@/shared/ticket-phase';

// ---- JSON helpers ----

function parseJsonOr<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function jsonStrOrNull(v: unknown): string | null {
  return v != null ? JSON.stringify(v) : null;
}

function isoOrNull(epochMs: number | undefined): string | null {
  return epochMs != null ? toIso(epochMs) : null;
}

// ---- Row → Model conversions ----

export function rowToProject(row: ProjectRow): Project {
  const project: Project = {
    id: row.id as ProjectId,
    label: row.label,
    slug: row.slug,
    createdAt: fromIso(row.created_at),
  };
  if (row.is_personal) project.isPersonal = true;
  if (row.auto_dispatch) project.autoDispatch = true;
  if (row.source) project.source = JSON.parse(row.source);
  if (row.sandbox) project.sandbox = JSON.parse(row.sandbox);
  return project;
}

export function rowToColumn(row: ColumnRow): Column {
  const col: Column = {
    id: row.id as ColumnId,
    label: row.label,
  };
  if (row.description) col.description = row.description;
  if (row.gate) col.gate = true;
  return col;
}

export function rowsToPipeline(rows: ColumnRow[]): Pipeline {
  return { columns: rows.map(rowToColumn) };
}

export function rowToTicket(row: TicketRow, comments?: CommentRow[]): Ticket {
  const ticket: Ticket = {
    id: row.id as TicketId,
    projectId: row.project_id as ProjectId,
    columnId: row.column_id as ColumnId,
    title: row.title,
    description: row.description,
    priority: row.priority as TicketPriority,
    blockedBy: parseJsonOr<TicketId[]>(row.blocked_by, []),
    createdAt: fromIso(row.created_at),
    updatedAt: fromIso(row.updated_at),
  };
  if (row.milestone_id) ticket.milestoneId = row.milestone_id as MilestoneId;
  if (row.branch) ticket.branch = row.branch;
  if (row.shaping) ticket.shaping = JSON.parse(row.shaping) as ShapingData;
  if (row.resolution) ticket.resolution = row.resolution as TicketResolution;
  if (row.resolved_at) ticket.resolvedAt = fromIso(row.resolved_at);
  if (row.archived_at) ticket.archivedAt = fromIso(row.archived_at);
  if (row.column_changed_at) ticket.columnChangedAt = fromIso(row.column_changed_at);
  if (row.use_worktree) ticket.useWorktree = true;
  if (row.worktree_path) ticket.worktreePath = row.worktree_path;
  if (row.worktree_name) ticket.worktreeName = row.worktree_name;
  // supervisor_session_id column is retained in SQLite for old rows but is
  // no longer surfaced on the Ticket model — the renderer Code column owns
  // the session id now, not the ticket record.
  if (row.phase) ticket.phase = row.phase as TicketPhase;
  if (row.phase_changed_at) ticket.phaseChangedAt = fromIso(row.phase_changed_at);
  if (row.supervisor_task_id) ticket.supervisorTaskId = row.supervisor_task_id as TaskId;
  if (row.token_usage) ticket.tokenUsage = JSON.parse(row.token_usage) as TokenUsage;

  const runs = parseJsonOr<unknown[]>(row.runs, []);
  if (runs.length > 0) ticket.runs = runs as Ticket['runs'];

  if (comments && comments.length > 0) {
    ticket.comments = comments.map(rowToComment);
  }
  return ticket;
}

export function rowToComment(row: CommentRow): TicketComment {
  return {
    id: row.id,
    author: row.author as 'agent' | 'human',
    content: row.content,
    createdAt: fromIso(row.created_at),
  };
}

export function rowToMilestone(row: MilestoneRow): Milestone {
  const milestone: Milestone = {
    id: row.id as MilestoneId,
    projectId: row.project_id as ProjectId,
    title: row.title,
    description: row.description,
    status: row.status as Milestone['status'],
    createdAt: fromIso(row.created_at),
    updatedAt: fromIso(row.updated_at),
  };
  if (row.branch) milestone.branch = row.branch;
  if (row.brief) milestone.brief = row.brief;
  if (row.due_date) milestone.dueDate = fromIso(row.due_date);
  if (row.completed_at) milestone.completedAt = fromIso(row.completed_at);
  return milestone;
}

export function rowToPage(row: PageRow): Page {
  const page: Page = {
    id: row.id as PageId,
    projectId: row.project_id as ProjectId,
    parentId: (row.parent_id as PageId | null),
    title: row.title,
    sortOrder: row.sort_order,
    createdAt: fromIso(row.created_at),
    updatedAt: fromIso(row.updated_at),
  };
  if (row.icon) page.icon = row.icon;
  if (row.is_root) page.isRoot = true;
  if (row.kind && row.kind !== 'doc') page.kind = row.kind as Page['kind'];
  if (row.properties) page.properties = JSON.parse(row.properties);
  return page;
}

export function rowToInboxItem(row: InboxRow): InboxItem {
  const item: InboxItem = {
    id: row.id as InboxItemId,
    title: row.title,
    status: row.status as InboxItem['status'],
    createdAt: fromIso(row.created_at),
    updatedAt: fromIso(row.updated_at),
  };
  if (row.note) item.note = row.note;
  if (row.project_id) item.projectId = row.project_id as ProjectId;
  if (row.shaping) item.shaping = JSON.parse(row.shaping) as InboxShaping;
  if (row.later_at) item.laterAt = fromIso(row.later_at);
  if (row.promoted_to) item.promotedTo = JSON.parse(row.promoted_to) as InboxPromotion;
  return item;
}

export function rowToTask(row: TaskRow): Task {
  const task: Task = {
    id: row.id as TaskId,
    projectId: row.project_id as ProjectId,
    taskDescription: row.task_description,
    status: JSON.parse(row.status),
    createdAt: fromIso(row.created_at),
  };
  if (row.branch) task.branch = row.branch;
  if (row.worktree_path) task.worktreePath = row.worktree_path;
  if (row.worktree_name) task.worktreeName = row.worktree_name;
  if (row.session_id) task.sessionId = row.session_id;
  if (row.ticket_id) task.ticketId = row.ticket_id as TicketId;
  if (row.last_urls) task.lastUrls = JSON.parse(row.last_urls);
  return task;
}

// ---- Model → Row conversions ----

export function projectToRow(p: Project): ProjectRow {
  const now = toIso(Date.now());
  return {
    id: p.id,
    label: p.label,
    slug: p.slug,
    workspace_dir: null,
    is_personal: p.isPersonal ? 1 : 0,
    auto_dispatch: p.autoDispatch ? 1 : 0,
    source: jsonStrOrNull(p.source),
    sandbox: jsonStrOrNull(p.sandbox),
    created_at: toIso(p.createdAt),
    updated_at: now,
  };
}

export function columnToRow(col: Column, projectId: string, sortOrder: number): ColumnRow {
  return {
    id: col.id,
    project_id: projectId,
    label: col.label,
    description: col.description ?? null,
    sort_order: sortOrder,
    gate: col.gate ? 1 : 0,
  };
}

export function ticketToRow(t: Ticket): TicketRow {
  return {
    id: t.id,
    project_id: t.projectId,
    milestone_id: t.milestoneId ?? null,
    column_id: t.columnId,
    title: t.title,
    description: t.description,
    priority: t.priority,
    branch: t.branch ?? null,
    blocked_by: JSON.stringify(t.blockedBy ?? []),
    shaping: jsonStrOrNull(t.shaping),
    resolution: t.resolution ?? null,
    resolved_at: isoOrNull(t.resolvedAt),
    archived_at: isoOrNull(t.archivedAt),
    column_changed_at: isoOrNull(t.columnChangedAt),
    use_worktree: t.useWorktree ? 1 : 0,
    worktree_path: t.worktreePath ?? null,
    worktree_name: t.worktreeName ?? null,
    // Column kept for backwards compatibility with older rows; not written.
    supervisor_session_id: null,
    phase: (t.phase as string) ?? null,
    phase_changed_at: isoOrNull(t.phaseChangedAt),
    supervisor_task_id: (t.supervisorTaskId as string) ?? null,
    token_usage: jsonStrOrNull(t.tokenUsage),
    runs: JSON.stringify(t.runs ?? []),
    created_at: toIso(t.createdAt),
    updated_at: toIso(t.updatedAt),
  };
}

export function commentToRow(c: TicketComment, ticketId: string): CommentRow {
  return {
    id: c.id,
    ticket_id: ticketId,
    author: c.author,
    content: c.content,
    created_at: toIso(c.createdAt),
  };
}

export function milestoneToRow(m: Milestone): MilestoneRow {
  return {
    id: m.id,
    project_id: m.projectId,
    title: m.title,
    description: m.description,
    branch: m.branch ?? null,
    brief: m.brief ?? null,
    status: m.status,
    due_date: isoOrNull(m.dueDate),
    completed_at: isoOrNull(m.completedAt),
    created_at: toIso(m.createdAt),
    updated_at: toIso(m.updatedAt),
  };
}

export function pageToRow(p: Page): PageRow {
  return {
    id: p.id,
    project_id: p.projectId,
    parent_id: p.parentId,
    title: p.title,
    icon: p.icon ?? null,
    sort_order: p.sortOrder,
    is_root: p.isRoot ? 1 : 0,
    kind: p.kind ?? 'doc',
    properties: jsonStrOrNull(p.properties),
    created_at: toIso(p.createdAt),
    updated_at: toIso(p.updatedAt),
  };
}

export function inboxItemToRow(i: InboxItem): InboxRow {
  return {
    id: i.id,
    title: i.title,
    note: i.note ?? null,
    project_id: i.projectId ?? null,
    status: i.status,
    shaping: jsonStrOrNull(i.shaping),
    later_at: isoOrNull(i.laterAt),
    promoted_to: jsonStrOrNull(i.promotedTo),
    created_at: toIso(i.createdAt),
    updated_at: toIso(i.updatedAt),
  };
}

export function taskToRow(t: Task): TaskRow {
  return {
    id: t.id,
    project_id: t.projectId,
    task_description: t.taskDescription,
    status: JSON.stringify(t.status),
    created_at: toIso(t.createdAt),
    branch: t.branch ?? null,
    worktree_path: t.worktreePath ?? null,
    worktree_name: t.worktreeName ?? null,
    session_id: t.sessionId ?? null,
    ticket_id: t.ticketId ?? null,
    last_urls: jsonStrOrNull(t.lastUrls),
  };
}

// ---- Store snapshot builder ----

/** Keys served from SQLite (not the host store) when the repo is active. */
export const PROJECT_KEYS: ReadonlySet<keyof StoreData> = new Set<keyof StoreData>([
  'projects',
  'tickets',
  'milestones',
  'pages',
  'inboxItems',
  'tasks',
]);

/** Minimal store shape needed to assemble a snapshot — satisfied by both
 * electron-store and ServerStore. */
type StoreLike = { store: StoreData };

/**
 * Build a full `StoreData` object by merging project data from SQLite
 * with non-project data from the host store (electron-store or ServerStore).
 * This is what gets broadcast to the renderer via `store:changed`.
 */
export function buildStoreSnapshot(
  repo: ProjectsRepo,
  hostStore: StoreLike
): StoreData {
  // Read all project data from SQLite and convert to launcher models
  const projects = repo.listProjects().map(rowToProject);
  const tickets = repo.listAllTickets().map((row) => {
    const comments = repo.listCommentsByTicket(row.id);
    return rowToTicket(row, comments);
  });

  // Attach pipeline data to projects that don't have an explicit pipeline.
  // In the old electron-store model, pipeline was an inline field on Project.
  // In SQLite, it's a separate table. We need to reconstruct it.
  for (const project of projects) {
    const columns = repo.listColumns(project.id);
    if (columns.length > 0) {
      project.pipeline = rowsToPipeline(columns);
    }
  }

  return {
    // Non-project data from host store (settings, UI state, credentials)
    ...hostStore.store,
    // Project data from SQLite (overrides any stale host-store keys)
    projects,
    tickets,
    milestones: repo.listAllMilestones().map(rowToMilestone),
    pages: repo.listAllPages().map(rowToPage),
    inboxItems: repo.listAllInboxItems().map(rowToInboxItem),
    tasks: repo.listAllTasks().map(rowToTask),
  };
}
