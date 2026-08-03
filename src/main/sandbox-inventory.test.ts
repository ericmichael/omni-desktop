/**
 * Tests for sandbox-inventory — container listing/ownership, protected
 * removal, on-demand orphan sweep, and the Docker substrate probe.
 *
 * Uses an injected exec fake — zero vi.mock.
 */
import { describe, expect, it, vi } from 'vitest';

import type { DockerExecFn } from '@/main/docker-orphan-cleanup';
import {
  codeTabLabel,
  getContainerLogs,
  getImageStatus,
  getSubstrateStatus,
  listContainers,
  parseReclaimedBytes,
  processOwnersFromState,
  pruneImages,
  pullImage,
  removeContainer,
  type SandboxInventoryDeps,
  sweepOrphans,
} from '@/main/sandbox-inventory';
import type { CodeTab } from '@/shared/types';

type ExecCall = { cmd: string; args: string[] };

function makeDeps(responses: Map<string, { stdout: string; stderr?: string } | Error> = new Map()): {
  deps: SandboxInventoryDeps;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const execFileFn = vi.fn(async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const key = `${cmd} ${args.join(' ')}`;
    for (const [pattern, response] of responses) {
      if (key.includes(pattern)) {
        if (response instanceof Error) {
          throw response;
        }
        return { stdout: response.stdout, stderr: response.stderr ?? '' };
      }
    }
    return { stdout: '', stderr: '' };
  }) as unknown as DockerExecFn;

  return {
    deps: {
      execFileFn,
      getEnv: () => ({ PATH: '/usr/bin' }),
      getProcessOwners: () => [],
    },
    calls,
  };
}

const psLine = (id: string, extra: Record<string, string> = {}): string =>
  JSON.stringify({
    ID: id,
    Names: `omni-sandbox-${id}`,
    Image: 'ghcr.io/example/devbox',
    CreatedAt: '2026-07-27 10:00:00 +0000 UTC',
    State: 'running',
    ...extra,
  });

// Full 64-char id whose short prefix is `0af06484b591`.
const FULL_ID = '0af06484b5914160461f03ec01229261586be2c4c2988ca63addf134136ea4ca';

describe('listContainers', () => {
  it('parses docker ps json lines and marks unowned containers orphans', async () => {
    const { deps, calls } = makeDeps(
      new Map([['label=com.omni.omni-code', { stdout: `${psLine('abc123')}\n${psLine('def456')}\n` }]])
    );
    const result = await listContainers(deps);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: 'abc123',
      name: 'omni-sandbox-abc123',
      image: 'ghcr.io/example/devbox',
      createdAt: '2026-07-27 10:00:00 +0000 UTC',
      state: 'running',
      ownerKind: 'orphan',
      ownerLabel: null,
    });
    expect(calls[0]!.args).toEqual(['ps', '-a', '--filter', 'label=com.omni.omni-code', '--format', '{{json .}}']);
  });

  it('skips blank and unparseable lines', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps } = makeDeps(
      new Map([['label=com.omni.omni-code', { stdout: `\n${psLine('abc123')}\nnot-json\n\n` }]])
    );
    const result = await listContainers(deps);
    expect(result.map((c) => c.id)).toEqual(['abc123']);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('joins live ownership by short or full container id', async () => {
    const { deps } = makeDeps(
      new Map([['label=com.omni.omni-code', { stdout: `${psLine('0af06484b591')}\n${psLine('ccc333')}\n` }]])
    );
    deps.getProcessOwners = () => [{ containerId: FULL_ID, label: 'Fix the login bug' }];
    const result = await listContainers(deps);
    expect(result[0]).toMatchObject({ ownerKind: 'process', ownerLabel: 'Fix the login bug' });
    expect(result[1]).toMatchObject({ ownerKind: 'orphan', ownerLabel: null });
  });
});

describe('removeContainer', () => {
  it('force-removes an unprotected container', async () => {
    const { deps, calls } = makeDeps();
    await removeContainer(deps, 'abc123');
    expect(calls).toEqual([{ cmd: 'docker', args: ['rm', '-f', 'abc123'] }]);
  });

  it('throws with the owner label for a live-process container without touching docker', async () => {
    const { deps, calls } = makeDeps();
    deps.getProcessOwners = () => [{ containerId: FULL_ID, label: 'Fix the login bug' }];
    await expect(removeContainer(deps, '0af06484b591')).rejects.toThrow(
      'Container is in use by a running session: Fix the login bug'
    );
    expect(calls).toHaveLength(0);
  });
});

describe('sweepOrphans', () => {
  it('removes only unprotected containers and reports the removed ids', async () => {
    const { deps, calls } = makeDeps(
      new Map([['label=com.omni.omni-code', { stdout: '0af06484b591\nbbb222\nccc333\n' }]])
    );
    deps.getProcessOwners = () => [{ containerId: FULL_ID, label: 'live session' }];
    const result = await sweepOrphans(deps);
    expect(result).toEqual({ removed: ['bbb222', 'ccc333'] });
    const rmCalls = calls.filter((c) => c.args[0] === 'rm');
    expect(rmCalls).toEqual([
      { cmd: 'docker', args: ['rm', '-f', 'bbb222'] },
      { cmd: 'docker', args: ['rm', '-f', 'ccc333'] },
    ]);
  });

  it('reports an empty list when Docker is unavailable', async () => {
    const { deps } = makeDeps(new Map([['docker version', new Error('not found')]]));
    await expect(sweepOrphans(deps)).resolves.toEqual({ removed: [] });
  });
});

describe('getContainerLogs', () => {
  it('tails logs of a labeled container, concatenating stdout and stderr', async () => {
    const { deps, calls } = makeDeps(
      new Map([
        ['label=com.omni.omni-code', { stdout: `${psLine('abc123')}\n` }],
        ['logs', { stdout: 'out line\n', stderr: 'err line\n' }],
      ])
    );
    await expect(getContainerLogs(deps, 'abc123', 100)).resolves.toEqual({ logs: 'out line\nerr line\n' });
    const logsCall = calls.find((c) => c.args[0] === 'logs');
    expect(logsCall?.args).toEqual(['logs', '--tail', '100', 'abc123']);
  });

  it('matches short vs full ids and passes the LISTED id to docker', async () => {
    const { deps, calls } = makeDeps(
      new Map([['label=com.omni.omni-code', { stdout: `${psLine('0af06484b591')}\n` }]])
    );
    await getContainerLogs(deps, FULL_ID, 50);
    expect(calls.find((c) => c.args[0] === 'logs')?.args).toContain('0af06484b591');
  });

  it('caps tailLines at 2000 and floors non-positive input at 1', async () => {
    const { deps, calls } = makeDeps(new Map([['label=com.omni.omni-code', { stdout: `${psLine('abc123')}\n` }]]));
    await getContainerLogs(deps, 'abc123', 99_999);
    await getContainerLogs(deps, 'abc123', -5);
    const tails = calls.filter((c) => c.args[0] === 'logs').map((c) => c.args[2]);
    expect(tails).toEqual(['2000', '1']);
  });

  it('refuses ids that are not in the labeled listing, without running docker logs', async () => {
    const { deps, calls } = makeDeps(new Map([['label=com.omni.omni-code', { stdout: `${psLine('abc123')}\n` }]]));
    await expect(getContainerLogs(deps, 'not-ours', 100)).rejects.toThrow(/No sandbox container/);
    expect(calls.some((c) => c.args[0] === 'logs')).toBe(false);
  });
});

describe('getImageStatus', () => {
  it('maps an inspectable image to present + size', async () => {
    const { deps, calls } = makeDeps(new Map([['image inspect', { stdout: '123456789\n' }]]));
    await expect(getImageStatus(deps, 'ghcr.io/example/devbox:latest')).resolves.toEqual({
      image: 'ghcr.io/example/devbox:latest',
      present: true,
      sizeBytes: 123_456_789,
    });
    expect(calls[0]!.args).toEqual(['image', 'inspect', 'ghcr.io/example/devbox:latest', '--format', '{{.Size}}']);
  });

  it('maps "No such image" to present: false instead of throwing', async () => {
    const notFound = Object.assign(new Error('exit 1'), {
      stderr: 'Error response from daemon: No such image: ghcr.io/example/devbox:latest',
    });
    const { deps } = makeDeps(new Map([['image inspect', notFound]]));
    await expect(getImageStatus(deps, 'ghcr.io/example/devbox:latest')).resolves.toEqual({
      image: 'ghcr.io/example/devbox:latest',
      present: false,
      sizeBytes: null,
    });
  });

  it('rethrows docker-unavailable failures', async () => {
    const down = Object.assign(new Error('Cannot connect to the Docker daemon'), { code: 1 });
    const { deps } = makeDeps(new Map([['image inspect', down]]));
    await expect(getImageStatus(deps, 'devbox')).rejects.toThrow(/Cannot connect/);
  });

  it('rejects flag-shaped references before any exec', async () => {
    const { deps, calls } = makeDeps();
    await expect(getImageStatus(deps, '--evil')).rejects.toThrow(/Invalid image reference/);
    expect(calls).toHaveLength(0);
  });
});

describe('pullImage', () => {
  it('pulls a valid reference (registry port, tag, digest all pass the charset check)', async () => {
    const { deps, calls } = makeDeps();
    await pullImage(deps, 'registry.local:5000/team/devbox:1.2@sha256:abc123');
    expect(calls).toEqual([{ cmd: 'docker', args: ['pull', 'registry.local:5000/team/devbox:1.2@sha256:abc123'] }]);
  });

  it.each(['--evil', '-q', 'bad ref', 'a;b', 'img\nother', ''])(
    'rejects unsafe reference %j without running docker',
    async (ref) => {
      const { deps, calls } = makeDeps();
      await expect(pullImage(deps, ref)).rejects.toThrow(/Invalid image reference/);
      expect(calls).toHaveLength(0);
    }
  );

  it('rejects with the stderr tail when the pull fails', async () => {
    const failure = Object.assign(new Error('exit 1'), {
      stderr: 'Error response from daemon: manifest unknown: manifest unknown',
    });
    const { deps } = makeDeps(new Map([['pull', failure]]));
    await expect(pullImage(deps, 'ghcr.io/example/nope')).rejects.toThrow(/manifest unknown/);
  });
});

describe('image pruning', () => {
  it.each([
    ['Total reclaimed space: 234B', 234],
    ['Total reclaimed space: 1.2kB', 1_200],
    ['Total reclaimed space: 45.6MB', 45_600_000],
    ['Total reclaimed space: 1.5GB', 1_500_000_000],
    ['Total reclaimed space: 2GiB', 2 * 2 ** 30],
    ['Deleted Images:\nuntagged: foo\n\nTotal reclaimed space: 0B', 0],
    ['Total reclaimed space: garbage', null],
    ['', null],
  ])('parseReclaimedBytes(%j) → %o', (output, expected) => {
    expect(parseReclaimedBytes(output)).toBe(expected);
  });

  it('prunes dangling images and reports reclaimed bytes', async () => {
    const { deps, calls } = makeDeps(
      new Map([['image prune', { stdout: 'Deleted Images:\nsha256:aaa\n\nTotal reclaimed space: 1.5GB\n' }]])
    );
    await expect(pruneImages(deps)).resolves.toEqual({ reclaimedBytes: 1_500_000_000 });
    expect(calls).toEqual([{ cmd: 'docker', args: ['image', 'prune', '-f'] }]);
  });

  it('reports null when docker prints no reclaim line', async () => {
    const { deps } = makeDeps(new Map([['image prune', { stdout: '' }]]));
    await expect(pruneImages(deps)).resolves.toEqual({ reclaimedBytes: null });
  });
});

describe('getSubstrateStatus', () => {
  it('maps a missing binary (ENOENT) to missing', async () => {
    const enoent = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
    const { deps } = makeDeps(new Map([['version', enoent]]));
    await expect(getSubstrateStatus(deps)).resolves.toEqual({ docker: 'missing' });
  });

  it('maps a daemon-connect failure to daemon-down', async () => {
    const refused = Object.assign(new Error('Cannot connect to the Docker daemon'), { code: 1 });
    const { deps } = makeDeps(new Map([['version', refused]]));
    await expect(getSubstrateStatus(deps)).resolves.toEqual({ docker: 'daemon-down' });
  });

  it('returns ok with the server version', async () => {
    const { deps, calls } = makeDeps(new Map([['version', { stdout: '27.1.1\n' }]]));
    await expect(getSubstrateStatus(deps)).resolves.toEqual({ docker: 'ok', dockerVersion: '27.1.1' });
    expect(calls[0]!.args).toEqual(['version', '--format', '{{.Server.Version}}']);
  });
});

describe('ownership label helpers', () => {
  const tab = (over: Partial<CodeTab>): CodeTab => ({ id: 'tab-1', projectId: null, createdAt: 0, ...over });

  it('codeTabLabel prefers ticket title, then routine, then app, then Chat', () => {
    expect(codeTabLabel(tab({ ticketTitle: 'Fix bug', routineName: 'r' }))).toBe('Fix bug');
    expect(codeTabLabel(tab({ routineName: 'Nightly' }))).toBe('Nightly');
    expect(codeTabLabel(tab({ customAppId: 'marimo' }))).toBe('marimo');
    expect(codeTabLabel(tab({}))).toBe('Chat');
  });

  it('processOwnersFromState labels tab processes, residents, and unknowns', () => {
    const owners = processOwnersFromState(
      [
        { processId: 'tab-1', containerId: 'c1' },
        { processId: 'agent:scout', containerId: 'c2' },
        { processId: 'mystery', containerId: 'c3' },
      ],
      [tab({ id: 'tab-1', ticketTitle: 'Fix bug' })],
      [{ id: 'scout', name: 'Scout' }]
    );
    expect(owners).toEqual([
      { containerId: 'c1', label: 'Fix bug' },
      { containerId: 'c2', label: 'Scout' },
      { containerId: 'c3', label: 'mystery' },
    ]);
  });
});
