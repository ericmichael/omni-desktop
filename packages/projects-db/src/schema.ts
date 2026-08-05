export type Migration = { version: number; sql: string };

export const migrations: Migration[] = [
  {
    version: 1,
    sql: `
-- Projects
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  workspace_dir TEXT,
  is_personal   INTEGER NOT NULL DEFAULT 0,
  auto_dispatch INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Pipeline columns (ordered per project)
CREATE TABLE pipeline_columns (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  description TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  gate        INTEGER NOT NULL DEFAULT 0,
  UNIQUE(project_id, label)
);
CREATE INDEX idx_pipeline_columns_project ON pipeline_columns(project_id, sort_order);

-- Milestones
CREATE TABLE milestones (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  branch       TEXT,
  brief        TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','archived')),
  due_date     TEXT,
  completed_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_milestones_project ON milestones(project_id);

-- Tickets
CREATE TABLE tickets (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id    TEXT REFERENCES milestones(id) ON DELETE SET NULL,
  column_id       TEXT NOT NULL REFERENCES pipeline_columns(id),
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  priority        TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
  branch          TEXT,
  blocked_by      TEXT NOT NULL DEFAULT '[]',
  shaping         TEXT,
  resolution      TEXT CHECK(resolution IN ('completed','wont_do','duplicate','cancelled')),
  resolved_at     TEXT,
  archived_at     TEXT,
  column_changed_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_tickets_project ON tickets(project_id);
CREATE INDEX idx_tickets_column ON tickets(column_id);
CREATE INDEX idx_tickets_milestone ON tickets(milestone_id);

-- Ticket comments
CREATE TABLE ticket_comments (
  id         TEXT PRIMARY KEY,
  ticket_id  TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author     TEXT NOT NULL DEFAULT 'human' CHECK(author IN ('agent','human')),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_comments_ticket ON ticket_comments(ticket_id, created_at);

-- Pages (metadata; content on disk as .md files)
CREATE TABLE pages (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id   TEXT REFERENCES pages(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  icon        TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_root     INTEGER NOT NULL DEFAULT 0,
  kind        TEXT NOT NULL DEFAULT 'doc' CHECK(kind IN ('doc','notebook')),
  properties  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_pages_project ON pages(project_id);
CREATE INDEX idx_pages_parent ON pages(parent_id);

-- Inbox items
CREATE TABLE inbox_items (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  note        TEXT,
  project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','shaped','later')),
  shaping     TEXT,
  later_at    TEXT,
  promoted_to TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_inbox_status ON inbox_items(status);
`,
  },
  {
    version: 2,
    sql: `
-- Launcher-specific ticket fields (supervisor/worktree state)
ALTER TABLE tickets ADD COLUMN use_worktree INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tickets ADD COLUMN worktree_path TEXT;
ALTER TABLE tickets ADD COLUMN worktree_name TEXT;
ALTER TABLE tickets ADD COLUMN supervisor_session_id TEXT;
ALTER TABLE tickets ADD COLUMN phase TEXT;
ALTER TABLE tickets ADD COLUMN phase_changed_at TEXT;
ALTER TABLE tickets ADD COLUMN supervisor_task_id TEXT;
ALTER TABLE tickets ADD COLUMN token_usage TEXT;
ALTER TABLE tickets ADD COLUMN runs TEXT NOT NULL DEFAULT '[]';

-- Launcher-specific project fields
ALTER TABLE projects ADD COLUMN source TEXT;
ALTER TABLE projects ADD COLUMN sandbox TEXT;

-- Tasks table (supervisor state, not MCP-exposed)
CREATE TABLE tasks (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_description TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT '{}',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  branch           TEXT,
  worktree_path    TEXT,
  worktree_name    TEXT,
  session_id       TEXT,
  ticket_id        TEXT REFERENCES tickets(id) ON DELETE SET NULL,
  last_urls        TEXT
);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_ticket ON tasks(ticket_id);

-- Cross-process change tracking
CREATE TABLE _change_seq (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  seq        INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO _change_seq (id, seq) VALUES (1, 0);
`,
  },
  {
    version: 3,
    sql: `
-- Per-project agent runtime configuration (manifest, capabilities, runtime,
-- mcp_servers, snapshot, run_as). Stored as JSON-stringified ProjectConfig.
-- Nullable: rows from before v3 get backfilled on next boot. See
-- src/lib/project-to-config.ts for the canonical shape and src/main/index.ts
-- for the backfill routine.
ALTER TABLE projects ADD COLUMN config TEXT;
`,
  },
  {
    version: 4,
    sql: `
-- Pin state + project deadline. Both pin columns are timestamps (epoch ms,
-- stringified) — set = pinned to Home, NULL = not pinned. due_date on
-- projects mirrors the existing milestones.due_date column.
ALTER TABLE projects ADD COLUMN due_date TEXT;
ALTER TABLE projects ADD COLUMN pinned_at TEXT;
ALTER TABLE milestones ADD COLUMN pinned_at TEXT;
`,
  },
  {
    version: 5,
    sql: `
-- v22 launcher cut: per-project sandbox config is no longer an inline
-- image/dockerfile JSON blob; it's a profile name that points at a YAML
-- profile under <config>/sandbox/<name>.yml. Drop the legacy column
-- (always NULL after the launcher's electron-store migration to v22)
-- and add the new "sandbox_profile" column.
ALTER TABLE projects DROP COLUMN sandbox;
ALTER TABLE projects ADD COLUMN sandbox_profile TEXT;
`,
  },
  {
    version: 6,
    sql: `
-- PR state on tickets. Used by the per-source PR UI flow:
--   pr_review:    JSON array of linked pull requests (Ticket.pullRequests).
--   pr_merged_at: JSON map of source id -> epoch ms (Ticket.prMergedAt).
-- Pre-existing rows get NULL; the Ticket model already treats both fields as
-- optional so no backfill is needed.
ALTER TABLE tickets ADD COLUMN pr_review TEXT;
ALTER TABLE tickets ADD COLUMN pr_merged_at TEXT;
`,
  },
  {
    version: 7,
    sql: `
-- Multi-source projects. A project now owns 0..N sources (repos/dirs)
-- instead of exactly 0..1. The container exposes each under
-- /workspace/<mountName>. Ticket PR state becomes a JSON map keyed by
-- ProjectSource.id so reviews/merges are tracked per source.
--
-- Migration of existing rows (pure SQL via SQLite's json1):
--   projects.sources: wrap the old single source as a 1-element array
--     after injecting auto-generated id + mountName (slug-derived).
--     Rows with source IS NULL get an empty array.
--   tickets.pr_review / pr_merged_at: the old scalar shape and the new
--     map shape are incompatible. Clear the columns rather than try to
--     migrate (no production state has these populated yet).
ALTER TABLE projects ADD COLUMN sources TEXT NOT NULL DEFAULT '[]';

UPDATE projects
SET sources = json_array(
  json_patch(
    source,
    json_object(
      'id', lower(hex(randomblob(8))),
      'mountName', slug
    )
  )
)
WHERE source IS NOT NULL;

ALTER TABLE projects DROP COLUMN source;

UPDATE tickets SET pr_review = NULL, pr_merged_at = NULL;
`,
  },
  {
    version: 8,
    sql: `
-- Page content moves from disk files into the DB (one model across SQLite +
-- Postgres; no per-replica filesystem). Markdown docs live here as the source
-- of truth; notebook (.py) bodies stay on disk (marimo executes them).
-- Existing on-disk doc content is migrated lazily on first read.
CREATE TABLE page_content (
  page_id    TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  body       TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`,
  },
  {
    version: 9,
    sql: `
-- Ticket assignee (principal id). Per-user WIP/review need "whose ticket is this".
-- Nullable; single-user (Electron/local) installs leave it NULL.
ALTER TABLE tickets ADD COLUMN assignee TEXT;
`,
  },
  {
    // Version 10 was previously used by a WIP iteration of this branch, so DBs
    // that ran that build already recorded version 10. The column-adding SQL
    // below ships as version 11 to guarantee it runs on those DBs too.
    version: 11,
    sql: `
-- DB-backed workflow metadata for pipeline columns. Existing columns keep
-- working; runtime mapping supplies safe defaults when these are NULL.
ALTER TABLE pipeline_columns ADD COLUMN max_concurrent INTEGER;
ALTER TABLE pipeline_columns ADD COLUMN workflow TEXT;
`,
  },
  {
    version: 12,
    sql: `
-- Remove the shaping system. Structured shaping blocks fold into the
-- free-text channel (ticket description / inbox note) so the data survives;
-- the 'shaped' inbox status collapses to 'new' with a fresh capture
-- timestamp (so the expiry sweep doesn't instantly defer those items).
-- The v13 rebuild below tightens the CHECK constraint to new/later only.
UPDATE tickets
SET description = CASE WHEN description = '' THEN '' ELSE description || char(10) || char(10) END
  || '**Done when:** ' || TRIM(json_extract(shaping, '$.doneLooksLike'))
WHERE shaping IS NOT NULL
  AND COALESCE(TRIM(json_extract(shaping, '$.doneLooksLike')), '') <> '';

UPDATE tickets
SET description = CASE WHEN description = '' THEN '' ELSE description || char(10) || char(10) END
  || '**Out of scope:** ' || TRIM(json_extract(shaping, '$.outOfScope'))
WHERE shaping IS NOT NULL
  AND COALESCE(TRIM(json_extract(shaping, '$.outOfScope')), '') <> '';

UPDATE inbox_items
SET note = CASE WHEN note IS NULL OR note = '' THEN '' ELSE note || char(10) || char(10) END
  || '**Done when:** ' || TRIM(json_extract(shaping, '$.outcome'))
WHERE shaping IS NOT NULL
  AND COALESCE(TRIM(json_extract(shaping, '$.outcome')), '') <> '';

UPDATE inbox_items
SET note = CASE WHEN note IS NULL OR note = '' THEN '' ELSE note || char(10) || char(10) END
  || '**Out of scope:** ' || TRIM(json_extract(shaping, '$.notDoing'))
WHERE shaping IS NOT NULL
  AND COALESCE(TRIM(json_extract(shaping, '$.notDoing')), '') <> '';

UPDATE inbox_items
SET status = 'new',
    created_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
WHERE status = 'shaped';

ALTER TABLE tickets DROP COLUMN shaping;
ALTER TABLE inbox_items DROP COLUMN shaping;
`,
  },
  {
    version: 13,
    sql: `
-- Hard cutover to projects.sources as the only project source model.
-- Preserve old workspace_dir values once, then remove the column so runtime
-- code cannot keep treating it as a second source of truth.
UPDATE projects
SET sources = json_array(
  json_object(
    'kind', 'local',
    'id', lower(hex(randomblob(8))),
    'mountName', slug,
    'workspaceDir', workspace_dir
  )
)
WHERE workspace_dir IS NOT NULL
  AND workspace_dir <> ''
  AND (sources IS NULL OR sources = '[]' OR json_array_length(sources) = 0);

ALTER TABLE projects DROP COLUMN workspace_dir;
`,
  },
  {
    version: 14,
    sql: `
-- Tighten inbox status now that shaping is gone. Rebuild is required because
-- SQLite cannot alter CHECK constraints in place.
PRAGMA foreign_keys = OFF;

CREATE TABLE inbox_items_new (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  note        TEXT,
  project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','later')),
  later_at    TEXT,
  promoted_to TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO inbox_items_new (id, title, note, project_id, status, later_at, promoted_to, created_at, updated_at)
SELECT id, title, note, project_id, CASE WHEN status = 'later' THEN 'later' ELSE 'new' END, later_at, promoted_to, created_at, updated_at
FROM inbox_items;

DROP TABLE inbox_items;
ALTER TABLE inbox_items_new RENAME TO inbox_items;
CREATE INDEX idx_inbox_status ON inbox_items(status);

PRAGMA foreign_keys = ON;
`,
  },
  {
    version: 15,
    sql: `
-- Jira-style status category per pipeline column. The custom column graph
-- stays the agent's state machine; the category is the human-facing
-- universal state the global Work view groups by.
-- Backfill order matters: 'done' first so a single-column pipeline lands on
-- 'done' (preserving the old "last column = shipped" semantics), then 'todo'
-- for the first column of pipelines that still have a non-done head.
ALTER TABLE pipeline_columns ADD COLUMN category TEXT NOT NULL DEFAULT 'doing'
  CHECK(category IN ('todo','doing','done'));

UPDATE pipeline_columns SET category = 'done' WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY sort_order DESC, id DESC) AS rn
    FROM pipeline_columns
  ) WHERE rn = 1
);

UPDATE pipeline_columns SET category = 'todo' WHERE category <> 'done' AND id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY sort_order ASC, id ASC) AS rn
    FROM pipeline_columns
  ) WHERE rn = 1
);
`,
  },
  {
    version: 16,
    sql: `
-- Resident agents' durable data moves from launcher-store keys into the
-- shared world model (docs/residents-in-projects-db-plan.md). Runtime state
-- (cursors, budgets, morning-beat bookkeeping) stays manager-side.

-- Comment authorship graduates from the 'agent'/'human' enum to free
-- principal strings ('agent:<id>' for resident sessions). Rebuild is
-- required because SQLite cannot alter CHECK constraints in place (the
-- v14 inbox pattern).
PRAGMA foreign_keys = OFF;

CREATE TABLE ticket_comments_new (
  id         TEXT PRIMARY KEY,
  ticket_id  TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author     TEXT NOT NULL DEFAULT 'human',
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO ticket_comments_new (id, ticket_id, author, content, created_at)
SELECT id, ticket_id, author, content, created_at FROM ticket_comments;

DROP TABLE ticket_comments;
ALTER TABLE ticket_comments_new RENAME TO ticket_comments;
CREATE INDEX idx_comments_ticket ON ticket_comments(ticket_id, created_at);

PRAGMA foreign_keys = ON;

CREATE TABLE resident_agents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL,
  persona_text  TEXT NOT NULL,
  profile_name  TEXT,
  project_ids   TEXT NOT NULL DEFAULT '[]',
  morning_hour  INTEGER,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE resident_memories (
  agent_id TEXT NOT NULL REFERENCES resident_agents(id) ON DELETE CASCADE,
  key      TEXT NOT NULL,
  text     TEXT NOT NULL,
  at       TEXT NOT NULL,
  PRIMARY KEY (agent_id, key)
);

CREATE TABLE resident_channels (
  id          TEXT PRIMARY KEY,
  description TEXT,
  members     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE resident_messages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  channel   TEXT NOT NULL,
  from_id   TEXT NOT NULL,
  from_name TEXT,
  text      TEXT NOT NULL,
  at        TEXT NOT NULL,
  reply_to  INTEGER
);
CREATE INDEX idx_resident_messages_channel ON resident_messages(channel, id);

CREATE TABLE resident_alarms (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT NOT NULL REFERENCES resident_agents(id) ON DELETE CASCADE,
  at         TEXT NOT NULL,
  note       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_resident_alarms_agent ON resident_alarms(agent_id);
`,
  },
  {
    version: 17,
    sql: `
-- Team handbook: ONE shared rules document for the resident roster
-- (GitLab handbook-first, structurally enforced — the body renders into
-- every agent's identity instructions on every wake). Single row; the
-- launcher UI and the update_handbook MCP tool are the two writers.
CREATE TABLE team_handbook (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  body       TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
`,
  },
  {
    version: 18,
    sql: `
-- Workspace-superuser residents: a flagged agent's watcher declares the
-- workspace/column client tools (list_workspace, column_send, app_* …),
-- fulfilled by the launcher renderer. 0|1 flag, default off.
ALTER TABLE resident_agents ADD COLUMN superuser INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 19,
    sql: `
-- Completion is the ticket's Done-category pipeline state. Retire the
-- Jira-style resolution field so status and presentation cannot diverge.
-- Legacy completed tickets move to the project's Done column; the other
-- retired close outcomes become archived tasks.
UPDATE tickets
SET archived_at = COALESCE(archived_at, resolved_at, updated_at),
    resolved_at = NULL
WHERE resolution IN ('wont_do', 'duplicate', 'cancelled');

UPDATE tickets
SET column_id = (
      SELECT id FROM pipeline_columns
      WHERE project_id = tickets.project_id AND category = 'done'
      ORDER BY sort_order DESC, id DESC LIMIT 1
    ),
    column_changed_at = COALESCE(resolved_at, updated_at)
WHERE resolution = 'completed'
  AND EXISTS (
    SELECT 1 FROM pipeline_columns
    WHERE project_id = tickets.project_id AND category = 'done'
  );

UPDATE tickets
SET resolved_at = COALESCE(resolved_at, column_changed_at, updated_at)
WHERE resolution IN ('completed') OR (
  resolution IS NULL
  AND column_id IN (SELECT id FROM pipeline_columns WHERE category = 'done')
);

ALTER TABLE tickets RENAME COLUMN resolved_at TO completed_at;
ALTER TABLE tickets DROP COLUMN resolution;
`,
  },
];
