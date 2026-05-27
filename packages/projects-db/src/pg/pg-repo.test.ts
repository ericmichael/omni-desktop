/**
 * Integration tests for PgProjectsRepo against a real Postgres, exercising the
 * tenant-scoped contract and — critically — that row-level security isolates
 * tenants even when two repos share one pool/connection.
 *
 * Gated on OMNI_TEST_DATABASE_URL; skipped when unset so CI without a database
 * stays green. Locally:
 *   docker compose -f docker-compose.postgres.yml up -d
 *   OMNI_TEST_DATABASE_URL=postgres://omni:omni@localhost:5432/omni \
 *     npx vitest run packages/projects-db/src/pg/pg-repo.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPgPool, type Pool, runPgMigrations } from './connection.js';
import { PgProjectsRepo } from './pg-repo.js';
import type { ProjectRow } from '../types.js';

const URL = process.env['OMNI_TEST_DATABASE_URL'];

const projectRow = (id: string, slug: string): ProjectRow => ({
  id,
  label: `Project ${id}`,
  slug,
  workspace_dir: null,
  is_personal: 0,
  auto_dispatch: 0,
  sources: '[]',
  sandbox_profile: null,
  config: null,
  due_date: null,
  pinned_at: null,
  created_at: '2026-01-01 00:00:00.000',
  updated_at: '2026-01-01 00:00:00.000',
});

describe.skipIf(!URL)('PgProjectsRepo (live Postgres)', () => {
  let pool: Pool;
  let repoA: PgProjectsRepo;
  let repoB: PgProjectsRepo;

  beforeAll(async () => {
    pool = createPgPool(URL!);
    // Clean slate so schema + RLS match the current migration.
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runPgMigrations(pool);
    repoA = new PgProjectsRepo(pool, 'tenant-A');
    repoB = new PgProjectsRepo(pool, 'tenant-B');
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE projects, pipeline_columns, milestones, tickets, ticket_comments, pages, inbox_items, tasks CASCADE');
  });

  it('reads back what it writes (tenant-scoped)', async () => {
    await repoA.upsertProject(projectRow('p1', 'one'));
    const all = await repoA.listProjects();
    expect(all.map((p) => p.id)).toEqual(['p1']);
    expect((await repoA.getProject('p1'))?.slug).toBe('one');
  });

  it('RLS isolates tenants — B cannot see A rows', async () => {
    await repoA.upsertProject(projectRow('pa', 'a-slug'));
    await repoB.upsertProject(projectRow('pb', 'b-slug'));

    expect((await repoA.listProjects()).map((p) => p.id)).toEqual(['pa']);
    expect((await repoB.listProjects()).map((p) => p.id)).toEqual(['pb']);
    // B querying A's id by primary key returns nothing — RLS, not just a filter.
    expect(await repoB.getProject('pa')).toBeUndefined();
  });

  it('two tenants may reuse the same slug', async () => {
    await repoA.upsertProject(projectRow('pa', 'shared'));
    await expect(repoB.upsertProject(projectRow('pb', 'shared'))).resolves.toBeUndefined();
    expect((await repoB.getProjectBySlug('shared'))?.id).toBe('pb');
  });

  it('syncColumnsForProject seeds and remaps within the tenant', async () => {
    await repoA.upsertProject(projectRow('pc', 'cols'));
    const result = await repoA.syncColumnsForProject('pc', [
      { logicalId: 'backlog', label: 'Backlog' },
      { logicalId: 'review', label: 'Review', gate: true },
      { logicalId: 'done', label: 'Done' },
    ]);
    expect(result.inserted.length).toBe(3);
    const cols = await repoA.listColumns('pc');
    expect(cols.map((c) => c.label)).toEqual(['Backlog', 'Review', 'Done']);
    expect(cols.find((c) => c.label === 'Review')?.gate).toBe(1);
    // Tenant B sees no columns for A's project.
    expect(await repoB.listColumns('pc')).toEqual([]);
  });

  it('persists tickets + comments and round-trips them', async () => {
    await repoA.upsertProject(projectRow('pd', 'tix'));
    await repoA.syncColumnsForProject('pd', [{ logicalId: 'backlog', label: 'Backlog' }]);
    const columnId = (await repoA.listColumns('pd'))[0]!.id;
    await repoA.upsertTicket({
      id: 't1', project_id: 'pd', milestone_id: null, column_id: columnId,
      title: 'First', description: '', priority: 'medium', branch: null,
      blocked_by: '[]', shaping: null, resolution: null, resolved_at: null,
      archived_at: null, column_changed_at: null, use_worktree: 0, worktree_path: null,
      worktree_name: null, supervisor_session_id: null, phase: null, phase_changed_at: null,
      supervisor_task_id: null, token_usage: null, runs: '[]', pr_review: null,
      pr_merged_at: null, assignee: null, created_at: '2026-01-01 00:00:00.000', updated_at: '2026-01-01 00:00:00.000',
    });
    await repoA.replaceCommentsForTicket('t1', [
      { id: 'c1', ticket_id: 't1', author: 'agent', content: 'hi', created_at: '2026-01-01 00:00:01.000' },
    ]);
    expect((await repoA.listAllTickets()).map((t) => t.id)).toEqual(['t1']);
    expect((await repoA.listCommentsByTicket('t1')).map((c) => c.content)).toEqual(['hi']);
    expect(await repoB.listAllTickets()).toEqual([]);
  });
});
