import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type GitDiffResult, type GitStatusResult, workspaceRepo } from '@/renderer/omniagents-ui/rpc/git';

import { GitStatusDiffView } from './GitStatusDiffView';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const repo = workspaceRepo('apps/web');
const status: GitStatusResult = {
  environment_id: 'environment-1',
  repo,
  head: { detached: false, unborn: false, branch: 'main', oid: 'abc' },
  upstream: { name: 'origin/main', ahead: 2, behind: 1 },
  entries: [
    {
      path: 'src/app.ts',
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
  untracked: ['README.md'],
  ignored: [],
  conflicted: [],
  stash_count: 0,
  clean: false,
  state: 'clean',
};
const diff: GitDiffResult = {
  environment_id: 'environment-1',
  repo,
  mode: 'worktree',
  context_lines: 3,
  context_lines_clamped: false,
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
          hunk_id: '0123456789abcdef',
          index: 0,
          header: '@@ -1 +1 @@',
          section_heading: 'render',
          old_start: 1,
          old_lines: 1,
          new_start: 1,
          new_lines: 1,
          lines: [
            { origin: 'delete', content: 'old value', old_lineno: 1, new_lineno: null },
            { origin: 'add', content: 'new value', old_lineno: null, new_lineno: 1 },
          ],
        },
      ],
    },
  ],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('GitStatusDiffView', () => {
  it('renders a semantic status summary, changed files, and structural diff lines', () => {
    act(() => root.render(<GitStatusDiffView status={status} diff={diff} />));

    expect(container.querySelector('[role="region"][aria-label="Source control changes"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Changed files"]')?.textContent).toContain('src/app.ts');
    expect(container.querySelector('[aria-label="Changed files"]')?.textContent).toContain('README.md');
    expect(container.textContent).toContain('main · 2 changed files · 2 ahead, 1 behind');
    expect(container.querySelector('[data-origin="delete"]')?.textContent).toContain('-old value');
    expect(container.querySelector('[data-origin="add"]')?.textContent).toContain('+new value');
  });

  it('emits hunk selections with the content-addressed id, mode, and context', () => {
    const onStage = vi.fn();
    const onDiscard = vi.fn();
    act(() => root.render(<GitStatusDiffView status={status} diff={diff} onStage={onStage} onDiscard={onDiscard} />));

    const buttons = [...container.querySelectorAll('button')];
    act(() => buttons.find((button) => button.textContent === 'Stage hunk')?.click());
    act(() => buttons.find((button) => button.textContent === 'Discard hunk')?.click());

    const ref = { path: 'src/app.ts', hunk_id: '0123456789abcdef' };
    expect(onStage).toHaveBeenCalledWith({ hunks: [ref], contextLines: 3, mode: 'worktree' });
    expect(onDiscard).toHaveBeenCalledWith({ hunks: [ref], contextLines: 3 });
  });

  it('offers unstaging—not discard—for a staged diff', () => {
    const onUnstage = vi.fn();
    act(() =>
      root.render(<GitStatusDiffView status={status} diff={{ ...diff, mode: 'staged' }} onUnstage={onUnstage} />)
    );

    const labels = [...container.querySelectorAll('button')].map((button) => button.textContent);
    expect(labels).toContain('Unstage hunk');
    expect(labels).not.toContain('Discard hunk');
  });

  it('keeps revision range diffs read-only because their hunk ids cannot target a worktree operation', () => {
    const onStage = vi.fn();
    const onUnstage = vi.fn();
    const onDiscard = vi.fn();
    act(() =>
      root.render(
        <GitStatusDiffView
          status={status}
          diff={{ ...diff, mode: 'range' }}
          onStage={onStage}
          onUnstage={onUnstage}
          onDiscard={onDiscard}
        />
      )
    );

    expect(container.textContent).toContain('Revision range diff');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('announces empty and context-clamped states', () => {
    act(() =>
      root.render(
        <GitStatusDiffView
          status={{ ...status, entries: [], untracked: [], clean: true, upstream: null }}
          diff={{ ...diff, files: [], context_lines: 64, context_lines_clamped: true }}
        />
      )
    );

    expect(container.textContent).toContain('Working tree clean');
    expect(container.textContent).toContain('No changes in this view');
    expect(container.querySelector('[role="status"]')?.textContent).toContain('limited to 64 lines');
  });
});
