import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { _resetSnapshotStoreForTests, AzureBlobSnapshotStore, getSnapshotStore } from './snapshot-blob-store';

describe('snapshot-blob-store: selection', () => {
  beforeEach(() => _resetSnapshotStoreForTests());

  it('returns a no-op store when blob env is unset', async () => {
    const store = getSnapshotStore({});
    await expect(store.pull('s', '/tmp')).resolves.toBe(false);
    await expect(store.verify('s', '/tmp')).resolves.toBe(false);
    await expect(store.push('s', '/tmp')).resolves.toBe(false);
    await expect(store.remove('s')).resolves.toBeUndefined();
  });

  it('returns an AzureBlobSnapshotStore when account + key + container are set', () => {
    const store = getSnapshotStore({
      AZURE_STORAGE_ACCOUNT_NAME: 'acct',
      AZURE_STORAGE_ACCOUNT_KEY: 'k',
      OMNI_AZURE_SNAPSHOT_CONTAINER: 'snapshots',
    });
    expect(store).toBeInstanceOf(AzureBlobSnapshotStore);
  });

  it('falls back to no-op when only some env vars are set', () => {
    const store = getSnapshotStore({
      AZURE_STORAGE_ACCOUNT_NAME: 'acct',
      AZURE_STORAGE_ACCOUNT_KEY: 'k',
      // missing OMNI_AZURE_SNAPSHOT_CONTAINER
    });
    expect(store).not.toBeInstanceOf(AzureBlobSnapshotStore);
  });
});

describe('snapshot-blob-store: no-op behaviour', () => {
  beforeEach(() => _resetSnapshotStoreForTests());

  it('does not throw on missing session id', async () => {
    const store = getSnapshotStore({});
    await expect(store.pull('', '/tmp')).resolves.toBe(false);
    await expect(store.verify('', '/tmp')).resolves.toBe(false);
    await expect(store.push('', '/tmp')).resolves.toBe(false);
    await expect(store.remove('')).resolves.toBeUndefined();
  });

  it('only accepts a non-empty regular snapshot as locally durable', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'omni-snapshot-store-'));
    try {
      const store = getSnapshotStore({});
      writeFileSync(path.join(dir, 'empty.tar'), '');
      writeFileSync(path.join(dir, 'valid.tar'), 'snapshot');

      await expect(store.verify('empty', dir)).resolves.toBe(false);
      await expect(store.push('empty', dir)).resolves.toBe(false);
      await expect(store.verify('valid', dir)).resolves.toBe(true);
      await expect(store.push('valid', dir)).resolves.toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
