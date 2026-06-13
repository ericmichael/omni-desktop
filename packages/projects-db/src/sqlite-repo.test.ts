/**
 * Tests for SqliteProjectsRepo — the async adapter over the sync ProjectsRepo.
 * Verifies it satisfies the IProjectsRepo contract by delegating to the sync
 * core (read-after-write through the async surface).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from './migrate.js';
import { ProjectsRepo } from './repo.js';
import type { IProjectsRepo } from './repo-interface.js';
import { SqliteProjectsRepo } from './sqlite-repo.js';
import type { ProjectRow } from './types.js';

let tmpDir: string;
let db: DatabaseSync;
let repo: IProjectsRepo;
let sync: ProjectsRepo;

const projectRow = (id: string, slug: string): ProjectRow => ({
  id,
  label: `Project ${id}`,
  slug,
  is_personal: 0,
  auto_dispatch: 0,
  sources: '[]',
  sandbox_profile: null,
  config: null,
  due_date: null,
  pinned_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sqlite-repo-test-'));
  db = new DatabaseSync(join(tmpDir, 'test.db'));
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  sync = new ProjectsRepo(db);
  repo = new SqliteProjectsRepo(sync);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('SqliteProjectsRepo', () => {
  it('resolves async reads with the sync result (read-after-write)', async () => {
    await repo.upsertProject(projectRow('p1', 'one'));
    const all = await repo.listProjects();
    expect(all.map((p) => p.id)).toEqual(['p1']);
    const got = await repo.getProject('p1');
    expect(got?.slug).toBe('one');
  });

  it('writes through to the same underlying db as the sync core', async () => {
    await repo.upsertProject(projectRow('p2', 'two'));
    // The adapter shares the sync repo's connection — the write is visible
    // synchronously on the wrapped instance.
    expect(sync.getProject('p2')?.slug).toBe('two');
  });

  it('returns undefined for a missing row', async () => {
    expect(await repo.getProject('nope')).toBeUndefined();
  });

  it('deletes through the async surface', async () => {
    await repo.upsertProject(projectRow('p3', 'three'));
    await repo.deleteProject('p3');
    expect(await repo.getProject('p3')).toBeUndefined();
  });

  it('exposes the sync core for SQLite-only paths', () => {
    expect((repo as SqliteProjectsRepo).sync).toBe(sync);
  });
});
