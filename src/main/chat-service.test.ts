/**
 * chat-v1 facade (docs/chat-v1-plan.md): poster identity stamping, the
 * post/paging/channel surface over a real manager + SQLite repo, and the
 * chat-event stream. Delivery (sandbox boot, watchers) is out of scope —
 * assertions stop at event intake, exactly like the manager's own tests.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase, ProjectsRepo, SqliteProjectsRepo } from 'omni-projects-db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dmChannelId } from '@/lib/resident-agent';
import { ChatService, posterFromEvent } from '@/main/chat-service';
import type { ProcessManager } from '@/main/process-manager';
import { ResidentAgentManager } from '@/main/resident-agent-manager';
import type { ChatEvent, StoreData } from '@/shared/types';

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
let manager: ResidentAgentManager;
let service: ChatService;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'chat-service-test-'));
  db = openDatabase(join(tmpDir, 'projects.db'));
  repo = new SqliteProjectsRepo(new ProjectsRepo(db));
  manager = new ResidentAgentManager({
    store: createStore({ residentMorningBeats: {} }),
    repo,
    processManager: {} as ProcessManager,
    sendToWindow: () => {},
    getSnapshot: () => undefined,
    now: () => now,
  });
  await manager.whenReady;
  service = new ChatService(manager);
});

afterEach(async () => {
  await manager.cleanup();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Wait until the serialized persist chain has landed `n` log rows. */
const persisted = (n: number) =>
  vi.waitFor(async () => {
    const { messages } = await manager.listMessages({});
    expect(messages).toHaveLength(n);
    return messages;
  });

describe('posterFromEvent', () => {
  it('is the collective user for Electron events and single-user server contexts', () => {
    expect(posterFromEvent(null)).toEqual({ id: 'user', name: null });
    expect(posterFromEvent({ sender: {} })).toEqual({ id: 'user', name: null });
    expect(posterFromEvent({ tenantId: 'local', principalId: 'local' })).toEqual({ id: 'user', name: null });
  });

  it('is a named human when the principal differs from the tenant (teams cloud)', () => {
    expect(posterFromEvent({ tenantId: 'team-1', principalId: 'alice' })).toEqual({ id: 'human:alice', name: null });
  });

  it('carries the connection-time display name for named humans', () => {
    expect(posterFromEvent({ tenantId: 'team-1', principalId: 'alice', displayName: 'Alice Vimes' })).toEqual({
      id: 'human:alice',
      name: 'Alice Vimes',
    });
    expect(posterFromEvent({ tenantId: 'team-1', principalId: 'alice', displayName: '  ' })).toEqual({
      id: 'human:alice',
      name: null,
    });
  });
});

describe('hello', () => {
  it('reflects the stamped identity', () => {
    expect(service.hello({ id: 'human:alice', name: 'Alice' })).toEqual({
      protocol: 'chat-v1',
      self: { id: 'human:alice', name: 'Alice' },
      capabilities: [],
    });
  });
});

describe('post_message', () => {
  it('stores the collective user with NO display name — self-rendering is viewer-relative', async () => {
    const { message } = service.postMessage({ id: 'user', name: null }, { channel: 'team', text: 'hello team' });
    expect(message).toMatchObject({ channel: 'team', from: 'user', text: 'hello team' });
    expect(message.fromName).toBeUndefined();
    const [row] = await persisted(1);
    expect(row).toMatchObject({ from: 'user', text: 'hello team' });
  });

  it('wakes channel members: the routed message id shows up in presence queues', () => {
    const agent = manager.create({ name: 'Scout', role: 'engineer', personaText: '' });
    const { message } = service.postMessage({ id: 'user', name: null }, { channel: 'team', text: 'morning' });
    expect(service.getPresence().presence[agent.id]?.queuedMessageIds).toContain(message.id);
  });

  it('rejects unknown channels and #system', () => {
    expect(() => service.postMessage({ id: 'user', name: null }, { channel: 'nope', text: 'x' })).toThrow(
      /Unknown channel/
    );
    expect(() => service.postMessage({ id: 'user', name: null }, { channel: 'system', text: 'x' })).toThrow(
      /server-authored/
    );
  });

  it('gates asExternal on bridge scope, and requires it OF bridges', () => {
    expect(() =>
      service.postMessage(
        { id: 'user', name: null },
        { channel: 'team', text: 'x', asExternal: { network: 'slack', id: 'U7', displayName: 'Sam' } }
      )
    ).toThrow(/bridge scope/);
    expect(() =>
      service.postMessage({ id: 'bridge', name: null, bridge: true }, { channel: 'team', text: 'x' })
    ).toThrow(/asExternal/);
  });

  it('stamps bridged external users with the participant grammar + display name', () => {
    const { message } = service.postMessage(
      { id: 'bridge', name: null, bridge: true },
      { channel: 'team', text: 'from slack', asExternal: { network: 'slack', id: 'U7', displayName: 'Sam Vimes' } }
    );
    expect(message).toMatchObject({ from: 'ext:slack:U7', fromName: 'Sam Vimes', text: 'from slack' });
  });

  it('posts into a user↔agent DM and wakes the peer; agent↔agent DMs refuse', () => {
    const agent = manager.create({ name: 'Scout', role: 'engineer', personaText: '' });
    const other = manager.create({ name: 'Rex', role: 'reviewer', personaText: '' });
    const dm = `dm:${[agent.id, 'user'].sort().join(':')}`;
    const { message } = service.postMessage({ id: 'user', name: null }, { channel: dm, text: 'hi scout' });
    expect(service.getPresence().presence[agent.id]?.queuedMessageIds).toContain(message.id);
    const foreign = `dm:${[agent.id, other.id].sort().join(':')}`;
    expect(() => service.postMessage({ id: 'user', name: null }, { channel: foreign, text: 'x' })).toThrow(
      /Unknown channel/
    );
  });

  it('personal threads are single-writer: the named participant posts, everyone else observes', () => {
    const agent = manager.create({ name: 'Scout', role: 'engineer', personaText: '' });
    const alice = { id: 'human:alice', name: 'Alice' };
    const personal = dmChannelId('human:alice', agent.id);
    // Alice posts into her own thread and the agent wakes.
    const { message } = service.postMessage(alice, { channel: personal, text: 'hi from alice' });
    expect(message).toMatchObject({ channel: personal, from: 'human:alice', fromName: 'Alice' });
    expect(service.getPresence().presence[agent.id]?.queuedMessageIds).toContain(message.id);
    // Another human (or the collective user) may not post into it.
    expect(() => service.postMessage({ id: 'human:bob', name: 'Bob' }, { channel: personal, text: 'x' })).toThrow(
      /personal thread/
    );
    expect(() => service.postMessage({ id: 'user', name: null }, { channel: personal, text: 'x' })).toThrow(
      /personal thread/
    );
    // The collective thread stays open to named humans.
    const collective = dmChannelId('user', agent.id);
    expect(service.postMessage(alice, { channel: collective, text: 'also here' }).message.from).toBe('human:alice');
    // And bridged users get personal threads through the same rule.
    const bridged = service.postMessage(
      { id: 'bridge', name: null, bridge: true },
      {
        channel: dmChannelId('ext:slack:U7', agent.id),
        text: 'via slack',
        asExternal: { network: 'slack', id: 'U7', displayName: 'Sam' },
      }
    );
    expect(bridged.message.channel).toBe(dmChannelId('ext:slack:U7', agent.id));
  });
});

describe('list_messages paging', () => {
  beforeEach(async () => {
    service.createChannel({ name: 'deploy log' });
    for (let i = 0; i < 5; i++) {
      service.postMessage({ id: 'user', name: null }, { channel: 'team', text: `t${i}` });
      service.postMessage({ id: 'user', name: null }, { channel: 'deploy-log', text: `d${i}` });
    }
    await persisted(10);
  });

  it('defaults to the newest window with hasMore', async () => {
    const page = await service.listMessages({ limit: 4 });
    expect(page.hasMore).toBe(true);
    expect(page.messages.map((m) => m.text)).toEqual(['t3', 'd3', 't4', 'd4']);
  });

  it('pages forward from an `after` cursor (the resume path)', async () => {
    const all = (await service.listMessages({ limit: 100 })).messages;
    const cursor = all[3]!.id;
    const page = await service.listMessages({ after: cursor, limit: 3 });
    expect(page.messages.map((m) => m.id)).toEqual(all.slice(4, 7).map((m) => m.id));
    expect(page.hasMore).toBe(true);
    const tail = await service.listMessages({ after: all[all.length - 1]!.id, limit: 10 });
    expect(tail.messages).toEqual([]);
    expect(tail.hasMore).toBe(false);
  });

  it('scopes by channel and pages history with `before`', async () => {
    const teamOnly = await service.listMessages({ channel: 'team', limit: 100 });
    expect(teamOnly.messages.every((m) => m.channel === 'team')).toBe(true);
    expect(teamOnly.messages).toHaveLength(5);
    const newest = teamOnly.messages[teamOnly.messages.length - 1]!;
    const history = await service.listMessages({ channel: 'team', before: newest.id, limit: 2 });
    expect(history.messages.map((m) => m.text)).toEqual(['t2', 't3']);
    expect(history.hasMore).toBe(true);
  });
});

describe('channels + roster', () => {
  it('lists team, named defs, a DM per roster agent, and system', () => {
    const agent = manager.create({ name: 'Scout', role: 'engineer', personaText: '' });
    service.createChannel({ name: 'Deploy Log', description: 'deploys' });
    const { channels } = service.listChannels();
    expect(channels[0]).toEqual({ id: 'team', kind: 'team' });
    expect(channels).toContainEqual({ id: 'deploy-log', kind: 'named', description: 'deploys', createdAt: now });
    expect(channels).toContainEqual({
      id: `dm:${[agent.id, 'user'].sort().join(':')}`,
      kind: 'dm',
      dmParticipants: [agent.id, 'user'].sort(),
    });
    expect(channels[channels.length - 1]).toEqual({ id: 'system', kind: 'system' });
  });

  it('projects the roster for addressing only', () => {
    manager.create({ name: 'Scout Rider', role: 'engineer', personaText: 'secret persona' });
    const { agents } = service.listRoster();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ handle: 'scout-rider', name: 'Scout Rider', role: 'engineer', enabled: true });
    expect('personaText' in agents[0]!).toBe(false);
  });

  it('new agents default to NO morning beat — proactivity is opt-in (quiet-start)', () => {
    const quiet = manager.create({ name: 'Quiet', role: 'engineer', personaText: '' });
    expect(quiet.morningHour).toBeNull();
    const proactive = manager.create({ name: 'Early', role: 'planner', personaText: '', morningHour: 7 });
    expect(proactive.morningHour).toBe(7);
  });
});

describe('chat events', () => {
  it('emits message_added, channel_changed, and roster_changed', () => {
    const events: ChatEvent[] = [];
    const unsubscribe = service.subscribe((e) => events.push(e));
    manager.create({ name: 'Scout', role: 'engineer', personaText: '' });
    service.createChannel({ name: 'ops' });
    service.postMessage({ id: 'user', name: null }, { channel: 'ops', text: 'hi' });
    service.deleteChannel({ channelId: 'ops' });
    unsubscribe();
    const methods = events.map((e) => e.method);
    expect(methods).toContain('chat.roster_changed');
    expect(methods).toContain('chat.message_added');
    expect(events).toContainEqual({
      method: 'chat.channel_changed',
      params: { channel: { id: 'ops', kind: 'named', createdAt: now } },
    });
    expect(events).toContainEqual({ method: 'chat.channel_changed', params: { deletedId: 'ops' } });
  });
});
