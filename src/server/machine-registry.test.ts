import type { MachineRow, MachinesRepo } from 'omni-projects-db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

import { MachineRegistry } from '@/server/machine-registry';

const stubWs = (): WebSocket => ({ readyState: 1 }) as unknown as WebSocket;

/** Mock repo backed by an in-memory map keyed by `${principalId}::${machineId}`. */
class MockRepo {
  private rows = new Map<string, MachineRow>();
  register = vi.fn(async (principal: string, info: { machineId: string; label: string; platform: string }) => {
    const key = `${principal}::${info.machineId}`;
    const prev = this.rows.get(key);
    this.rows.set(key, {
      machine_id: info.machineId,
      principal_id: principal,
      label: info.label,
      platform: info.platform,
      registered_at: prev?.registered_at ?? new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    });
  });
  touch = vi.fn(async (principal: string, machineId: string) => {
    const row = this.rows.get(`${principal}::${machineId}`);
    if (row) {
      row.last_seen_at = new Date().toISOString();
    }
  });
  list = vi.fn(async (principal: string) => {
    return [...this.rows.values()].filter((r) => r.principal_id === principal);
  });
  get = vi.fn(async (principal: string, machineId: string) => {
    return this.rows.get(`${principal}::${machineId}`);
  });
  rename = vi.fn(async (principal: string, machineId: string, label: string) => {
    const row = this.rows.get(`${principal}::${machineId}`);
    if (row) {
      row.label = label;
    }
  });
  delete = vi.fn(async (principal: string, machineId: string) => {
    this.rows.delete(`${principal}::${machineId}`);
  });
}

describe('MachineRegistry', () => {
  let repo: MockRepo;
  let onChanged: ReturnType<typeof vi.fn>;
  let registry: MachineRegistry;

  beforeEach(() => {
    repo = new MockRepo();
    onChanged = vi.fn();
    registry = new MachineRegistry(repo as unknown as MachinesRepo, { onChanged });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('binds a WS and upserts the PG row', async () => {
    const ws = stubWs();
    const row = await registry.bindFromWs(ws, 'alice', { machineId: 'm-1', label: 'Mac', platform: 'darwin' });
    expect(row.label).toBe('Mac');
    expect(registry.getActiveWs('m-1')).toBe(ws);
    expect(registry.isOnline('m-1')).toBe(true);
    expect(onChanged).toHaveBeenCalledWith('alice');
  });

  it('last-WS-wins: a fresh bind replaces the prior WS', async () => {
    const wsA = stubWs();
    const wsB = stubWs();
    await registry.bindFromWs(wsA, 'alice', { machineId: 'm-1', label: 'Mac', platform: 'darwin' });
    await registry.bindFromWs(wsB, 'alice', { machineId: 'm-1', label: 'Mac', platform: 'darwin' });
    expect(registry.getActiveWs('m-1')).toBe(wsB);
    // releasing the old WS does nothing — it isn't the active binding anymore.
    expect(registry.releaseWs(wsA)).toBeNull();
    expect(registry.getActiveWs('m-1')).toBe(wsB);
  });

  it('releases the active binding when the bound WS closes', async () => {
    const ws = stubWs();
    await registry.bindFromWs(ws, 'alice', { machineId: 'm-1', label: 'Mac', platform: 'darwin' });
    const released = registry.releaseWs(ws);
    expect(released).toMatchObject({ machineId: 'm-1', principalId: 'alice', label: 'Mac', sessionsAnchored: [] });
    expect(registry.isOnline('m-1')).toBe(false);
    // The durable row stays — list() still returns it.
    expect(await repo.list('alice')).toHaveLength(1);
  });

  it('snapshots anchored sessions on release so the cloud can push host-offline', async () => {
    const ws = stubWs();
    await registry.bindFromWs(ws, 'alice', { machineId: 'm-1', label: 'Mac', platform: 'darwin' });
    registry.anchorSession('m-1', 's1');
    registry.anchorSession('m-1', 's2');
    const released = registry.releaseWs(ws);
    expect(released?.sessionsAnchored.sort()).toEqual(['s1', 's2']);
  });

  it('tracks anchored sessions per machine', async () => {
    const ws = stubWs();
    await registry.bindFromWs(ws, 'alice', { machineId: 'm-1', label: 'Mac', platform: 'darwin' });
    registry.anchorSession('m-1', 's1');
    registry.anchorSession('m-1', 's2');
    expect(registry.anchoredSessions('m-1').sort()).toEqual(['s1', 's2']);
    registry.releaseSession('m-1', 's1');
    expect(registry.anchoredSessions('m-1')).toEqual(['s2']);
  });

  it('preserves anchored sessions across a WS swap', async () => {
    const wsA = stubWs();
    const wsB = stubWs();
    await registry.bindFromWs(wsA, 'alice', { machineId: 'm-1', label: 'Mac', platform: 'darwin' });
    registry.anchorSession('m-1', 'persistent');
    await registry.bindFromWs(wsB, 'alice', { machineId: 'm-1', label: 'Mac', platform: 'darwin' });
    expect(registry.anchoredSessions('m-1')).toEqual(['persistent']);
  });

  it('listForPrincipal joins PG rows with the live online flag and marks self', async () => {
    const ws = stubWs();
    await registry.bindFromWs(ws, 'alice', { machineId: 'm-1', label: 'Mac', platform: 'darwin' });
    await registry.bindFromWs(stubWs(), 'alice', { machineId: 'm-2', label: 'PC', platform: 'win32' });

    const summaries = await registry.listForPrincipal('alice', 'm-1');
    expect(summaries.map((s) => s.machineId).sort()).toEqual(['m-1', 'm-2']);
    expect(summaries.find((s) => s.machineId === 'm-1')?.isSelf).toBe(true);
    expect(summaries.find((s) => s.machineId === 'm-2')?.isSelf).toBe(false);
    expect(summaries.every((s) => s.online)).toBe(true);
  });

  it('remove drops the row and the live binding', async () => {
    const ws = stubWs();
    await registry.bindFromWs(ws, 'alice', { machineId: 'm-1', label: 'Mac', platform: 'darwin' });
    await registry.remove('alice', 'm-1');
    expect(registry.getActiveWs('m-1')).toBeNull();
    expect(await repo.list('alice')).toEqual([]);
  });

  it('rename updates label both on disk and in-memory', async () => {
    const ws = stubWs();
    await registry.bindFromWs(ws, 'alice', { machineId: 'm-1', label: 'Old', platform: 'darwin' });
    await registry.rename('alice', 'm-1', 'New');
    const summaries = await registry.listForPrincipal('alice');
    expect(summaries[0]?.label).toBe('New');
  });
});
