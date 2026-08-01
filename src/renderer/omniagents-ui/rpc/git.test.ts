import { describe, expect, it, vi } from 'vitest';

import { OmniagentsRpcError } from '@/shared/omniagents-rpc';

import type { RPCClient } from './client';
import { GitClient, workspaceRepo } from './git';

type Transport = Pick<RPCClient, 'request' | 'on'>;

const repo = workspaceRepo('apps/web');
const session = 'session-1';

function status(overrides: Record<string, unknown> = {}) {
  return {
    session_id: session,
    repo,
    head: { detached: false, unborn: false, branch: 'main', oid: 'abc' },
    upstream: { name: 'origin/main', ahead: 1, behind: 2 },
    entries: [],
    untracked: [],
    ignored: [],
    conflicted: [],
    stash_count: 0,
    clean: true,
    state: 'clean',
    ...overrides,
  };
}

function transport(result: unknown) {
  return {
    request: vi.fn().mockResolvedValue(result),
    on: vi.fn().mockReturnValue(() => {}),
  } as unknown as Transport;
}

function confirmationError(
  operation: string,
  impact: Record<string, unknown> = { dirty_paths: ['a.ts'] },
  reason = 'confirmation_required'
) {
  return new OmniagentsRpcError({
    code: -32093,
    message: 'Confirmation required',
    data: {
      kind: 'git_confirmation_required',
      operation,
      repo,
      confirmation_token: 'once-only',
      impact,
      reason,
    },
  });
}

describe('workspaceRepo', () => {
  it('accepts root and nested workspace-relative POSIX repositories', () => {
    expect(workspaceRepo('.')).toBe('.');
    expect(workspaceRepo('apps/web')).toBe('apps/web');
  });

  it.each(['/tmp/repo', '../repo', 'apps/../repo', 'C:/repo', 'apps\\repo', 'apps//repo', ''])('rejects %j', (path) => {
    expect(() => workspaceRepo(path)).toThrow(/workspace-relative POSIX/);
  });
});

describe('GitClient read boundaries', () => {
  it('always sends the explicit session and repository, and omits unset options', async () => {
    const rpc = transport(status());
    const client = new GitClient(rpc, session);

    await client.status(repo);

    expect(rpc.request).toHaveBeenCalledWith('git_status', { session_id: session, repo });
  });

  it('validates status echoes and nested fields instead of casting open records', async () => {
    const rpc = transport(status({ repo: 'other/repo' }));
    await expect(new GitClient(rpc, session).status(repo)).rejects.toThrow(/wrong repository/);

    vi.mocked(rpc.request).mockResolvedValue(status({ head: { branch: 42 } }) as never);
    await expect(new GitClient(rpc, session).status(repo)).rejects.toThrow(/head.detached/);
  });

  it('preserves content-addressed hunk ids, scope, and effective context', async () => {
    const rpc = transport({
      session_id: session,
      repo,
      mode: 'head',
      context_lines: 64,
      context_lines_clamped: true,
      files: [
        {
          path: 'src/app.ts',
          old_path: null,
          change: 'modified',
          old_mode: '100644',
          new_mode: '100644',
          old_oid: 'aaa',
          new_oid: 'bbb',
          similarity: null,
          binary: false,
          added_lines: 1,
          deleted_lines: 1,
          unmerged: false,
          submodule: false,
          hunk_selectable: true,
          hunks: [
            {
              hunk_id: 'deadbeefdeadbeef',
              index: 0,
              header: '@@ -1 +1 @@',
              section_heading: '',
              old_start: 1,
              old_lines: 1,
              new_start: 1,
              new_lines: 1,
              lines: [{ origin: 'add', content: 'new', old_lineno: null, new_lineno: 1 }],
            },
          ],
        },
      ],
    });
    const result = await new GitClient(rpc, session).diff(repo, { mode: 'head', contextLines: 999 });

    expect(result.context_lines_clamped).toBe(true);
    expect(result.files[0]?.hunks[0]?.hunk_id).toBe('deadbeefdeadbeef');
    expect(rpc.request).toHaveBeenCalledWith('git_diff', {
      session_id: session,
      repo,
      mode: 'head',
      context_lines: 999,
    });
  });

  it('parses repository discovery clamps and unreachable sources', async () => {
    const rpc = transport({
      session_id: session,
      path: '.',
      repositories: [
        {
          repo: 'apps/web',
          root: 'apps/web',
          absolute_root: '/workspace/apps/web',
          branch: 'main',
          detached: false,
          bare: false,
          git_common_dir: '/workspace/apps/web/.git',
          is_linked_worktree: false,
          source: { mountName: 'web' },
        },
      ],
      sources: [{ mountName: 'web' }],
      unreachable_sources: [
        { mount_name: 'outside', kind: 'local-git', path: '/outside', repo_url: null, reason: 'not_in_workspace' },
      ],
      max_depth: 4,
      max_depth_clamped: true,
      truncated: true,
    });

    const result = await new GitClient(rpc, session).listRepositories({ maxDepth: 99 });
    expect(result.repositories[0]?.repo).toBe(repo);
    expect(result.max_depth_clamped).toBe(true);
    expect(result.unreachable_sources[0]?.reason).toBe('not_in_workspace');
  });

  it('rejects invalid discovery depth and a mismatched echoed path', async () => {
    const rpc = transport({
      session_id: session,
      path: 'other',
      repositories: [],
      sources: [],
      unreachable_sources: [],
      max_depth: 1,
      max_depth_clamped: false,
      truncated: false,
    });
    const client = new GitClient(rpc, session);

    await expect(client.listRepositories({ maxDepth: -1 })).rejects.toThrow(/non-negative safe integer/);
    await expect(client.listRepositories({ maxDepth: 1.5 })).rejects.toThrow(/non-negative safe integer/);
    await expect(client.listRepositories({ path: 'apps' })).rejects.toThrow(/wrong path/);
    expect(rpc.request).toHaveBeenCalledTimes(1);
  });

  it('filters operation progress to its session and unsubscribes through the public event API', () => {
    let handler: ((payload: Record<string, unknown>) => void) | undefined;
    const unsubscribe = vi.fn();
    const rpc = transport(status());
    vi.mocked(rpc.on).mockImplementation((_event, next) => {
      handler = next as (payload: Record<string, unknown>) => void;
      return unsubscribe;
    });
    const received = vi.fn();

    const stop = new GitClient(rpc, session).onOperationProgress(received);
    handler?.({ session_id: 'other', operation_id: '1', repo, operation: 'fetch', phase: 'started' });
    handler?.({ session_id: session, operation_id: '2', repo, operation: 'fetch', phase: 'completed' });
    stop();

    expect(rpc.on).toHaveBeenCalledWith('git_operation_progress', expect.any(Function));
    expect(received).toHaveBeenCalledTimes(1);
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ operation_id: '2' }));
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

describe('GitClient mutations', () => {
  it('sends hunk ids with the exact diff scope and context', async () => {
    const rpc = transport({
      session_id: session,
      repo,
      staged_paths: [],
      staged_hunks: [{ path: 'a.ts', hunk_id: '0123456789abcdef' }],
    });
    const result = await new GitClient(rpc, session).stage(repo, {
      hunks: [{ path: 'a.ts', hunk_id: '0123456789abcdef' }],
      mode: 'head',
      contextLines: 12,
    });

    expect(result.staged_hunks[0]?.hunk_id).toBe('0123456789abcdef');
    expect(rpc.request).toHaveBeenCalledWith('git_stage', {
      session_id: session,
      repo,
      hunks: [{ path: 'a.ts', hunk_id: '0123456789abcdef' }],
      mode: 'head',
      context_lines: 12,
    });
  });

  it('requires a visible challenge and resends identical destructive params exactly once', async () => {
    const rpc = transport(undefined);
    vi.mocked(rpc.request)
      .mockRejectedValueOnce(confirmationError('discard_changes'))
      .mockResolvedValueOnce({ session_id: session, repo, discarded_paths: ['a.ts'], discarded_hunks: [] } as never);
    const client = new GitClient(rpc, session);
    const selection = { paths: ['a.ts'], contextLines: 3 };

    const first = await client.discard(repo, selection);
    expect(first.kind).toBe('confirmation_required');
    if (first.kind !== 'confirmation_required') {
      throw new Error('challenge expected');
    }
    expect(first.confirmation.impact).toEqual({ dirty_paths: ['a.ts'] });

    await client.confirmDiscard(repo, selection, first.confirmation);
    expect(rpc.request).toHaveBeenNthCalledWith(1, 'git_discard', {
      session_id: session,
      repo,
      paths: ['a.ts'],
      context_lines: 3,
    });
    expect(rpc.request).toHaveBeenNthCalledWith(2, 'git_discard', {
      session_id: session,
      repo,
      paths: ['a.ts'],
      context_lines: 3,
      confirmation_token: 'once-only',
    });
    await expect(client.confirmDiscard(repo, selection, first.confirmation)).rejects.toThrow(/already been used/);
  });

  it('refuses a token when any bound operation input changes', async () => {
    const rpc = transport(undefined);
    vi.mocked(rpc.request).mockRejectedValueOnce(confirmationError('reset_hard'));
    const client = new GitClient(rpc, session);
    const first = await client.reset(repo, { mode: 'hard', rev: 'HEAD' });
    if (first.kind !== 'confirmation_required') {
      throw new Error('challenge expected');
    }

    await expect(client.confirmReset(repo, { mode: 'hard', rev: 'HEAD~1' }, first.confirmation)).rejects.toThrow(
      /does not match/
    );
  });

  it('fails closed on an unrecognized confirmation reason', async () => {
    const rpc = transport(undefined);
    vi.mocked(rpc.request).mockRejectedValueOnce(confirmationError('reset_hard', {}, 'unexpected_reason'));

    await expect(new GitClient(rpc, session).reset(repo, { mode: 'hard' })).rejects.toThrow(
      /Invalid confirmation reason/
    );
  });

  it('surfaces stale confirmation as a new challenge without auto-redeeming it', async () => {
    const rpc = transport(undefined);
    vi.mocked(rpc.request)
      .mockRejectedValueOnce(confirmationError('amend_commit'))
      .mockRejectedValueOnce(confirmationError('amend_commit', { staged_paths: ['new.ts'] }));
    const client = new GitClient(rpc, session);
    const first = await client.commit(repo, 'amend', { amend: true });
    if (first.kind !== 'confirmation_required') {
      throw new Error('challenge expected');
    }

    const stale = await client.confirmCommit(repo, 'amend', { amend: true }, first.confirmation);
    expect(stale.kind).toBe('confirmation_required');
    if (stale.kind !== 'confirmation_required') {
      throw new Error('fresh challenge expected');
    }
    expect(stale.confirmation.impact).toEqual({ staged_paths: ['new.ts'] });
    expect(rpc.request).toHaveBeenCalledTimes(2);
  });

  it('keeps conflicted pulls and rejected pushes as structured results', async () => {
    const rpc = transport({
      session_id: session,
      repo,
      ok: false,
      state: 'merging',
      conflicted: ['a.ts'],
      head: { detached: false, unborn: false, branch: 'main', oid: 'abc' },
    });
    const client = new GitClient(rpc, session);
    await expect(client.pull(repo)).resolves.toMatchObject({ ok: false, conflicted: ['a.ts'] });

    vi.mocked(rpc.request).mockResolvedValue({
      session_id: session,
      repo,
      ok: false,
      remote_url: 'https://example.test/repo',
      updates: [
        {
          flag: '!',
          status: 'rejected',
          rejected: true,
          source_ref: 'refs/heads/main',
          target_ref: 'refs/heads/main',
          summary_raw: '[rejected]',
          reason_raw: 'non-fast-forward',
        },
      ],
      rejected: ['refs/heads/main'],
    } as never);
    await expect(client.push(repo)).resolves.toMatchObject({
      kind: 'completed',
      result: { ok: false, rejected: ['refs/heads/main'] },
    });
  });

  it('covers repository, history, branch, worktree, conflict, unstage, checkout, fetch, and network request names', async () => {
    const rpc = transport({ session_id: session, repo, unstaged_paths: [], unstaged_hunks: [] });
    const client = new GitClient(rpc, session);
    await client.unstage(repo, { paths: ['a.ts'] });

    vi.mocked(rpc.request).mockResolvedValue({
      session_id: session,
      repo,
      head: status().head,
      upstream: null,
      entries: [],
      untracked: [],
      ignored: [],
      conflicted: [],
      stash_count: 0,
      clean: true,
      state: 'clean',
    } as never);
    await client.checkout(repo, 'main');

    vi.mocked(rpc.request).mockResolvedValue({
      session_id: session,
      repo,
      remote: 'origin',
      updated_refs: [],
    } as never);
    await client.fetch(repo);

    const methods = vi.mocked(rpc.request).mock.calls.map(([method]) => method);
    expect(methods).toEqual(['git_unstage', 'git_checkout', 'git_fetch']);
  });
});
