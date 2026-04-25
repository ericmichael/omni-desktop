import type { DatabaseSync } from 'node:sqlite';

import { migrations } from './schema.js';
import { tx } from './tx.js';

export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const current = (db.prepare('SELECT MAX(version) as v FROM _migrations').get() as { v: number | null })?.v ?? 0;

  for (const m of migrations) {
    if (m.version > current) {
      tx(db, () => {
        db.exec(m.sql);
        db.prepare('INSERT INTO _migrations (version) VALUES (?)').run(m.version);
      });
    }
  }
}
