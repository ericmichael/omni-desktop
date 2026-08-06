import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitDiffResult, GitRepository, GitStatusResult, WorkspaceRepo } from '@/renderer/omniagents-ui/rpc/git';
import { GitClient, workspaceRepo } from '@/renderer/omniagents-ui/rpc/git';
import type { ProjectSource } from '@/shared/types';

import { GitSurface, sourceForRepository } from './GitSurface';

const mocks = vi.hoisted(() => ({
  connected: true,
  store: { codeTabs: [], projects: [], defaultProfileName: 'host' } as any,
  invoke: vi.fn(),
  rpc: {
    serverCall: vi.fn().mockResolvedValue({}),
    supportsExperimentalOperation: vi.fn().mockReturnValue(true),
  },
  git: {
    listRepositories: vi.fn(),
    status: vi.fn(),
    diff: vi.fn(),
    stage: vi.fn(),
    unstage: vi.fn(),
    discard: vi.fn(),
    confirmDiscard: vi.fn(),
    onOperationProgress: vi.fn(() => () => {}),
  },
}));

vi.mock('@nanostores/react', () => ({ useStore: () => mocks.store }));

vi.mock('@/renderer/services/ipc', () => ({ emitter: { invoke: mocks.invoke } }));

vi.mock('@/renderer/services/store', () => ({ persistedStoreApi: { $atom: {} } }));

vi.mock('@/renderer/omniagents-ui/rpc-context', () => ({
  useRPCClient: () => mocks.rpc,
  useRPCConnected: () => mocks.connected,
}));

vi.mock('@/renderer/omniagents-ui/rpc/git', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/renderer/omniagents-ui/rpc/git')>();
  return { ...original, GitClient: vi.fn(() => mocks.git) };
});

vi.mock('@/renderer/ds', async () => {
  const { createElement } = await import('react');
  return {
    Button: ({ children, ...props }: any) => createElement('button', props, children),
    Select: ({ children, ...props }: any) => createElement('select', props, children),
    Spinner: () => createElement('span', { 'aria-hidden': true }, 'loading'),
  };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const repo = workspaceRepo('.');
const status: GitStatusResult = {
  environment_id: 'environment-1',
  repo,
  head: { detached: false, unborn: false, branch: 'main', oid: 'abc' },
  upstream: { name: 'origin/main', ahead: 1, behind: 0 },
  entries: [
    {
      path: 'src/index.ts',
      orig_path: null,
      xy: '.M',
      index_status: 'unmodified',
      worktree_status: 'modified',
      staged: false,
      unstaged: true,
      submodule: false,
      similarity: null,
      unmerged: null,
    },
  ],
  untracked: [],
  ignored: [],
  conflicted: [],
  stash_count: 0,
  clean: false,
  state: 'clean',
};

function diff(mode: 'worktree' | 'staged' | 'range' = 'worktree'): GitDiffResult {
  return {
    environment_id: 'environment-1',
    repo,
    mode,
    context_lines: 3,
    context_lines_clamped: false,
    files: [
      {
        path: 'src/index.ts',
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
            hunk_id: '0123456789abcdef',
            index: 0,
            header: '@@ -2 +2 @@',
            section_heading: '',
            old_start: 2,
            old_lines: 1,
            new_start: 2,
            new_lines: 1,
            lines: [
              { origin: 'delete', content: 'old', old_lineno: 2, new_lineno: null },
              { origin: 'add', content: 'new', old_lineno: null, new_lineno: 2 },
            ],
          },
        ],
      },
    ],
  };
}

let container: HTMLDivElement;
let root: Root;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(label: string): HTMLButtonElement {
  const result = [...document.querySelectorAll('button')].find(
    (candidate) => candidate.getAttribute('aria-label') === label || candidate.textContent === label
  );
  if (!result) {
    throw new Error(`Button not found: ${label}`);
  }
  return result;
}

beforeEach(() => {
  mocks.connected = true;
  mocks.store = { codeTabs: [], projects: [], defaultProfileName: 'host' };
  mocks.invoke.mockResolvedValue({ ok: true, mergeCommitSha: 'sync' });
  mocks.rpc.serverCall.mockResolvedValue({});
  mocks.rpc.supportsExperimentalOperation.mockReturnValue(true);
  mocks.git.listRepositories.mockResolvedValue({
    environment_id: 'environment-1',
    path: '.',
    repositories: [
      {
        repo,
        root: '.',
        absolute_root: '/workspace',
        branch: 'main',
        detached: false,
        bare: false,
        git_common_dir: '/workspace/.git',
        is_linked_worktree: false,
        source: null,
      },
    ],
    sources: [],
    unreachable_sources: [],
    max_depth: 4,
    max_depth_clamped: false,
    truncated: false,
  });
  mocks.git.status.mockResolvedValue(status);
  mocks.git.diff.mockImplementation(async (_repo: WorkspaceRepo, options: { mode?: 'worktree' | 'staged' | 'range' }) =>
    diff(options.mode)
  );
  mocks.git.stage.mockResolvedValue({
    environment_id: 'environment-1',
    repo,
    staged_paths: ['src/index.ts'],
    staged_hunks: [],
  });
  mocks.git.unstage.mockResolvedValue({
    environment_id: 'environment-1',
    repo,
    unstaged_paths: ['src/index.ts'],
    unstaged_hunks: [],
  });
  mocks.git.discard.mockReset();
  mocks.git.confirmDiscard.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('GitSurface', () => {
  const executionTarget = {
    workspaceId: 'workspace-1',
    environmentId: 'environment-1',
    environmentGeneration: 3,
  };
  it('discovers the session repository, filters a selected diff, and opens the first changed line', async () => {
    const onOpenFile = vi.fn();
    await act(async () =>
      root.render(
        <GitSurface
          executionTarget={executionTarget}
          sessionId="session-1"
          workspaceRoot="/workspace"
          onOpenFile={onOpenFile}
        />
      )
    );
    await settle();
    await settle();

    expect(mocks.rpc.serverCall).not.toHaveBeenCalledWith('session.ensure', expect.anything());
    expect(vi.mocked(GitClient)).toHaveBeenCalledWith(mocks.rpc, executionTarget);
    expect(container.querySelector('section[aria-label="Source control"]')).not.toBeNull();
    expect(container.querySelector('select[aria-label="Repository"]')?.getAttribute('value')).toBeNull();

    await act(async () => button('src/index.ts').click());
    await settle();
    expect(mocks.git.diff).toHaveBeenLastCalledWith(repo, { mode: 'worktree', paths: ['src/index.ts'] });

    act(() => button('Open src/index.ts').click());
    expect(onOpenFile).toHaveBeenCalledWith('src/index.ts', 2);
  });

  it('stages and unstages the exact file selection through explicit view buttons', async () => {
    await act(async () =>
      root.render(<GitSurface executionTarget={executionTarget} sessionId="session-1" workspaceRoot="/workspace" />)
    );
    await settle();
    await settle();

    await act(async () => button('Stage file').click());
    await settle();
    expect(mocks.git.stage).toHaveBeenCalledWith(repo, {
      paths: ['src/index.ts'],
      contextLines: 3,
      mode: 'worktree',
    });

    await act(async () => button('Staged').click());
    await settle();
    expect(mocks.git.diff).toHaveBeenLastCalledWith(repo, { mode: 'staged' });
    await act(async () => button('Unstage file').click());
    await settle();
    expect(mocks.git.unstage).toHaveBeenCalledWith(repo, { paths: ['src/index.ts'], contextLines: 3 });
  });

  it('requires and redeems the server confirmation before discarding an exact file selection', async () => {
    const confirmation = { operation: 'discard_changes', impact: { dirty_paths: ['src/index.ts'] }, repo };
    mocks.git.discard.mockResolvedValue({ kind: 'confirmation_required', confirmation });
    mocks.git.confirmDiscard.mockResolvedValue({
      kind: 'completed',
      result: { environment_id: 'environment-1', repo, discarded_paths: ['src/index.ts'], discarded_hunks: [] },
    });
    await act(async () =>
      root.render(<GitSurface executionTarget={executionTarget} sessionId="session-1" workspaceRoot="/workspace" />)
    );
    await settle();
    await settle();

    await act(async () => button('Discard file').click());
    await settle();
    expect(mocks.git.confirmDiscard).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('dirty paths: src/index.ts');

    await act(async () => button('Discard changes').click());
    await settle();
    expect(mocks.git.confirmDiscard).toHaveBeenCalledWith(
      repo,
      { paths: ['src/index.ts'], contextLines: 3 },
      confirmation
    );
  });

  it('preserves the selected repository while the RPC connection reconnects', async () => {
    const discovered = await mocks.git.listRepositories();
    mocks.git.listRepositories.mockResolvedValue({
      ...discovered,
      repositories: [
        ...discovered.repositories,
        {
          ...discovered.repositories[0],
          repo: workspaceRepo('apps/api'),
          root: 'apps/api',
          absolute_root: '/workspace/apps/api',
        },
      ],
    });
    await act(async () =>
      root.render(<GitSurface executionTarget={executionTarget} sessionId="session-1" workspaceRoot="/workspace" />)
    );
    await settle();
    await settle();

    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Repository"]')!;
    select.value = 'apps/api';
    await act(async () => select.dispatchEvent(new Event('change', { bubbles: true })));
    await settle();

    mocks.connected = false;
    act(() =>
      root.render(
        <GitSurface active={false} executionTarget={executionTarget} sessionId="session-1" workspaceRoot="/workspace" />
      )
    );
    expect(container.textContent).toContain('The selected repository is preserved');
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Repository"]')?.value).toBe('apps/api');

    mocks.connected = true;
    act(() =>
      root.render(
        <GitSurface active executionTarget={executionTarget} sessionId="session-1" workspaceRoot="/workspace" />
      )
    );
    await settle();
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Repository"]')?.value).toBe('apps/api');
  });

  it('refreshes repository status and diffs when the persistent Git surface becomes active again', async () => {
    await act(async () =>
      root.render(
        <GitSurface active executionTarget={executionTarget} sessionId="session-1" workspaceRoot="/workspace" />
      )
    );
    await settle();
    await settle();
    const discoveryCalls = mocks.git.listRepositories.mock.calls.length;
    const statusCalls = mocks.git.status.mock.calls.length;
    const diffCalls = mocks.git.diff.mock.calls.length;

    act(() =>
      root.render(
        <GitSurface active={false} executionTarget={executionTarget} sessionId="session-1" workspaceRoot="/workspace" />
      )
    );
    await settle();
    expect(mocks.git.listRepositories.mock.calls.length).toBe(discoveryCalls);
    expect(mocks.git.status.mock.calls.length).toBe(statusCalls);
    expect(mocks.git.diff.mock.calls.length).toBe(diffCalls);

    act(() =>
      root.render(
        <GitSurface active executionTarget={executionTarget} sessionId="session-1" workspaceRoot="/workspace" />
      )
    );
    await settle();
    await settle();

    expect(mocks.git.listRepositories.mock.calls.length).toBeGreaterThan(discoveryCalls);
    expect(mocks.git.status.mock.calls.length).toBeGreaterThan(statusCalls);
    expect(mocks.git.diff.mock.calls.length).toBeGreaterThan(diffCalls);
  });

  it('explains when configured repository sources are outside the session workspace', async () => {
    const discovered = await mocks.git.listRepositories();
    mocks.git.listRepositories.mockResolvedValue({
      ...discovered,
      repositories: [],
      unreachable_sources: [
        { mount_name: 'external', kind: 'local-git', path: '/outside', repo_url: null, reason: 'not_in_workspace' },
      ],
    });
    await act(async () =>
      root.render(<GitSurface executionTarget={executionTarget} sessionId="session-1" workspaceRoot="/workspace" />)
    );
    await settle();

    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Configured Git sources were not materialized in this environment'
    );
  });

  it('reviews all tracked session changes and confirms before applying them to a local folder', async () => {
    mocks.store = {
      defaultProfileName: 'docker',
      codeTabs: [{ id: 'tab-1', projectId: 'project-1', profileName: 'docker' }],
      projects: [
        {
          id: 'project-1',
          sources: [{ id: 'source-1', kind: 'local', mountName: 'work', workspaceDir: '/home/user/work' }],
        },
      ],
    };
    await act(async () =>
      root.render(
        <GitSurface
          executionTarget={executionTarget}
          tabId="tab-1"
          sessionId="session-1"
          workspaceRoot="/workspace/work"
        />
      )
    );
    await settle();
    await settle();

    await act(async () => button('Session changes').click());
    await settle();
    expect(mocks.git.diff).toHaveBeenLastCalledWith(repo, {
      mode: 'range',
      fromRev: 'refs/tags/omni/seed',
    });
    expect(container.textContent).toContain('Session changes');

    act(() => button('Apply to local folder').click());
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('/home/user/work');

    await act(async () => button('Apply changes').click());
    await settle();
    expect(mocks.invoke).toHaveBeenCalledWith('project:apply-code-tab-source-changes', 'tab-1', 'source-1');
    expect(container.textContent).toContain('Applied sandbox changes to /home/user/work.');
  });
});

describe('sourceForRepository', () => {
  const sources: ProjectSource[] = [
    { id: 'launcher', kind: 'local', mountName: 'launcher', workspaceDir: '/home/user/launcher' },
    { id: 'agents', kind: 'git-remote', mountName: 'omniagents', repoUrl: 'https://example.com/agents.git' },
  ];

  const repository = (repoPath: string, absoluteRoot: string): GitRepository => ({
    repo: workspaceRepo(repoPath),
    root: repoPath,
    absolute_root: absoluteRoot,
    branch: 'main',
    detached: false,
    bare: false,
    git_common_dir: `${absoluteRoot}/.git`,
    is_linked_worktree: false,
    source: null,
  });

  it('matches repositories to container mount roots instead of tickets', () => {
    expect(sourceForRepository(sources, repository('launcher', '/workspace/launcher'))?.id).toBe('launcher');
    expect(sourceForRepository(sources, repository('omniagents', '/workspace/omniagents'))?.id).toBe('agents');
  });

  it('uses the only project source for a workspace-root repository', () => {
    expect(sourceForRepository([sources[0]!], repository('.', '/workspace/launcher'))?.id).toBe('launcher');
  });
});
