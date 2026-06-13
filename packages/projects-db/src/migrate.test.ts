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

  it("keeps the kind CHECK: notebook allowed, unknown kinds rejected", () => {
    // 'drawing' was a planned kind that never shipped — PageKind is
    // 'doc' | 'notebook' and the schema CHECK must match it.
    runMigrations(db);
    db.prepare("INSERT INTO projects (id, label, slug) VALUES ('proj_1', 'P', 'p')").run();
    expect(() =>
      db.prepare("INSERT INTO pages (id, project_id, title, kind) VALUES ('pg_n', 'proj_1', 'NB', 'notebook')").run()
    ).not.toThrow();
    expect(() =>
      db.prepare("INSERT INTO pages (id, project_id, title, kind) VALUES ('pg_d', 'proj_1', 'Sketch', 'drawing')").run()
    ).toThrow(/CHECK constraint/);
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

describe('v12 shaping removal', () => {
  /** Seed a pre-v12 DB with one project/column and return helpers. */
  const seedPreV12 = (): void => {
    migrateTo(12);
    db.prepare("INSERT INTO projects (id, label, slug) VALUES ('proj_1', 'P', 'p')").run();
    db.prepare("INSERT INTO pipeline_columns (id, project_id, label, sort_order) VALUES ('col_1', 'proj_1', 'Backlog', 0)").run();
  };

  it('folds ticket shaping into the description and drops the column', () => {
    seedPreV12();
    db.prepare(
      `INSERT INTO tickets (id, project_id, column_id, title, description, shaping)
       VALUES ('tkt_1', 'proj_1', 'col_1', 'T', 'Existing body.',
               '{"doneLooksLike":"redirect works","appetite":"medium","outOfScope":"password reset"}')`
    ).run();
    db.prepare(
      `INSERT INTO tickets (id, project_id, column_id, title, description, shaping)
       VALUES ('tkt_2', 'proj_1', 'col_1', 'T2', '', '{"doneLooksLike":"  ","appetite":"small","outOfScope":""}')`
    ).run();

    runMigrations(db); // applies v12

    const t1 = db.prepare("SELECT description FROM tickets WHERE id = 'tkt_1'").get() as { description: string };
    expect(t1.description).toBe(
      'Existing body.\n\n**Done when:** redirect works\n\n**Out of scope:** password reset'
    );
    // Blank shaping fields fold to nothing.
    const t2 = db.prepare("SELECT description FROM tickets WHERE id = 'tkt_2'").get() as { description: string };
    expect(t2.description).toBe('');
    // Column is gone.
    const cols = db.prepare('PRAGMA table_info(tickets)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).not.toContain('shaping');
  });

  it("folds inbox shaping into the note and collapses 'shaped' to 'new' with a fresh createdAt", () => {
    seedPreV12();
    db.prepare(
      `INSERT INTO inbox_items (id, title, note, status, shaping, created_at)
       VALUES ('inb_1', 'I', NULL, 'shaped',
               '{"outcome":"Demo booked","appetite":"small","notDoing":"No counter-offer"}',
               '2020-01-01 00:00:00.000')`
    ).run();

    runMigrations(db);

    const row = db
      .prepare("SELECT note, status, created_at FROM inbox_items WHERE id = 'inb_1'")
      .get() as { note: string; status: string; created_at: string };
    expect(row.note).toBe('**Done when:** Demo booked\n\n**Out of scope:** No counter-offer');
    expect(row.status).toBe('new');
    // createdAt was refreshed so the expiry sweep doesn't instantly defer it.
    expect(row.created_at > '2020-01-02').toBe(true);
    const cols = db.prepare('PRAGMA table_info(inbox_items)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).not.toContain('shaping');
  });
});

describe('v13 source cutover', () => {
  it('moves workspace_dir into sources and drops workspace_dir', () => {
    migrateTo(13);
    db.prepare("INSERT INTO projects (id, label, slug, workspace_dir) VALUES ('proj_1', 'P', 'p', '/tmp/project')").run();

    runMigrations(db);

    const row = db.prepare("SELECT sources FROM projects WHERE id = 'proj_1'").get() as { sources: string };
    expect(JSON.parse(row.sources)).toEqual([
      expect.objectContaining({ kind: 'local', mountName: 'p', workspaceDir: '/tmp/project' }),
    ]);
    const cols = db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).not.toContain('workspace_dir');
  });
});

describe('v14 inbox status tightening', () => {
  it('removes shaped from the inbox status check', () => {
    migrateTo(14);
    db.prepare("INSERT INTO inbox_items (id, title, status) VALUES ('inb_1', 'I', 'shaped')").run();

    runMigrations(db);

    const row = db.prepare("SELECT status FROM inbox_items WHERE id = 'inb_1'").get() as { status: string };
    expect(row.status).toBe('new');
    expect(() => db.prepare("INSERT INTO inbox_items (id, title, status) VALUES ('inb_2', 'I2', 'shaped')").run()).toThrow(/CHECK constraint/);
  });
});
