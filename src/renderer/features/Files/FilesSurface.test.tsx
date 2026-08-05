import type { ReactNode } from 'react';
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
  };
});

vi.mock('@/renderer/omniagents-ui/rpc-context', () => ({
  useRPCClient: () => mocks.rpc,
  useRPCConnected: () => true,
}));

vi.mock('@/renderer/omniagents-ui/rpc/fs', () => {
  class FsClient {
    disposed = false;

    constructor() {
      mocks.clients.push(this);
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
      throw new Error('not used');
    }

    dispose() {
      this.disposed = true;
    }
  },
}));

vi.mock('./fs-file-editor-io', () => ({ FsFileEditorIO: class {} }));
vi.mock('./CodeMirrorEditor', () => ({ CodeMirrorEditor: () => null }));
vi.mock('./open-file-intent', () => ({ registerOpenFileTarget: () => () => {} }));
vi.mock('@xstate/react', () => ({ useSelector: () => ({ context: {} }) }));

vi.mock('./WorkspaceFileTree', () => ({
  WorkspaceFileTree: ({ watchRegistry }: { watchRegistry: { subscribe: () => Promise<unknown> } }) => {
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
    return <div data-testid="workspace-tree">{state}</div>;
  },
}));

vi.mock('@/renderer/ds', () => ({
  Button: ({ children }: { children?: ReactNode }) => <button>{children}</button>,
  Spinner: () => <span>loading</span>,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  mocks.serverCall.mockResolvedValue({});
  mocks.registries.length = 0;
  mocks.clients.length = 0;
  mocks.editors.length = 0;
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
          <FilesSurface environmentId="environment-1" sessionId="session-1" workspaceRoot="/workspace" />
        </StrictMode>
      );
    });
    await settle();
    await settle();

    expect(container.querySelector('[data-testid="workspace-tree"]')?.textContent).toBe('ready');
    expect(container.textContent).not.toContain('WatchRegistry is disposed');
    expect(mocks.registries.length).toBeGreaterThanOrEqual(2);
    expect(mocks.registries.at(0)?.disposed).toBe(true);
    expect(mocks.registries.at(-1)?.disposed).toBe(false);
    expect(mocks.clients.at(0)?.disposed).toBe(true);
    expect(mocks.editors.at(0)?.disposed).toBe(true);
  });
});
