// Connection & migrations
export { closeDatabase, openDatabase } from './connection.js';
export { runMigrations } from './migrate.js';
export { migrations } from './schema.js';
export type { Migration } from './schema.js';
export { tx } from './tx.js';

// Repository — sync SQLite core + async backend-agnostic contract/adapter
export { ProjectsRepo } from './repo.js';
export { SqliteProjectsRepo } from './sqlite-repo.js';
export type { ColumnSyncInput, ColumnSyncResult, IProjectsRepo, TicketRemap } from './repo-interface.js';

// Postgres backend (multi-tenant cloud). Importing these pulls in the `pg`
// driver, so consumers load them only when OMNI_DATABASE_URL is set.
export { PgProjectsRepo } from './pg/pg-repo.js';
export { createPgListener, createPgPool, runPgMigrations } from './pg/connection.js';
export {
  loadTenantSettings,
  saveTenantSettings,
  loadTeamSettings,
  saveTeamSettings,
  loadUserSettings,
  saveUserSettings,
  loadLegacyUserSettings,
} from './pg/settings.js';
export { ControlPlaneRepo } from './pg/control-plane.js';
export type {
  TeamRole,
  UserRow,
  TeamRow,
  TeamMembershipRow,
  TeamWithRole,
  InvitationRow,
} from './pg/control-plane.js';
export type { Pool as PgPool } from './pg/connection.js';
export { pgMigrations } from './pg/schema.js';
export type { PgMigration } from './pg/schema.js';

// Types
export type {
  ProjectRow,
  ColumnRow,
  TicketRow,
  CommentRow,
  MilestoneRow,
  PageRow,
  InboxRow,
  TaskRow,
} from './types.js';

// IDs
export {
  projectId,
  ticketId,
  milestoneId,
  pageId,
  inboxId,
  columnId,
  commentId,
  taskId,
} from './ids.js';

// Timestamps
export { toIso, fromIso, nowTimestamp } from './timestamps.js';

// Defaults
export {
  DEFAULT_COLUMNS,
  SIMPLE_COLUMNS,
  defaultColumnId,
  logicalColumnId,
} from './defaults.js';
export type { ColumnDef } from './defaults.js';

// Page filesystem
export {
  getPageDir,
  getPagePath,
  readPageContent,
  writePageContent,
  deletePageContent,
  deleteProjectPages,
} from './pages-fs.js';

// Markdown normalization
export { normalizeMarkdown } from './normalize-markdown.js';

// JSON migration
export { migrateFromJson } from './migrate-from-json.js';
export type { JsonStoreData } from './migrate-from-json.js';

// Path resolution (shared between launcher and MCP server)
export { getOmniConfigDir, getDefaultDbPath, getDefaultPagesDir } from './paths.js';
