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
  getSubstrateStatus,
  listContainers,
  processOwnersFromState,
  removeContainer,
  type SandboxInventoryDeps,
  sweepOrphans,
  warmReattachOwnersFromTabs,
} from '@/main/sandbox-inventory';
import type { CodeTab } from '@/shared/types';

type ExecCall = { cmd: string; args: string[] };

function makeDeps(responses: Map<string, { stdout: string } | Error> = new Map()): {
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
        return { stdout: response.stdout, stderr: '' };
      }
    }
    return { stdout: '', stderr: '' };
  }) as unknown as DockerExecFn;

  return {
    deps: {
      execFileFn,
      getEnv: () => ({ PATH: '/usr/bin' }),
      getProcessOwners: () => [],
      getWarmReattachIds: () => [],
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

  it('joins ownership with process > warm-reattach precedence, matching short vs full ids', async () => {
    const { deps } = makeDeps(
      new Map([
        [
          'label=com.omni.omni-code',
          { stdout: `${psLine('0af06484b591')}\n${psLine('bbb222')}\n${psLine('ccc333')}\n` },
        ],
      ])
    );
    deps.getProcessOwners = () => [{ containerId: FULL_ID, label: 'Fix the login bug' }];
    deps.getWarmReattachIds = () => [
      // Also claims the live container — the process owner must win.
      { containerId: FULL_ID, label: 'stale tab claim' },
      { containerId: 'bbb222', label: 'Nightly build routine' },
    ];
    const result = await listContainers(deps);
    expect(result[0]).toMatchObject({ ownerKind: 'process', ownerLabel: 'Fix the login bug' });
    expect(result[1]).toMatchObject({ ownerKind: 'warm-reattach', ownerLabel: 'Nightly build routine' });
    expect(result[2]).toMatchObject({ ownerKind: 'orphan', ownerLabel: null });
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

  it('throws with the owner label for a warm-reattach claim', async () => {
    const { deps } = makeDeps();
    deps.getWarmReattachIds = () => [{ containerId: 'abc123', label: 'Nightly build routine' }];
    await expect(removeContainer(deps, 'abc123')).rejects.toThrow(
      'Container is in use by a resumable session: Nightly build routine'
    );
  });
});

describe('sweepOrphans', () => {
  it('removes only unprotected containers and reports the removed ids', async () => {
    const { deps, calls } = makeDeps(
      new Map([['label=com.omni.omni-code', { stdout: '0af06484b591\nbbb222\nccc333\n' }]])
    );
    deps.getProcessOwners = () => [{ containerId: FULL_ID, label: 'live session' }];
    deps.getWarmReattachIds = () => [{ containerId: 'bbb222', label: 'tab' }];
    const result = await sweepOrphans(deps);
    expect(result).toEqual({ removed: ['ccc333'] });
    const rmCalls = calls.filter((c) => c.args[0] === 'rm');
    expect(rmCalls).toEqual([{ cmd: 'docker', args: ['rm', '-f', 'ccc333'] }]);
  });

  it('reports an empty list when Docker is unavailable', async () => {
    const { deps } = makeDeps(new Map([['docker version', new Error('not found')]]));
    await expect(sweepOrphans(deps)).resolves.toEqual({ removed: [] });
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

  it('warmReattachOwnersFromTabs keeps only tabs with container ids', () => {
    expect(
      warmReattachOwnersFromTabs([tab({ id: 'a', containerId: 'c1', routineName: 'Nightly' }), tab({ id: 'b' })])
    ).toEqual([{ containerId: 'c1', label: 'Nightly' }]);
  });
});
