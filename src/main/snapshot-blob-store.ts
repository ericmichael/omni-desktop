/**
 * Snapshot pull/push backend.
 *
 * ``omni serve`` writes per-session sandbox-state tars to a local
 * ``--snapshot-dir``. On the launcher's host that's
 * ``<omni-config>/snapshots/<sessionId>.tar``. In the deployed cloud the
 * launcher container's disk is ephemeral — without an external sync those
 * tars are lost on every App Service container recycle.
 *
 * This module is a small lifecycle layer the launcher invokes around each
 * ``omni serve`` spawn:
 *
 *   * Before spawn: ``pull(sessionId, snapshotDir)`` — if the local tar is
 *     missing but a copy exists in blob, download it so omni serve can
 *     rehydrate from disk as usual.
 *   * After exit: ``push(sessionId, snapshotDir)`` — if a tar exists at the
 *     local path, upload it so it survives the launcher container being
 *     recycled.
 *   * Cascade delete: ``remove(sessionId)`` — called from the snapshot
 *     manager so blob copies don't outlive the renderer-side tab deletion.
 *
 * Selection happens at construction:
 *   * AzureBlobSnapshotStore — when AZURE_STORAGE_ACCOUNT_NAME,
 *     AZURE_STORAGE_ACCOUNT_KEY, and OMNI_AZURE_SNAPSHOT_CONTAINER are all
 *     set (cloud deploy). Uses ``@azure/storage-blob`` via a dynamic import
 *     so desktop builds don't pull the package in.
 *   * NullSnapshotStore — everywhere else (desktop, self-hosted single-
 *     tenant). The local tar IS the durable copy; no sync needed.
 */

import { existsSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SNAPSHOT_SUFFIX = '.tar';

const blobName = (sessionId: string): string => `${sessionId}${SNAPSHOT_SUFFIX}`;
const localPath = (snapshotDir: string, sessionId: string): string =>
  join(snapshotDir, blobName(sessionId));

export interface SnapshotStore {
  pull(sessionId: string, snapshotDir: string): Promise<boolean>;
  push(sessionId: string, snapshotDir: string): Promise<void>;
  remove(sessionId: string): Promise<void>;
}

class NullSnapshotStore implements SnapshotStore {
  async pull(): Promise<boolean> {
    return false;
  }
  async push(): Promise<void> {}
  async remove(): Promise<void> {}
}

// Minimal shape of `@azure/storage-blob` we use. Mirrors the pattern in
// AzureFilesArtifactStore so the package is a dynamic import — the desktop
// build never instantiates this class and never pays the bundle cost.
type AzureBlockBlobClient = {
  download: (offset?: number) => Promise<{ readableStreamBody?: NodeJS.ReadableStream }>;
  downloadToBuffer: () => Promise<Buffer>;
  uploadData: (data: Buffer) => Promise<unknown>;
  deleteIfExists: () => Promise<unknown>;
  exists: () => Promise<boolean>;
};
type AzureContainerClient = {
  createIfNotExists: () => Promise<unknown>;
  getBlockBlobClient: (name: string) => AzureBlockBlobClient;
};
type AzureBlobSdk = {
  StorageSharedKeyCredential: new (account: string, key: string) => unknown;
  BlobServiceClient: new (url: string, cred: unknown) => {
    getContainerClient: (name: string) => AzureContainerClient;
  };
};

export class AzureBlobSnapshotStore implements SnapshotStore {
  constructor(
    private readonly cfg: { account: string; key: string; container: string },
  ) {}

  private async container(): Promise<AzureContainerClient> {
    const specifier = '@azure/storage-blob';
    let sdk: AzureBlobSdk;
    try {
      sdk = (await import(/* @vite-ignore */ specifier)) as unknown as AzureBlobSdk;
    } catch (err) {
      throw new Error(
        '[snapshot-blob] @azure/storage-blob is required for cloud snapshot sync',
      );
    }
    const cred = new sdk.StorageSharedKeyCredential(this.cfg.account, this.cfg.key);
    const svc = new sdk.BlobServiceClient(
      `https://${this.cfg.account}.blob.core.windows.net`,
      cred,
    );
    const container = svc.getContainerClient(this.cfg.container);
    // Idempotent — succeeds whether or not the container already exists. The
    // bicep creates it at deploy, but local-dev / self-hosted-cloud may not.
    try {
      await container.createIfNotExists();
    } catch {
      // Permission failures here are tolerable as long as the container
      // exists; the blob ops below will surface a clearer error.
    }
    return container;
  }

  async pull(sessionId: string, snapshotDir: string): Promise<boolean> {
    if (!sessionId) return false;
    const dest = localPath(snapshotDir, sessionId);
    // If a local copy already exists, trust it — the launcher writes locally
    // on snapshot-end and the local path is the canonical input to omni
    // serve. Re-downloading would race with omni serve's own writes.
    if (existsSync(dest)) return false;
    try {
      const client = (await this.container()).getBlockBlobClient(blobName(sessionId));
      if (!(await client.exists())) return false;
      const buf = await client.downloadToBuffer();
      await writeFile(dest, buf);
      return true;
    } catch (err) {
      console.error(`[snapshot-blob] pull failed for ${sessionId}:`, err);
      return false;
    }
  }

  async push(sessionId: string, snapshotDir: string): Promise<void> {
    if (!sessionId) return;
    const src = localPath(snapshotDir, sessionId);
    if (!existsSync(src)) return;
    // Guard against zero-byte tars (omni serve crashed mid-write); a zero
    // byte upload would clobber a usable prior copy.
    try {
      const stat = statSync(src);
      if (stat.size === 0) return;
    } catch {
      return;
    }
    try {
      const buf = await readFile(src);
      const client = (await this.container()).getBlockBlobClient(blobName(sessionId));
      await client.uploadData(buf);
    } catch (err) {
      console.error(`[snapshot-blob] push failed for ${sessionId}:`, err);
    }
  }

  async remove(sessionId: string): Promise<void> {
    if (!sessionId) return;
    try {
      const client = (await this.container()).getBlockBlobClient(blobName(sessionId));
      await client.deleteIfExists();
    } catch (err) {
      console.error(`[snapshot-blob] remove failed for ${sessionId}:`, err);
    }
  }
}

let _store: SnapshotStore | undefined;

/** Lazily-resolved global. Cached so the SDK pool is shared across spawns. */
export function getSnapshotStore(env: NodeJS.ProcessEnv = process.env): SnapshotStore {
  if (_store) return _store;
  const account = env['AZURE_STORAGE_ACCOUNT_NAME'];
  const key = env['AZURE_STORAGE_ACCOUNT_KEY'];
  const container = env['OMNI_AZURE_SNAPSHOT_CONTAINER'];
  _store = account && key && container
    ? new AzureBlobSnapshotStore({ account, key, container })
    : new NullSnapshotStore();
  return _store;
}

/** Test-only — reset the cached store so a new env can be picked up. */
export function _resetSnapshotStoreForTests(): void {
  _store = undefined;
}
