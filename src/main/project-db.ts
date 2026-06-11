/**
 * Singleton SQLite database connection for project data.
 *
 * Both the launcher and the MCP server share the same `projects.db` file
 * via WAL mode. This module manages the connection lifecycle in the Electron
 * main process.
 */
import type { DatabaseSync } from 'node:sqlite';

import { closeDatabase, getDefaultDbPath, getDefaultPagesDir, openDatabase, ProjectsRepo, SqliteProjectsRepo } from 'omni-projects-db';
import type { IProjectsRepo } from 'omni-projects-db';

let _db: DatabaseSync | undefined;
let _repo: ProjectsRepo | undefined;
let _asyncRepo: SqliteProjectsRepo | undefined;

export { getDefaultDbPath, getDefaultPagesDir };

/**
 * Open the shared SQLite database. Runs migrations on first open.
 * Idempotent — returns the existing connection if already open.
 *
 * Returns two views of the same connection:
 *   - `repo`      — the synchronous {@link ProjectsRepo}, for SQLite-only paths
 *                   (db-change-watcher's `_change_seq` polling, the one-time
 *                   JSON migration, the MCP server).
 *   - `asyncRepo` — a {@link SqliteProjectsRepo} adapter satisfying the
 *                   backend-agnostic async {@link IProjectsRepo}. This is the
 *                   seam the data layer hydrates from; in cloud mode the same
 *                   consumers receive a `PgProjectsRepo` instead.
 */
export function openProjectDb(dbPath?: string): {
  db: DatabaseSync;
  repo: ProjectsRepo;
  asyncRepo: SqliteProjectsRepo;
} {
  if (_db && _repo && _asyncRepo) {
    return { db: _db, repo: _repo, asyncRepo: _asyncRepo };
  }
  _db = openDatabase(dbPath ?? getDefaultDbPath());
  _repo = new ProjectsRepo(_db);
  _asyncRepo = new SqliteProjectsRepo(_repo);
  return { db: _db, repo: _repo, asyncRepo: _asyncRepo };
}

/** Get the synchronous repo instance. Throws if the database hasn't been opened yet. */
export function getRepo(): ProjectsRepo {
  if (!_repo) {
    throw new Error('Project database not initialized. Call openProjectDb() first.');
  }
  return _repo;
}

/**
 * Get the async, backend-agnostic repo. Throws if the database hasn't been
 * opened yet. Returns `IProjectsRepo` so callers depend on the contract, not
 * the SQLite implementation.
 */
export function getAsyncRepo(): IProjectsRepo {
  if (!_asyncRepo) {
    throw new Error('Project database not initialized. Call openProjectDb() first.');
  }
  return _asyncRepo;
}

/** Get the raw database instance. Throws if not opened. */
export function getDb(): DatabaseSync {
  if (!_db) {
    throw new Error('Project database not initialized. Call openProjectDb() first.');
  }
  return _db;
}

/** Close the database connection. Safe to call multiple times. */
export function closeProjectDb(): void {
  if (_db) {
    closeDatabase(_db);
    _db = undefined;
    _repo = undefined;
    _asyncRepo = undefined;
  }
}
