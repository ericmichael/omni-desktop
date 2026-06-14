// Connection & migrations
export { closeDatabase, openDatabase } from './connection.js';
export { runMigrations } from './migrate.js';
export type { Migration } from './schema.js';
export { migrations } from './schema.js';
export { tx } from './tx.js';

// Repository — sync SQLite core + async backend-agnostic contract/adapter
export { ProjectsRepo } from './repo.js';
export type { ColumnSyncInput, ColumnSyncResult, IProjectsRepo, TicketRemap } from './repo-interface.js';
export { SqliteProjectsRepo } from './sqlite-repo.js';

// Postgres backend (multi-tenant cloud). Importing these pulls in the `pg`
// driver, so consumers load them only when OMNI_DATABASE_URL is set.
export type { Pool as PgPool } from './pg/connection.js';
export { createPgListener, createPgPool, runPgMigrations } from './pg/connection.js';
export type { InvitationRow, TeamMembershipRow, TeamRole, TeamRow, TeamWithRole, UserRow } from './pg/control-plane.js';
export { ControlPlaneRepo } from './pg/control-plane.js';
export type { MachineRow } from './pg/machines.js';
export { MachinesRepo } from './pg/machines.js';
export { PgProjectsRepo } from './pg/pg-repo.js';
export type { PgMigration } from './pg/schema.js';
export { pgMigrations } from './pg/schema.js';
export {
  loadLegacyUserSettings,
  loadTeamSettings,
  loadTenantSettings,
  loadUserSettings,
  saveTeamSettings,
  saveTenantSettings,
  saveUserSettings,
} from './pg/settings.js';

// Types
export type {
  ColumnRow,
  CommentRow,
  InboxRow,
  MilestoneRow,
  PageRow,
  ProjectRow,
  TaskRow,
  TicketRow,
} from './types.js';

// IDs
export { columnId, commentId, inboxId, milestoneId, pageId, projectId, taskId, ticketId } from './ids.js';

// Timestamps
export { fromIso, nowTimestamp, toIso } from './timestamps.js';

// Defaults
export type { ColumnDef } from './defaults.js';
export { DEFAULT_COLUMNS, defaultColumnId, logicalColumnId, SIMPLE_COLUMNS } from './defaults.js';

// Page filesystem
export {
  deletePageContent,
  deleteProjectPages,
  getPageDir,
  getPagePath,
  readPageContent,
  writePageContent,
} from './pages-fs.js';

// Markdown normalization
export { normalizeMarkdown } from './normalize-markdown.js';

// JSON migration
export type { JsonStoreData } from './migrate-from-json.js';
export { migrateFromJson } from './migrate-from-json.js';

// Path resolution (shared between launcher and MCP server)
export { getDefaultDbPath, getDefaultPagesDir, getOmniConfigDir } from './paths.js';
