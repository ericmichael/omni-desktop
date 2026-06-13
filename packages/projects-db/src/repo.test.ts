/**
 * Tests for ProjectsRepo.syncColumnsForProject — pipeline defaults → SQLite
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
import { ProjectsRepo } from './repo.js';
import type { ColumnSyncInput } from './repo-interface.js';

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

  it('persists workflow metadata and max concurrency on synced columns', () => {
    repo.syncColumnsForProject(PROJECT_ID, [
      { logicalId: 'backlog', label: 'Backlog' },
      {
        logicalId: 'spec',
        label: 'Spec',
        description: 'Plan the work',
        maxConcurrent: 2,
        workflow: {
          purpose: 'Plan the implementation',
          definitionOfDone: ['Decision-complete plan exists'],
          agentInstructions: 'Use the software-planning skill.',
          recommendedSkills: ['software-planning'],
        },
      },
      { logicalId: 'completed', label: 'Completed' },
    ]);

    const spec = repo.listColumns(PROJECT_ID).find((c) => c.id === defaultColumnId(PROJECT_ID, 'spec'))!;
    expect(spec.description).toBe('Plan the work');
    expect(spec.max_concurrent).toBe(2);
    expect(JSON.parse(spec.workflow!)).toEqual({
      purpose: 'Plan the implementation',
      definitionOfDone: ['Decision-complete plan exists'],
      agentInstructions: 'Use the software-planning skill.',
      recommendedSkills: ['software-planning'],
    });
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

  it('removed milestone preserves other tickets (SET NULL cascade)', () => {
    // Set up: two tickets, one with a milestone, one without
    const tid1 = seedTicket('implementation');
    const tid2 = seedTicket('implementation');
    db.prepare(`INSERT INTO milestones (id, project_id, title) VALUES (?, ?, ?)`)
      .run('ms_1', PROJECT_ID, 'M1');
    db.prepare('UPDATE tickets SET milestone_id = ? WHERE id = ?').run('ms_1', tid1);

    repo.replaceAllMilestones([]);

    // The milestone was deleted, tid1's milestone_id should be NULL,
    // tid2 unaffected. Both tickets must still exist.
    const t1 = repo.getTicket(tid1)!;
    const t2 = repo.getTicket(tid2)!;
    expect(t1).toBeTruthy();
    expect(t2).toBeTruthy();
    expect(t1.milestone_id).toBeNull();
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

/**
 * Regression suite for the cascade-wipe class of bugs:
 *
 *   The original `replaceAllX` methods did `DELETE FROM <table>` then
 *   re-inserted. With foreign keys enabled and the schema's ON DELETE
 *   CASCADE / SET NULL rules, every routine "save the projects list" or
 *   "save the tickets list" call destroyed child data across multiple
 *   tables. These tests pin the diff-and-upsert behavior so the class of
 *   bug can't silently regress.
 */
describe('replaceAll* preserves child data', () => {
  const seedTicketWithComment = (commentId: string): string => {
    const tid = seedTicket('implementation');
    db.prepare(
      `INSERT INTO ticket_comments (id, ticket_id, author, content) VALUES (?, ?, 'human', 'hello')`
    ).run(commentId, tid);
    return tid;
  };

  const seedSecondProject = (id = 'proj_other'): string => {
    db.prepare(
      `INSERT INTO projects (id, label, slug) VALUES (?, ?, ?)`
    ).run(id, 'Other', 'other');
    repo.syncColumnsForProject(id, initialDefaults);
    return id;
  };

  it('replaceAllProjects: updating one project preserves its tickets', () => {
    const tid = seedTicket('implementation');
    const project = repo.getProject(PROJECT_ID)!;

    // Simulate `updateProject` — re-write the same project list with a
    // renamed label.
    repo.replaceAllProjects([{ ...project, label: 'Renamed' }]);

    expect(repo.getProject(PROJECT_ID)!.label).toBe('Renamed');
    expect(repo.getTicket(tid)).toBeTruthy();
  });

  it('replaceAllProjects: adding a new project preserves existing children', () => {
    const tid = seedTicket('implementation');
    db.prepare(`INSERT INTO milestones (id, project_id, title) VALUES (?, ?, ?)`)
      .run('ms_a', PROJECT_ID, 'M');
    db.prepare(`INSERT INTO pages (id, project_id, title, is_root) VALUES (?, ?, ?, 1)`)
      .run('page_a', PROJECT_ID, 'Root');
    const existing = repo.getProject(PROJECT_ID)!;

    repo.replaceAllProjects([
      existing,
      {
        id: 'proj_b',
        label: 'B',
        slug: 'b',
        is_personal: 0,
        auto_dispatch: 0,
        sources: '[]',
        sandbox_profile: null,
        config: null,
        due_date: null,
        pinned_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);

    expect(repo.listProjects()).toHaveLength(2);
    expect(repo.getTicket(tid)).toBeTruthy();
    expect(repo.listMilestonesByProject(PROJECT_ID)).toHaveLength(1);
    expect(repo.listPagesByProject(PROJECT_ID)).toHaveLength(1);
  });

  it('replaceAllProjects: removing one project deletes only its data', () => {
    seedSecondProject('proj_other');
    const tidKeep = seedTicket('implementation');
    db.prepare(
      `INSERT INTO tickets (id, project_id, column_id, title, description, priority)
       VALUES (?, ?, ?, ?, '', 'medium')`
    ).run('tk_other', 'proj_other', defaultColumnId('proj_other', 'implementation'), 'Other');
    const keep = repo.getProject(PROJECT_ID)!;

    repo.replaceAllProjects([keep]); // drops proj_other

    expect(repo.listProjects().map((p) => p.id)).toEqual([PROJECT_ID]);
    expect(repo.getTicket(tidKeep)).toBeTruthy();
    expect(repo.getTicket('tk_other')).toBeUndefined();
  });

  it('replaceAllProjects: preserves inbox_items.project_id linkage', () => {
    db.prepare(
      `INSERT INTO inbox_items (id, title, project_id) VALUES (?, ?, ?)`
    ).run('ib_1', 'Some thought', PROJECT_ID);
    const existing = repo.getProject(PROJECT_ID)!;

    // Routine "save projects" — the old code would SET NULL the inbox link.
    repo.replaceAllProjects([{ ...existing, label: 'Renamed' }]);

    expect(repo.getInboxItem('ib_1')!.project_id).toBe(PROJECT_ID);
  });

  it('replaceAllTickets: updating one ticket preserves comments on other tickets', () => {
    const tidA = seedTicketWithComment('cmt_a');
    const tidB = seedTicketWithComment('cmt_b');
    const rowA = repo.getTicket(tidA)!;
    const rowB = repo.getTicket(tidB)!;

    // Save the same list back — should be idempotent for comments.
    repo.replaceAllTickets([{ ...rowA, title: 'Edited' }, rowB]);

    expect(repo.listCommentsByTicket(tidA)).toHaveLength(1);
    expect(repo.listCommentsByTicket(tidB)).toHaveLength(1);
    expect(repo.getTicket(tidA)!.title).toBe('Edited');
  });

  it('replaceAllTickets: deleting one ticket cascade-drops only its comments', () => {
    const tidA = seedTicketWithComment('cmt_a');
    const tidB = seedTicketWithComment('cmt_b');
    const rowB = repo.getTicket(tidB)!;

    repo.replaceAllTickets([rowB]); // drop tidA

    expect(repo.getTicket(tidA)).toBeUndefined();
    expect(repo.listCommentsByTicket(tidA)).toHaveLength(0);
    expect(repo.listCommentsByTicket(tidB)).toHaveLength(1);
  });

  it('replaceAllMilestones: updating one milestone preserves ticket links', () => {
    const tid = seedTicket('implementation');
    db.prepare(`INSERT INTO milestones (id, project_id, title) VALUES (?, ?, ?)`)
      .run('ms_1', PROJECT_ID, 'M1');
    db.prepare('UPDATE tickets SET milestone_id = ? WHERE id = ?').run('ms_1', tid);
    const ms = repo.getMilestone('ms_1')!;

    repo.replaceAllMilestones([{ ...ms, title: 'Renamed' }]);

    expect(repo.getTicket(tid)!.milestone_id).toBe('ms_1');
    expect(repo.getMilestone('ms_1')!.title).toBe('Renamed');
  });

  it('replaceAllPages: parent/child pages survive a no-op save in any order', () => {
    db.prepare(
      `INSERT INTO pages (id, project_id, title, is_root) VALUES (?, ?, ?, 1)`
    ).run('page_root', PROJECT_ID, 'Root');
    db.prepare(
      `INSERT INTO pages (id, project_id, parent_id, title) VALUES (?, ?, ?, ?)`
    ).run('page_child', PROJECT_ID, 'page_root', 'Child');
    const root = repo.getPage('page_root')!;
    const child = repo.getPage('page_child')!;

    // Child appears BEFORE parent — would have tripped FK without
    // defer_foreign_keys.
    repo.replaceAllPages([child, root]);

    expect(repo.getPage('page_child')!.parent_id).toBe('page_root');
  });

  it('replaceAllInboxItems: idempotent save preserves rows', () => {
    db.prepare(
      `INSERT INTO inbox_items (id, title) VALUES (?, ?)`
    ).run('ib_1', 'A');
    const row = repo.getInboxItem('ib_1')!;

    repo.replaceAllInboxItems([row]);

    expect(repo.getInboxItem('ib_1')).toBeTruthy();
  });

  it('getProjectConfig: returns null when never set', () => {
    expect(repo.getProjectConfig(PROJECT_ID)).toBeNull();
  });

  it('setProjectConfig + getProjectConfig: round-trips JSON', () => {
    const json = JSON.stringify({ manifest: { root: '/workspace' } });
    repo.setProjectConfig(PROJECT_ID, json);
    expect(repo.getProjectConfig(PROJECT_ID)).toBe(json);
  });

  it('setProjectConfig: setting null clears the column', () => {
    repo.setProjectConfig(PROJECT_ID, '{"hello":1}');
    expect(repo.getProjectConfig(PROJECT_ID)).toBe('{"hello":1}');
    repo.setProjectConfig(PROJECT_ID, null);
    expect(repo.getProjectConfig(PROJECT_ID)).toBeNull();
  });

  it('replaceAllProjects: preserves config column on existing rows', () => {
    repo.setProjectConfig(PROJECT_ID, '{"keep":true}');
    const existing = repo.getProject(PROJECT_ID)!;

    // Diff-and-upsert path: re-write the same row. config should survive.
    repo.replaceAllProjects([{ ...existing, label: 'Renamed' }]);

    expect(repo.getProjectConfig(PROJECT_ID)).toBe('{"keep":true}');
  });

  it('replaceAllTasks: deleting one task preserves the rest', () => {
    db.prepare(
      `INSERT INTO tasks (id, project_id, task_description, status) VALUES (?, ?, ?, '{}')`
    ).run('tk_1', PROJECT_ID, 'A');
    db.prepare(
      `INSERT INTO tasks (id, project_id, task_description, status) VALUES (?, ?, ?, '{}')`
    ).run('tk_2', PROJECT_ID, 'B');
    const t2 = repo.getTask('tk_2')!;

    repo.replaceAllTasks([t2]);

    expect(repo.getTask('tk_1')).toBeUndefined();
    expect(repo.getTask('tk_2')).toBeTruthy();
  });

  it('upsertTicket: assignee round-trips and updates', () => {
    const id = seedTicket('backlog', 'tkt_assignee');
    const row = repo.getTicket(id)!;
    expect(row.assignee).toBeNull();

    repo.upsertTicket({ ...row, assignee: 'principal-abc' });
    expect(repo.getTicket(id)!.assignee).toBe('principal-abc');

    repo.upsertTicket({ ...repo.getTicket(id)!, assignee: null });
    expect(repo.getTicket(id)!.assignee).toBeNull();
  });
});
