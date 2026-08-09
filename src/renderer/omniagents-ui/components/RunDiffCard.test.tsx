import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunDiffFile, RunDiffItem } from '@/shared/chat-types';

import { RunDiffCard } from './RunDiffCard';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

const file = (path: string, overrides: Partial<RunDiffFile> = {}): RunDiffFile => ({
  path,
  changeType: 'modified',
  additions: 1,
  deletions: 2,
  opaque: false,
  baselineUnknown: false,
  ...overrides,
});

const item = (overrides: Partial<RunDiffItem> = {}): RunDiffItem => ({
  type: 'run_diff',
  id: 'turn-1',
  diff: '',
  files: [],
  stats: { filesChanged: 0, additions: 0, deletions: 0 },
  truncated: false,
  filesTruncated: false,
  status: 'completed',
  canonical: {
    item_id: 'diff-1',
    thread_id: 'thread-1',
    turn_id: 'turn-1',
    seq: 3,
    kind: 'run_diff',
    status: 'completed',
    revision: 1,
    created_at: 1,
    updated_at: 2,
    content: {},
    source_ref: {},
  },
  ...overrides,
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('RunDiffCard', () => {
  it('states clearly when an authoritative run diff is empty', async () => {
    await act(async () => root.render(<RunDiffCard item={item()} />));
    expect(container.textContent).toContain('0 files');
    expect(container.textContent).toContain('No workspace file changes were captured for this run.');
  });

  it('summarizes without inlining the diff, with per-file counts and capture caveats', async () => {
    await act(async () =>
      root.render(
        <RunDiffCard
          item={item({
            diff: 'diff --git a/src/app.ts b/src/app.ts\n+SECRET_HUNK_CONTENT',
            files: [
              file('src/app.ts', { additions: 3, deletions: 1 }),
              file('assets/logo.bin', { opaque: true, baselineUnknown: true }),
            ],
            stats: { filesChanged: 501, additions: 3, deletions: 1 },
            truncated: true,
            filesTruncated: true,
          })}
        />
      )
    );
    expect(container.textContent).toContain('501 files');
    expect(container.textContent).toContain('+3');
    expect(container.textContent).toContain('−1');
    expect(container.textContent).toContain('src/app.ts');
    expect(container.textContent).toContain('opaque');
    expect(container.textContent).toContain('no baseline');
    expect(container.textContent).toContain('The file list is truncated.');
    expect(container.textContent).toContain('The textual diff is truncated.');
    expect(container.textContent).not.toContain('SECRET_HUNK_CONTENT');
  });

  it('folds files beyond the cap into a remaining count', async () => {
    const files = Array.from({ length: 11 }, (_, index) => file(`src/file-${index}.ts`));
    await act(async () =>
      root.render(<RunDiffCard item={item({ files, stats: { filesChanged: 11, additions: 11, deletions: 22 } })} />)
    );
    expect(container.textContent).toContain('+3 more files');
    expect(container.textContent).not.toContain('src/file-10.ts');
  });

  it('offers a Review action that passes this card’s record', async () => {
    const onReview = vi.fn();
    const target = item({ files: [file('src/app.ts')], stats: { filesChanged: 1, additions: 1, deletions: 2 } });
    await act(async () => root.render(<RunDiffCard item={target} onReview={onReview} />));
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Review');
    expect(button).toBeDefined();
    await act(async () => button!.click());
    expect(onReview).toHaveBeenCalledWith(target);
  });
});
