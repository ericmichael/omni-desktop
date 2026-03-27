import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { shellEnvSync } from 'shell-env';

import { DEFAULT_ENV } from '@/lib/pty-utils';

const execFileAsync = promisify(execFile);

const LABEL_KEY = 'com.omni.omni-code';

/**
 * Find and remove orphaned Docker containers from previous launcher sessions.
 *
 * Omni Code containers are identified by the `com.omni.omni-code` label.
 * On startup we check for any still-running containers with that label and stop/remove them,
 * since the managing process (the previous launcher instance) is gone.
 *
 * Returns the number of containers cleaned up, or -1 if Docker is unavailable.
 */
export const cleanupOrphanedContainers = async (): Promise<number> => {
  const env = { ...process.env, ...DEFAULT_ENV, ...shellEnvSync() } as Record<string, string>;
  const opts = { encoding: 'utf8' as const, timeout: 15_000, env };

  // Verify Docker is available
  try {
    await execFileAsync('docker', ['version'], opts);
  } catch {
    return -1;
  }

  // List containers created by omni sandbox (running or stopped) using the omni-code label.
  // The `omni sandbox` command names containers with the `omni-sandbox-` prefix, so we also
  // check by name as a fallback for older versions that may not have the label.
  let containerIds: string[];
  try {
    const { stdout: labelResult } = await execFileAsync(
      'docker',
      ['ps', '-a', '--filter', `label=${LABEL_KEY}`, '--format', '{{.ID}}'],
      opts
    );
    const { stdout: nameResult } = await execFileAsync(
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
    return 0;
  }

  if (containerIds.length === 0) {
    return 0;
  }

  // Force-remove each orphaned container (stop + rm)
  let cleaned = 0;
  for (const id of containerIds) {
    try {
      await execFileAsync('docker', ['rm', '-f', id], opts);
      cleaned++;
      console.debug(`Cleaned up orphaned container: ${id}`);
    } catch (error) {
      console.warn(`Failed to remove orphaned container ${id}:`, error);
    }
  }

  return cleaned;
};

/**
 * Prune unused Docker resources (stopped containers, dangling images, unused networks, build cache).
 *
 * Runs `docker system prune -f` which only removes resources not associated with any running container.
 * Returns the reclaimed space string (e.g. "1.2GB"), or null if Docker is unavailable or prune fails.
 */
export const pruneDockerResources = async (): Promise<string | null> => {
  const env = { ...process.env, ...DEFAULT_ENV, ...shellEnvSync() } as Record<string, string>;
  const opts = { encoding: 'utf8' as const, timeout: 60_000, env };

  try {
    const { stdout } = await execFileAsync('docker', ['system', 'prune', '-f'], opts);
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
