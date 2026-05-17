/**
 * Snapshot manager — bookkeeping for the per-session workspace tarballs
 * that ``omni serve`` writes to ``<omni-config>/snapshots/{sessionId}.tar``.
 *
 * The snapshot is the SDK's "if the docker container is gone, rehydrate
 * the workspace from this tar" cache. One file per resumable session;
 * see ``omniagents/core/sandbox/`` and ``omni-code/serve_cli.py``.
 *
 * Two cleanup paths live here:
 *
 *   1. ``deleteSnapshot(sessionId)`` — cascade GC invoked by the
 *      renderer when a code tab is removed. The tab is gone for good
 *      (no resume UI for deleted tabs), so its tar is dead weight.
 *
 *   2. ``gcStaleSnapshots({ keep, ttlMs })`` — startup sweep that
 *      deletes any tar whose stem isn't in ``keep`` AND whose mtime is
 *      older than ``ttlMs``. Used for chat snapshots, where the
 *      omniagents server keeps message history for sessions the user
 *      can still resume via the picker. ``keep`` protects the
 *      currently-active conversation ids regardless of age.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { IIpcListener } from '@/shared/ipc-listener';

import { getOmniConfigDir } from './util';

/** TTL applied to chat snapshots that aren't explicitly protected. */
export const DEFAULT_CHAT_SNAPSHOT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

const SNAPSHOT_SUFFIX = '.tar';

const snapshotsDir = (): string => path.join(getOmniConfigDir(), 'snapshots');

/**
 * Delete one snapshot file. Idempotent — missing file is not an error.
 * Returns true if a file was deleted, false otherwise.
 */
export async function deleteSnapshot(sessionId: string): Promise<boolean> {
  if (!sessionId) return false;
  const filename = `${sessionId}${SNAPSHOT_SUFFIX}`;
  // Reject anything that escapes the snapshots dir — sessionId is
  // caller-controlled (renderer-supplied) and we don't want a stray
  // ``../`` to nuke files outside the bucket.
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return false;
  }
  try {
    await fs.unlink(path.join(snapshotsDir(), filename));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Delete snapshot tars whose stem is not in *keep* and whose mtime is
 * older than *ttlMs* ago. Files in *keep* are never deleted regardless
 * of age. Returns the list of deleted session ids.
 */
export async function gcStaleSnapshots(opts: {
  keep: Set<string>;
  ttlMs: number;
}): Promise<string[]> {
  const dir = snapshotsDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const cutoff = Date.now() - opts.ttlMs;
  const deleted: string[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(SNAPSHOT_SUFFIX)) continue;
    const sessionId = entry.slice(0, -SNAPSHOT_SUFFIX.length);
    if (opts.keep.has(sessionId)) continue;

    const fullPath = path.join(dir, entry);
    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      continue;
    }
    if (stat.mtimeMs > cutoff) continue;

    try {
      await fs.unlink(fullPath);
      deleted.push(sessionId);
    } catch {
      // best-effort
    }
  }
  return deleted;
}

/**
 * Register the renderer-facing IPC handler for cascade deletion.
 * The startup GC sweep is wired separately by the caller (it needs
 * access to the store snapshot to build the protected set).
 */
export function registerSnapshotHandlers(ipc: IIpcListener): void {
  ipc.handle('snapshot:delete', async (_, sessionId) => {
    await deleteSnapshot(sessionId);
  });
}
