/**
 * Tests for docker-orphan-cleanup — orphaned container detection and removal,
 * Docker prune.
 *
 * Uses injectable deps (execFileFn, getEnv) — zero vi.mock.
 */
import { describe, expect, it, vi } from 'vitest';

import { cleanupOrphanedContainers, type DockerCleanupDeps, pruneDockerResources } from '@/main/docker-orphan-cleanup';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ExecCall = { cmd: string; args: string[] };

function makeDeps(responses: Map<string, { stdout: string } | Error> = new Map()): {
  deps: DockerCleanupDeps;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];

  const execFileFn = vi.fn(async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    // Build a lookup key from cmd + first meaningful arg
    const key = `${cmd} ${args.join(' ')}`;
    for (const [pattern, response] of responses) {
      if (key.includes(pattern)) {
        if (response instanceof Error) {
          throw response;
        }
        return { stdout: response.stdout, stderr: '' };
      }
    }
    return { stdout: '', stderr: '' };
  }) as unknown as DockerCleanupDeps['execFileFn'];

  return {
    deps: { execFileFn, getEnv: () => ({ PATH: '/usr/bin' }) },
    calls,
  };
}

// ---------------------------------------------------------------------------
// cleanupOrphanedContainers
// ---------------------------------------------------------------------------

describe('cleanupOrphanedContainers', () => {
  it('returns -1 when Docker is unavailable', async () => {
    const { deps } = makeDeps(new Map([['docker version', new Error('not found')]]));
    const result = await cleanupOrphanedContainers(deps);
    expect(result).toBe(-1);
  });

  it('returns 0 when no containers are found', async () => {
    const { deps } = makeDeps();
    const result = await cleanupOrphanedContainers(deps);
    expect(result).toBe(0);
  });

  it('removes containers found by label', async () => {
    const { deps, calls } = makeDeps(
      new Map([
        ['label=com.omni.omni-code', { stdout: 'abc123\ndef456\n' }],
      ])
    );
    const result = await cleanupOrphanedContainers(deps);
    expect(result).toBe(2);
    // Should have called docker rm -f for each
    const rmCalls = calls.filter((c) => c.args.includes('rm'));
    expect(rmCalls).toHaveLength(2);
    expect(rmCalls[0]!.args).toEqual(['rm', '-f', 'abc123']);
    expect(rmCalls[1]!.args).toEqual(['rm', '-f', 'def456']);
  });

  it('removes containers found by name prefix', async () => {
    const { deps } = makeDeps(
      new Map([
        ['name=omni-sandbox-', { stdout: 'xyz789\n' }],
      ])
    );
    const result = await cleanupOrphanedContainers(deps);
    expect(result).toBe(1);
  });

  it('deduplicates containers found by both label and name', async () => {
    const { deps } = makeDeps(
      new Map([
        ['label=com.omni.omni-code', { stdout: 'abc123\n' }],
        ['name=omni-sandbox-', { stdout: 'abc123\n' }],
      ])
    );
    const result = await cleanupOrphanedContainers(deps);
    expect(result).toBe(1);
  });

  it('returns partial count when some removals fail', async () => {
    let rmCount = 0;
    const { deps } = makeDeps(
      new Map([
        ['label=com.omni.omni-code', { stdout: 'a1\nb2\nc3\n' }],
      ])
    );
    // Override execFileFn to fail on the second rm
    const original = deps.execFileFn;
    deps.execFileFn = (async (cmd: string, args: string[], opts: unknown) => {
      if (args[0] === 'rm') {
        rmCount++;
        if (rmCount === 2) {
          throw new Error('permission denied');
        }
      }
      return original(cmd, args, opts as never);
    }) as typeof deps.execFileFn;

    const result = await cleanupOrphanedContainers(deps);
    expect(result).toBe(2); // 3 containers, 1 failed = 2 cleaned
  });

  it('returns 0 when listing fails', async () => {
    const { deps } = makeDeps(
      new Map([
        // docker version succeeds but ps fails
        ['ps', new Error('ps failed')],
      ])
    );
    const result = await cleanupOrphanedContainers(deps);
    expect(result).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// pruneDockerResources
// ---------------------------------------------------------------------------

describe('pruneDockerResources', () => {
  it('returns reclaimed space string on success', async () => {
    const { deps } = makeDeps(
      new Map([['system prune', { stdout: 'Deleted Images:\nfoo\nTotal reclaimed space: 1.2GB\n' }]])
    );
    const result = await pruneDockerResources(deps);
    expect(result).toBe('1.2GB');
  });

  it('returns null when prune output has no space line', async () => {
    const { deps } = makeDeps(
      new Map([['system prune', { stdout: 'Nothing to prune\n' }]])
    );
    const result = await pruneDockerResources(deps);
    expect(result).toBeNull();
  });

  it('returns null when Docker is unavailable', async () => {
    const { deps } = makeDeps(
      new Map([['system prune', new Error('docker not found')]])
    );
    const result = await pruneDockerResources(deps);
    expect(result).toBeNull();
  });
});
