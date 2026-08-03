/**
 * Snapshot manager — bookkeeping for Workspace snapshot tarballs written to
 * ``<omni-config>/snapshots/{snapshotRef}.tar`` by materialized environments.
 *
 * The snapshot is the SDK's "if the docker container is gone, rehydrate
 * the workspace from this tar" cache. The snapshot reference belongs to the
 * registered Workspace (serve protocol v2), never to an AgentHost, live
 * container, or conversation session.
 *
 * Two cleanup paths live here:
 *
 *   1. ``deleteSnapshot(snapshotRef)`` — cascade GC invoked by the
 *      renderer when a code tab is removed. The tab is gone for good
 *      (no resume UI for deleted tabs), so its tar is dead weight.
 *
 *   2. ``gcStaleSnapshots({ keep, ttlMs })`` — startup sweep that
 *      deletes any tar whose stem isn't in ``keep`` AND whose mtime is
 *      older than ``ttlMs``. Used for chat snapshots, where the
 *      omniagents server keeps message history for sessions the user
 *      can still resume via the picker. ``keep`` protects the
 *      currently-active Workspace snapshot references regardless of age.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { codeTabLabel } from '@/main/sandbox-inventory';
import type { IIpcListener } from '@/shared/ipc-listener';
import type { CodeTab, SandboxSnapshotSummary } from '@/shared/types';

import { getSnapshotStore } from './snapshot-blob-store';
import { getOmniConfigDir } from './util';

/** TTL applied to chat snapshots that aren't explicitly protected. */
export const DEFAULT_CHAT_SNAPSHOT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

const SNAPSHOT_SUFFIX = '.tar';

const snapshotsDir = (): string => path.join(getOmniConfigDir(), 'snapshots');

/**
 * Delete one snapshot file. Idempotent — missing file is not an error.
 * Returns true if a file was deleted, false otherwise. *dir* is a test seam;
 * production always uses the omni-config snapshots dir.
 */
export async function deleteSnapshot(snapshotRef: string, dir: string = snapshotsDir()): Promise<boolean> {
  if (!snapshotRef) {
    return false;
  }
  const filename = `${snapshotRef}${SNAPSHOT_SUFFIX}`;
  // Reject anything that escapes the snapshots dir — snapshotRef is
  // caller-controlled (renderer-supplied) and we don't want a stray
  // ``../`` to nuke files outside the bucket.
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return false;
  }
  let unlinked = false;
  try {
    await fs.unlink(path.join(dir, filename));
    unlinked = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
  // Cascade to blob — the cloud copy is the durable one; leaving it after a
  // local delete defeats the cascade-on-tab-close semantics. Best-effort.
  await getSnapshotStore()
    .remove(snapshotRef)
    .catch((err) => console.error('[snapshot-manager] blob remove failed:', err));
  return unlinked;
}

/**
 * Delete snapshot tars whose stem is not in *keep* and whose mtime is
 * older than *ttlMs* ago. Files in *keep* are never deleted regardless
 * of age. Returns the list of deleted snapshot references.
 */
export async function gcStaleSnapshots(opts: { keep: Set<string>; ttlMs: number }): Promise<string[]> {
  const dir = snapshotsDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  const cutoff = Date.now() - opts.ttlMs;
  const deleted: string[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(SNAPSHOT_SUFFIX)) {
      continue;
    }
    const snapshotRef = entry.slice(0, -SNAPSHOT_SUFFIX.length);
    if (opts.keep.has(snapshotRef)) {
      continue;
    }

    const fullPath = path.join(dir, entry);
    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      continue;
    }
    if (stat.mtimeMs > cutoff) {
      continue;
    }

    try {
      await fs.unlink(fullPath);
      deleted.push(snapshotRef);
    } catch {
      // best-effort
    }
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Snapshot browser (`sandbox:list-snapshots`) + in-use delete guard
// ---------------------------------------------------------------------------

/** One open tab's claim on a Workspace snapshot tar. */
export type SnapshotClaim = { snapshotRef: string; label: string | null };

export type SnapshotHandlerDeps = {
  /**
   * Snapshots an open code tab still claims — the same source as the
   * `gcStaleSnapshots` keep set (`codeTabs[].snapshotRef`). These tars are `inUse` in the
   * listing and protected from `snapshot:delete`.
   */
  getProtectedSnapshots: () => SnapshotClaim[];
  /** Test seam; production defaults to `<omni-config>/snapshots`. */
  dir?: string;
};

/**
 * Open-tab claims for {@link SnapshotHandlerDeps.getProtectedSnapshots}
 * — mirrors the keep set the Electron shell passes to `gcStaleSnapshots`.
 */
export const protectedSnapshotsFromTabs = (tabs: CodeTab[]): SnapshotClaim[] =>
  tabs
    .filter((t): t is CodeTab & { snapshotRef: string } => !!t.snapshotRef)
    .map((t) => ({ snapshotRef: t.snapshotRef, label: codeTabLabel(t) }));

/** Enumerate `<dir>/*.tar` for the Sandboxes tab, newest first. */
export async function listSnapshots(deps: SnapshotHandlerDeps): Promise<SandboxSnapshotSummary[]> {
  const dir = deps.dir ?? snapshotsDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  const protectedClaims = deps.getProtectedSnapshots();
  const summaries: SandboxSnapshotSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(SNAPSHOT_SUFFIX)) {
      continue;
    }
    const snapshotRef = entry.slice(0, -SNAPSHOT_SUFFIX.length);
    let stat;
    try {
      stat = await fs.stat(path.join(dir, entry));
    } catch {
      continue;
    }
    const claim = protectedClaims.find((c) => c.snapshotRef === snapshotRef);
    summaries.push({
      snapshotRef,
      sizeBytes: stat.size,
      modifiedAt: stat.mtimeMs,
      inUse: claim !== undefined,
      label: claim?.label ?? null,
    });
  }
  return summaries.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/**
 * Register the renderer-facing snapshot channels. The startup GC sweep is
 * wired separately by the caller (same protected-session source).
 *
 * `snapshot:delete` guards against references an open tab still claims. The
 * tab-close cascade is not
 * affected: `removeTab` persists the pruned `codeTabs` (awaited round trip)
 * BEFORE invoking the delete, so the closed tab's snapshot is already out of
 * the protected set when the guard evaluates.
 */
export function registerSnapshotHandlers(ipc: IIpcListener, deps: SnapshotHandlerDeps): void {
  ipc.handle('snapshot:delete', async (_, snapshotRef: string) => {
    const claim = deps.getProtectedSnapshots().find((c) => c.snapshotRef === snapshotRef);
    if (claim) {
      throw new Error(`Snapshot is in use by an open tab: ${claim.label ?? snapshotRef}`);
    }
    await deleteSnapshot(snapshotRef, deps.dir);
  });
  ipc.handle('sandbox:list-snapshots', () => listSnapshots(deps));
}
