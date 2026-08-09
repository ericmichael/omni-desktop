/**
 * Snapshot manager — cascade + GC for a Workspace's durable remains.
 *
 * A docker Workspace's durable state is its container (reattached via the
 * ``<omni-config>/sandbox-state/`` records — see `sandbox-state.ts`).
 * Legacy ``<omni-config>/snapshots/{snapshotRef}.tar`` archives from the
 * pre-reattach era are still swept/deletable here so old installs drain
 * clean.
 *
 * Two cleanup paths live here:
 *
 *   1. ``deleteSnapshot(snapshotRef)`` — cascade GC invoked by the
 *      renderer when a code tab is removed. The tab is gone for good
 *      (no resume UI for deleted tabs), so its container + state record
 *      (and any legacy tar) are dead weight. When the owning serve
 *      process was live, it already destroyed the environment via
 *      ``sandbox.discard_snapshot`` — this path is the idempotent
 *      backstop for tabs whose process was not running.
 *
 *   2. ``gcStaleSnapshots({ keep, ttlMs })`` — startup sweep that
 *      destroys any workspace (state record + container, plus legacy
 *      tars) whose ref isn't in ``keep`` AND whose record is older than
 *      ``ttlMs``. ``keep`` protects the currently-active Workspace
 *      references regardless of age.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { codeTabLabel } from '@/main/sandbox-inventory';
import { destroySandboxState, listSandboxStates, sandboxStateDir } from '@/main/sandbox-state';
import type { IIpcListener } from '@/shared/ipc-listener';
import type { CodeTab, SandboxSnapshotSummary } from '@/shared/types';

import { getOmniConfigDir } from './util';

/** TTL applied to chat snapshots that aren't explicitly protected. */
export const DEFAULT_CHAT_SNAPSHOT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

const SNAPSHOT_SUFFIX = '.tar';

const snapshotsDir = (): string => path.join(getOmniConfigDir(), 'snapshots');

/**
 * Retire one Workspace's durable remains: destroy its container + state
 * record and delete any legacy tar. Idempotent — nothing found is not an
 * error. Returns true if a tar file was deleted. *dir* and *stateDir* are
 * test seams; production uses the omni-config locations.
 */
export async function deleteSnapshot(
  snapshotRef: string,
  dir: string = snapshotsDir(),
  stateDir: string = sandboxStateDir()
): Promise<boolean> {
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
  await destroySandboxState(snapshotRef, undefined, stateDir);
  let unlinked = false;
  try {
    await fs.unlink(path.join(dir, filename));
    unlinked = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
  return unlinked;
}

/**
 * Retire workspaces whose ref is not in *keep* and whose on-disk record
 * (session-state json, or legacy tar) is older than *ttlMs* ago. Refs in
 * *keep* are never touched regardless of age. Returns the retired refs.
 */
export async function gcStaleSnapshots(opts: {
  keep: Set<string>;
  ttlMs: number;
  dir?: string;
  stateDir?: string;
}): Promise<string[]> {
  const dir = opts.dir ?? snapshotsDir();
  const stateDir = opts.stateDir ?? sandboxStateDir();
  const cutoff = Date.now() - opts.ttlMs;
  const deleted: string[] = [];

  // Stale container sessions: destroy container + record.
  for (const record of listSandboxStates(stateDir)) {
    if (opts.keep.has(record.snapshotRef)) {
      continue;
    }
    let stat;
    try {
      stat = await fs.stat(path.join(stateDir, `${record.snapshotRef}.json`));
    } catch {
      continue;
    }
    if (stat.mtimeMs > cutoff) {
      continue;
    }
    await destroySandboxState(record.snapshotRef, undefined, stateDir);
    deleted.push(record.snapshotRef);
  }

  // Legacy tars from the pre-reattach era.
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return deleted;
    }
    throw err;
  }

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
      if (!deleted.includes(snapshotRef)) {
        deleted.push(snapshotRef);
      }
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
