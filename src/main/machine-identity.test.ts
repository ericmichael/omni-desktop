import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { getOrCreateMachineIdentity, renameMachine } from '@/main/machine-identity';

const mktmp = (): string => mkdtempSync(join(tmpdir(), 'machine-id-'));

describe('machine-identity', () => {
  it('mints + persists an identity on first call, returns it verbatim on the next', () => {
    const dir = mktmp();
    const first = getOrCreateMachineIdentity(dir);
    expect(first.machineId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.label.length).toBeGreaterThan(0);
    expect(['darwin', 'linux', 'win32', 'freebsd', 'openbsd', 'sunos', 'aix'].includes(first.platform)).toBe(true);

    const second = getOrCreateMachineIdentity(dir);
    expect(second).toEqual(first);
  });

  it('writes a readable JSON file to <configDir>/machine.json', () => {
    const dir = mktmp();
    const identity = getOrCreateMachineIdentity(dir);
    const parsed = JSON.parse(readFileSync(join(dir, 'machine.json'), 'utf-8'));
    expect(parsed).toEqual(identity);
  });

  it('preserves a pre-existing machineId if the file is partially-written', () => {
    const dir = mktmp();
    writeFileSync(join(dir, 'machine.json'), `${JSON.stringify({ machineId: 'pre-existing-id' })}\n`, 'utf-8');
    const identity = getOrCreateMachineIdentity(dir);
    expect(identity.machineId).toBe('pre-existing-id');
    expect(identity.label).toBeTruthy();
    expect(identity.platform).toBeTruthy();
  });

  it('renameMachine keeps the id, updates the label, persists', () => {
    const dir = mktmp();
    const first = getOrCreateMachineIdentity(dir);
    const renamed = renameMachine(dir, 'My Laptop');
    expect(renamed.machineId).toBe(first.machineId);
    expect(renamed.label).toBe('My Laptop');
    const reread = getOrCreateMachineIdentity(dir);
    expect(reread.label).toBe('My Laptop');
  });

  it('survives a corrupt file by regenerating', () => {
    const dir = mktmp();
    writeFileSync(join(dir, 'machine.json'), 'not-json', 'utf-8');
    const identity = getOrCreateMachineIdentity(dir);
    expect(identity.machineId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
