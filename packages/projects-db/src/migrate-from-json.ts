import type { DatabaseSync } from 'node:sqlite';

import { DEFAULT_COLUMNS as SHARED_DEFAULT_COLUMNS, defaultColumnId } from './defaults.js';
import { commentId } from './ids.js';
import type { ProjectsRepo } from './repo.js';
import { nowTimestamp, toIso } from './timestamps.js';
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
  // Legacy electron-store rows had `source: ProjectSource | undefined`. The
  // current model is `sources: ProjectSource[]`. We accept either here and
  // normalize to an array in the migrator.
  source?: unknown;
  sources?: unknown[];
  createdAt: number;
  pipeline?: { columns: JsonColumn[] };
  autoDispatch?: boolean;
  dueDate?: number;
  pinnedAt?: number;
}

interface JsonColumn {
  id: string;
  label: string;
  description?: string;
  maxConcurrent?: number;
  gate?: boolean;
  workflow?: unknown;
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
  /** Legacy structured shaping (removed system) — folded into description on import. */
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
  // Multi-source migration: prReview/prMergedAt are now Record<sourceId, ...>.
  // The JSON migrator accepts both the legacy scalar shape and the new map
  // shape so we don't have to special-case the unmigrated electron-store dump.
  prReview?: { status: 'approved' | 'changes_requested'; at: number } | Record<string, { status: 'approved' | 'changes_requested'; at: number }>;
  prMergedAt?: number | Record<string, number>;
  assignee?: string;
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
  pinnedAt?: number;
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
  /** Legacy structured shaping (removed system) — folded into `note` on import. */
  shaping?: unknown;
  laterAt?: number;
  promotedTo?: unknown;
  createdAt: number;
  updatedAt: number;
}

/**
 * Fold a legacy shaping block into free text (the shaping system was
 * removed; description/note is the single channel). Returns '' when there
 * is nothing meaningful to carry.
 */
function foldLegacyShaping(raw: unknown, doneKey: string, scopeKey: string): string {
  if (!raw || typeof raw !== 'object') {
    return '';
  }
  const s = raw as Record<string, unknown>;
  const lines: string[] = [];
  const done = s[doneKey];
  const scope = s[scopeKey];
  if (typeof done === 'string' && done.trim()) {
    lines.push(`**Done when:** ${done.trim()}`);
  }
  if (typeof scope === 'string' && scope.trim()) {
    lines.push(`**Out of scope:** ${scope.trim()}`);
  }
  return lines.join('\n');
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

const DEFAULT_COLUMNS: JsonColumn[] = SHARED_DEFAULT_COLUMNS.map((c) => ({
  id: c.logicalId,
  label: c.label,
  ...(c.gate ? { gate: true } : {}),
}));

/**
 * Normalize a legacy JsonProject's source/sources fields into the current
 * ``ProjectSource[]`` shape.
 *
 * - If ``sources`` is already an array, use it as-is (each entry assumed
 *   to already have ``id`` + ``mountName`` from a later launcher run).
 * - Else if ``source`` is a populated object, wrap it as a single-element
 *   array, injecting a random ``id`` and using the project's slug as the
 *   default ``mountName``.
 * - Else (both absent), produce an empty array.
 */
function _legacyToSources(p: JsonProject): unknown[] {
  if (Array.isArray(p.sources)) return p.sources;
  if (p.source && typeof p.source === 'object') {
    const id = Math.random().toString(36).slice(2, 18);
    return [{ ...(p.source as object), id, mountName: p.slug }];
  }
  return [];
}

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
  if (existing.length > 0) {
return 0;
}

  const projects = data.projects ?? [];
  const tickets = data.tickets ?? [];
  const milestones = data.milestones ?? [];
  const pages = data.pages ?? [];
  const inboxItems = data.inboxItems ?? [];
  const tasks = data.tasks ?? [];

  // Column IDs in the launcher's electron-store collide across projects
  // (e.g. every project has a column called `backlog` with id `backlog`).
  // SQLite's `pipeline_columns.id` is a global PRIMARY KEY, so we rewrite
  // every column id as `${projectId}__${logicalId}` and remap the
  // referenced ticket.column_id accordingly.
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
        sources: JSON.stringify(_legacyToSources(p)),
        // v22 launcher cut: the legacy `sandbox: { image?, dockerfile? }`
        // shape is dead. Per-project sandbox profile selection lives in
        // ``sandboxProfile`` (string), which post-dates the JSON store —
        // electron-store rows never had it, so we always seed null.
        sandbox_profile: null,
        config: null,
        due_date: isoOpt(p.dueDate),
        pinned_at: isoOpt(p.pinnedAt),
        created_at: toIso(p.createdAt),
        updated_at: toIso(p.createdAt),
      });

      const columns = p.pipeline?.columns ?? DEFAULT_COLUMNS;
      for (let i = 0; i < columns.length; i++) {
        const col = columns[i]!;
        const newId = defaultColumnId(p.id, col.id);
        columnIdRemap.set(`${p.id}:${col.id}`, newId);
        repo.upsertColumn({
          id: newId,
          project_id: p.id,
          label: col.label,
          description: col.description ?? null,
          sort_order: i,
          gate: col.gate ? 1 : 0,
          max_concurrent: col.maxConcurrent ?? null,
          workflow: col.workflow == null ? null : JSON.stringify(col.workflow),
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
        pinned_at: isoOpt(m.pinnedAt),
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
        description: [t.description, foldLegacyShaping(t.shaping, 'doneLooksLike', 'outOfScope')]
          .filter(Boolean)
          .join('\n\n'),
        priority: t.priority,
        branch: t.branch ?? null,
        blocked_by: JSON.stringify(t.blockedBy ?? []),
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
        // pr_review and pr_merged_at are JSON columns in the v7+ schema
        // (Record<sourceId, ...>). Pass straight through — if the JSON
        // source has the legacy scalar shape it'll persist as malformed
        // and be ignored by the bridge converter, which is acceptable
        // since pre-multi-source rows have no source ids to key on.
        pr_review: t.prReview ? JSON.stringify(t.prReview) : null,
        pr_merged_at: t.prMergedAt !== undefined && t.prMergedAt !== null ? JSON.stringify(t.prMergedAt) : null,
        assignee: t.assignee ?? null,
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
      const foldedNote =
        [item.note ?? '', foldLegacyShaping(item.shaping, 'outcome', 'notDoing')].filter(Boolean).join('\n\n') ||
        null;
      const wasShaped = item.status === 'shaped';
      repo.upsertInboxItem({
        id: item.id,
        title: item.title,
        note: foldedNote,
        project_id: item.projectId ?? null,
        // 'shaped' collapsed to 'new' when the shaping system was removed; a
        // fresh capture timestamp keeps the expiry sweep from instantly
        // deferring those items.
        status: wasShaped ? 'new' : item.status,
        later_at: isoOpt(item.laterAt),
        promoted_to: jsonStr(item.promotedTo),
        created_at: wasShaped ? nowTimestamp() : toIso(item.createdAt),
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
