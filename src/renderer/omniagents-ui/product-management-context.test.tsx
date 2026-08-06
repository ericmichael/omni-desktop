import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RpcMethodMap, RpcNotificationMap } from '@/generated/omniagents-gui-v1/gui-v1';

vi.mock('@/renderer/services/ipc', () => ({
  emitter: { invoke: vi.fn() },
  serverOrigin: () => 'http://launcher.test',
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
