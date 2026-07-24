/**
 * Tests for the resident-agent tables (v16) — roster/memories/channels/
 * messages/alarms round-trips, the delete cascades, and the log bound
 * (docs/residents-in-projects-db-plan.md).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from './migrate.js';
import { ProjectsRepo } from './repo.js';
import type { ResidentMessageRow, ResidentRow } from './types.js';

let tmpDir: string;
let db: DatabaseSync;
let repo: ProjectsRepo;

const agentRow = (id: string, overrides: Partial<ResidentRow> = {}): ResidentRow => ({
  id,
  name: id,
  role: 'engineer',
  persona_text: 'persona',
  profile_name: null,
  project_ids: '[]',
  morning_hour: 8,
  enabled: 1,
  created_at: '2026-07-23 08:00:00.000',
  ...overrides,
});

const messageRow = (id: number, overrides: Partial<ResidentMessageRow> = {}): ResidentMessageRow => ({
  id,
  channel: 'team',
  from_id: 'user',
  from_name: 'You',
  text: `message ${id}`,
  at: '2026-07-23 09:00:00.000',
  reply_to: null,
  ...overrides,
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'projects-db-resident-test-'));
  db = new DatabaseSync(join(tmpDir, 'test.db'));
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  repo = new ProjectsRepo(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('resident roster', () => {
  it('round-trips rows, including the null morning hour and enabled flag', () => {
    repo.upsertResident(agentRow('sable'));
    repo.upsertResident(agentRow('quill', { morning_hour: null, enabled: 0, project_ids: '["proj_a"]' }));

    const listed = repo.listResidents();
    expect(listed.map((r) => r.id)).toEqual(['sable', 'quill']);
    expect(listed[1]).toMatchObject({ morning_hour: null, enabled: 0, project_ids: '["proj_a"]' });
  });

  it('upsert by id updates in place', () => {
    repo.upsertResident(agentRow('sable'));
    repo.upsertResident(agentRow('sable', { role: 'release engineer', morning_hour: null }));
    expect(repo.listResidents()).toHaveLength(1);
    expect(repo.listResidents()[0]).toMatchObject({ role: 'release engineer', morning_hour: null });
  });
});

describe('resident memories', () => {
  beforeEach(() => {
    repo.upsertResident(agentRow('sable'));
  });

  it('upserts by (agent, key) — same key replaces the text', () => {
    repo.upsertResidentMemory({
      agent_id: 'sable',
      key: 'deploy-window',
      text: 'Fridays',
      at: '2026-07-23 09:00:00.000',
    });
    repo.upsertResidentMemory({
      agent_id: 'sable',
      key: 'deploy-window',
      text: 'Mondays',
      at: '2026-07-23 10:00:00.000',
    });
    const rows = repo.listResidentMemories('sable');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe('Mondays');
  });

  it('setResidentMemories replaces the full list; deleteResidentMemory retracts by key', () => {
    repo.upsertResidentMemory({ agent_id: 'sable', key: 'a', text: 'A', at: '2026-07-23 09:00:00.000' });
    repo.setResidentMemories('sable', [
      { agent_id: 'sable', key: 'b', text: 'B', at: '2026-07-23 09:00:00.000' },
      { agent_id: 'sable', key: 'c', text: 'C', at: '2026-07-23 09:00:00.000' },
    ]);
    expect(repo.listResidentMemories('sable').map((r) => r.key)).toEqual(['b', 'c']);

    repo.deleteResidentMemory('sable', 'b');
    expect(repo.listResidentMemories('sable').map((r) => r.key)).toEqual(['c']);
  });

  it('cascades on resident delete', () => {
    repo.upsertResidentMemory({ agent_id: 'sable', key: 'a', text: 'A', at: '2026-07-23 09:00:00.000' });
    repo.deleteResident('sable');
    expect(repo.listResidentMemories('sable')).toEqual([]);
  });
});

describe('resident channels + message log', () => {
  it('channel delete removes its messages, other channels untouched', () => {
    repo.upsertResidentChannel({
      id: 'deploy-log',
      description: null,
      members: null,
      created_at: '2026-07-23 08:00:00.000',
    });
    repo.appendResidentMessage(messageRow(1, { channel: 'deploy-log' }));
    repo.appendResidentMessage(messageRow(2, { channel: 'team' }));

    repo.deleteResidentChannel('deploy-log');
    expect(repo.listResidentChannels()).toEqual([]);
    expect(repo.listResidentMessages(10).map((m) => m.id)).toEqual([2]);
  });

  it('lists after a cursor and keeps caller-assigned ids', () => {
    for (let i = 1; i <= 5; i++) {
      repo.appendResidentMessage(messageRow(i));
    }
    expect(repo.listResidentMessagesAfter(3, 10).map((m) => m.id)).toEqual([4, 5]);
    // The tail listing is ascending.
    expect(repo.listResidentMessages(2).map((m) => m.id)).toEqual([4, 5]);
  });

  it('prune keeps the newest N rows', () => {
    for (let i = 1; i <= 10; i++) {
      repo.appendResidentMessage(messageRow(i));
    }
    repo.pruneResidentMessages(3);
    expect(repo.listResidentMessages(10).map((m) => m.id)).toEqual([8, 9, 10]);
  });
});

describe('resident alarms', () => {
  beforeEach(() => {
    repo.upsertResident(agentRow('sable'));
  });

  it('round-trips and deletes by id', () => {
    repo.addResidentAlarm({
      id: 1,
      agent_id: 'sable',
      at: '2026-07-23 14:30:00.000',
      note: 'check CI',
      created_at: '2026-07-23 09:00:00.000',
    });
    repo.addResidentAlarm({
      id: 2,
      agent_id: 'sable',
      at: '2026-07-24 08:00:00.000',
      note: 'follow up',
      created_at: '2026-07-23 09:00:00.000',
    });
    expect(repo.listResidentAlarms().map((a) => a.id)).toEqual([1, 2]);

    repo.deleteResidentAlarm(1);
    expect(repo.listResidentAlarms().map((a) => a.id)).toEqual([2]);
  });

  it('cascades on resident delete', () => {
    repo.addResidentAlarm({
      id: 1,
      agent_id: 'sable',
      at: '2026-07-23 14:30:00.000',
      note: 'check CI',
      created_at: '2026-07-23 09:00:00.000',
    });
    repo.deleteResident('sable');
    expect(repo.listResidentAlarms()).toEqual([]);
  });
});

describe('team handbook', () => {
  it('is absent until first write, then upserts in place', () => {
    expect(repo.getTeamHandbook()).toBeUndefined();

    repo.setTeamHandbook('rule one', null, '2026-07-24 08:00:00.000');
    expect(repo.getTeamHandbook()).toMatchObject({ body: 'rule one', updated_by: null });

    repo.setTeamHandbook('rule one\nrule two', 'agent:sable', '2026-07-24 09:00:00.000');
    const row = repo.getTeamHandbook();
    expect(row).toMatchObject({ body: 'rule one\nrule two', updated_by: 'agent:sable' });
  });
});
