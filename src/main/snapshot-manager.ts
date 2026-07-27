/**
 * Snapshot manager — bookkeeping for the per-session workspace tarballs
 * that ``omni serve`` writes to ``<omni-config>/snapshots/{sessionId}.tar``.
 *
 * The snapshot is the SDK's "if the docker container is gone, rehydrate
 * the workspace from this tar" cache. One file per resumable session;
 * see ``omniagents/core/sandbox/`` and omniagents ``docs/serve-protocol.md``
 * (protocol v1, ``--snapshot-dir``).
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

import { codeTabLabel } from '@/main/sandbox-inventory';
import type { IIpcListener } from '@/shared/ipc-listener';
import type { ChatConversation, CodeTab, SandboxSnapshotSummary } from '@/shared/types';

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
export async function deleteSnapshot(sessionId: string, dir: string = snapshotsDir()): Promise<boolean> {
  if (!sessionId) {
    return false;
  }
  const filename = `${sessionId}${SNAPSHOT_SUFFIX}`;
  // Reject anything that escapes the snapshots dir — sessionId is
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
    .remove(sessionId)
    .catch((err) => console.error('[snapshot-manager] blob remove failed:', err));
  return unlinked;
}

/**
 * Delete snapshot tars whose stem is not in *keep* and whose mtime is
 * older than *ttlMs* ago. Files in *keep* are never deleted regardless
 * of age. Returns the list of deleted session ids.
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
    const sessionId = entry.slice(0, -SNAPSHOT_SUFFIX.length);
    if (opts.keep.has(sessionId)) {
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
      deleted.push(sessionId);
    } catch {
      // best-effort
    }
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Snapshot browser (`sandbox:list-snapshots`) + in-use delete guard
// ---------------------------------------------------------------------------

/** One session's claim on its snapshot tar, with a human label when known. */
export type SessionClaim = { sessionId: string; label: string | null };

export type SnapshotHandlerDeps = {
  /**
   * Sessions an open code tab still claims — the SAME source as the
   * `gcStaleSnapshots` keep set both shells build (`codeTabs[].sessionId`,
   * the reserved chat column included). These tars are `inUse` in the
   * listing and protected from `snapshot:delete`.
   */
  getProtectedSessions: () => SessionClaim[];
  /**
   * Archived-conversation titles (`chatConversations`) — label-only, never
   * protective: closing a chat column deliberately deletes its snapshot
   * (archived chats resume fresh), so a leftover tar is deletable.
   */
  getArchivedLabels: () => SessionClaim[];
  /** Test seam; production defaults to `<omni-config>/snapshots`. */
  dir?: string;
};

/**
 * Open-tab session claims for {@link SnapshotHandlerDeps.getProtectedSessions}
 * — mirrors the keep set the Electron shell passes to `gcStaleSnapshots`.
 */
export const protectedSessionsFromTabs = (tabs: CodeTab[]): SessionClaim[] =>
  tabs
    .filter((t): t is CodeTab & { sessionId: string } => !!t.sessionId)
    .map((t) => ({ sessionId: t.sessionId, label: codeTabLabel(t) }));

/** Archived-conversation labels for {@link SnapshotHandlerDeps.getArchivedLabels}. */
export const archivedLabelsFromConversations = (conversations: ChatConversation[]): SessionClaim[] =>
  conversations.map((c) => ({ sessionId: c.sessionId, label: c.title || null }));

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
  const protectedClaims = deps.getProtectedSessions();
  const archived = deps.getArchivedLabels();
  const summaries: SandboxSnapshotSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(SNAPSHOT_SUFFIX)) {
      continue;
    }
    const sessionId = entry.slice(0, -SNAPSHOT_SUFFIX.length);
    let stat;
    try {
      stat = await fs.stat(path.join(dir, entry));
    } catch {
      continue;
    }
    const claim = protectedClaims.find((c) => c.sessionId === sessionId);
    summaries.push({
      sessionId,
      sizeBytes: stat.size,
      modifiedAt: stat.mtimeMs,
      inUse: claim !== undefined,
      label: claim?.label ?? archived.find((c) => c.sessionId === sessionId)?.label ?? null,
    });
  }
  return summaries.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/**
 * Register the renderer-facing snapshot channels. The startup GC sweep is
 * wired separately by the caller (same protected-session source).
 *
 * `snapshot:delete` guards against ids an open tab still claims — the
 * Sandboxes browser UI can pass arbitrary ids. The tab-close cascade is not
 * affected: `removeTab` persists the pruned `codeTabs` (awaited round trip)
 * BEFORE invoking the delete, so the closed tab's session is already out of
 * the protected set when the guard evaluates.
 */
export function registerSnapshotHandlers(ipc: IIpcListener, deps: SnapshotHandlerDeps): void {
  ipc.handle('snapshot:delete', async (_, sessionId: string) => {
    const claim = deps.getProtectedSessions().find((c) => c.sessionId === sessionId);
    if (claim) {
      throw new Error(`Snapshot is in use by an open session: ${claim.label ?? sessionId}`);
    }
    await deleteSnapshot(sessionId, deps.dir);
  });
  ipc.handle('sandbox:list-snapshots', () => listSnapshots(deps));
}
