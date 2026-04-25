import type { DatabaseSync } from 'node:sqlite';

import { commentId, columnId } from './ids.js';
import type { ProjectsRepo } from './repo.js';
import { toIso } from './timestamps.js';
import { tx } from './tx.js';

/**
 * Shape of project data as stored in the launcher's electron-store JSON.
 * These are loose types — we only need enough to read and transform.
 */
export interface JsonStoreData {
  projects?: JsonProject[];
  tickets?: JsonTicket[];
  milestones?: JsonMilestone[];
  pages?: JsonPage[];
  inboxItems?: JsonInboxItem[];
  tasks?: JsonTask[];
}

interface JsonProject {
  id: string;
  label: string;
  slug: string;
  isPersonal?: boolean;
  source?: unknown;
  createdAt: number;
  pipeline?: { columns: JsonColumn[] };
  autoDispatch?: boolean;
  sandbox?: unknown;
}

interface JsonColumn {
  id: string;
  label: string;
  description?: string;
  maxConcurrent?: number;
  gate?: boolean;
}

interface JsonTicket {
  id: string;
  projectId: string;
  milestoneId?: string;
  columnId: string;
  title: string;
  description: string;
  priority: string;
  branch?: string;
  blockedBy: string[];
  shaping?: { doneLooksLike: string; appetite: string; outOfScope: string };
  resolution?: string;
  resolvedAt?: number;
  archivedAt?: number;
  columnChangedAt?: number;
  useWorktree?: boolean;
  worktreePath?: string;
  worktreeName?: string;
  supervisorSessionId?: string;
  phase?: string;
  phaseChangedAt?: number;
  supervisorTaskId?: string;
  tokenUsage?: unknown;
  comments?: { id: string; author: string; content: string; createdAt: number }[];
  runs?: unknown[];
  createdAt: number;
  updatedAt: number;
}

interface JsonMilestone {
  id: string;
  projectId: string;
  title: string;
  description: string;
  branch?: string;
  brief?: string;
  status: string;
  dueDate?: number;
  completedAt?: number;
  createdAt: number;
  updatedAt: number;
}

interface JsonPage {
  id: string;
  projectId: string;
  parentId: string | null;
  title: string;
  icon?: string;
  sortOrder: number;
  isRoot?: boolean;
  kind?: string;
  properties?: unknown;
  createdAt: number;
  updatedAt: number;
}

interface JsonInboxItem {
  id: string;
  title: string;
  note?: string;
  projectId?: string | null;
  status: string;
  shaping?: unknown;
  laterAt?: number;
  promotedTo?: unknown;
  createdAt: number;
  updatedAt: number;
}

interface JsonTask {
  id: string;
  projectId: string;
  taskDescription: string;
  status: unknown;
  createdAt: number;
  branch?: string;
  worktreePath?: string;
  worktreeName?: string;
  sessionId?: string;
  ticketId?: string;
  lastUrls?: unknown;
}

const DEFAULT_COLUMNS: JsonColumn[] = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'spec', label: 'Spec' },
  { id: 'implementation', label: 'Implementation' },
  { id: 'review', label: 'Review', gate: true },
  { id: 'pr', label: 'PR' },
  { id: 'completed', label: 'Completed' },
];

function jsonStr(v: unknown): string | null {
  return v != null ? JSON.stringify(v) : null;
}

function isoOpt(epochMs: number | undefined): string | null {
  return epochMs != null ? toIso(epochMs) : null;
}

/**
 * Migrate data from an electron-store JSON blob into the SQLite database.
 * Runs in a single transaction. Idempotent — skips if projects table already has data.
 *
 * @returns Number of projects migrated, or 0 if skipped.
 */
export function migrateFromJson(repo: ProjectsRepo, db: DatabaseSync, data: JsonStoreData): number {
  // Idempotency: skip if DB already has projects
  const existing = repo.listProjects();
  if (existing.length > 0) return 0;

  const projects = data.projects ?? [];
  const tickets = data.tickets ?? [];
  const milestones = data.milestones ?? [];
  const pages = data.pages ?? [];
  const inboxItems = data.inboxItems ?? [];
  const tasks = data.tasks ?? [];

  // Track column ID remaps: oldId → newId. Column IDs in the launcher's
  // electron-store may collide across projects (e.g. every project has a
  // column called "backlog" with id "backlog"). Since pipeline_columns.id
  // is a global PRIMARY KEY, we generate fresh IDs for duplicates and remap
  // ticket.column_id references accordingly.
  const seenColumnIds = new Set<string>();
  const columnIdRemap = new Map<string, string>();

  tx(db, () => {
    // 1. Projects + pipeline columns
    for (const p of projects) {
      repo.upsertProject({
        id: p.id,
        label: p.label,
        slug: p.slug,
        workspace_dir: null,
        is_personal: p.isPersonal ? 1 : 0,
        auto_dispatch: p.autoDispatch ? 1 : 0,
        source: jsonStr(p.source),
        sandbox: jsonStr(p.sandbox),
        created_at: toIso(p.createdAt),
        updated_at: toIso(p.createdAt),
      });

      const columns = p.pipeline?.columns ?? DEFAULT_COLUMNS;
      for (let i = 0; i < columns.length; i++) {
        const col = columns[i]!;
        let id = col.id;
        if (seenColumnIds.has(id)) {
          // Collision: generate a fresh ID and record the remap
          // Key is scoped to (projectId, oldColumnId) so tickets can be remapped
          const newId = columnId();
          columnIdRemap.set(`${p.id}:${id}`, newId);
          id = newId;
        }
        seenColumnIds.add(id);
        repo.upsertColumn({
          id,
          project_id: p.id,
          label: col.label,
          description: col.description ?? null,
          sort_order: i,
          gate: col.gate ? 1 : 0,
        });
      }
    }

    // 2. Milestones (before tickets, since tickets reference them)
    for (const m of milestones) {
      repo.upsertMilestone({
        id: m.id,
        project_id: m.projectId,
        title: m.title,
        description: m.description,
        branch: m.branch ?? null,
        brief: m.brief ?? null,
        status: m.status,
        due_date: isoOpt(m.dueDate),
        completed_at: isoOpt(m.completedAt),
        created_at: toIso(m.createdAt),
        updated_at: toIso(m.updatedAt),
      });
    }

    // 3. Tickets + comments
    for (const t of tickets) {
      // Resolve column_id through remap if it was reassigned during column dedup
      const resolvedColumnId = columnIdRemap.get(`${t.projectId}:${t.columnId}`) ?? t.columnId;
      repo.upsertTicket({
        id: t.id,
        project_id: t.projectId,
        milestone_id: t.milestoneId ?? null,
        column_id: resolvedColumnId,
        title: t.title,
        description: t.description,
        priority: t.priority,
        branch: t.branch ?? null,
        blocked_by: JSON.stringify(t.blockedBy ?? []),
        shaping: jsonStr(t.shaping),
        resolution: t.resolution ?? null,
        resolved_at: isoOpt(t.resolvedAt),
        archived_at: isoOpt(t.archivedAt),
        column_changed_at: isoOpt(t.columnChangedAt),
        use_worktree: t.useWorktree ? 1 : 0,
        worktree_path: t.worktreePath ?? null,
        worktree_name: t.worktreeName ?? null,
        supervisor_session_id: t.supervisorSessionId ?? null,
        phase: t.phase ?? null,
        phase_changed_at: isoOpt(t.phaseChangedAt),
        supervisor_task_id: t.supervisorTaskId ?? null,
        token_usage: jsonStr(t.tokenUsage),
        runs: JSON.stringify(t.runs ?? []),
        created_at: toIso(t.createdAt),
        updated_at: toIso(t.updatedAt),
      });

      // Flatten inline comments into ticket_comments table
      for (const c of t.comments ?? []) {
        repo.upsertComment({
          id: c.id || commentId(),
          ticket_id: t.id,
          author: c.author,
          content: c.content,
          created_at: toIso(c.createdAt),
        });
      }
    }

    // 4. Pages
    for (const p of pages) {
      repo.upsertPage({
        id: p.id,
        project_id: p.projectId,
        parent_id: p.parentId,
        title: p.title,
        icon: p.icon ?? null,
        sort_order: p.sortOrder,
        is_root: p.isRoot ? 1 : 0,
        kind: p.kind ?? 'doc',
        properties: jsonStr(p.properties),
        created_at: toIso(p.createdAt),
        updated_at: toIso(p.updatedAt),
      });
    }

    // 5. Inbox items
    for (const item of inboxItems) {
      repo.upsertInboxItem({
        id: item.id,
        title: item.title,
        note: item.note ?? null,
        project_id: item.projectId ?? null,
        status: item.status,
        shaping: jsonStr(item.shaping),
        later_at: isoOpt(item.laterAt),
        promoted_to: jsonStr(item.promotedTo),
        created_at: toIso(item.createdAt),
        updated_at: toIso(item.updatedAt),
      });
    }

    // 6. Tasks
    for (const t of tasks) {
      repo.upsertTask({
        id: t.id,
        project_id: t.projectId,
        task_description: t.taskDescription,
        status: JSON.stringify(t.status ?? {}),
        created_at: toIso(t.createdAt),
        branch: t.branch ?? null,
        worktree_path: t.worktreePath ?? null,
        worktree_name: t.worktreeName ?? null,
        session_id: t.sessionId ?? null,
        ticket_id: t.ticketId ?? null,
        last_urls: jsonStr(t.lastUrls),
      });
    }
  });

  return projects.length;
}
