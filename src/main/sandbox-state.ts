/**
 * Durable container-session ownership records.
 *
 * `omni serve` persists one JSON record per docker Workspace at
 * ``<omni-config>/sandbox-state/<snapshotRef>.json`` (omniagents
 * ``serve_harness.write_session_state``) so a later serve process can
 * reattach to the Workspace's container. The record doubles as the
 * launcher-side **ownership claim**: a labeled container referenced by a
 * record belongs to a session the user can still reopen, so the orphan
 * sweep must not remove it; a labeled container with no record and no
 * live process is a true orphan.
 *
 * Close/archive is the destruction point: when the owning serve process
 * is live the launcher asks it to destroy the environment
 * (``sandbox.discard_snapshot`` → container stop+rm + record delete);
 * when it is not, :func:`destroySandboxState` does the same directly
 * against dockerd.
 *
 * Electron-free and dependency-injected like the rest of the docker
 * plumbing (`docker-orphan-cleanup.ts`).
 */

import { readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { defaultDockerExecDeps, type DockerExecFn } from '@/main/docker-orphan-cleanup';
import { getOmniConfigDir } from '@/main/util';

const STATE_SUFFIX = '.json';

/** Same safe-name rule omni serve applies before writing a record. */
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export type SandboxStateRecord = { snapshotRef: string; containerId: string | null };

export type SandboxStateDeps = {
  execFileFn: DockerExecFn;
  getEnv: () => Record<string, string>;
};

export const sandboxStateDir = (configDir: string = getOmniConfigDir()): string =>
  path.join(configDir, 'sandbox-state');

/**
 * Enumerate every persisted session-state record. Unreadable / malformed
 * records surface with ``containerId: null`` so they still show up (and can
 * be destroyed), rather than silently vanishing from ownership.
 */
export const listSandboxStates = (dir: string = sandboxStateDir()): SandboxStateRecord[] => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const records: SandboxStateRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(STATE_SUFFIX)) {
      continue;
    }
    const snapshotRef = entry.slice(0, -STATE_SUFFIX.length);
    if (!SAFE_REF.test(snapshotRef)) {
      continue;
    }
    let containerId: string | null = null;
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, entry), 'utf8')) as { container_id?: unknown };
      containerId = typeof parsed.container_id === 'string' && parsed.container_id ? parsed.container_id : null;
    } catch {
      // Torn/corrupt record — keep it listed with no container claim.
    }
    records.push({ snapshotRef, containerId });
  }
  return records;
};

/** Container ids claimed by persisted session states (orphan-sweep protection). */
export const sandboxStateContainerIds = (dir: string = sandboxStateDir()): string[] =>
  listSandboxStates(dir)
    .map((record) => record.containerId)
    .filter((id): id is string => !!id);

/**
 * Destroy the durable environment behind *snapshotRef*: force-remove its
 * container and delete the record only after removal is confirmed. A Docker
 * outage preserves the ownership record for retry. Used when no live serve
 * process owns the environment, and by the stale-workspace GC.
 */
export const destroySandboxState = async (
  snapshotRef: string,
  deps: SandboxStateDeps = defaultDockerExecDeps(),
  dir: string = sandboxStateDir()
): Promise<void> => {
  if (!SAFE_REF.test(snapshotRef)) {
    return;
  }
  const filename = path.join(dir, `${snapshotRef}${STATE_SUFFIX}`);
  let original: string;
  try {
    original = readFileSync(filename, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  // Corrupt/unreadable state is not evidence that no container is owned.
  const record = JSON.parse(original) as { container_id?: unknown };
  if (record.container_id !== null && typeof record.container_id !== 'string') {
    throw new Error(`Invalid sandbox ownership record: ${snapshotRef}`);
  }
  if (record.container_id) {
    const opts = { encoding: 'utf8' as const, timeout: 15_000, env: deps.getEnv() };
    try {
      await deps.execFileFn('docker', ['rm', '-f', '--', record.container_id], opts);
    } catch (error) {
      // A lost reply/already-removed container is success only if a fresh,
      // successful daemon query proves absence. Never parse error prose.
      const { stdout } = await deps.execFileFn(
        'docker',
        ['ps', '-a', '--no-trunc', '--filter', `id=${record.container_id}`, '--format', '{{.ID}}'],
        opts
      );
      if (stdout.trim()) {
        throw error;
      }
    }
  }
  try {
    if (readFileSync(filename, 'utf8') !== original) {
      throw new Error(`Sandbox ownership changed during cleanup: ${snapshotRef}`);
    }
    rmSync(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
};
