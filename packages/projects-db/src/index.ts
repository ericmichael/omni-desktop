// Connection & migrations
export { closeDatabase, openDatabase } from './connection.js';
export { runMigrations } from './migrate.js';
export { migrations } from './schema.js';
export type { Migration } from './schema.js';
export { tx } from './tx.js';

// Repository
export { ProjectsRepo } from './repo.js';
export type { ColumnSyncInput, ColumnSyncResult, TicketRemap } from './repo.js';

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
export { toIso, fromIso } from './timestamps.js';

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

// JSON migration
export { migrateFromJson } from './migrate-from-json.js';
export type { JsonStoreData } from './migrate-from-json.js';

// Path resolution (shared between launcher and MCP server)
export { getOmniConfigDir, getDefaultDbPath, getDefaultPagesDir } from './paths.js';
