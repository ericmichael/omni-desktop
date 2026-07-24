/**
 * ResidentAgentManager durable-data fold (docs/residents-in-projects-db-plan.md):
 * the one-shot store→db migration (including both legacy store shapes), cache
 * hydration, write-through persistence, and the assignment wakeup.
 *
 * The delivery pipeline (sandbox boot, watchers) is out of scope here — these
 * tests never advance past event intake.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase, ProjectsRepo, SqliteProjectsRepo } from 'omni-projects-db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProcessManager } from '@/main/process-manager';
import { ResidentAgentManager } from '@/main/resident-agent-manager';
import type { StoreData } from '@/shared/types';

const now = 1_753_250_000_000;

function createStore(storeData: Partial<StoreData>) {
  return {
    get: <Key extends keyof StoreData>(key: Key): StoreData[Key] => storeData[key] as StoreData[Key],
    set: <Key extends keyof StoreData>(key: Key, value: StoreData[Key]): void => {
      storeData[key] = value;
    },
  } as any;
}

let tmpDir: string;
let db: ReturnType<typeof openDatabase>;
let repo: SqliteProjectsRepo;
let managers: ResidentAgentManager[];

const buildManager = (storeData: Partial<StoreData>): ResidentAgentManager => {
  const manager = new ResidentAgentManager({
    store: createStore(storeData),
    repo,
    processManager: {} as ProcessManager,
    sendToWindow: () => {},
    getSnapshot: () => undefined,
    now: () => now,
  });
  managers.push(manager);
  return manager;
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'resident-manager-test-'));
  db = openDatabase(join(tmpDir, 'projects.db'));
  repo = new SqliteProjectsRepo(new ProjectsRepo(db));
  managers = [];
});

afterEach(async () => {
  for (const manager of managers) {
    await manager.cleanup();
  }
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A pre-fold store payload with BOTH legacy shapes in play. */
const legacyStoreData = (): Partial<StoreData> => ({
  residentAgents: [
    // Legacy: single `projectId`, no `morningHour` (implicit default 8).
    {
      id: 'sable',
      name: 'Sable',
      role: 'engineer',
      personaText: 'p',
      projectId: 'proj_a',
      enabled: true,
      createdAt: now,
    } as any,
    {
      id: 'quill',
      name: 'Quill',
      role: 'writer',
      personaText: 'q',
      morningHour: null,
      enabled: false,
      createdAt: now,
    } as any,
  ],
  residentMemories: {
    // Legacy: memories keyed {id, text} instead of {key, text}.
    sable: [{ id: 1, text: 'The deploy window is Friday', at: now } as any],
    // Orphan (no such agent) — must be skipped, not crash the FK.
    ghost: [{ key: 'x', text: 'orphan', at: now }],
  },
  residentChannels: [
    { id: 1, channel: 'team', from: 'user', fromName: 'You', text: 'hello', at: now },
    { id: 2, channel: 'dm:sable:user', from: 'sable', fromName: 'Sable', text: 'hi', at: now },
  ],
  residentChannelDefs: [{ id: 'deploy-log', description: 'deploys', createdAt: now }],
  residentAlarms: { sable: [{ id: 1, at: now + 60_000, note: 'check CI', createdAt: now }] },
  residentMorningBeats: {},
});

describe('store→db migration + hydration', () => {
  it('moves all five datasets, normalizes legacy shapes, and clears the store keys', async () => {
    const storeData = legacyStoreData();
    const manager = buildManager(storeData);
    await manager.whenReady;

    const snapshot = manager.getDurableSnapshot();
    expect(snapshot.residentAgents.map((a) => a.id)).toEqual(['sable', 'quill']);
    // projectId folded into projectIds; implicit morning hour materialized.
    expect(snapshot.residentAgents[0]).toMatchObject({ projectIds: ['proj_a'], morningHour: 8 });
    expect(snapshot.residentAgents[1]).toMatchObject({ morningHour: null, enabled: false });
    // Legacy {id,text} memory got a slug key; the orphan was skipped.
    expect(snapshot.residentMemories['sable']![0]!.key).toBe('the-deploy-window-is-friday');
    expect(snapshot.residentMemories['ghost']).toBeUndefined();
    expect(snapshot.residentChannels.map((m) => m.id)).toEqual([1, 2]);
    expect(snapshot.residentChannelDefs.map((d) => d.id)).toEqual(['deploy-log']);
    expect(snapshot.residentAlarms['sable']).toHaveLength(1);

    // Store keys are cleared — the migration is one-shot.
    expect(storeData.residentAgents).toEqual([]);
    expect(storeData.residentChannels).toEqual([]);

    // And the rows really are in the DB.
    expect((await repo.listResidents()).map((r) => r.id)).toEqual(['sable', 'quill']);
  });

  it('is idempotent: a second boot hydrates from the DB without duplicating', async () => {
    const storeData = legacyStoreData();
    const first = buildManager(storeData);
    await first.whenReady;
    await first.cleanup();

    const second = buildManager(storeData);
    await second.whenReady;
    expect(second.getDurableSnapshot().residentAgents).toHaveLength(2);
    expect(await repo.listResidents()).toHaveLength(2);
  });
});

describe('write-through persistence', () => {
  it('create() mints an opaque res_ id and lands in the DB with the morning-hour default', async () => {
    const manager = buildManager({ residentMorningBeats: {} });
    await manager.whenReady;

    const agent = manager.create({ name: 'Sable', role: 'engineer', personaText: 'p' });
    expect(agent.id).toMatch(/^res_/);
    expect(agent.morningHour).toBe(8);
    await manager.cleanup(); // flushes the persist chain

    const rows = await repo.listResidents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: agent.id, name: 'Sable', morning_hour: 8, enabled: 1 });
  });

  it('rejects a name whose @handle is taken, and frees it on rename', async () => {
    const manager = buildManager({ residentMorningBeats: {} });
    await manager.whenReady;
    const sable = manager.create({ name: 'Sable', role: 'engineer', personaText: 'p' });

    expect(() => manager.create({ name: 'sable', role: 'x', personaText: 'y' })).toThrow(/already/);
    expect(() => manager.create({ name: 'User', role: 'x', personaText: 'y' })).toThrow(/reserved/);

    // Rename is free — the address follows the name — and frees the old handle.
    manager.update(sable.id, { name: 'Quill' });
    const second = manager.create({ name: 'Sable', role: 'x', personaText: 'y' });
    expect(second.id).not.toBe(sable.id);
  });

  it('setMemories replaces the agent, delete cascades and prunes DM rows', async () => {
    const manager = buildManager({ residentMorningBeats: {} });
    await manager.whenReady;
    const agent = manager.create({ name: 'Sable', role: 'engineer', personaText: 'p' });
    manager.setMemories(agent.id, [{ key: 'a', text: 'A', at: now }]);
    manager.post(`dm:${agent.id}:user`, 'hello there');

    manager.delete(agent.id);
    await manager.cleanup();

    expect(await repo.listResidents()).toEqual([]);
    expect(await repo.listResidentMemories(agent.id)).toEqual([]);
    expect(await repo.listResidentMessages(10)).toEqual([]);
  });
});

describe('assignment wakeup', () => {
  it('queues a WAKE_NOW assignment event for an enabled resident', async () => {
    const manager = buildManager({ residentMorningBeats: {} });
    await manager.whenReady;
    const agent = manager.create({ name: 'Sable', role: 'engineer', personaText: 'p' });

    manager.deliverAssignment(agent.id, { id: 'tkt_1', title: 'Fix the build', projectLabel: 'Launcher' });
    expect(manager.getStatus()[agent.id]!.pendingCount).toBe(1);
  });

  it('drops the event for disabled or unknown residents', async () => {
    const manager = buildManager({ residentMorningBeats: {} });
    await manager.whenReady;
    const agent = manager.create({ name: 'Sable', role: 'engineer', personaText: 'p' });
    manager.update(agent.id, { enabled: false });

    manager.deliverAssignment(agent.id, { id: 'tkt_1', title: 'Fix the build' });
    manager.deliverAssignment('nobody', { id: 'tkt_2', title: 'Nope' });
    expect(manager.getStatus()[agent.id]!.pendingCount).toBe(0);
  });
});
