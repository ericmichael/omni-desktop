// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { createPgPool, type PgPool, runPgMigrations } from 'omni-projects-db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ChatCommand } from '@/shared/chat-commands';
import type { CodeTab } from '@/shared/types';

import { CompositeSettingsStore } from './composite-settings-store';

// Run only against a disposable database: migrations are applied here.
const url = process.env.OMNI_TEST_SETTINGS_PG_URL;
describe.skipIf(!url)('PostgreSQL chat authority across independent settings caches', () => {
  let pool: PgPool;
  beforeAll(async () => {
    pool = createPgPool(url!);
    await runPgMigrations(pool);
  });
  afterAll(async () => {
    await pool?.end();
  });

  async function add(store: CompositeSettingsStore) {
    return (await store.chatCommand({ method: 'addTab', args: [] })) as CodeTab;
  }

  async function principal() {
    const id = randomUUID();
    await pool.query('INSERT INTO users (id) VALUES ($1)', [id]);
    return id;
  }

  it('retains both creations when two replicas start from the same snapshot', async () => {
    const user = await principal();
    const team = randomUUID();
    const a = new CompositeSettingsStore(pool, team, user, 'replica-A');
    const b = new CompositeSettingsStore(pool, team, user, 'replica-B');
    await Promise.all([a.whenReady, b.whenReady]);
    const [first, second] = await Promise.all([add(a), add(b)]);
    await Promise.all([a.flush(), b.flush()]);
    const restarted = new CompositeSettingsStore(pool, team, user, 'after-restart');
    await restarted.whenReady;
    expect(
      restarted
        .get('codeTabs')
        .map((tab) => tab.id)
        .sort()
    ).toEqual([first.id, second.id].sort());
  });

  it('retains removal jobs across restart and merges acknowledgements from stale replicas', async () => {
    const user = await principal();
    const team = randomUUID();
    const a = new CompositeSettingsStore(pool, team, user, 'A');
    const b = new CompositeSettingsStore(pool, team, user, 'B');
    await Promise.all([a.whenReady, b.whenReady]);
    const first = await add(a);
    const second = await add(a);
    await Promise.all([
      a.chatCommand({ method: 'removeTab', args: [first.id] }),
      b.chatCommand({ method: 'archiveTab', args: [second.id] }),
    ]);
    const restarted = new CompositeSettingsStore(pool, team, user);
    await restarted.whenReady;
    expect(restarted.get('codeTabs')).toEqual([]);
    expect(
      restarted
        .get('chatCleanupJobs')
        ?.map((job) => job.id)
        .sort()
    ).toEqual([first.id, second.id].sort());
    await a.acknowledgeChatCleanup(first.id);
    await b.acknowledgeChatCleanup(second.id);
    await restarted.reloadUser();
    expect(restarted.get('chatCleanupJobs')).toEqual([]);
  });

  it('rejects a delayed runtime claim after another replica closes its tab', async () => {
    const user = await principal();
    const team = randomUUID();
    const a = new CompositeSettingsStore(pool, team, user);
    const b = new CompositeSettingsStore(pool, team, user);
    await Promise.all([a.whenReady, b.whenReady]);
    const tab = await add(a);
    await b.chatCommand({ method: 'removeTab', args: [tab.id] });
    await expect(a.claimChatRuntime(tab.id, 'delayed-launcher')).rejects.toThrow('closed');
    await a.reloadUser();
    expect(a.get('chatCleanupJobs')?.map((job) => job.id)).toEqual([tab.id]);
  });

  it('does not erase another team overlay when the same user writes in two teams', async () => {
    const user = await principal();
    const teamA = randomUUID();
    const teamB = randomUUID();
    const a = new CompositeSettingsStore(pool, teamA, user);
    const b = new CompositeSettingsStore(pool, teamB, user);
    await Promise.all([a.whenReady, b.whenReady]);
    const first = await add(a);
    await a.flush();
    await add(b);
    await b.flush();
    await a.reloadUser();
    expect(a.get('codeTabs').map((tab) => tab.id)).toEqual([first.id]);
  });

  it('reports a rejected database write instead of resolving its durability barrier', async () => {
    const readOnlyUrl = new URL(url!);
    readOnlyUrl.searchParams.set('options', '-c default_transaction_read_only=on');
    const readOnlyPool = createPgPool(readOnlyUrl.toString());
    try {
      const store = new CompositeSettingsStore(readOnlyPool, randomUUID(), await principal());
      await store.whenReady;
      await expect(add(store)).rejects.toMatchObject({ code: '25006' });
      await expect(store.flush()).resolves.toBeUndefined();
      expect(store.get('codeTabs')).toEqual([]);
      const previous = store.get('defaultProfileName');
      store.set('defaultProfileName', 'failed-profile');
      expect(store.get('defaultProfileName')).toBe('failed-profile');
      await expect(store.flush()).rejects.toThrow();
      expect(store.get('defaultProfileName')).toBe(previous);
    } finally {
      await readOnlyPool.end();
    }
  });

  it('merges generic writes from stale caches and preserves synchronous read-after-set', async () => {
    const user = await principal();
    const a = new CompositeSettingsStore(pool, randomUUID(), user);
    const b = new CompositeSettingsStore(pool, randomUUID(), user);
    await Promise.all([a.whenReady, b.whenReady]);
    const first = await add(a);
    b.set('defaultProfileName', 'host');
    expect(b.get('defaultProfileName')).toBe('host');
    await b.flush();
    await a.reloadUser();
    expect(a.get('codeTabs').map((tab) => tab.id)).toEqual([first.id]);
  });

  it('publishes committed commands while later commands are queued', async () => {
    const store = new CompositeSettingsStore(pool, randomUUID(), await principal());
    await store.whenReady;
    const first = add(store);
    const second = add(store);
    const firstTab = await first;
    expect(store.get('codeTabs').map((tab) => tab.id)).toContain(firstTab.id);
    const secondTab = await second;
    expect(store.get('codeTabs').map((tab) => tab.id)).toEqual([firstTab.id, secondTab.id]);
  });

  it('rolls back a rejected command without poisoning subsequent writes', async () => {
    const store = new CompositeSettingsStore(pool, randomUUID(), await principal());
    await store.whenReady;
    await expect(store.chatCommand({ method: 'invalid', args: [] } as unknown as ChatCommand)).rejects.toThrow(
      'Invalid chat command'
    );
    const tab = await add(store);
    await expect(store.flush()).resolves.toBeUndefined();
    await store.reloadUser();
    expect(store.get('codeTabs').map((entry) => entry.id)).toEqual([tab.id]);
  });
});
