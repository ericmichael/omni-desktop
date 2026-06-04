/**
 * Tests for the v10 pages-table rebuild: it must drop the kind CHECK
 * constraint (so 'drawing' and future kinds insert cleanly) WITHOUT losing
 * page_content rows to the implicit cascade-delete that DROP TABLE performs
 * when foreign keys are enabled.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from './migrate.js';
import { migrations } from './schema.js';

let tmpDir: string;
let db: DatabaseSync;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'projects-db-migrate-test-'));
  db = new DatabaseSync(join(tmpDir, 'test.db'));
  db.exec('PRAGMA foreign_keys = ON');
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Apply every migration strictly below `version`, simulating an older DB. */
const migrateTo = (version: number): void => {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  for (const m of migrations) {
    if (m.version < version) {
      db.exec(m.sql);
      db.prepare('INSERT INTO _migrations (version) VALUES (?)').run(m.version);
    }
  }
};

describe('v10 pages rebuild', () => {
  it('preserves page_content rows across the rebuild', () => {
    migrateTo(10);
    db.prepare("INSERT INTO projects (id, label, slug) VALUES ('proj_1', 'P', 'p')").run();
    db.prepare("INSERT INTO pages (id, project_id, parent_id, title, kind) VALUES ('pg_1', 'proj_1', NULL, 'Root', 'doc')").run();
    db.prepare("INSERT INTO pages (id, project_id, parent_id, title, kind) VALUES ('pg_2', 'proj_1', 'pg_1', 'Child', 'doc')").run();
    db.prepare("INSERT INTO page_content (page_id, body) VALUES ('pg_1', '# hello')").run();
    db.prepare("INSERT INTO page_content (page_id, body) VALUES ('pg_2', '# child')").run();

    runMigrations(db); // applies v10

    const content = db.prepare('SELECT page_id, body FROM page_content ORDER BY page_id').all();
    expect(content).toEqual([
      { page_id: 'pg_1', body: '# hello' },
      { page_id: 'pg_2', body: '# child' },
    ]);
    // Self-referencing parent_id survives.
    const child = db.prepare("SELECT parent_id FROM pages WHERE id = 'pg_2'").get() as { parent_id: string };
    expect(child.parent_id).toBe('pg_1');
    // Foreign keys are re-enabled after the rebuild.
    const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);
  });

  it("allows inserting kind='drawing' after migration", () => {
    runMigrations(db);
    db.prepare("INSERT INTO projects (id, label, slug) VALUES ('proj_1', 'P', 'p')").run();
    expect(() =>
      db.prepare("INSERT INTO pages (id, project_id, title, kind) VALUES ('pg_d', 'proj_1', 'Sketch', 'drawing')").run()
    ).not.toThrow();
    const row = db.prepare("SELECT kind FROM pages WHERE id = 'pg_d'").get() as { kind: string };
    expect(row.kind).toBe('drawing');
  });

  it('cascade-deletes page_content when its page is removed (FK intact)', () => {
    runMigrations(db);
    db.prepare("INSERT INTO projects (id, label, slug) VALUES ('proj_1', 'P', 'p')").run();
    db.prepare("INSERT INTO pages (id, project_id, title, kind) VALUES ('pg_1', 'proj_1', 'Root', 'doc')").run();
    db.prepare("INSERT INTO page_content (page_id, body) VALUES ('pg_1', 'x')").run();
    db.prepare("DELETE FROM pages WHERE id = 'pg_1'").run();
    const count = db.prepare('SELECT COUNT(*) AS n FROM page_content').get() as { n: number };
    expect(count.n).toBe(0);
  });
});
