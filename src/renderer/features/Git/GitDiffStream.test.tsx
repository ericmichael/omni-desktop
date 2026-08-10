import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitDiffFile, GitStatusEntry } from '@/renderer/omniagents-ui/rpc/git';

import { GitDiffStream } from './GitDiffStream';

vi.mock('@/renderer/omniagents-ui/components/ai/code-block', () => ({
  highlightCode: () => null,
  TokenSpan: () => null,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const file: GitDiffFile = {
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
      hunk_id: 'hunk-1',
      index: 0,
      header: '@@ -2 +2 @@',
      section_heading: 'function main()',
      old_start: 2,
      old_lines: 1,
      new_start: 2,
      new_lines: 1,
      lines: [
        { origin: 'delete', content: 'const value = 1;', old_lineno: 2, new_lineno: null },
        { origin: 'add', content: 'const value = 2;', old_lineno: null, new_lineno: 2 },
      ],
    },
  ],
};

const entry: GitStatusEntry = {
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
};

let container: HTMLDivElement;
let root: Root;

function button(label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.getAttribute('aria-label') === label || candidate.textContent === label
  );
  if (!result) {
    throw new Error(`Button not found: ${label}`);
  }
  return result;
}

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

function render(overrides: Partial<Parameters<typeof GitDiffStream>[0]> = {}) {
  const handlers = {
    onSectionOpenChange: vi.fn(),
    onOpenFile: vi.fn(),
    onStage: vi.fn(),
    onUnstage: vi.fn(),
    onDiscard: vi.fn(),
  };
  act(() =>
    root.render(
      <GitDiffStream
        files={[file]}
        entriesByPath={new Map([[entry.path, entry]])}
        conflicted={[]}
        mode="worktree"
        contextLines={3}
        collapsedPaths={new Set()}
        {...handlers}
        {...overrides}
      />
    )
  );
  return handlers;
}

describe('GitDiffStream', () => {
  it('renders human-titled badges, hunk headings, and numbered diff lines', () => {
    render();
    const badge = container.querySelector('[title="Modified"]');
    expect(badge?.textContent).toBe('·M');
    expect(container.textContent).toContain('function main()');
    expect(container.textContent).toContain('const value = 2;');
    expect(container.textContent).not.toContain('@@ -2 +2 @@');
  });

  it('stages, discards, and opens files from the section header actions', () => {
    const handlers = render();
    act(() => button('Stage src/index.ts').click());
    expect(handlers.onStage).toHaveBeenCalledWith({ paths: ['src/index.ts'], contextLines: 3, mode: 'worktree' });

    act(() => button('Discard src/index.ts').click());
    expect(handlers.onDiscard).toHaveBeenCalledWith({ paths: ['src/index.ts'], contextLines: 3 });

    act(() => button('Open src/index.ts').click());
    expect(handlers.onOpenFile).toHaveBeenCalledWith('src/index.ts', 2);
  });

  it('targets single hunks through the hunk header actions', () => {
    const handlers = render();
    act(() => button('Stage hunk').click());
    expect(handlers.onStage).toHaveBeenCalledWith({
      hunks: [{ path: 'src/index.ts', hunk_id: 'hunk-1' }],
      contextLines: 3,
      mode: 'worktree',
    });

    act(() => button('Discard hunk').click());
    expect(handlers.onDiscard).toHaveBeenCalledWith({
      hunks: [{ path: 'src/index.ts', hunk_id: 'hunk-1' }],
      contextLines: 3,
    });
  });

  it('offers unstage in the staged view and no mutations in the session view', () => {
    const staged = render({ mode: 'staged' });
    act(() => button('Unstage src/index.ts').click());
    expect(staged.onUnstage).toHaveBeenCalledWith({ paths: ['src/index.ts'], contextLines: 3 });
    expect(() => button('Stage src/index.ts')).toThrow();

    render({ mode: 'session' });
    expect(() => button('Unstage src/index.ts')).toThrow();
    expect(() => button('Discard src/index.ts')).toThrow();
    expect(container.textContent).toContain('const value = 2;');
  });

  it('renders whole-file-only diffs without hunk actions and explains binary files', () => {
    render({
      files: [
        { ...file, hunk_selectable: false },
        { ...file, path: 'logo.png', binary: true, added_lines: null, deleted_lines: null, hunks: [] },
      ],
      entriesByPath: new Map(),
    });
    expect(() => button('Stage hunk')).toThrow();
    expect(container.textContent).toContain('const value = 2;');
    expect(container.textContent).toContain('whole file only');
    expect(container.textContent).toContain('Binary file — no text hunks.');
  });

  it('shows a per-mode empty state', () => {
    render({ files: [], mode: 'staged' });
    expect(container.textContent).toContain('Nothing staged');
  });
});
