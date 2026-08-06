import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RunDiffItem } from '@/shared/chat-types';

import { RunDiffCard } from './RunDiffCard';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

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
    expect(container.textContent).toContain('0 files changed');
    expect(container.textContent).toContain('No workspace file changes were captured for this run.');
  });

  it('does not imply text hunks exist for opaque, unknown-baseline, truncated files', async () => {
    await act(async () =>
      root.render(
        <RunDiffCard
          item={item({
            files: [
              {
                path: 'assets/logo.bin',
                changeType: 'modified',
                additions: 0,
                deletions: 0,
                opaque: true,
                baselineUnknown: true,
              },
            ],
            stats: { filesChanged: 501, additions: 0, deletions: 0 },
            truncated: true,
            filesTruncated: true,
          })}
        />
      )
    );
    expect(container.textContent).toContain('The textual diff and file list are truncated.');
    expect(container.textContent).toContain('binary or oversized; no text hunks');
    expect(container.textContent).toContain('baseline unavailable');
    expect(container.textContent).toContain('Text diff unavailable');
  });
});
