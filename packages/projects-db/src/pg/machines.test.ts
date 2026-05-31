/**
 * Integration tests for MachinesRepo. Gated on OMNI_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPgPool, type Pool, runPgMigrations } from './connection.js';
import { ControlPlaneRepo } from './control-plane.js';
import { MachinesRepo } from './machines.js';

const URL = process.env['OMNI_TEST_DATABASE_URL'];

describe.skipIf(!URL)('MachinesRepo (live Postgres)', () => {
  let pool: Pool;
  let control: ControlPlaneRepo;
  let repo: MachinesRepo;

  beforeAll(async () => {
    pool = createPgPool(URL!);
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runPgMigrations(pool);
    control = new ControlPlaneRepo(pool);
    repo = new MachinesRepo(pool);
    await control.ensureUser('alice');
    await control.ensureUser('bob');
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE machines CASCADE');
  });

  it('register upserts and bumps last_seen on second call', async () => {
    await repo.register('alice', { machineId: 'm-1', label: 'Eric-Mac', platform: 'darwin' });
    const first = await repo.get('alice', 'm-1');
    expect(first?.label).toBe('Eric-Mac');

    await new Promise((r) => setTimeout(r, 10));
    await repo.register('alice', { machineId: 'm-1', label: 'Eric-Mac (renamed)', platform: 'darwin' });
    const second = await repo.get('alice', 'm-1');
    expect(second?.label).toBe('Eric-Mac (renamed)');
    expect(second!.last_seen_at).not.toBe(first!.last_seen_at);
  });

  it('list returns only the calling principal’s machines', async () => {
    await repo.register('alice', { machineId: 'm-a', label: 'A', platform: 'linux' });
    await repo.register('bob', { machineId: 'm-b', label: 'B', platform: 'win32' });
    expect((await repo.list('alice')).map((m) => m.machine_id)).toEqual(['m-a']);
    expect((await repo.list('bob')).map((m) => m.machine_id)).toEqual(['m-b']);
  });

  it('rename updates label without touching registered_at', async () => {
    await repo.register('alice', { machineId: 'm-1', label: 'Old', platform: 'darwin' });
    const before = await repo.get('alice', 'm-1');
    await repo.rename('alice', 'm-1', 'New');
    const after = await repo.get('alice', 'm-1');
    expect(after?.label).toBe('New');
    expect(after!.registered_at).toBe(before!.registered_at);
  });

  it('delete is scoped to the principal', async () => {
    await repo.register('alice', { machineId: 'm-1', label: 'A', platform: 'darwin' });
    // Bob cannot delete alice's machine.
    await repo.delete('bob', 'm-1');
    expect(await repo.get('alice', 'm-1')).toBeDefined();
    await repo.delete('alice', 'm-1');
    expect(await repo.get('alice', 'm-1')).toBeUndefined();
  });

  it('touch bumps last_seen_at', async () => {
    await repo.register('alice', { machineId: 'm-1', label: 'A', platform: 'darwin' });
    const before = await repo.get('alice', 'm-1');
    await new Promise((r) => setTimeout(r, 10));
    await repo.touch('alice', 'm-1');
    const after = await repo.get('alice', 'm-1');
    expect(after!.last_seen_at).not.toBe(before!.last_seen_at);
  });

  it('cascades when the user row is deleted', async () => {
    await repo.register('alice', { machineId: 'm-1', label: 'A', platform: 'darwin' });
    await pool.query(`DELETE FROM users WHERE id = 'alice'`);
    expect(await repo.get('alice', 'm-1')).toBeUndefined();
    await control.ensureUser('alice'); // restore for other tests
  });
});
