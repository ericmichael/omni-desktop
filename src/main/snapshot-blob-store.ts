/**
 * Snapshot pull/push backend.
 *
 * AgentHost environments write per-Workspace sandbox-state tars to a shared
 * ``--snapshot-dir``. On the launcher's host that's
 * ``<omni-config>/snapshots/<snapshotRef>.tar``. In the deployed cloud the
 * launcher container's disk is ephemeral — without an external sync those
 * tars are lost on every App Service container recycle.
 *
 * This module is a small lifecycle layer the launcher invokes around each
 * consumer environment:
 *
 *   * Before materialization: ``pull(snapshotRef, snapshotDir)`` — if the
 *     local tar is missing but a copy exists in blob, download it.
 *   * After environment stop: ``push(snapshotRef, snapshotDir)`` — if a tar
 *     exists at the local path, upload it so it survives host recycling.
 *   * Cascade delete: ``remove(snapshotRef)`` — called from the snapshot
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

const blobName = (snapshotRef: string): string => `${snapshotRef}${SNAPSHOT_SUFFIX}`;
const localPath = (snapshotDir: string, snapshotRef: string): string => join(snapshotDir, blobName(snapshotRef));

export interface SnapshotStore {
  pull(snapshotRef: string, snapshotDir: string): Promise<boolean>;
  push(snapshotRef: string, snapshotDir: string): Promise<void>;
  remove(snapshotRef: string): Promise<void>;
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
  BlobServiceClient: new (
    url: string,
    cred: unknown
  ) => {
    getContainerClient: (name: string) => AzureContainerClient;
  };
};

export class AzureBlobSnapshotStore implements SnapshotStore {
  constructor(private readonly cfg: { account: string; key: string; container: string }) {}

  private async container(): Promise<AzureContainerClient> {
    const specifier = '@azure/storage-blob';
    let sdk: AzureBlobSdk;
    try {
      sdk = (await import(/* @vite-ignore */ specifier)) as unknown as AzureBlobSdk;
    } catch {
      throw new Error('[snapshot-blob] @azure/storage-blob is required for cloud snapshot sync');
    }
    const cred = new sdk.StorageSharedKeyCredential(this.cfg.account, this.cfg.key);
    const svc = new sdk.BlobServiceClient(`https://${this.cfg.account}.blob.core.windows.net`, cred);
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

  async pull(snapshotRef: string, snapshotDir: string): Promise<boolean> {
    if (!snapshotRef) {
      return false;
    }
    const dest = localPath(snapshotDir, snapshotRef);
    // If a local copy already exists, trust it — the launcher writes locally
    // on snapshot-end and the local path is the canonical input to omni
    // serve. Re-downloading would race with omni serve's own writes.
    if (existsSync(dest)) {
      return false;
    }
    try {
      const client = (await this.container()).getBlockBlobClient(blobName(snapshotRef));
      if (!(await client.exists())) {
        return false;
      }
      const buf = await client.downloadToBuffer();
      await writeFile(dest, buf);
      return true;
    } catch (err) {
      console.error(`[snapshot-blob] pull failed for ${snapshotRef}:`, err);
      return false;
    }
  }

  async push(snapshotRef: string, snapshotDir: string): Promise<void> {
    if (!snapshotRef) {
      return;
    }
    const src = localPath(snapshotDir, snapshotRef);
    if (!existsSync(src)) {
      return;
    }
    // Guard against zero-byte tars (omni serve crashed mid-write); a zero
    // byte upload would clobber a usable prior copy.
    try {
      const stat = statSync(src);
      if (stat.size === 0) {
        return;
      }
    } catch {
      return;
    }
    try {
      const buf = await readFile(src);
      const client = (await this.container()).getBlockBlobClient(blobName(snapshotRef));
      await client.uploadData(buf);
    } catch (err) {
      console.error(`[snapshot-blob] push failed for ${snapshotRef}:`, err);
    }
  }

  async remove(snapshotRef: string): Promise<void> {
    if (!snapshotRef) {
      return;
    }
    try {
      const client = (await this.container()).getBlockBlobClient(blobName(snapshotRef));
      await client.deleteIfExists();
    } catch (err) {
      console.error(`[snapshot-blob] remove failed for ${snapshotRef}:`, err);
    }
  }
}

let _store: SnapshotStore | undefined;

/** Lazily-resolved global. Cached so the SDK pool is shared across spawns. */
export function getSnapshotStore(env: NodeJS.ProcessEnv = process.env): SnapshotStore {
  if (_store) {
    return _store;
  }
  const account = env['AZURE_STORAGE_ACCOUNT_NAME'];
  const key = env['AZURE_STORAGE_ACCOUNT_KEY'];
  const container = env['OMNI_AZURE_SNAPSHOT_CONTAINER'];
  _store =
    account && key && container ? new AzureBlobSnapshotStore({ account, key, container }) : new NullSnapshotStore();
  return _store;
}

/** Test-only — reset the cached store so a new env can be picked up. */
export function _resetSnapshotStoreForTests(): void {
  _store = undefined;
}
