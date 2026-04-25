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
];
