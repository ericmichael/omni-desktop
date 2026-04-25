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
