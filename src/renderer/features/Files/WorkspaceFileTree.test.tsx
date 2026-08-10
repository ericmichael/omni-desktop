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
let mutations: {
  writeTextFile: ReturnType<typeof vi.fn>;
  mkdir: ReturnType<typeof vi.fn>;
  rename: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};
let onOpenFile: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  registry = new FakeWatchRegistry();
  list = vi.fn();
  mutations = {
    writeTextFile: vi.fn().mockResolvedValue({}),
    mkdir: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  onOpenFile = vi.fn();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function renderTree(extras: Partial<Parameters<typeof WorkspaceFileTree>[0]> = {}): Promise<void> {
  await act(async () => {
    root.render(
      <WorkspaceFileTree
        executionTarget={{ workspaceId: 'workspace-1', environmentId: 'environment-1', environmentGeneration: 3 }}
        fsClient={{ list, ...mutations } as never}
        onOpenFile={onOpenFile}
        watchRegistry={registry}
        {...extras}
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
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'environment-1', environmentGeneration: 3 }),
      '.',
      false
    );
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
    expect(
      [...container.querySelectorAll('[role="status"]')].some((node) => node.textContent?.includes('Loading source'))
    ).toBe(true);

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
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'environment-1', environmentGeneration: 3 }),
      'source',
      false
    );
    expect(container.textContent).toContain('new.ts');

    const refresh = [...document.querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-label') === 'Refresh'
    )!;
    await act(async () => refresh.click());
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'environment-1', environmentGeneration: 3 }),
      '.',
      false
    );
  });
});

describe('WorkspaceFileTree management', () => {
  function button(label: string): HTMLButtonElement {
    const found = [...document.querySelectorAll('button')].find(
      (candidate) => candidate.getAttribute('aria-label') === label || candidate.textContent?.trim() === label
    );
    if (!found) {
      throw new Error(`Button not found: ${label}`);
    }
    return found;
  }

  function setInput(value: string) {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('creates a file from the header action and opens it', async () => {
    const onFileCreated = vi.fn();
    list.mockResolvedValue(listing('.', []));
    await renderTree({ canManage: true, onFileCreated });
    await act(async () => registry.callbacks.get('.')?.onRescan?.(listing('.', [file('z.txt')]), 'initial'));

    await act(async () => button('New file').click());
    act(() => setInput('todo.md'));
    await act(async () => button('Create file').click());

    expect(mutations.writeTextFile).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'environment-1' }),
      'todo.md',
      '',
      { overwrite: false }
    );
    expect(onFileCreated).toHaveBeenCalledWith('todo.md');
    // The name dialog closed after success.
    expect(document.querySelector('input[aria-label="Name"]')).toBeNull();
  });

  it('deletes a file behind an explicit confirmation via the row menu', async () => {
    const onFileDeleted = vi.fn();
    list.mockResolvedValue(listing('.', []));
    await renderTree({ canManage: true, onFileDeleted });
    await act(async () => registry.callbacks.get('.')?.onRescan?.(listing('.', [file('z.txt')]), 'initial'));

    const trigger = button('Actions for z.txt');
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      trigger.click();
    });
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (candidate) => candidate.textContent === 'Delete'
    );
    if (!item) {
      throw new Error('Delete menu item not found');
    }
    await act(async () => item.click());

    expect(mutations.delete).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('z.txt');
    await act(async () => button('Delete').click());
    expect(mutations.delete).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'environment-1' }),
      'z.txt',
      { recursive: false }
    );
    expect(onFileDeleted).toHaveBeenCalledWith('z.txt', false);
  });

  it('hides management affordances without the capability', async () => {
    await renderTree();
    await act(async () => registry.callbacks.get('.')?.onRescan?.(listing('.', [file('z.txt')]), 'initial'));
    expect([...document.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).not.toContain('New file');
    expect(document.querySelector('[aria-label="Actions for z.txt"]')).toBeNull();
  });
});
