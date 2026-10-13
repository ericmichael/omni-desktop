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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('protocols', () => {
  it('Omni is seeded with one; a bot revises its own and the versions keep; a hire can carry a draft', async () => {
    const manager = buildManager({ residentMorningBeats: {} });
    await manager.whenReady;
    const seeded = manager.getProtocol('omni');
    expect(seeded).toMatchObject({ version: 1, author: 'seed' });
    expect(seeded!.body).toContain('How I operate');
    // The block rides in the instructions, first.
    const instructions = (manager as unknown as { identityInstructions: (id: string) => string }).identityInstructions(
      'omni'
    );
    expect(instructions.indexOf('How you operate (your protocol, v1)')).toBeLessThan(
      instructions.indexOf('About the user') === -1 ? Infinity : instructions.indexOf('About the user')
    );
    // A bot revises its own.
    const revised = await manager.handleProtocolTool('omni', 'update_protocol', {
      body: '# v2\nDo less.',
      note: 'trimmed',
    });
    expect(revised.version).toBe(2);
    expect(manager.getProtocol('omni')!.body).toBe('# v2\nDo less.');
    const versions = await manager.listProtocolVersions('omni');
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[0]!.note).toBe('trimmed');
    await expect(manager.handleProtocolTool('omni', 'update_protocol', { body: '  ', note: 'x' })).rejects.toThrow(
      /empty/
    );
    // A hire carries the drafted protocol, attributed to the hirer.
    await manager.handleRosterTool('omni', 'create_bot', {
      name: 'Mara',
      role: 'QA engineer',
      personaText: 'You test things.',
      protocol: '# Mara\n- Test before trusting.',
    });
    const mara = manager.chatRoster().find((a) => a.name === 'Mara')!;
    expect(manager.getProtocol(mara.id)).toMatchObject({ version: 1, author: 'omni' });
    // A bot with none gets told to write one.
    const bare = manager.create({ name: 'Quill', role: 'writer', personaText: 'p' });
    expect(
      (manager as unknown as { identityInstructions: (id: string) => string }).identityInstructions(bare.id)
    ).toContain('no protocol yet');
  });
});

describe('roster tools', () => {
  it('let a superuser hire a paused bot and reshape others, never Omni or itself', async () => {
    const manager = buildManager({ residentMorningBeats: {} });
    await manager.whenReady;
    const plain = manager.create({ name: 'Quill', role: 'writer', personaText: 'p' });
    await expect(
      manager.handleRosterTool(plain.id, 'create_bot', { name: 'X', role: 'y', personaText: 'z' })
    ).rejects.toThrow(/superuser/);
    const hired = await manager.handleRosterTool('omni', 'create_bot', {
      name: 'Mara',
      role: 'QA engineer',
      personaText: 'You test things.',
      superuser: true,
    });
    const mara = manager.chatRoster().find((a) => a.name === 'Mara');
    expect(mara).toMatchObject({ enabled: false });
    expect(mara?.superuser).toBeUndefined();
    expect(hired.note).toMatch(/paused/);
    await expect(manager.handleRosterTool('omni', 'update_bot', { id: 'omni', role: 'x' })).rejects.toThrow(/Omni/);
    await expect(manager.handleRosterTool('omni', 'update_bot', { id: mara!.id, enabled: true })).rejects.toThrow(
      /Nothing to change/
    );
    await manager.handleRosterTool('omni', 'update_bot', { id: mara!.id, role: 'release engineer' });
    expect(manager.chatRoster().find((a) => a.id === mara!.id)?.role).toBe('release engineer');
  });
});

describe('user profile', () => {
  it("is validated, stored, and lands in every bot's instructions", async () => {
    const manager = buildManager({ residentMorningBeats: {} });
    await manager.whenReady;
    expect(manager.getUserProfile().roles).toEqual([]);
    expect(() => manager.setUserProfile({ roles: ['Wizard'] })).toThrow(/Unknown role/);
    const saved = manager.setUserProfile({ roles: ['Founder', 'Engineer', 'Founder'], roleNote: '  ships weekly  ' });
    expect(saved).toMatchObject({ roles: ['Founder', 'Engineer'], roleNote: 'ships weekly' });
    expect(manager.getUserProfile()).toEqual(saved);
    // The block rides with identity, as the goals do.
    const instructions = (manager as unknown as { identityInstructions: (id: string) => string }).identityInstructions(
      'omni'
    );
    expect(instructions).toContain('Roles: Founder, Engineer.');
    expect(instructions).toContain('In their words: ships weekly');
  });
});

describe('Omni, the built-in chief of staff', () => {
  it('is seeded once into any roster, cannot be deleted, and is the default pin', async () => {
    const first = buildManager({ residentMorningBeats: {} });
    await first.whenReady;
    const omni = first.chatRoster().find((a) => a.id === 'omni');
    expect(omni).toMatchObject({ name: 'Omni', role: 'Chief of Staff', superuser: true, enabled: true });
    expect(first.getPrimaryAgent()).toBe('omni');
    expect(() => first.delete('omni')).toThrow(/cannot be deleted/);
    // A rename sticks: the row, not the definition, is the source of truth.
    first.update('omni', { name: 'Ada' });
    await first.cleanup();
    const second = buildManager({ residentMorningBeats: {} });
    await second.whenReady;
    expect(second.chatRoster().filter((a) => a.id === 'omni')).toHaveLength(1);
    expect(second.chatRoster().find((a) => a.id === 'omni')?.name).toBe('Ada');
  });
});

describe('store→db migration + hydration', () => {
  it('moves all five datasets, normalizes legacy shapes, and clears the store keys', async () => {
    const storeData = legacyStoreData();
    const manager = buildManager(storeData);
    await manager.whenReady;

    const snapshot = manager.getDurableSnapshot();
    // Omni is seeded after the migrated rows.
    expect(snapshot.residentAgents.map((a) => a.id)).toEqual(['sable', 'quill', 'omni']);
    // projectId folded into projectIds; implicit morning hour materialized.
    expect(snapshot.residentAgents[0]).toMatchObject({ projectIds: ['proj_a'], morningHour: 8 });
    expect(snapshot.residentAgents[1]).toMatchObject({ morningHour: null, enabled: false });
    // Legacy {id,text} memory got a slug key; the orphan was skipped.
    expect(snapshot.residentMemories['sable']![0]!.key).toBe('the-deploy-window-is-friday');
    expect(snapshot.residentMemories['ghost']).toBeUndefined();
    // Channel data left the snapshot for chat-v1 — read it off the manager.
    const { messages } = await manager.listMessages({});
    expect(messages.map((m) => m.id)).toEqual([1, 2]);
    expect(
      manager
        .listChatChannels()
        .filter((c) => c.kind === 'named')
        .map((c) => c.id)
    ).toEqual(['deploy-log']);
    expect(snapshot.residentAlarms['sable']).toHaveLength(1);

    // Store keys are cleared — the migration is one-shot.
    expect(storeData.residentAgents).toEqual([]);
    expect(storeData.residentChannels).toEqual([]);

    // And the rows really are in the DB.
    expect((await repo.listResidents()).map((r) => r.id).sort()).toEqual(['omni', 'quill', 'sable']);
  });

  it('seeds the team handbook on first boot and leaves an existing one alone', async () => {
    const manager = buildManager({ residentMorningBeats: {} });
    await manager.whenReady;
    const seeded = await repo.getTeamHandbook();
    expect(seeded?.body).toContain('YOURS ALONE');

    await repo.setTeamHandbook('my rules', null, '2026-07-24 08:00:00.000');
    const second = buildManager({ residentMorningBeats: {} });
    await second.whenReady;
    expect((await repo.getTeamHandbook())?.body).toBe('my rules');
  });

  it('is idempotent: a second boot hydrates from the DB without duplicating', async () => {
    const storeData = legacyStoreData();
    const first = buildManager(storeData);
    await first.whenReady;
    await first.cleanup();

    const second = buildManager(storeData);
    await second.whenReady;
    expect(second.getDurableSnapshot().residentAgents).toHaveLength(3);
    expect(await repo.listResidents()).toHaveLength(3);
  });
});

describe('write-through persistence', () => {
  it('create() mints an opaque res_ id; no morning beat unless opted in (quiet-start)', async () => {
    const manager = buildManager({ residentMorningBeats: {} });
    await manager.whenReady;

    const agent = manager.create({ name: 'Sable', role: 'engineer', personaText: 'p' });
    expect(agent.id).toMatch(/^res_/);
    expect(agent.morningHour).toBeNull();
    await manager.cleanup(); // flushes the persist chain

    const rows = await repo.listResidents();
    expect(rows.filter((r) => r.id !== 'omni')).toHaveLength(1);
    expect(rows.find((r) => r.id === agent.id)).toMatchObject({
      id: agent.id,
      name: 'Sable',
      morning_hour: null,
      enabled: 1,
    });
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

    expect((await repo.listResidents()).map((r) => r.id)).toEqual(['omni']);
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

describe('daily execution binding', () => {
  const setup = async () => {
    const manager = buildManager({});
    await manager.whenReady;
    const agent = manager.create({ name: 'Worker', role: 'engineer', personaText: '' });
    const internal = manager as any;
    const bindSession = vi.fn(async () => {});
    internal.processManager = {
      bindSession,
      getStatus: () => ({ type: 'running', data: { uiUrl: 'http://runtime', wsUrl: 'ws://runtime/ws' } }),
    };
    const watcher = {
      ensureSession: vi.fn(async () => {}),
      waitForRunEnd: vi.fn(async () => ({})),
      call: vi.fn(async () => {}),
      close: vi.fn(),
    };
    vi.spyOn(internal, 'ensureRunning').mockResolvedValue({ wsUrl: 'ws://runtime/ws' });
    vi.spyOn(internal, 'ensureWatcher').mockResolvedValue(watcher);
    vi.spyOn(internal, 'refreshHandbook').mockResolvedValue(undefined);
    return { manager, agent, internal, bindSession, watcher };
  };

  it('binds before ensuring an opened session, and propagates binding failures', async () => {
    const { manager, agent, bindSession, watcher } = await setup();
    const result = await manager.ensureSession(agent.id);
    expect(bindSession).toHaveBeenCalledWith(`agent:${agent.id}`, result.sessionId);
    expect(watcher.ensureSession).toHaveBeenCalledWith(
      result.sessionId,
      expect.objectContaining({ capability_profile: 'resident' }),
      expect.any(String)
    );
    expect(bindSession.mock.invocationCallOrder[0]).toBeLessThan(watcher.ensureSession.mock.invocationCallOrder[0]!);
    bindSession.mockRejectedValueOnce(new Error('stale environment'));
    await expect(manager.ensureSession(agent.id)).rejects.toThrow('stale environment');
    expect(watcher.ensureSession).toHaveBeenCalledTimes(1);
  });

  it('binds each wakeup before enqueueing and keeps one session when the day changes on a live process', async () => {
    const { agent, internal, bindSession, watcher } = await setup();
    vi.spyOn(internal, 'armParkTimer').mockImplementation(() => {});
    let clock = new Date('2026-09-12T12:00:00').getTime();
    internal.now = () => clock;
    internal.runtime(agent.id).pending.push({ kind: 'wake' });
    await internal.deliver(agent.id);
    expect(bindSession).toHaveBeenCalledWith(`agent:${agent.id}`, `resident-${agent.id}`);
    expect(bindSession.mock.invocationCallOrder[0]).toBeLessThan(watcher.call.mock.invocationCallOrder[0]!);
    clock = new Date('2026-09-13T12:00:00').getTime();
    internal.runtime(agent.id).pending.push({ kind: 'wake' });
    await internal.deliver(agent.id);
    expect(bindSession).toHaveBeenLastCalledWith(`agent:${agent.id}`, `resident-${agent.id}`);
    expect(watcher.call).toHaveBeenLastCalledWith(
      'enqueue_message',
      expect.objectContaining({ session_id: `resident-${agent.id}`, source: 'resident:wakeup' })
    );
  });

  it('also binds the active-run session-opening fast path', async () => {
    const { manager, agent, internal, bindSession, watcher } = await setup();
    const first = await manager.ensureSession(agent.id);
    internal.runtime(agent.id).thinking = true;
    internal.runtime(agent.id).watcher = watcher;
    bindSession.mockClear();
    const next = await manager.ensureSession(agent.id);
    expect(next.sessionId).toBe(first.sessionId);
    expect(bindSession).toHaveBeenCalledWith(`agent:${agent.id}`, first.sessionId);
  });

  it('binds the one continuous session before reflection enqueues work', async () => {
    const { agent, internal, bindSession, watcher } = await setup();
    internal.runtime(agent.id).day = '2020-01-01';
    await internal.reflectIfDayRolled(agent.id);
    expect(bindSession).toHaveBeenCalledWith(`agent:${agent.id}`, `resident-${agent.id}`);
    expect(watcher.call).toHaveBeenCalledWith(
      'enqueue_message',
      expect.objectContaining({ session_id: `resident-${agent.id}`, source: 'resident:reflect' })
    );
    expect(bindSession.mock.invocationCallOrder[0]).toBeLessThan(watcher.call.mock.invocationCallOrder[0]!);
  });
});

describe('resident execution settings', () => {
  it('defaults new residents to host with Guardian review', async () => {
    const manager = buildManager({});
    await manager.whenReady;
    const agent = manager.create({ name: 'Defaults', role: 'engineer', personaText: '' });
    expect(agent.profileName).toBe('host');
    expect(agent.approvalsReviewer).toBe('auto');
  });
  const setupExecution = async () => {
    const manager = buildManager({});
    await manager.whenReady;
    const agent = manager.create({ name: 'Policy tester', role: 'engineer', personaText: '', profileName: 'devbox' });
    const internal = manager as any;
    const watcher = {
      ensureSession: vi.fn(async () => {}),
      setReviewer: vi.fn(async () => {}),
      close: vi.fn(),
      refreshSessions: vi.fn(async () => {}),
    };
    internal.processManager = {
      validateProfileSelection: vi.fn(),
      bindSession: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      getStatus: () => ({ type: 'running', data: { uiUrl: 'http://runtime', wsUrl: 'ws://runtime/ws' } }),
    };
    vi.spyOn(internal, 'ensureRunning').mockResolvedValue({ wsUrl: 'ws://runtime/ws' });
    vi.spyOn(internal, 'ensureWatcher').mockResolvedValue(watcher);
    vi.spyOn(internal, 'armParkTimer').mockImplementation(() => {});
    return { manager, agent, internal, watcher };
  };

  it('persists review preference and reapplies it after manager hydration', async () => {
    const { manager, agent, internal, watcher } = await setupExecution();
    internal.runtime(agent.id).watcher = watcher;
    internal.runtime(agent.id).thinking = true;
    await manager.configureExecution(agent.id, { approvalsReviewer: 'user' });
    expect(watcher.setReviewer).toHaveBeenCalledWith('user');
    expect((await repo.listResidents()).find((a) => a.id === agent.id)?.approvals_reviewer).toBe('user');
    const reloaded = buildManager({});
    await reloaded.whenReady;
    expect(reloaded.getDurableSnapshot().residentAgents.find((a) => a.id === agent.id)?.approvalsReviewer).toBe('user');
    expect(internal.processManager.stop).not.toHaveBeenCalled();
  });

  it('binds the prepared environment and policy before a switch succeeds', async () => {
    const { manager, agent, internal, watcher } = await setupExecution();
    await manager.configureExecution(agent.id, { profileName: 'host', approvalsReviewer: 'user' });
    expect(manager.getDurableSnapshot().residentAgents.find((a) => a.id === agent.id)?.profileName).toBe('host');
    expect(internal.processManager.stop).toHaveBeenCalledWith(`agent:${agent.id}`);
    expect(watcher.ensureSession).toHaveBeenCalledWith(`resident-${agent.id}`, expect.anything(), 'user');
    expect(internal.processManager.bindSession.mock.invocationCallOrder[0]).toBeLessThan(
      watcher.ensureSession.mock.invocationCallOrder[0]!
    );
  });

  it('restores the old selection and runtime after preparation fails', async () => {
    const { manager, agent, internal } = await setupExecution();
    internal.ensureRunning.mockRejectedValueOnce(new Error('cannot materialize host sources'));
    await expect(manager.configureExecution(agent.id, { profileName: 'host' })).rejects.toThrow(
      'previous selection was restored'
    );
    expect(manager.getDurableSnapshot().residentAgents.find((a) => a.id === agent.id)?.profileName).toBe('devbox');
    expect(internal.ensureRunning).toHaveBeenCalledTimes(2);
    expect((await repo.listResidents()).find((a) => a.id === agent.id)?.profile_name).toBe('devbox');
  });

  it('does not stop an active run or silently accept an unavailable profile', async () => {
    const { manager, agent, internal } = await setupExecution();
    internal.runtime(agent.id).thinking = true;
    await expect(manager.configureExecution(agent.id, { profileName: 'host' })).rejects.toThrow(
      'Finish the current run'
    );
    expect(internal.processManager.stop).not.toHaveBeenCalled();
    internal.runtime(agent.id).thinking = false;
    internal.processManager.validateProfileSelection.mockImplementationOnce(() => {
      throw new Error('unavailable');
    });
    await expect(manager.configureExecution(agent.id, { profileName: 'host' })).rejects.toThrow('unavailable');
    expect(internal.processManager.stop).not.toHaveBeenCalled();
  });

  it('rejects an approval preference that would bypass review', async () => {
    const { manager, agent } = await setupExecution();
    await expect(manager.configureExecution(agent.id, { approvalsReviewer: 'always' as any })).rejects.toThrow(
      'Guardian review or human'
    );
  });
});

it('user goals persist independently of residents and expose no completion tool', async () => {
  const data: Partial<StoreData> = {};
  const manager = buildManager(data);
  await manager.whenReady;
  const goal = await manager.userGoalCommand({ kind: 'create', title: 'Find a direction', notes: '' });
  expect(goal.completedAt).toBeNull();
  expect(data.userGoals?.[0]?.id).toBe(goal.id);
  await expect(
    manager.userGoalCommand({ kind: 'set_completed', id: goal.id, completed: true }, { kind: 'agent', agentId: 'a' })
  ).rejects.toThrow('Only the user');
  const again = buildManager(data);
  await again.whenReady;
  expect(again.listUserGoals()[0]!.title).toBe('Find a direction');
  await again.userGoalCommand({ kind: 'set_completed', id: goal.id, completed: true });
  expect(again.listUserGoals()[0]!.completedAt).toBe(now);
});

it('idea decisions persist for missing residents without starting a session or completing their goal', async () => {
  const data: Partial<StoreData> = {};
  const manager = buildManager(data);
  await manager.whenReady;
  const wake = vi.spyOn(manager, 'wake');
  const ensure = vi.spyOn(manager, 'ensureSession');
  const goal = await manager.userGoalCommand({ kind: 'create', title: 'Improve onboarding' });
  const idea = await manager.userIdeaCommand(
    {
      kind: 'propose',
      goalId: goal.id,
      title: 'Review onboarding',
      plan: 'Write a review',
      authorization: 'A written review only',
    },
    { kind: 'agent', agentId: 'quill' }
  );
  await manager.userIdeaCommand({ kind: 'decide', id: idea.id, status: 'approved' });
  expect(wake).not.toHaveBeenCalled();
  expect(ensure).not.toHaveBeenCalled();
  expect(Object.keys(manager.getStatus())).toEqual(['omni']);
  expect(manager.listUserGoals()[0]!.completedAt).toBeNull();
  const again = buildManager(data);
  await again.whenReady;
  expect(again.listUserIdeas()[0]).toMatchObject({ id: idea.id, status: 'approved', agentId: 'quill' });
});

for (const status of ['approved', 'dismissed'] as const) {
  it(`wakes the proposing resident once when an idea is ${status}`, async () => {
    const data: Partial<StoreData> = {};
    const manager = buildManager(data);
    await manager.whenReady;
    const agent = manager.create({ name: 'Sable', role: 'engineer', personaText: 'p' });
    const goal = await manager.userGoalCommand({ kind: 'create', title: 'Improve onboarding' });
    const events = vi.spyOn(manager, 'dispatchEvent');
    const idea = await manager.userIdeaCommand(
      { kind: 'propose', goalId: goal.id, title: 'Review', plan: 'Write a review', authorization: 'Draft only' },
      { kind: 'agent', agentId: agent.id }
    );
    expect(events).not.toHaveBeenCalled();
    await Promise.all([
      manager.userIdeaCommand({ kind: 'decide', id: idea.id, status }),
      manager.userIdeaCommand({ kind: 'decide', id: idea.id, status }),
    ]);
    expect(events).toHaveBeenCalledTimes(1);
    expect(events).toHaveBeenCalledWith(
      agent.id,
      expect.objectContaining({ kind: 'idea_decision', from: 'user', detail: expect.stringContaining(idea.id) })
    );
    expect(events.mock.calls[0]![1].detail).toContain(
      status === 'approved' ? 'within its authorization scope' : 'Do not execute'
    );
    expect(manager.getStatus()[agent.id]!.pendingCount).toBeGreaterThan(0);
    expect(manager.listUserGoals()[0]!.completedAt).toBeNull();
    expect(data.userIdeas![0]!.status).toBe(status);
  });
}

it('keeps disabled residents paused when their ideas are reviewed', async () => {
  const manager = buildManager({});
  await manager.whenReady;
  const agent = manager.create({ name: 'Sable', role: 'engineer', personaText: 'p' });
  manager.update(agent.id, { enabled: false });
  const goal = await manager.userGoalCommand({ kind: 'create', title: 'Improve onboarding' });
  const idea = await manager.userIdeaCommand(
    { kind: 'propose', goalId: goal.id, title: 'Review', plan: 'Write a review', authorization: 'Draft only' },
    { kind: 'agent', agentId: agent.id }
  );
  await manager.userIdeaCommand({ kind: 'decide', id: idea.id, status: 'approved' });
  expect(manager.getStatus()[agent.id]!.pendingCount).toBe(0);
  expect(manager.listUserIdeas()[0]!.status).toBe('approved');
});

it('does not wake a resident when persisting the decision fails', async () => {
  const manager = buildManager({});
  await manager.whenReady;
  const events = vi.spyOn(manager, 'dispatchEvent');
  (manager as any).store.userIdeaCommand = vi.fn().mockRejectedValue(new Error('Storage unavailable'));
  await expect(manager.userIdeaCommand({ kind: 'decide', id: 'i', status: 'approved' })).rejects.toThrow(
    'Storage unavailable'
  );
  expect(events).not.toHaveBeenCalled();
});
