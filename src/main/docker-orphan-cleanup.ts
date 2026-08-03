import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { shellEnvSync } from 'shell-env';

import { DEFAULT_ENV } from '@/lib/pty-utils';

const execFileAsync = promisify(execFile);

/** Docker label identifying containers created by omni sandbox. Shared with `sandbox-inventory.ts`. */
export const OMNI_CONTAINER_LABEL = 'com.omni.omni-code';

// ---------------------------------------------------------------------------
// Injectable deps
// ---------------------------------------------------------------------------

export type DockerExecFn = (
  cmd: string,
  args: string[],
  opts: { encoding: 'utf8'; timeout: number; env: Record<string, string> }
) => Promise<{ stdout: string; stderr: string }>;

export type DockerCleanupDeps = {
  execFileFn: DockerExecFn;
  getEnv: () => Record<string, string>;
  /**
   * Container ids this launcher instance still has a claim on: warm-reattach
   * targets persisted on `codeTabs[].containerId` plus containers of live
   * agent processes. These are never swept — auto-launched sessions resume
   * them concurrently with the startup sweep, and removing one mid-resume
   * surfaces as a Docker 409 (`marked for removal` / `is not running`).
   * Called right before removal so sessions that come up mid-sweep are
   * still protected.
   */
  getProtectedContainerIds: () => string[];
};

/**
 * Default exec plumbing for docker CLI calls: real execFile + the login-shell
 * env (Docker Desktop installs often only extend PATH in the user's shell rc).
 * Shared with `sandbox-inventory.ts` so both surfaces resolve docker the same way.
 */
export const defaultDockerExecDeps = (): Pick<DockerCleanupDeps, 'execFileFn' | 'getEnv'> => ({
  execFileFn: execFileAsync as unknown as DockerExecFn,
  getEnv: () => ({ ...process.env, ...DEFAULT_ENV, ...shellEnvSync() }) as Record<string, string>,
});

const defaultDeps = (): DockerCleanupDeps => ({
  ...defaultDockerExecDeps(),
  getProtectedContainerIds: () => [],
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find and remove orphaned Docker containers from previous launcher sessions.
 *
 * Omni Code containers are identified by the `com.omni.omni-code` label.
 * On startup we check for any still-running containers with that label and stop/remove them,
 * since the managing process (the previous launcher instance) is gone.
 *
 * Containers reported by `getProtectedContainerIds` are NOT orphans — they are
 * resume targets or live sessions of this launcher instance — and are skipped.
 *
 * Returns the ids of the containers removed, or null if Docker is unavailable.
 * Runs at startup (both shells) and on demand via `sandbox:sweep-orphans`.
 */
export const cleanupOrphanedContainers = async (deps?: Partial<DockerCleanupDeps>): Promise<string[] | null> => {
  const { execFileFn, getEnv, getProtectedContainerIds } = { ...defaultDeps(), ...deps };
  const env = getEnv();
  const opts = { encoding: 'utf8' as const, timeout: 15_000, env };

  // Verify Docker is available
  try {
    await execFileFn('docker', ['version'], opts);
  } catch {
    return null;
  }

  // List containers created by omni sandbox (running or stopped) using the omni-code label.
  // The `omni sandbox` command names containers with the `omni-sandbox-` prefix, so we also
  // check by name as a fallback for older versions that may not have the label.
  let containerIds: string[];
  try {
    const { stdout: labelResult } = await execFileFn(
      'docker',
      ['ps', '-a', '--filter', `label=${OMNI_CONTAINER_LABEL}`, '--format', '{{.ID}}'],
      opts
    );
    const { stdout: nameResult } = await execFileFn(
      'docker',
      ['ps', '-a', '--filter', 'name=omni-sandbox-', '--format', '{{.ID}}'],
      opts
    );

    const ids = new Set<string>();
    for (const line of [...labelResult.split('\n'), ...nameResult.split('\n')]) {
      const id = line.trim();
      if (id) {
        ids.add(id);
      }
    }
    containerIds = [...ids];
  } catch {
    return [];
  }

  if (containerIds.length === 0) {
    return [];
  }

  // `docker ps --format {{.ID}}` yields short (12-char) ids while the store
  // and omni serve payloads carry full 64-char ids — match by prefix in
  // either direction.
  const protectedIds = getProtectedContainerIds().filter(Boolean);
  const isProtected = (id: string): boolean => protectedIds.some((p) => p.startsWith(id) || id.startsWith(p));

  // Force-remove each orphaned container (stop + rm)
  const removed: string[] = [];
  for (const id of containerIds) {
    if (isProtected(id)) {
      continue;
    }
    try {
      await execFileFn('docker', ['rm', '-f', id], opts);
      removed.push(id);
      console.debug(`Cleaned up orphaned container: ${id}`);
    } catch (error) {
      console.warn(`Failed to remove orphaned container ${id}:`, error);
    }
  }

  return removed;
};

/**
 * Prune unused Docker resources (stopped containers, dangling images, unused networks, build cache).
 *
 * Runs `docker system prune -f` which only removes resources not associated with any running container.
 * Omni Code containers are excluded via `label!=` — stopped ones are warm-reattach targets that
 * `omni serve --container-id` restarts on the next launch; pruning one mid-resume is the same
 * 409 race as the orphan sweep. True omni orphans are handled by `cleanupOrphanedContainers`.
 * Returns the reclaimed space string (e.g. "1.2GB"), or null if Docker is unavailable or prune fails.
 */
export const pruneDockerResources = async (deps?: Partial<DockerCleanupDeps>): Promise<string | null> => {
  const { execFileFn, getEnv } = { ...defaultDeps(), ...deps };
  const env = getEnv();
  // Permanent E2E prepares a pinned digest-only image before Electron starts.
  // Docker classifies that image as pruneable until a container references it,
  // so the startup sweep would delete the fixture out from under the test.
  if (env['OMNI_SKIP_DOCKER_PRUNE'] === '1') {
    return null;
  }
  const opts = { encoding: 'utf8' as const, timeout: 60_000, env };

  try {
    const { stdout } = await execFileFn(
      'docker',
      ['system', 'prune', '-f', '--filter', `label!=${OMNI_CONTAINER_LABEL}`],
      opts
    );
    const match = stdout.match(/Total reclaimed space:\s*(.+)/);
    const reclaimed = match?.[1]?.trim() ?? null;
    if (reclaimed) {
      console.debug(`Docker prune reclaimed: ${reclaimed}`);
    }
    return reclaimed;
  } catch {
    return null;
  }
};
