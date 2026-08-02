import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FsEntry, FsListResult, WatchCallbacks } from '@/renderer/omniagents-ui/rpc/fs';

import { WorkspaceFileTree, type WorkspaceTreeWatchRegistry } from './WorkspaceFileTree';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const directory = (path: string): FsEntry => ({ path, type: 'directory', size: null, mtime: null, writable: true });
const file = (path: string): FsEntry => ({ path, type: 'file', size: 1, mtime: 1, writable: true });
const listing = (path: string, entries: FsEntry[]): FsListResult => ({
  path,
  entries,
  truncated: false,
  writable: true,
});

class FakeWatchRegistry implements WorkspaceTreeWatchRegistry {
  readonly callbacks = new Map<string, WatchCallbacks>();
  readonly subscribed: string[] = [];
  readonly unsubscribed: string[] = [];
  readonly touched: string[] = [];

  async subscribe(path: string, callbacks: WatchCallbacks): Promise<() => Promise<void>> {
    this.subscribed.push(path);
    this.callbacks.set(path, callbacks);
    return async () => {
      this.unsubscribed.push(path);
      this.callbacks.delete(path);
    };
  }

  touch(path: string): void {
    this.touched.push(path);
  }
}

let container: HTMLDivElement;
let root: Root;
let registry: FakeWatchRegistry;
let list: ReturnType<typeof vi.fn>;
let onOpenFile: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  registry = new FakeWatchRegistry();
  list = vi.fn();
  onOpenFile = vi.fn();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function renderTree(): Promise<void> {
  await act(async () => {
    root.render(
      <WorkspaceFileTree
        environmentId="environment-1"
        fsClient={{ list } as never}
        onOpenFile={onOpenFile}
        watchRegistry={registry}
      />
    );
  });
}

function treeItem(label: string): HTMLElement {
  const item = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((candidate) =>
    candidate.textContent?.includes(label)
  );
  if (!item) {
    throw new Error(`No tree item contains ${label}`);
  }
  return item;
}

describe('WorkspaceFileTree', () => {
  it('roots at dot and announces loading, empty, and error/retry states', async () => {
    list.mockResolvedValue(listing('.', []));
    await renderTree();

    expect(registry.subscribed).toEqual(['.']);
    expect(container.querySelector('[data-workspace-root="."]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Loading workspace files');

    await act(async () => registry.callbacks.get('.')?.onRescan?.(listing('.', []), 'initial'));
    expect(container.querySelector('[role="status"]')?.textContent).toContain('This workspace is empty');

    await act(async () => registry.callbacks.get('.')?.onError?.(new Error('Workspace unavailable')));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Workspace unavailable');

    const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!;
    await act(async () => retry.click());
    expect(list).toHaveBeenCalledWith('environment-1', '.', false);
    expect(container.querySelector('[role="status"]')?.textContent).toContain('This workspace is empty');
  });

  it('shows mount names, lazily watches expanded directories, and selects files', async () => {
    await renderTree();
    await act(async () =>
      registry.callbacks.get('.')?.onRescan?.(listing('.', [file('z.txt'), directory('source')]), 'initial')
    );

    expect(container.querySelector('[role="tree"]')?.getAttribute('aria-label')).toBe('Workspace files');
    expect(container.textContent).toContain('source');
    expect(container.textContent).toContain('z.txt');
    expect(container.textContent!.indexOf('source')).toBeLessThan(container.textContent!.indexOf('z.txt'));

    const source = treeItem('source');
    await act(async () => source.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(registry.subscribed).toEqual(['.', 'source']);
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Loading source');

    await act(async () =>
      registry.callbacks.get('source')?.onRescan?.(listing('source', [file('source/index.ts')]), 'initial')
    );
    await act(async () => container.querySelector<HTMLElement>('[role="treeitem"][title="source/index.ts"]')!.click());
    expect(onOpenFile).toHaveBeenCalledWith('source/index.ts');

    await act(async () => source.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
    expect(registry.unsubscribed).toContain('source');
  });

  it('refreshes an expanded directory after watched events and exposes manual refresh', async () => {
    vi.useFakeTimers();
    list.mockImplementation(async (_environmentId: string, path: string) =>
      path === '.' ? listing('.', [directory('source')]) : listing('source', [file('source/new.ts')])
    );
    await renderTree();
    await act(async () => registry.callbacks.get('.')?.onRescan?.(listing('.', [directory('source')]), 'initial'));
    const source = treeItem('source');
    await act(async () => source.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    await act(async () => registry.callbacks.get('source')?.onRescan?.(listing('source', []), 'initial'));

    await act(async () => {
      registry.callbacks.get('source')?.onEvents?.([{ type: 'created', path: 'source/new.ts', entryType: 'file' }]);
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(list).toHaveBeenCalledWith('environment-1', 'source', false);
    expect(container.textContent).toContain('new.ts');

    const refresh = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Refresh')!;
    await act(async () => refresh.click());
    expect(list).toHaveBeenCalledWith('environment-1', '.', false);
  });
});
