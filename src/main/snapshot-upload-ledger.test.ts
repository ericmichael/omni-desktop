import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SnapshotStore } from '@/main/snapshot-blob-store';
import { gcStaleSnapshots } from '@/main/snapshot-manager';
import {
  completePendingSnapshotUpload,
  listPendingSnapshotUploads,
  reconcilePendingSnapshotUploads,
  recordPendingSnapshotUpload,
} from '@/main/snapshot-upload-ledger';

const LEDGER_FILENAME = '.snapshot-upload-ledger.json';

describe('snapshot upload ledger', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'omni-snapshot-ledger-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const store = (durable: boolean): SnapshotStore => ({
    pull: vi.fn(async () => false),
    verify: vi.fn(async () => true),
    push: vi.fn(async () => durable),
    remove: vi.fn(async () => {}),
  });

  it('survives a restart-shaped reread and clears only after upload succeeds', async () => {
    expect(recordPendingSnapshotUpload('snapshot-restart', dir, 'retryable', 1_000)).toBe(true);
    expect(listPendingSnapshotUploads(dir)).toMatchObject([
      { snapshotRef: 'snapshot-restart', disposition: 'retryable', attempts: 1 },
    ]);

    const backend = store(true);
    await expect(reconcilePendingSnapshotUploads(dir, { store: backend, force: true, now: 2_000 })).resolves.toEqual({
      attempted: 1,
      persisted: ['snapshot-restart'],
      retryable: [],
      forcedUncertain: [],
    });
    expect(backend.verify).toHaveBeenCalledWith('snapshot-restart', dir);
    expect(backend.push).toHaveBeenCalledWith('snapshot-restart', dir);
    expect(listPendingSnapshotUploads(dir)).toEqual([]);
  });

  it('keeps failed startup recovery queued with bounded backoff metadata', async () => {
    recordPendingSnapshotUpload('snapshot-retry', dir, 'retryable', 1_000);

    await expect(
      reconcilePendingSnapshotUploads(dir, { store: store(false), force: true, now: 2_000 })
    ).resolves.toMatchObject({
      attempted: 1,
      persisted: [],
      retryable: ['snapshot-retry'],
    });
    const [pending] = listPendingSnapshotUploads(dir);
    expect(pending).toMatchObject({ snapshotRef: 'snapshot-retry', attempts: 2, updatedAt: 2_000 });
    expect(pending!.nextAttemptAt).toBeGreaterThan(2_000);

    await expect(
      reconcilePendingSnapshotUploads(dir, { store: store(true), force: true, now: 3_000 })
    ).resolves.toMatchObject({
      persisted: ['snapshot-retry'],
      retryable: [],
    });
  });

  it('never auto-uploads a forced-shutdown uncertainty entry', async () => {
    recordPendingSnapshotUpload('snapshot-forced', dir, 'forced-uncertain', 1_000);
    const backend = store(true);

    await expect(reconcilePendingSnapshotUploads(dir, { store: backend, force: true, now: 2_000 })).resolves.toEqual({
      attempted: 0,
      persisted: [],
      retryable: [],
      forcedUncertain: ['snapshot-forced'],
    });
    expect(backend.verify).not.toHaveBeenCalled();
    expect(backend.push).not.toHaveBeenCalled();
  });

  it('fails closed without overwriting a corrupt ledger or accepting path-like refs', async () => {
    const target = path.join(dir, LEDGER_FILENAME);
    writeFileSync(target, '{not-json', 'utf8');

    expect(recordPendingSnapshotUpload('../../secret', dir, 'retryable')).toBe(false);
    expect(recordPendingSnapshotUpload('snapshot-safe', dir, 'retryable')).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('{not-json');
    expect(() => listPendingSnapshotUploads(dir)).toThrow('Snapshot upload ledger is invalid');
    await expect(reconcilePendingSnapshotUploads(dir, { store: store(true), force: true })).rejects.toThrow(
      'Snapshot upload ledger is invalid'
    );
  });

  it('allows explicit deletion to clear a forced uncertainty record', () => {
    recordPendingSnapshotUpload('snapshot-delete', dir, 'forced-uncertain');

    expect(completePendingSnapshotUpload('snapshot-delete', dir)).toBe(true);
    expect(listPendingSnapshotUploads(dir)).toEqual([]);
  });

  it('protects every durable pending upload from stale snapshot GC', async () => {
    const target = path.join(dir, 'snapshot-protected.tar');
    writeFileSync(target, 'snapshot');
    utimesSync(target, 1, 1);
    recordPendingSnapshotUpload('snapshot-protected', dir, 'retryable');

    await expect(gcStaleSnapshots({ keep: new Set(), ttlMs: 1, dir })).resolves.toEqual([]);
    expect(readFileSync(target, 'utf8')).toBe('snapshot');
  });
});
