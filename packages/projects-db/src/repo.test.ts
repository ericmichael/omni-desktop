/**
 * Tests for ProjectsRepo.syncColumnsForProject — the FLEET.md → SQLite
 * remap policy.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultColumnId } from './defaults.js';
import { ticketId } from './ids.js';
import { runMigrations } from './migrate.js';
import type { ColumnSyncInput } from './repo.js';
import { ProjectsRepo } from './repo.js';

const PROJECT_ID = 'proj_test';

let tmpDir: string;
let db: DatabaseSync;
let repo: ProjectsRepo;

const seedProject = () => {
  db.prepare(
    "INSERT INTO projects (id, label, slug) VALUES (?, ?, ?)"
  ).run(PROJECT_ID, 'Test', 'test');
};

const seedTicket = (columnLogicalId: string, idOverride?: string): string => {
  const id = idOverride ?? ticketId();
  db.prepare(`
    INSERT INTO tickets (id, project_id, column_id, title, description, priority)
    VALUES (?, ?, ?, ?, '', 'medium')
  `).run(id, PROJECT_ID, defaultColumnId(PROJECT_ID, columnLogicalId), `Ticket ${id}`);
  return id;
};

const initialDefaults: ColumnSyncInput[] = [
  { logicalId: 'backlog', label: 'Backlog' },
  { logicalId: 'spec', label: 'Spec' },
  { logicalId: 'implementation', label: 'Implementation' },
  { logicalId: 'review', label: 'Review', gate: true },
  { logicalId: 'pr', label: 'PR' },
  { logicalId: 'completed', label: 'Completed' },
];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'projects-db-test-'));
  const dbPath = join(tmpDir, 'test.db');
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  repo = new ProjectsRepo(db);
  seedProject();
  repo.syncColumnsForProject(PROJECT_ID, initialDefaults);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('syncColumnsForProject', () => {
  it('inserts columns with deterministic prefixed IDs', () => {
    const cols = repo.listColumns(PROJECT_ID);
    expect(cols.map((c) => c.id)).toEqual([
      defaultColumnId(PROJECT_ID, 'backlog'),
      defaultColumnId(PROJECT_ID, 'spec'),
      defaultColumnId(PROJECT_ID, 'implementation'),
      defaultColumnId(PROJECT_ID, 'review'),
      defaultColumnId(PROJECT_ID, 'pr'),
      defaultColumnId(PROJECT_ID, 'completed'),
    ]);
  });

  it('is idempotent — second sync with same defs is a no-op', () => {
    const result = repo.syncColumnsForProject(PROJECT_ID, initialDefaults);
    expect(result.inserted).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.remappedTickets).toEqual([]);
  });

  it('updates label and gate without changing IDs', () => {
    const updated: ColumnSyncInput[] = [
      ...initialDefaults.slice(0, 3),
      { logicalId: 'review', label: 'Code Review', gate: false }, // gate flipped
      ...initialDefaults.slice(4),
    ];
    repo.syncColumnsForProject(PROJECT_ID, updated);
    const cols = repo.listColumns(PROJECT_ID);
    const review = cols.find((c) => c.id === defaultColumnId(PROJECT_ID, 'review'))!;
    expect(review.label).toBe('Code Review');
    expect(review.gate).toBe(0);
  });

  it('rebinds tickets to new IDs by label match when logical id changes', () => {
    const tid = seedTicket('implementation');
    const renamed: ColumnSyncInput[] = [
      ...initialDefaults.slice(0, 2),
      { logicalId: 'building', label: 'Implementation' }, // same label, new id
      ...initialDefaults.slice(3),
    ];
    const result = repo.syncColumnsForProject(PROJECT_ID, renamed);
    expect(result.remappedTickets).toHaveLength(1);
    expect(result.remappedTickets[0]!.toColumnId).toBe(defaultColumnId(PROJECT_ID, 'building'));
    expect(result.remappedTickets[0]!.gateLost).toBe(false);

    const ticket = repo.getTicket(tid)!;
    expect(ticket.column_id).toBe(defaultColumnId(PROJECT_ID, 'building'));
  });

  it('buckets a removed first column to the new first column', () => {
    const tid = seedTicket('backlog');
    const trimmed: ColumnSyncInput[] = [
      { logicalId: 'inbox', label: 'Inbox' }, // new first
      ...initialDefaults.slice(2), // drop backlog and spec
    ];
    repo.syncColumnsForProject(PROJECT_ID, trimmed);
    expect(repo.getTicket(tid)!.column_id).toBe(defaultColumnId(PROJECT_ID, 'inbox'));
  });

  it('buckets a removed last column to the new last column', () => {
    const tid = seedTicket('completed');
    const trimmed: ColumnSyncInput[] = [
      ...initialDefaults.slice(0, 5),
      { logicalId: 'shipped', label: 'Shipped' }, // new last
    ];
    repo.syncColumnsForProject(PROJECT_ID, trimmed);
    expect(repo.getTicket(tid)!.column_id).toBe(defaultColumnId(PROJECT_ID, 'shipped'));
  });

  it('buckets a removed gate column to the new first gate column', () => {
    const tid = seedTicket('review');
    const trimmed: ColumnSyncInput[] = [
      ...initialDefaults.slice(0, 3),
      { logicalId: 'qa', label: 'QA', gate: true },
      ...initialDefaults.slice(4),
    ];
    const result = repo.syncColumnsForProject(PROJECT_ID, trimmed);
    expect(repo.getTicket(tid)!.column_id).toBe(defaultColumnId(PROJECT_ID, 'qa'));
    expect(result.remappedTickets[0]!.gateLost).toBe(false);
  });

  it('flags gateLost when the removed gate has no replacement gate', () => {
    const tid = seedTicket('review');
    const noGate: ColumnSyncInput[] = [
      { logicalId: 'backlog', label: 'Backlog' },
      { logicalId: 'spec', label: 'Spec' },
      { logicalId: 'implementation', label: 'Implementation' },
      { logicalId: 'pr', label: 'PR' },
      { logicalId: 'completed', label: 'Completed' },
    ];
    const result = repo.syncColumnsForProject(PROJECT_ID, noGate);
    const remap = result.remappedTickets.find((r) => r.ticketId === tid)!;
    expect(remap.gateLost).toBe(true);
    // Falls into the "first middle" bucket
    expect(remap.toColumnId).toBe(defaultColumnId(PROJECT_ID, 'spec'));
  });

  it('removes columns that no longer exist', () => {
    const trimmed = initialDefaults.slice(0, 4);
    const result = repo.syncColumnsForProject(PROJECT_ID, trimmed);
    expect(result.removed).toEqual([
      defaultColumnId(PROJECT_ID, 'pr'),
      defaultColumnId(PROJECT_ID, 'completed'),
    ]);
    expect(repo.listColumns(PROJECT_ID)).toHaveLength(4);
  });

  it('refuses to sync an empty pipeline', () => {
    expect(() => repo.syncColumnsForProject(PROJECT_ID, [])).toThrow();
  });

  it('label match wins over bucket fallback', () => {
    // Old "review" gate has unique label "Review"; new pipeline keeps the
    // label but moves the column out of the gate position. Ticket should
    // follow the label, not the gate slot.
    const tid = seedTicket('review');
    const reorder: ColumnSyncInput[] = [
      { logicalId: 'backlog', label: 'Backlog' },
      { logicalId: 'review', label: 'Review' }, // no longer a gate, no longer last
      { logicalId: 'gate2', label: 'QA', gate: true },
      { logicalId: 'completed', label: 'Completed' },
    ];
    const result = repo.syncColumnsForProject(PROJECT_ID, reorder);
    // Same SQLite id (review), so no remap recorded
    expect(result.remappedTickets).toHaveLength(0);
    expect(repo.getTicket(tid)!.column_id).toBe(defaultColumnId(PROJECT_ID, 'review'));
  });
});
