/**
 * Singleton SQLite database connection for project data.
 *
 * Both the launcher and the MCP server share the same `projects.db` file
 * via WAL mode. This module manages the connection lifecycle in the Electron
 * main process.
 */
import type { DatabaseSync } from 'node:sqlite';

import { closeDatabase, getDefaultDbPath, getDefaultPagesDir, openDatabase, ProjectsRepo } from 'omni-projects-db';

let _db: DatabaseSync | undefined;
let _repo: ProjectsRepo | undefined;

export { getDefaultDbPath, getDefaultPagesDir };

/**
 * Open the shared SQLite database. Runs migrations on first open.
 * Idempotent — returns the existing connection if already open.
 */
export function openProjectDb(dbPath?: string): { db: DatabaseSync; repo: ProjectsRepo } {
  if (_db && _repo) {
    return { db: _db, repo: _repo };
  }
  _db = openDatabase(dbPath ?? getDefaultDbPath());
  _repo = new ProjectsRepo(_db);
  return { db: _db, repo: _repo };
}

/** Get the repo instance. Throws if the database hasn't been opened yet. */
export function getRepo(): ProjectsRepo {
  if (!_repo) {
    throw new Error('Project database not initialized. Call openProjectDb() first.');
  }
  return _repo;
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
  }
}
