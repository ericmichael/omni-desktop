import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitClient, WorkspaceRepo } from '@/renderer/omniagents-ui/rpc/git';
import { workspaceRepo } from '@/renderer/omniagents-ui/rpc/git';

import { type GitRepositoryCapabilities, type GitSyncOptions, GitToolsPanel } from './GitToolsPanel';
import { describeConfirmation, useGitMutations } from './use-git-mutations';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const repo = workspaceRepo('.');

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
  progress: false,
};

const mocks = {
  log: vi.fn(),
  branches: vi.fn(),
  worktrees: vi.fn(),
  conflicts: vi.fn(),
  checkout: vi.fn(),
  confirmCheckout: vi.fn(),
  reset: vi.fn(),
  confirmReset: vi.fn(),
  stage: vi.fn(),
  onOperationProgress: vi.fn(() => () => {}),
};

const syncOptions: GitSyncOptions = { rebase: false, forceWithLease: false, setUpstream: false };

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

/** Mounts the panel exactly as the surface does: one shared mutations hook
 *  plus the surface-owned confirmation dialog. */
function Harness({
  capabilities,
  onChanged,
  onOpenFile,
}: {
  capabilities: GitRepositoryCapabilities;
  onChanged: () => void;
  onOpenFile?: (path: string, line?: number) => void;
}) {
  const mutations = useGitMutations({
    client: mocks as unknown as GitClient,
    repo: repo as WorkspaceRepo,
    subscribeProgress: capabilities.progress,
    onChanged,
  });
  const description = mutations.pending ? describeConfirmation(mutations.pending) : null;
  return (
    <>
      <GitToolsPanel
        client={mocks as unknown as GitClient}
        repo={repo}
        capabilities={capabilities}
        mutations={mutations}
        revision={0}
        syncOptions={syncOptions}
        onSyncOptionsChange={() => {}}
        onOpenFile={onOpenFile}
      />
      {mutations.pending ? (
        <div role="alertdialog">
          {description?.body}
          <button onClick={mutations.confirm}>Confirm operation</button>
        </div>
      ) : null}
    </>
  );
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
  mocks.checkout.mockResolvedValue({ kind: 'completed', result: {} });
  mocks.confirmCheckout.mockResolvedValue({ kind: 'completed', result: {} });
  mocks.reset.mockResolvedValue({ kind: 'completed', result: {} });
  mocks.confirmReset.mockResolvedValue({ kind: 'completed', result: {} });
  mocks.stage.mockResolvedValue({ environment_id: 'environment-1', repo, staged_paths: [], staged_hunks: [] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function render(capabilities = allCapabilities, onChanged = vi.fn(), onOpenFile = vi.fn()) {
  act(() => root.render(<Harness capabilities={capabilities} onChanged={onChanged} onOpenFile={onOpenFile} />));
  return { onChanged, onOpenFile };
}

describe('GitToolsPanel', () => {
  it('gates detail reads and tabs by negotiated operations', async () => {
    render({
      ...allCapabilities,
      branches: false,
      worktrees: false,
      conflicts: false,
      checkout: false,
      pull: false,
      push: false,
    });
    await settle();

    expect(container.textContent).toContain('History');
    expect(container.textContent).toContain('Initial commit');
    expect(container.textContent).not.toContain('Branches');
    expect(container.textContent).not.toContain('Rebase when pulling');
    expect(mocks.log).toHaveBeenCalledWith(repo, { maxCount: 50 });
    expect(mocks.branches).not.toHaveBeenCalled();
  });

  it('checks out existing and new branches through the shared mutation pipeline', async () => {
    const { onChanged } = render({ ...allCapabilities, log: false, worktrees: false, conflicts: false });
    await settle();

    expect(mocks.branches).toHaveBeenCalledWith(repo, true);
    await act(async () => button('Checkout').click());
    await settle();
    expect(mocks.checkout).toHaveBeenCalledWith(repo, 'feature', {});
    expect(onChanged).toHaveBeenCalled();

    const newBranch = container.querySelector<HTMLInputElement>('input[aria-label="New branch"]')!;
    act(() => inputValue(newBranch, 'feature/new-ui'));
    await act(async () => button('Create and checkout').click());
    await settle();
    expect(mocks.checkout).toHaveBeenCalledWith(repo, 'feature/new-ui', { create: true });
  });

  it('opens and resolves conflicts', async () => {
    const { onChanged, onOpenFile } = render({
      ...allCapabilities,
      log: false,
      branches: false,
      worktrees: false,
      checkout: false,
      reset: false,
    });
    await settle();

    act(() => button('Open file').click());
    expect(onOpenFile).toHaveBeenCalledWith('src/conflict.ts', 2);

    await act(async () => button('Mark resolved').click());
    await settle();
    expect(mocks.stage).toHaveBeenCalledWith(repo, { paths: ['src/conflict.ts'] });
    expect(onChanged).toHaveBeenCalled();
  });

  it('redeems the server challenge before a hard reset', async () => {
    const confirmation = { operation: 'reset', impact: { dirty_paths: ['src/app.ts'] }, repo };
    mocks.reset.mockResolvedValue({ kind: 'confirmation_required', confirmation });
    render({
      ...allCapabilities,
      log: false,
      branches: false,
      worktrees: false,
      conflicts: false,
      checkout: false,
      pull: false,
      push: false,
    });
    await settle();

    const mode = container.querySelector<HTMLSelectElement>('select[aria-label="Reset mode"]')!;
    mode.value = 'hard';
    act(() => mode.dispatchEvent(new Event('change', { bubbles: true })));
    const revision = container.querySelector<HTMLInputElement>('input[aria-label="Reset revision"]')!;
    act(() => inputValue(revision, 'HEAD~1'));
    await act(async () => button('Reset').click());
    await settle();
    expect(mocks.reset).toHaveBeenCalledWith(repo, { mode: 'hard', rev: 'HEAD~1' });
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('Dirty paths: src/app.ts');

    await act(async () => button('Confirm operation').click());
    await settle();
    expect(mocks.confirmReset).toHaveBeenCalledWith(repo, { mode: 'hard', rev: 'HEAD~1' }, confirmation);
  });
});
