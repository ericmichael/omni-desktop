import { act, StrictMode, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FilesSurface } from './FilesSurface';

const mocks = vi.hoisted(() => {
  const serverCall = vi.fn().mockResolvedValue({});
  return {
    serverCall,
    rpc: {
      serverCall,
      supportsExperimentalOperation: () => true,
    },
    registries: [] as Array<{ disposed: boolean }>,
    clients: [] as Array<{ disposed: boolean }>,
    editors: [] as Array<{ disposed: boolean }>,
    leases: [] as Array<{ release: ReturnType<typeof vi.fn> }>,
    dirty: false,
  };
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

vi.mock('@/renderer/omniagents-ui/rpc-context', () => ({
  useRPCClient: () => mocks.rpc,
  useRPCConnected: () => true,
}));

vi.mock('@nanostores/react', () => ({ useStore: () => ({}) }));

vi.mock('@/renderer/services/store', () => ({ persistedStoreApi: { $atom: {} } }));

vi.mock('@/renderer/omniagents-ui/rpc/fs', () => {
  class FsClient {
    disposed = false;

    constructor() {
      mocks.clients.push(this);
    }

    async stat() {
      return { type: 'file', writable: true };
    }

    dispose() {
      this.disposed = true;
    }
  }

  class WatchRegistry {
    disposed = false;

    constructor() {
      mocks.registries.push(this);
    }

    async subscribe() {
      if (this.disposed) {
        throw new Error('WatchRegistry is disposed');
      }
      return async () => {};
    }

    touch() {}

    async dispose() {
      this.disposed = true;
    }
  }

  return { FsClient, WatchRegistry };
});

vi.mock('@/shared/machines/file-editor-registry', () => ({
  FileEditorRegistry: class {
    disposed = false;

    constructor() {
      mocks.editors.push(this);
    }

    acquire() {
      const snapshot = () => ({
        value: mocks.dirty ? 'dirty' : 'clean',
        context: { content: '' },
        matches: (state: string) => state === (mocks.dirty ? 'dirty' : 'clean'),
      });
      const lease = {
        actor: { getSnapshot: snapshot, send: () => {}, subscribe: () => ({ unsubscribe: () => {} }) },
        release: vi.fn(),
      };
      mocks.leases.push(lease);
      return lease;
    }

    dispose() {
      this.disposed = true;
    }
  },
}));

vi.mock('./fs-file-editor-io', () => ({ FsFileEditorIO: class {} }));
vi.mock('./CodeMirrorEditor', () => ({ CodeMirrorEditor: () => null }));
vi.mock('./open-file-intent', () => ({ registerOpenFileTarget: () => () => {} }));
vi.mock('@xstate/react', () => ({
  useSelector: (actor: { getSnapshot: () => unknown }, selector: (snapshot: unknown) => unknown) =>
    selector(actor.getSnapshot()),
}));

vi.mock('./WorkspaceFileTree', () => ({
  WorkspaceFileTree: ({
    watchRegistry,
    onOpenFile,
    rootPath,
  }: {
    watchRegistry: { subscribe: () => Promise<unknown> };
    onOpenFile: (path: string) => void;
    rootPath?: string;
  }) => {
    const [state, setState] = useState('subscribing');
    useEffect(() => {
      let active = true;
      void watchRegistry.subscribe().then(
        () => active && setState('ready'),
        (error: Error) => active && setState(error.message)
      );
      return () => {
        active = false;
      };
    }, [watchRegistry]);
    return (
      <div data-testid="workspace-tree" data-root={rootPath}>
        {state}
        <button onClick={() => onOpenFile(rootPath === '.' ? 'src/app.ts' : `${rootPath}/app.ts`)}>open-app</button>
      </div>
    );
  },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(label: string): HTMLButtonElement {
  // Search the document: confirmation dialogs portal to document.body.
  const result = [...document.querySelectorAll('button')].find(
    (candidate) => candidate.getAttribute('aria-label') === label || candidate.textContent === label
  );
  if (!result) {
    throw new Error(`Button not found: ${label}`);
  }
  return result;
}

const surfaceProps = {
  executionTarget: { workspaceId: 'workspace-1', environmentId: 'environment-1', environmentGeneration: 3 },
  sessionId: 'session-1',
  workspaceRoot: '/workspace',
};

beforeEach(() => {
  mocks.serverCall.mockResolvedValue({});
  mocks.registries.length = 0;
  mocks.clients.length = 0;
  mocks.editors.length = 0;
  mocks.leases.length = 0;
  mocks.dirty = false;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('FilesSurface', () => {
  it('recreates terminal resources during the StrictMode effect replay', async () => {
    await act(async () => {
      root.render(
        <StrictMode>
          <FilesSurface {...surfaceProps} />
        </StrictMode>
      );
    });
    await settle();
    await settle();

    expect(container.querySelector('[data-testid="workspace-tree"]')?.textContent).toContain('ready');
    expect(container.textContent).not.toContain('WatchRegistry is disposed');
    expect(mocks.registries.length).toBeGreaterThanOrEqual(2);
    expect(mocks.registries.at(0)?.disposed).toBe(true);
    expect(mocks.registries.at(-1)?.disposed).toBe(false);
    expect(mocks.clients.at(0)?.disposed).toBe(true);
    expect(mocks.editors.at(0)?.disposed).toBe(true);
  });

  it('opens files into tabs and releases the editor lease on close', async () => {
    await act(async () => root.render(<FilesSurface {...surfaceProps} />));
    await settle();

    await act(async () => button('open-app').click());
    await settle();

    const tab = container.querySelector('[role="tab"]');
    expect(tab?.textContent).toContain('app.ts');
    expect(tab?.getAttribute('aria-selected')).toBe('true');
    expect(mocks.leases.length).toBe(1);

    await act(async () => button('Close src/app.ts').click());
    await settle();

    expect(mocks.leases[0]!.release).toHaveBeenCalled();
    expect(container.querySelector('[role="tab"]')).toBeNull();
    expect(container.textContent).toContain('No file open');
  });

  it('scopes the tree to the root prefix and strips it from the editor path', async () => {
    await act(async () => root.render(<FilesSurface {...surfaceProps} rootPrefix="f74a9eba" />));
    await settle();

    expect(container.querySelector('[data-testid="workspace-tree"]')?.getAttribute('data-root')).toBe('f74a9eba');

    await act(async () => button('open-app').click());
    await settle();

    // The RPC path keeps the prefix; the user-facing path drops it.
    expect(container.querySelector('[role="tab"]')?.getAttribute('title')).toBe('f74a9eba/app.ts');
    const pathLabel = [...container.querySelectorAll('span')].find(
      (span) => span.getAttribute('title') === 'f74a9eba/app.ts' && span.textContent === 'app.ts'
    );
    expect(pathLabel).not.toBeUndefined();
  });

  it('asks before closing a tab with unsaved changes', async () => {
    mocks.dirty = true;
    await act(async () => root.render(<FilesSurface {...surfaceProps} />));
    await settle();

    await act(async () => button('open-app').click());
    await settle();

    await act(async () => button('Close src/app.ts').click());
    await settle();
    expect(mocks.leases[0]!.release).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('Discard unsaved changes?');

    await act(async () => button('Discard and close').click());
    await settle();
    expect(mocks.leases[0]!.release).toHaveBeenCalled();
    expect(container.querySelector('[role="tab"]')).toBeNull();
  });
});
