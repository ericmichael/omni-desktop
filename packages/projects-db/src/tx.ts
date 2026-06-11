import type { DatabaseSync } from 'node:sqlite';

/**
 * Run `fn` inside a SQLite transaction. Commits on success, rolls back on
 * exception. `node:sqlite` doesn't ship the `db.transaction(fn)` helper that
 * `better-sqlite3` had — this is the equivalent.
 */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore secondary failures during rollback
    }
    throw err;
  }
}

/**
 * Run `fn` inside a SQLite transaction with foreign-key checks deferred to
 * COMMIT. Used by the "sync this entire table" methods so rows can be
 * upserted in any order (e.g. `pages.parent_id` self-references) and so a
 * mid-transaction state that briefly violates a FK constraint doesn't
 * abort the operation. SQLite resets `defer_foreign_keys` to 0 at end of
 * transaction automatically.
 */
export function txDeferred<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    db.exec('PRAGMA defer_foreign_keys = ON');
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore secondary failures during rollback
    }
    throw err;
  }
}
