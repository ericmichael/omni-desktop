import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RpcMethodMap, RpcNotificationMap } from '@/generated/omniagents-gui-v2/gui-v2';

const launcherConnect = vi.hoisted(() => ({ callback: null as (() => void) | null }));
vi.mock('@/renderer/services/ipc', () => ({
  emitter: { invoke: vi.fn() },
  serverOrigin: () => 'http://launcher.test',
  wsEmitter: {
    onConnect: (callback: () => void) => {
      launcherConnect.callback = callback;
      callback();
      return () => {
        launcherConnect.callback = null;
      };
    },
  },
}));

import {
  type ProductManagementClient,
  ProductManagementProvider,
  runtimeModelListFromManagement,
  useProductManagement,
  useProductManagementSnapshot,
} from './product-management-context';
import type { RPCConnectionState } from './rpc/client';
import type { ManagementSnapshot } from './rpc/management-repository';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeClient implements ProductManagementClient {
  connectionState: RPCConnectionState = 'disconnected';
  readonly connect = vi.fn(async () => {
    this.connectionState = 'connected';
    for (const handler of this.connectionHandlers) {
      handler('connected');
    }
  });
  readonly disconnect = vi.fn();
  readonly dispose = vi.fn(() => this.disconnect());
  private readonly connectionHandlers = new Set<(state: RPCConnectionState) => void>();

  async request<Method extends keyof RpcMethodMap>(
    method: Method,
    _params: RpcMethodMap[Method]['params']
  ): Promise<RpcMethodMap[Method]['result']> {
    const results: Partial<Record<keyof RpcMethodMap, unknown>> = {
      list_models: { models: [], default_model: null, voice_default_model: null, errors: [], reasons: [] },
      list_providers: { providers: [], errors: [], reasons: [] },
      account_status: { providers: [], selected_provider: null },
      mcp_list_servers: { servers: [], user_mcp_allowed: true, write_target: '/tmp/mcp.json' },
    };
    return results[method] as RpcMethodMap[Method]['result'];
  }

  on<Event extends keyof RpcNotificationMap>(
    _event: Event,
    _handler: (payload: RpcNotificationMap[Event]) => void
  ): () => void {
    return () => {};
  }

  onConnectionState(handler: (state: RPCConnectionState) => void): () => void {
    this.connectionHandlers.add(handler);
    handler(this.connectionState);
    return () => this.connectionHandlers.delete(handler);
  }

  supportsExperimentalOperation(): boolean {
    return false;
  }
}

describe('ProductManagementProvider', () => {
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
  });

  it('boots an ordinary product connection and exposes its repository without a code column', async () => {
    const client = new FakeClient();
    const ensureConnection = vi.fn(async () => ({
      baseUrl: 'http://runtime.test',
      authToken: 'ordinary-token',
      mutationCapabilities: { validateConfig: true, writeConfig: true },
    }));
    const createClient = vi.fn(() => client);

    const Harness = () => {
      const management = useProductManagement();
      const snapshot = useProductManagementSnapshot();
      return (
        <span>{`${management.status}:${snapshot.status}:${management.mutationCapabilities.validateConfig}:${management.mutationCapabilities.writeConfig}`}</span>
      );
    };

    act(() => {
      root.render(
        <ProductManagementProvider ensureConnection={ensureConnection} createClient={createClient}>
          <Harness />
        </ProductManagementProvider>
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(client.connect).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(container.textContent).toBe('ready:ready:true:true'));
    expect(ensureConnection).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledWith('ws://runtime.test/ws', 'ordinary-token');
  });

  it('keeps an unchanged runtime on reconnect but replaces a lost backend lease', async () => {
    const oldClient = new FakeClient();
    const newClient = new FakeClient();
    const connection = {
      baseUrl: 'http://old.test',
      authToken: 'ordinary-token',
      mutationCapabilities: { validateConfig: true, writeConfig: true },
    };
    const ensureConnection = vi.fn(async () => connection);
    const createClient = vi.fn().mockReturnValueOnce(oldClient).mockReturnValueOnce(newClient);
    await act(async () => {
      root.render(
        <ProductManagementProvider ensureConnection={ensureConnection} createClient={createClient}>
          ready
        </ProductManagementProvider>
      );
    });
    await act(async () => {
      launcherConnect.callback!();
    });
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(oldClient.disconnect).not.toHaveBeenCalled();
    ensureConnection.mockResolvedValue({ ...connection, baseUrl: 'http://new.test' });
    await act(async () => {
      launcherConnect.callback!();
    });
    expect(oldClient.disconnect).toHaveBeenCalledOnce();
    expect(oldClient.dispose).toHaveBeenCalledOnce();
    expect(newClient.connect).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenLastCalledWith('ws://new.test/ws', 'ordinary-token');
  });

  it('ignores an old bootstrap reply after a newer launcher connection has won', async () => {
    const connection = {
      baseUrl: 'http://new.test',
      authToken: 'ordinary-token',
      mutationCapabilities: { validateConfig: true, writeConfig: true },
    };
    let resolveOld!: (value: typeof connection) => void;
    const ensureConnection = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          })
      )
      .mockResolvedValue(connection);
    const client = new FakeClient();
    const createClient = vi.fn(() => client);
    await act(async () => {
      root.render(
        <ProductManagementProvider ensureConnection={ensureConnection} createClient={createClient}>
          ready
        </ProductManagementProvider>
      );
    });
    await act(async () => {
      launcherConnect.callback!();
    });
    await act(async () => {
      resolveOld({ ...connection, baseUrl: 'http://old.test' });
    });
    expect(createClient).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledWith('ws://new.test/ws', 'ordinary-token');
    expect(client.disconnect).not.toHaveBeenCalled();
    act(() => root.render(null));
    expect(launcherConnect.callback).toBeNull();
    expect(client.disconnect).toHaveBeenCalledOnce();
  });
});

describe('runtimeModelListFromManagement', () => {
  it('adapts the canonical model catalog to legacy picker input without secrets', () => {
    const snapshot = {
      models: {
        status: 'ready',
        data: {
          models: [
            {
              id: 'codex/gpt-5.5',
              label: 'GPT-5.5',
              provider: { name: 'codex', type: 'openai-oauth' },
              realtime: false,
              reasoning: { default: 'high' },
            },
          ],
          default_model: 'codex/gpt-5.5',
          voice_default_model: null,
        },
      },
    } as unknown as ManagementSnapshot;

    expect(runtimeModelListFromManagement(snapshot)).toEqual({
      models: [
        {
          name: 'codex/gpt-5.5',
          label: 'GPT-5.5',
          provider: 'openai-oauth',
          realtime: false,
          reasoning: 'high',
        },
      ],
      default: 'codex/gpt-5.5',
      voice_default: null,
    });
  });
});
