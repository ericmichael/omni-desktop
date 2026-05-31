/**
 * Postgres schema for multi-tenant server mode.
 *
 * This is the cloud counterpart to the SQLite `schema.ts`. Rather than replay
 * the SQLite migration history, it creates the FINAL table shape directly,
 * then adds the two things SQLite doesn't have:
 *
 *   1. A denormalized `tenant_id TEXT NOT NULL` on every table.
 *   2. Row-level security: each table is `ENABLE`d + `FORCE`d (so even the
 *      table owner is subject to it) with a policy that scopes every read and
 *      write to `current_setting('app.current_tenant')`. `PgProjectsRepo`
 *      sets that per transaction, so a forgotten predicate physically cannot
 *      cross tenants.
 *
 * Column types mirror the SQLite `*Row` shapes exactly (TEXT for ids /
 * timestamps / JSON, INTEGER for 0|1 flags) so `db-store-bridge` and the row
 * types are reused unchanged. Timestamp defaults match `toIso`'s
 * "YYYY-MM-DD HH:MM:SS.sss" format.
 */
export type PgMigration = { version: number; sql: string };

const TS_DEFAULT = `to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS.MS')`;

const TENANT_TABLES = [
  'projects',
  'pipeline_columns',
  'milestones',
  'tickets',
  'ticket_comments',
  'pages',
  'inbox_items',
  'tasks',
];

const rls = (table: string): string => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ${table}
  USING (tenant_id = current_setting('app.current_tenant', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true));`;

export const pgMigrations: PgMigration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE projects (
  tenant_id     TEXT NOT NULL,
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  slug          TEXT NOT NULL,
  workspace_dir TEXT,
  is_personal   INTEGER NOT NULL DEFAULT 0,
  auto_dispatch INTEGER NOT NULL DEFAULT 0,
  sources       TEXT NOT NULL DEFAULT '[]',
  sandbox_profile TEXT,
  config        TEXT,
  due_date      TEXT,
  pinned_at     TEXT,
  created_at    TEXT NOT NULL DEFAULT ${TS_DEFAULT},
  updated_at    TEXT NOT NULL DEFAULT ${TS_DEFAULT},
  UNIQUE (tenant_id, slug)
);
CREATE INDEX idx_projects_tenant ON projects(tenant_id);

CREATE TABLE pipeline_columns (
  tenant_id   TEXT NOT NULL,
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  description TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  gate        INTEGER NOT NULL DEFAULT 0,
  UNIQUE (project_id, label)
);
CREATE INDEX idx_pipeline_columns_project ON pipeline_columns(project_id, sort_order);
CREATE INDEX idx_pipeline_columns_tenant ON pipeline_columns(tenant_id);

CREATE TABLE milestones (
  tenant_id    TEXT NOT NULL,
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  branch       TEXT,
  brief        TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','archived')),
  due_date     TEXT,
  completed_at TEXT,
  pinned_at    TEXT,
  created_at   TEXT NOT NULL DEFAULT ${TS_DEFAULT},
  updated_at   TEXT NOT NULL DEFAULT ${TS_DEFAULT}
);
CREATE INDEX idx_milestones_project ON milestones(project_id);
CREATE INDEX idx_milestones_tenant ON milestones(tenant_id);

CREATE TABLE tickets (
  tenant_id         TEXT NOT NULL,
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id      TEXT REFERENCES milestones(id) ON DELETE SET NULL,
  column_id         TEXT NOT NULL REFERENCES pipeline_columns(id),
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  priority          TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
  branch            TEXT,
  blocked_by        TEXT NOT NULL DEFAULT '[]',
  shaping           TEXT,
  resolution        TEXT CHECK (resolution IN ('completed','wont_do','duplicate','cancelled')),
  resolved_at       TEXT,
  archived_at       TEXT,
  column_changed_at TEXT,
  use_worktree      INTEGER NOT NULL DEFAULT 0,
  worktree_path     TEXT,
  worktree_name     TEXT,
  supervisor_session_id TEXT,
  phase             TEXT,
  phase_changed_at  TEXT,
  supervisor_task_id TEXT,
  token_usage       TEXT,
  runs              TEXT NOT NULL DEFAULT '[]',
  pr_review         TEXT,
  pr_merged_at      TEXT,
  created_at        TEXT NOT NULL DEFAULT ${TS_DEFAULT},
  updated_at        TEXT NOT NULL DEFAULT ${TS_DEFAULT}
);
CREATE INDEX idx_tickets_project ON tickets(project_id);
CREATE INDEX idx_tickets_column ON tickets(column_id);
CREATE INDEX idx_tickets_milestone ON tickets(milestone_id);
CREATE INDEX idx_tickets_tenant ON tickets(tenant_id);

CREATE TABLE ticket_comments (
  tenant_id  TEXT NOT NULL,
  id         TEXT PRIMARY KEY,
  ticket_id  TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author     TEXT NOT NULL DEFAULT 'human' CHECK (author IN ('agent','human')),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${TS_DEFAULT}
);
CREATE INDEX idx_comments_ticket ON ticket_comments(ticket_id, created_at);
CREATE INDEX idx_comments_tenant ON ticket_comments(tenant_id);

CREATE TABLE pages (
  tenant_id   TEXT NOT NULL,
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id   TEXT REFERENCES pages(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  icon        TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_root     INTEGER NOT NULL DEFAULT 0,
  kind        TEXT NOT NULL DEFAULT 'doc' CHECK (kind IN ('doc','notebook')),
  properties  TEXT,
  created_at  TEXT NOT NULL DEFAULT ${TS_DEFAULT},
  updated_at  TEXT NOT NULL DEFAULT ${TS_DEFAULT}
);
CREATE INDEX idx_pages_project ON pages(project_id);
CREATE INDEX idx_pages_parent ON pages(parent_id);
CREATE INDEX idx_pages_tenant ON pages(tenant_id);

CREATE TABLE inbox_items (
  tenant_id   TEXT NOT NULL,
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  note        TEXT,
  project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','shaped','later')),
  shaping     TEXT,
  later_at    TEXT,
  promoted_to TEXT,
  created_at  TEXT NOT NULL DEFAULT ${TS_DEFAULT},
  updated_at  TEXT NOT NULL DEFAULT ${TS_DEFAULT}
);
CREATE INDEX idx_inbox_status ON inbox_items(status);
CREATE INDEX idx_inbox_tenant ON inbox_items(tenant_id);

CREATE TABLE tasks (
  tenant_id        TEXT NOT NULL,
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_description TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT '{}',
  created_at       TEXT NOT NULL DEFAULT ${TS_DEFAULT},
  branch           TEXT,
  worktree_path    TEXT,
  worktree_name    TEXT,
  session_id       TEXT,
  ticket_id        TEXT REFERENCES tickets(id) ON DELETE SET NULL,
  last_urls        TEXT
);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_ticket ON tasks(ticket_id);
CREATE INDEX idx_tasks_tenant ON tasks(tenant_id);

${TENANT_TABLES.map(rls).join('\n')}
`,
  },
  {
    version: 2,
    sql: `
-- Per-user settings (everything in StoreData that isn't project data): UI
-- prefs, code tabs, platform credentials, etc. One JSONB row per tenant,
-- RLS-isolated like the rest. The launcher's PgSettingsStore owns the shape.
CREATE TABLE user_settings (
  tenant_id  TEXT PRIMARY KEY,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TEXT NOT NULL DEFAULT ${TS_DEFAULT}
);
${rls('user_settings')}
`,
  },
  {
    version: 3,
    sql: `
-- Multi-replica cache coherence: every write notifies the 'omni_change'
-- channel with {t: tenant_id, o: origin}. \`origin\` is the writing replica's
-- id (set per-tx via app.current_origin); a replica ignores its own notifies
-- and re-hydrates only on foreign / MCP writes. Postgres collapses identical
-- payloads within a transaction, so a bulk write fires a single notify.
CREATE FUNCTION omni_notify_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'omni_change',
    json_build_object(
      't', COALESCE(NEW.tenant_id, OLD.tenant_id),
      'o', current_setting('app.current_origin', true)
    )::text
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

${[...TENANT_TABLES, 'user_settings']
  .map(
    (t) => `CREATE TRIGGER ${t}_notify AFTER INSERT OR UPDATE OR DELETE ON ${t}
  FOR EACH ROW EXECUTE FUNCTION omni_notify_change();`
  )
  .join('\n')}
`,
  },
  {
    version: 4,
    sql: `
-- Page content (markdown doc bodies) — DB source of truth, one model with
-- SQLite. Not in the change-notify trigger: content is read on demand, never
-- cached in the projection, so it needs no cross-replica re-hydrate.
CREATE TABLE page_content (
  tenant_id  TEXT NOT NULL,
  page_id    TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  body       TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ${TS_DEFAULT}
);
CREATE INDEX idx_page_content_tenant ON page_content(tenant_id);
${rls('page_content')}
`,
  },
  {
    version: 5,
    sql: `
-- Notify on page-content writes so an open editor on another replica (or the
-- agent's MCP) live-refreshes. Payload carries the page id (not the body —
-- NOTIFY is 8 KB-capped); the listener fetches the body and pushes
-- page:content-changed. The renderer drops echoes that match its buffer.
CREATE FUNCTION omni_notify_page_content() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'omni_change',
    json_build_object('t', COALESCE(NEW.tenant_id, OLD.tenant_id), 'p', COALESCE(NEW.page_id, OLD.page_id))::text
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER page_content_notify AFTER INSERT OR UPDATE OR DELETE ON page_content
  FOR EACH ROW EXECUTE FUNCTION omni_notify_page_content();
`,
  },
  {
    version: 6,
    sql: `
-- Ticket assignee (principal id). Per-user WIP/review need "whose ticket is this".
-- Nullable; mirrors the SQLite v9 column. RLS already scopes tickets by team.
ALTER TABLE tickets ADD COLUMN assignee TEXT;
`,
  },
  {
    version: 7,
    sql: `
-- Teams control plane. A deployment hosts many independent teams; a team is the
-- RLS tenant (app.current_tenant = team id) and owns projects. Users are
-- members with roles. Personal teams reuse the owner's principal id as the team
-- id (so existing project rows, already keyed tenant_id = principal, need no
-- rewrite when a solo user is migrated).
--
-- These tables are accessed by the launcher via the ADMIN pool (owner) with
-- app-level principal scoping, NOT the omni_app pool — membership must be read
-- before a team is selected, and an admin must write rows for teams the caller
-- isn't yet a member of (bootstrap/invite). RLS here is ENABLE (not FORCE) as
-- dormant defense-in-depth: the owner bypasses it, a stray omni_app access is
-- still isolated to the calling principal.
CREATE TABLE users (
  id           TEXT PRIMARY KEY,        -- EasyAuth principal id (or 'local')
  email        TEXT,
  display_name TEXT,
  idp          TEXT,
  created_at   TEXT NOT NULL DEFAULT ${TS_DEFAULT},
  updated_at   TEXT NOT NULL DEFAULT ${TS_DEFAULT}
);
CREATE TABLE teams (
  id          TEXT PRIMARY KEY,         -- personal team id == owning principal id
  label       TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'shared' CHECK (kind IN ('personal','shared')),
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT ${TS_DEFAULT},
  updated_at  TEXT NOT NULL DEFAULT ${TS_DEFAULT}
);
CREATE TABLE team_members (
  team_id  TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role     TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  added_at TEXT NOT NULL DEFAULT ${TS_DEFAULT},
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX idx_team_members_user ON team_members(user_id);
CREATE TABLE invitations (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  invited_by  TEXT NOT NULL,
  token       TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked')),
  created_at  TEXT NOT NULL DEFAULT ${TS_DEFAULT},
  accepted_at TEXT
);
CREATE INDEX idx_invitations_team ON invitations(team_id);
CREATE INDEX idx_invitations_email ON invitations(email);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY self ON users
  USING (id = current_setting('app.current_principal', true));
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
CREATE POLICY member ON teams
  USING (id IN (SELECT team_id FROM team_members WHERE user_id = current_setting('app.current_principal', true)));
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY self_membership ON team_members
  USING (user_id = current_setting('app.current_principal', true));
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY member ON invitations
  USING (team_id IN (SELECT team_id FROM team_members WHERE user_id = current_setting('app.current_principal', true)));
`,
  },
  {
    version: 8,
    sql: `
-- Settings split (see docs/teams-settings-merge.md):
--   team_settings   — admin-gated team base (models/mcp/env/network/skills/...).
--                     RLS-scoped by app.current_tenant (= team id), like project data.
--   user_settings_v2 — per-principal overlay + personal/UI state. RLS-scoped by
--                     app.current_principal. Per-(user,team) keys live under
--                     data->'byTeam'->team_id; global keys at the top level.
-- Both are on the omni_app pool with FORCE RLS — their key equals the GUC
-- directly, so writes pass WITH CHECK without any membership lookup.
CREATE TABLE team_settings (
  team_id    TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TEXT NOT NULL DEFAULT ${TS_DEFAULT}
);
ALTER TABLE team_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON team_settings
  USING (team_id = current_setting('app.current_tenant', true))
  WITH CHECK (team_id = current_setting('app.current_tenant', true));

CREATE TABLE user_settings_v2 (
  principal_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data         JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   TEXT NOT NULL DEFAULT ${TS_DEFAULT}
);
ALTER TABLE user_settings_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings_v2 FORCE ROW LEVEL SECURITY;
CREATE POLICY principal_isolation ON user_settings_v2
  USING (principal_id = current_setting('app.current_principal', true))
  WITH CHECK (principal_id = current_setting('app.current_principal', true));

-- Multi-replica notify: team_settings/user_settings_v2 lack the tenant_id
-- column the v3 trigger reads, so dedicated trigger fns. team change → {t};
-- user change → {u}. The listener maps these to a re-hydrate + targeted send.
CREATE FUNCTION omni_notify_team_settings() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('omni_change', json_build_object(
    't', COALESCE(NEW.team_id, OLD.team_id),
    'o', current_setting('app.current_origin', true))::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER team_settings_notify AFTER INSERT OR UPDATE OR DELETE ON team_settings
  FOR EACH ROW EXECUTE FUNCTION omni_notify_team_settings();

CREATE FUNCTION omni_notify_user_settings() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('omni_change', json_build_object(
    'u', COALESCE(NEW.principal_id, OLD.principal_id),
    'o', current_setting('app.current_origin', true))::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER user_settings_v2_notify AFTER INSERT OR UPDATE OR DELETE ON user_settings_v2
  FOR EACH ROW EXECUTE FUNCTION omni_notify_user_settings();
`,
  },
  {
    version: 9,
    sql: `
-- Secrets move into Postgres (durable + RLS-isolated), replacing the ephemeral
-- on-disk file store in cloud. Two scopes:
--   user_secrets  — per-principal (git/github tokens; follow the user, U-identity).
--   team_secrets  — per-team (shared model/MCP keys; admin-rotated, masked in UI).
-- Encrypted at rest with OMNI_SECRET_KEY (required in cloud). On the omni_app
-- pool with FORCE RLS, keyed directly on the GUCs.
CREATE TABLE user_secrets (
  principal_id TEXT NOT NULL,
  cred_id      TEXT NOT NULL,
  ciphertext   TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT ${TS_DEFAULT},
  PRIMARY KEY (principal_id, cred_id)
);
ALTER TABLE user_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY principal_isolation ON user_secrets
  USING (principal_id = current_setting('app.current_principal', true))
  WITH CHECK (principal_id = current_setting('app.current_principal', true));

CREATE TABLE team_secrets (
  team_id    TEXT NOT NULL,
  ref_name   TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT ${TS_DEFAULT},
  PRIMARY KEY (team_id, ref_name)
);
ALTER TABLE team_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON team_secrets
  USING (team_id = current_setting('app.current_tenant', true))
  WITH CHECK (team_id = current_setting('app.current_tenant', true));
`,
  },
  {
    version: 10,
    sql: `
-- Per-principal registry of Electron clients available as local compute hosts.
-- Each row is one user's laptop/desktop the cloud can dispatch sandbox
-- lifecycle to (computer-as-sandbox). principal_id references users(id) so it
-- is removed if the user is removed. Accessed via the ADMIN pool with
-- principal-scoping in application code (same model as the teams control
-- plane); RLS is dormant defense-in-depth.
CREATE TABLE machines (
  machine_id    TEXT PRIMARY KEY,
  principal_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  platform      TEXT NOT NULL,
  registered_at TEXT NOT NULL DEFAULT ${TS_DEFAULT},
  last_seen_at  TEXT NOT NULL DEFAULT ${TS_DEFAULT}
);
CREATE INDEX idx_machines_principal ON machines(principal_id);
ALTER TABLE machines ENABLE ROW LEVEL SECURITY;
CREATE POLICY principal_isolation ON machines
  USING (principal_id = current_setting('app.current_principal', true));
`,
  },
];
