/**
 * Tests for the v10 pages-table rebuild: it must drop the kind CHECK
 * constraint (so 'drawing' and future kinds insert cleanly) WITHOUT losing
 * page_content rows to the implicit cascade-delete that DROP TABLE performs
 * when foreign keys are enabled.
 */
import { DatabaseSync } from 'node:sqlite';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from './migrate.js';
import { migrations } from './schema.js';

/** Apply every migration strictly below `version`, simulating an older DB. */
const migrateTo = (db: DatabaseSync, version: number): void => {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`
  );
  for (const m of migrations) {
    if (m.version < version) {
      db.exec(m.sql);
      db.prepare('INSERT INTO _migrations (version) VALUES (?)').run(m.version);
    }
  }
};

/**
 * Build one migrated database per migration scenario, then isolate each
 * assertion with a savepoint. Replaying the full migration history for every
 * test is particularly expensive on Windows runners and is not part of the
 * behavior these assertions exercise.
 */
const useMigrationFixture = (version: number, seed: (db: DatabaseSync) => void): (() => DatabaseSync) => {
  let db: DatabaseSync | undefined;

  beforeAll(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrateTo(db, version);
    seed(db);
    runMigrations(db);
  });

  beforeEach(() => {
    db!.exec('SAVEPOINT test_case');
  });

  afterEach(() => {
    db!.exec('ROLLBACK TO test_case');
    db!.exec('RELEASE test_case');
  });

  afterAll(() => {
    db!.close();
  });

  return () => db!;
};

describe('v10 pages rebuild', () => {
  const getDb = useMigrationFixture(10, (db) => {
    db.prepare("INSERT INTO projects (id, label, slug) VALUES ('proj_1', 'P', 'p')").run();
    db.prepare(
      "INSERT INTO pages (id, project_id, parent_id, title, kind) VALUES ('pg_1', 'proj_1', NULL, 'Root', 'doc')"
    ).run();
    db.prepare(
      "INSERT INTO pages (id, project_id, parent_id, title, kind) VALUES ('pg_2', 'proj_1', 'pg_1', 'Child', 'doc')"
    ).run();
    db.prepare("INSERT INTO page_content (page_id, body) VALUES ('pg_1', '# hello')").run();
    db.prepare("INSERT INTO page_content (page_id, body) VALUES ('pg_2', '# child')").run();
  });

  it('preserves page_content rows across the rebuild', () => {
    const db = getDb();

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

  it('keeps the kind CHECK: notebook allowed, unknown kinds rejected', () => {
    const db = getDb();
    // 'drawing' was a planned kind that never shipped — PageKind is
    // 'doc' | 'notebook' and the schema CHECK must match it.
    expect(() =>
      db.prepare("INSERT INTO pages (id, project_id, title, kind) VALUES ('pg_n', 'proj_1', 'NB', 'notebook')").run()
    ).not.toThrow();
    expect(() =>
      db.prepare("INSERT INTO pages (id, project_id, title, kind) VALUES ('pg_d', 'proj_1', 'Sketch', 'drawing')").run()
    ).toThrow(/CHECK constraint/);
  });

  it('cascade-deletes page_content when its page is removed (FK intact)', () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO pages (id, project_id, title, kind) VALUES ('pg_cascade', 'proj_1', 'Cascade', 'doc')"
    ).run();
    db.prepare("INSERT INTO page_content (page_id, body) VALUES ('pg_cascade', 'x')").run();
    db.prepare("DELETE FROM pages WHERE id = 'pg_cascade'").run();
    const count = db.prepare("SELECT COUNT(*) AS n FROM page_content WHERE page_id = 'pg_cascade'").get() as {
      n: number;
    };
    expect(count.n).toBe(0);
  });
});

describe('v12 shaping removal', () => {
  const getDb = useMigrationFixture(12, (db) => {
    db.prepare("INSERT INTO projects (id, label, slug) VALUES ('proj_1', 'P', 'p')").run();
    db.prepare(
      "INSERT INTO pipeline_columns (id, project_id, label, sort_order) VALUES ('col_1', 'proj_1', 'Backlog', 0)"
    ).run();
    db.prepare(
      `INSERT INTO tickets (id, project_id, column_id, title, description, shaping)
       VALUES ('tkt_1', 'proj_1', 'col_1', 'T', 'Existing body.',
               '{"doneLooksLike":"redirect works","appetite":"medium","outOfScope":"password reset"}')`
    ).run();
    db.prepare(
      `INSERT INTO tickets (id, project_id, column_id, title, description, shaping)
       VALUES ('tkt_2', 'proj_1', 'col_1', 'T2', '', '{"doneLooksLike":"  ","appetite":"small","outOfScope":""}')`
    ).run();
    db.prepare(
      `INSERT INTO inbox_items (id, title, note, status, shaping, created_at)
       VALUES ('inb_1', 'I', NULL, 'shaped',
               '{"outcome":"Demo booked","appetite":"small","notDoing":"No counter-offer"}',
               '2020-01-01 00:00:00.000')`
    ).run();
  });

  it('folds ticket shaping into the description and drops the column', () => {
    const db = getDb();

    const t1 = db.prepare("SELECT description FROM tickets WHERE id = 'tkt_1'").get() as { description: string };
    expect(t1.description).toBe('Existing body.\n\n**Done when:** redirect works\n\n**Out of scope:** password reset');
    // Blank shaping fields fold to nothing.
    const t2 = db.prepare("SELECT description FROM tickets WHERE id = 'tkt_2'").get() as { description: string };
    expect(t2.description).toBe('');
    // Column is gone.
    const cols = db.prepare('PRAGMA table_info(tickets)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).not.toContain('shaping');
  });

  it("folds inbox shaping into the note and collapses 'shaped' to 'new' with a fresh createdAt", () => {
    const db = getDb();

    const row = db.prepare("SELECT note, status, created_at FROM inbox_items WHERE id = 'inb_1'").get() as {
      note: string;
      status: string;
      created_at: string;
    };
    expect(row.note).toBe('**Done when:** Demo booked\n\n**Out of scope:** No counter-offer');
    expect(row.status).toBe('new');
    // createdAt was refreshed so the expiry sweep doesn't instantly defer it.
    expect(row.created_at > '2020-01-02').toBe(true);
    const cols = db.prepare('PRAGMA table_info(inbox_items)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).not.toContain('shaping');
  });
});

describe('v13 source cutover', () => {
  const getDb = useMigrationFixture(13, (db) => {
    db.prepare(
      "INSERT INTO projects (id, label, slug, workspace_dir) VALUES ('proj_1', 'P', 'p', '/tmp/project')"
    ).run();
  });

  it('moves workspace_dir into sources and drops workspace_dir', () => {
    const db = getDb();

    const row = db.prepare("SELECT sources FROM projects WHERE id = 'proj_1'").get() as { sources: string };
    expect(JSON.parse(row.sources)).toEqual([
      expect.objectContaining({ kind: 'local', mountName: 'p', workspaceDir: '/tmp/project' }),
    ]);
    const cols = db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).not.toContain('workspace_dir');
  });
});

describe('v14 inbox status tightening', () => {
  const getDb = useMigrationFixture(14, (db) => {
    db.prepare("INSERT INTO inbox_items (id, title, status) VALUES ('inb_1', 'I', 'shaped')").run();
  });

  it('removes shaped from the inbox status check', () => {
    const db = getDb();

    const row = db.prepare("SELECT status FROM inbox_items WHERE id = 'inb_1'").get() as { status: string };
    expect(row.status).toBe('new');
    expect(() =>
      db.prepare("INSERT INTO inbox_items (id, title, status) VALUES ('inb_2', 'I2', 'shaped')").run()
    ).toThrow(/CHECK constraint/);
  });
});

describe('v15 pipeline column categories', () => {
  const insertColumn = (db: DatabaseSync, id: string, projectId: string, label: string, sortOrder: number): void => {
    db.prepare('INSERT INTO pipeline_columns (id, project_id, label, sort_order) VALUES (?, ?, ?, ?)').run(
      id,
      projectId,
      label,
      sortOrder
    );
  };

  const categoriesOf = (db: DatabaseSync, projectId: string): string[] =>
    (
      db
        .prepare('SELECT category FROM pipeline_columns WHERE project_id = ? ORDER BY sort_order')
        .all(projectId) as Array<{ category: string }>
    ).map((r) => r.category);

  const getDb = useMigrationFixture(15, (db) => {
    db.prepare("INSERT INTO projects (id, label, slug) VALUES ('proj_1', 'P', 'p')").run();
    insertColumn(db, 'proj_1__backlog', 'proj_1', 'Backlog', 0);
    insertColumn(db, 'proj_1__spec', 'proj_1', 'Spec', 1);
    insertColumn(db, 'proj_1__impl', 'proj_1', 'Implementation', 2);
    insertColumn(db, 'proj_1__review', 'proj_1', 'Review', 3);
    insertColumn(db, 'proj_1__done', 'proj_1', 'Completed', 4);
    db.prepare("INSERT INTO projects (id, label, slug) VALUES ('proj_2', 'P2', 'p2')").run();
    insertColumn(db, 'proj_2__a', 'proj_2', 'A', 0);
    insertColumn(db, 'proj_2__b', 'proj_2', 'B', 1);
    db.prepare("INSERT INTO projects (id, label, slug) VALUES ('proj_3', 'P3', 'p3')").run();
    insertColumn(db, 'proj_3__only', 'proj_3', 'Only', 0);
  });

  it('backfills first → todo, last → done, middle → doing', () => {
    expect(categoriesOf(getDb(), 'proj_1')).toEqual(['todo', 'doing', 'doing', 'doing', 'done']);
  });

  it('backfills a two-column pipeline as todo → done', () => {
    expect(categoriesOf(getDb(), 'proj_2')).toEqual(['todo', 'done']);
  });

  it('backfills a single-column pipeline as done (last wins)', () => {
    expect(categoriesOf(getDb(), 'proj_3')).toEqual(['done']);
  });

  it('rejects invalid categories after the migration', () => {
    const db = getDb();
    db.prepare("INSERT INTO projects (id, label, slug) VALUES ('proj_4', 'P4', 'p4')").run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO pipeline_columns (id, project_id, label, sort_order, category) VALUES (?, ?, ?, 0, 'bogus')"
        )
        .run('proj_4__x', 'proj_4', 'X')
    ).toThrow(/CHECK constraint/);
  });
});
