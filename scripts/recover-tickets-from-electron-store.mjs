#!/usr/bin/env node
/**
 * One-shot recovery: re-insert tickets / milestones / pages / inbox items /
 * tasks from the launcher's electron-store config.json into the current
 * SQLite DB. Required because `migrateFromJson` skips when `projects` is
 * already populated — leaving a split where projects live in SQLite but
 * the rest of the data stayed in electron-store JSON and never reached
 * the DB.
 *
 * Safe to run multiple times:
 *   - Uses INSERT ... ON CONFLICT(id) DO NOTHING so existing rows are
 *     untouched.
 *   - FKs are validated; rows whose parent projectId is missing are
 *     reported and skipped.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.config', 'omni_code');
const DB_PATH = join(CONFIG_DIR, 'projects.db');
const STORE_PATH = join(homedir(), '.config', 'Omni Code', 'config.json');

const toIso = (ms) => new Date(ms ?? Date.now()).toISOString().replace('T', ' ').replace('Z', '');
const jsonStr = (v) => (v == null ? null : JSON.stringify(v));

const store = JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');

const projectIds = new Set(db.prepare('SELECT id FROM projects').all().map((r) => r.id));

const inserted = { tickets: 0, comments: 0, milestones: 0, pages: 0, inbox_items: 0, tasks: 0 };
const skipped = { tickets: 0, milestones: 0, pages: 0, tasks: 0 };

db.exec('BEGIN');
try {
  // Milestones (before tickets — tickets reference them)
  const upsertMilestone = db.prepare(
    `INSERT OR IGNORE INTO milestones (id, project_id, title, description, branch, brief, status, due_date, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const m of store.milestones ?? []) {
    if (!projectIds.has(m.projectId)) {
      skipped.milestones++;
      continue;
    }
    const res = upsertMilestone.run(
      m.id, m.projectId, m.title, m.description, m.branch ?? null, m.brief ?? null,
      m.status, m.dueDate ? toIso(m.dueDate) : null, m.completedAt ? toIso(m.completedAt) : null,
      toIso(m.createdAt), toIso(m.updatedAt)
    );
    if (res.changes > 0) inserted.milestones++;
  }

  // Tickets
  const upsertTicket = db.prepare(
    `INSERT OR IGNORE INTO tickets (
       id, project_id, milestone_id, column_id, title, description, priority, branch,
       blocked_by, shaping, resolution, resolved_at, archived_at, column_changed_at,
       use_worktree, worktree_path, worktree_name, supervisor_session_id, phase,
       phase_changed_at, supervisor_task_id, token_usage, runs, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const upsertComment = db.prepare(
    `INSERT OR IGNORE INTO ticket_comments (id, ticket_id, author, content, created_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  // Pre-build a column lookup keyed by `${projectId}:${logicalId}` so we
  // can remap electron-store's project-local column ids (e.g. "backlog")
  // to SQLite's globally-unique ids (e.g. "<projectId>__backlog").
  const allCols = db.prepare('SELECT id, project_id FROM pipeline_columns').all();
  const colMap = new Map();
  for (const c of allCols) {
    const logical = c.id.includes('__') ? c.id.split('__').slice(-1)[0] : c.id;
    colMap.set(`${c.project_id}:${logical}`, c.id);
  }
  for (const t of store.tickets ?? []) {
    if (!projectIds.has(t.projectId)) {
      skipped.tickets++;
      continue;
    }
    const resolvedColumnId = colMap.get(`${t.projectId}:${t.columnId}`) ?? t.columnId;
    const res = upsertTicket.run(
      t.id, t.projectId, t.milestoneId ?? null, resolvedColumnId,
      t.title, t.description, t.priority, t.branch ?? null,
      JSON.stringify(t.blockedBy ?? []), jsonStr(t.shaping),
      t.resolution ?? null, t.resolvedAt ? toIso(t.resolvedAt) : null,
      t.archivedAt ? toIso(t.archivedAt) : null,
      t.columnChangedAt ? toIso(t.columnChangedAt) : null,
      t.useWorktree ? 1 : 0, t.worktreePath ?? null, t.worktreeName ?? null,
      t.supervisorSessionId ?? null, t.phase ?? null,
      t.phaseChangedAt ? toIso(t.phaseChangedAt) : null,
      t.supervisorTaskId ?? null, jsonStr(t.tokenUsage),
      JSON.stringify(t.runs ?? []),
      toIso(t.createdAt), toIso(t.updatedAt)
    );
    if (res.changes > 0) inserted.tickets++;
    for (const c of t.comments ?? []) {
      const cres = upsertComment.run(
        c.id || `cmt_${t.id}_${c.createdAt}`,
        t.id, c.author, c.content, toIso(c.createdAt)
      );
      if (cres.changes > 0) inserted.comments++;
    }
  }

  // Pages
  const upsertPage = db.prepare(
    `INSERT OR IGNORE INTO pages (
       id, project_id, parent_id, title, icon, sort_order, is_root, kind,
       properties, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const p of store.pages ?? []) {
    if (!projectIds.has(p.projectId)) {
      skipped.pages++;
      continue;
    }
    const res = upsertPage.run(
      p.id, p.projectId, p.parentId ?? null, p.title, p.icon ?? null,
      p.sortOrder, p.isRoot ? 1 : 0, p.kind ?? 'doc',
      jsonStr(p.properties), toIso(p.createdAt), toIso(p.updatedAt)
    );
    if (res.changes > 0) inserted.pages++;
  }

  // Inbox
  const upsertInbox = db.prepare(
    `INSERT OR IGNORE INTO inbox_items (
       id, title, note, project_id, status, shaping, later_at, promoted_to,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const item of store.inboxItems ?? []) {
    const res = upsertInbox.run(
      item.id, item.title, item.note ?? null, item.projectId ?? null,
      item.status, jsonStr(item.shaping),
      item.laterAt ? toIso(item.laterAt) : null,
      jsonStr(item.promotedTo),
      toIso(item.createdAt), toIso(item.updatedAt)
    );
    if (res.changes > 0) inserted.inbox_items++;
  }

  // Tasks
  const upsertTask = db.prepare(
    `INSERT OR IGNORE INTO tasks (
       id, project_id, task_description, status, created_at, branch,
       worktree_path, worktree_name, session_id, ticket_id, last_urls
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const t of store.tasks ?? []) {
    if (!projectIds.has(t.projectId)) {
      skipped.tasks++;
      continue;
    }
    const res = upsertTask.run(
      t.id, t.projectId, t.taskDescription ?? '', jsonStr(t.status) ?? '{}',
      toIso(t.createdAt), t.branch ?? null,
      t.worktreePath ?? null, t.worktreeName ?? null, t.sessionId ?? null,
      t.ticketId ?? null, jsonStr(t.lastUrls)
    );
    if (res.changes > 0) inserted.tasks++;
  }

  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  console.error('Recovery failed; transaction rolled back:', err);
  process.exit(1);
}

console.log('Inserted:', inserted);
console.log('Skipped (FK violations):', skipped);

const counts = db.prepare(
  `SELECT 'projects' AS table_name, COUNT(*) AS n FROM projects
   UNION ALL SELECT 'tickets', COUNT(*) FROM tickets
   UNION ALL SELECT 'pages', COUNT(*) FROM pages
   UNION ALL SELECT 'milestones', COUNT(*) FROM milestones
   UNION ALL SELECT 'inbox_items', COUNT(*) FROM inbox_items
   UNION ALL SELECT 'tasks', COUNT(*) FROM tasks
   UNION ALL SELECT 'ticket_comments', COUNT(*) FROM ticket_comments`
).all();
console.log('\nPost-recovery counts:');
for (const row of counts) {
  console.log(`  ${row.table_name}: ${row.n}`);
}
db.close();
