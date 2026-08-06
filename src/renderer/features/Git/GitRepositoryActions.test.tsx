import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitClient, GitStatusResult } from '@/renderer/omniagents-ui/rpc/git';
import { workspaceRepo } from '@/renderer/omniagents-ui/rpc/git';

import { GitRepositoryActions, type GitRepositoryCapabilities } from './GitRepositoryActions';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const repo = workspaceRepo('.');
const status: GitStatusResult = {
  environment_id: 'environment-1',
  repo,
  head: { detached: false, unborn: false, branch: 'main', oid: 'abc' },
  upstream: { name: 'origin/main', ahead: 1, behind: 0 },
  entries: [
    {
      path: 'src/app.ts',
      orig_path: null,
      xy: 'M.',
      index_status: 'modified',
      worktree_status: 'unmodified',
      staged: true,
      unstaged: false,
      submodule: false,
      similarity: null,
      unmerged: null,
    },
  ],
  untracked: [],
  ignored: [],
  conflicted: ['src/conflict.ts'],
  stash_count: 0,
  clean: false,
  state: 'merging',
};

const allCapabilities: GitRepositoryCapabilities = {
  commit: true,
  log: true,
  branches: true,
  worktrees: true,
  conflicts: true,
  stage: true,
  checkout: true,
  reset: true,
  fetch: true,
  pull: true,
  push: true,
  progress: true,
};

const mocks = {
  log: vi.fn(),
  branches: vi.fn(),
  worktrees: vi.fn(),
  conflicts: vi.fn(),
  commit: vi.fn(),
  confirmCommit: vi.fn(),
  checkout: vi.fn(),
  confirmCheckout: vi.fn(),
  reset: vi.fn(),
  confirmReset: vi.fn(),
  fetch: vi.fn(),
  pull: vi.fn(),
  push: vi.fn(),
  confirmPush: vi.fn(),
  stage: vi.fn(),
  onOperationProgress: vi.fn(),
};

let container: HTMLDivElement;
let root: Root;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')]
    .filter((candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label)
    .at(-1);
  if (!found) {
    throw new Error(`Button not found: ${label}`);
  }
  return found;
}

function inputValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.log.mockResolvedValue({
    environment_id: 'environment-1',
    repo,
    commits: [
      {
        oid: 'abcdef',
        short_oid: 'abcdef',
        parents: [],
        author_name: 'Ada',
        author_email: 'ada@example.test',
        authored_at: '2026-01-01T00:00:00Z',
        committer_name: 'Ada',
        committer_email: 'ada@example.test',
        committed_at: '2026-01-01T00:00:00Z',
        refs: ['HEAD -> main'],
        subject: 'Initial commit',
        body: '',
      },
    ],
    max_count: 50,
    truncated: false,
  });
  mocks.branches.mockResolvedValue({
    environment_id: 'environment-1',
    repo,
    branches: [
      {
        ref: 'refs/heads/main',
        name: 'main',
        oid: 'abc',
        remote: false,
        upstream: 'origin/main',
        upstream_remote: 'origin',
        current: true,
        worktree_path: null,
        category: 'branch',
      },
      {
        ref: 'refs/heads/feature',
        name: 'feature',
        oid: 'def',
        remote: false,
        upstream: null,
        upstream_remote: null,
        current: false,
        worktree_path: null,
        category: 'branch',
      },
    ],
  });
  mocks.worktrees.mockResolvedValue({
    environment_id: 'environment-1',
    repo,
    worktrees: [
      {
        path: '/workspace',
        head: 'abc',
        branch: 'main',
        detached: false,
        bare: false,
        locked: false,
        lock_reason: null,
        prunable: false,
        repo,
        accessible: true,
        inaccessible_reason: null,
        category: 'worktree',
      },
    ],
  });
  mocks.conflicts.mockResolvedValue({
    environment_id: 'environment-1',
    repo,
    state: 'merging',
    conflicts: [
      {
        path: 'src/conflict.ts',
        stages: {},
        regions: [
          {
            start_line: 2,
            end_line: 6,
            ours_label: 'HEAD',
            base_label: null,
            theirs_label: 'feature',
            ours: ['ours'],
            base: null,
            theirs: ['theirs'],
          },
        ],
        regions_available: true,
      },
    ],
    content_truncated: false,
  });
  mocks.commit.mockResolvedValue({
    kind: 'completed',
    result: { environment_id: 'environment-1', repo, oid: 'new', amended: false },
  });
  mocks.confirmCommit.mockResolvedValue({
    kind: 'completed',
    result: { environment_id: 'environment-1', repo, oid: 'new', amended: false },
  });
  mocks.checkout.mockResolvedValue({ kind: 'completed', result: status });
  mocks.confirmCheckout.mockResolvedValue({ kind: 'completed', result: status });
  mocks.reset.mockResolvedValue({ kind: 'completed', result: status });
  mocks.confirmReset.mockResolvedValue({ kind: 'completed', result: status });
  mocks.fetch.mockResolvedValue({ environment_id: 'environment-1', repo, remote: 'origin', updated_refs: [] });
  mocks.pull.mockResolvedValue({
    environment_id: 'environment-1',
    repo,
    ok: true,
    state: 'clean',
    conflicted: [],
    head: status.head,
  });
  mocks.push.mockResolvedValue({
    kind: 'completed',
    result: { environment_id: 'environment-1', repo, ok: true, remote_url: null, updates: [], rejected: [] },
  });
  mocks.confirmPush.mockResolvedValue({
    kind: 'completed',
    result: { environment_id: 'environment-1', repo, ok: true, remote_url: null, updates: [], rejected: [] },
  });
  mocks.stage.mockResolvedValue({
    environment_id: 'environment-1',
    repo,
    staged_paths: ['src/conflict.ts'],
    staged_hunks: [],
  });
  mocks.onOperationProgress.mockReturnValue(() => {});
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function render(capabilities = allCapabilities, onChanged = vi.fn(), onOpenFile = vi.fn()) {
  act(() =>
    root.render(
      <GitRepositoryActions
        client={mocks as unknown as GitClient}
        repo={repo}
        status={status}
        capabilities={capabilities}
        onChanged={onChanged}
        onOpenFile={onOpenFile}
      />
    )
  );
  return { onChanged, onOpenFile };
}

describe('GitRepositoryActions', () => {
  it('gates controls and reads by negotiated operations', async () => {
    render({
      ...allCapabilities,
      commit: false,
      branches: false,
      checkout: false,
      fetch: false,
      pull: false,
      push: false,
    });
    expect(() => button('Fetch')).toThrow();
    expect(container.textContent).not.toContain('Commit staged changes');

    act(() => button('Repository tools').click());
    await settle();

    expect(container.textContent).toContain('History');
    expect(container.textContent).toContain('Initial commit');
    expect(container.textContent).not.toContain('Branches');
    expect(mocks.log).toHaveBeenCalledWith(repo, { maxCount: 50 });
    expect(mocks.branches).not.toHaveBeenCalled();
  });

  it('loads history, branches, worktrees and conflicts, then runs checkout and conflict resolution', async () => {
    const onChanged = vi.fn();
    const onOpenFile = vi.fn();
    const branchCapabilities = {
      ...allCapabilities,
      commit: false,
      log: false,
      reset: false,
      fetch: false,
      pull: false,
      push: false,
      progress: false,
    };
    render(branchCapabilities, onChanged, onOpenFile);
    act(() => button('Repository tools').click());
    await settle();

    expect(mocks.branches).toHaveBeenCalledWith(repo, true);
    expect(mocks.worktrees).toHaveBeenCalledWith(repo);
    expect(mocks.conflicts).toHaveBeenCalledWith(repo);

    await act(async () => button('Checkout').click());
    await settle();
    expect(mocks.checkout).toHaveBeenCalledWith(repo, 'feature', {});

    const newBranch = container.querySelector<HTMLInputElement>('input[aria-label="New branch"]')!;
    act(() => inputValue(newBranch, 'feature/new-ui'));
    await act(async () => button('Create and checkout').click());
    await settle();
    expect(mocks.checkout).toHaveBeenCalledWith(repo, 'feature/new-ui', { create: true });

    render({ ...branchCapabilities, branches: false, checkout: false, worktrees: false }, onChanged, onOpenFile);
    await settle();
    act(() => button('Open file').click());
    expect(onOpenFile).toHaveBeenCalledWith('src/conflict.ts', 2);
    await act(async () => button('Mark resolved').click());
    await settle();
    expect(mocks.stage).toHaveBeenCalledWith(repo, { paths: ['src/conflict.ts'] });
    expect(onChanged).toHaveBeenCalled();
  });

  it('shows typed worktrees without offering unsupported worktree mutations', async () => {
    const capabilities = {
      ...allCapabilities,
      commit: false,
      log: false,
      branches: false,
      conflicts: false,
      stage: false,
      checkout: false,
      reset: false,
      fetch: false,
      pull: false,
      push: false,
      progress: false,
    };
    render(capabilities);
    act(() => button('Repository tools').click());
    await settle();

    expect(container.textContent).toContain('/workspace');
    expect(container.textContent).toContain('main');
    expect(container.textContent).not.toContain('Delete worktree');
  });

  it('redeems the server challenge before a hard reset', async () => {
    const confirmation = { operation: 'reset', impact: { dirty_paths: ['src/app.ts'] }, repo };
    mocks.reset.mockResolvedValue({ kind: 'confirmation_required', confirmation });
    const capabilities = {
      ...allCapabilities,
      commit: false,
      log: false,
      branches: false,
      worktrees: false,
      conflicts: false,
      stage: false,
      checkout: false,
      fetch: false,
      pull: false,
      push: false,
      progress: false,
    };
    render(capabilities);
    act(() => button('Repository tools').click());
    await settle();

    const mode = container.querySelector<HTMLSelectElement>('select[aria-label="Reset mode"]')!;
    mode.value = 'hard';
    act(() => mode.dispatchEvent(new Event('change', { bubbles: true })));
    const revision = container.querySelector<HTMLInputElement>('input[aria-label="Reset revision"]')!;
    act(() => inputValue(revision, 'HEAD~1'));
    await act(async () => button('Reset').click());
    await settle();
    expect(mocks.reset).toHaveBeenCalledWith(repo, { mode: 'hard', rev: 'HEAD~1' });

    await act(async () => button('Confirm operation').click());
    await settle();
    expect(mocks.confirmReset).toHaveBeenCalledWith(repo, { mode: 'hard', rev: 'HEAD~1' }, confirmation);
  });

  it('redeems a server confirmation for commit and exposes fetch/pull/push', async () => {
    const confirmation = { operation: 'commit', impact: { amended_commit: 'abc' }, repo };
    mocks.commit.mockResolvedValue({ kind: 'confirmation_required', confirmation });
    const { onChanged } = render();
    act(() => button('Repository tools').click());
    await settle();

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Commit message"]')!;
    act(() => inputValue(textarea, 'Ship it'));
    await act(async () => button('Commit staged changes').click());
    await settle();
    expect(mocks.commit).toHaveBeenCalledWith(repo, 'Ship it', {});
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('amended commit: abc');

    await act(async () => button('Confirm operation').click());
    await settle();
    expect(mocks.confirmCommit).toHaveBeenCalledWith(repo, 'Ship it', {}, confirmation);

    await act(async () => button('Fetch').click());
    await settle();
    await act(async () => button('Pull').click());
    await settle();
    await act(async () => button('Push').click());
    await settle();
    expect(mocks.fetch).toHaveBeenCalledWith(repo);
    expect(mocks.pull).toHaveBeenCalledWith(repo, { rebase: false });
    expect(mocks.push).toHaveBeenCalledWith(repo, {});
    expect(onChanged).toHaveBeenCalled();
    for (let index = 0; index < 5 && button('Push').disabled; index += 1) {
      await settle();
    }

    mocks.push.mockResolvedValue({
      kind: 'completed',
      result: {
        environment_id: 'environment-1',
        repo,
        ok: false,
        remote_url: null,
        updates: [],
        rejected: ['refs/heads/main'],
      },
    });
    const pushCalls = mocks.push.mock.calls.length;
    await act(async () => button('Push').click());
    await settle();
    expect(mocks.push).toHaveBeenCalledTimes(pushCalls + 1);
    expect(container.textContent).toContain('Push rejected: refs/heads/main');
  });
});
