import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RpcMethodMap, RpcNotificationMap } from '@/generated/omniagents-gui-v1/gui-v1';

import type { RPCClient, RPCConnectionState } from './rpc/client';
import type { ManagementRepository } from './rpc/management-repository';
import { RPCClientProvider, useManagementRepository, useManagementSnapshot, useRPCClient } from './rpc-context';

vi.mock('./ui-config', () => ({
  useUiConfig: () => ({ wsBaseUrl: 'ws://runtime.test/gui', token: 'ticket-secret' }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class ContextClient {
  readonly actor = {};
  connectionState: RPCConnectionState = 'disconnected';
  readonly disconnect = vi.fn();
  readonly eventHandlers = new Map<keyof RpcNotificationMap, Set<(payload: never) => void>>();
  readonly connectionHandlers = new Set<(state: RPCConnectionState) => void>();

  request<Method extends keyof RpcMethodMap>(
    _method: Method,
    _params: RpcMethodMap[Method]['params']
  ): Promise<RpcMethodMap[Method]['result']> {
    return Promise.reject(new Error('not connected'));
  }

  on<Event extends keyof RpcNotificationMap>(
    event: Event,
    handler: (payload: RpcNotificationMap[Event]) => void
  ): () => void {
    const handlers = this.eventHandlers.get(event) ?? new Set();
    handlers.add(handler as (payload: never) => void);
    this.eventHandlers.set(event, handlers);
    return () => handlers.delete(handler as (payload: never) => void);
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

describe('RPCClientProvider management boundary', () => {
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

  it('exposes one connection-scoped repository and reactive management snapshot', () => {
    const fake = new ContextClient();
    const factory = vi.fn(() => fake as unknown as RPCClient);
    let repository: ManagementRepository | undefined;
    let contextClient: RPCClient | undefined;

    const Harness = () => {
      repository = useManagementRepository();
      contextClient = useRPCClient();
      const snapshot = useManagementSnapshot();
      return <span>{snapshot.status}</span>;
    };

    act(() => {
      root.render(
        <RPCClientProvider createClient={factory}>
          <Harness />
        </RPCClientProvider>
      );
    });

    expect(factory).toHaveBeenCalledWith('ws://runtime.test/gui', 'ticket-secret');
    expect(contextClient).toBe(fake);
    expect(repository).toBeDefined();
    expect(repository?.getSnapshot().connection).toBe('disconnected');
    expect(container.textContent).toBe('disconnected');
    expect(fake.eventHandlers.get('account_changed')?.size).toBe(1);
    expect(fake.eventHandlers.get('mcp_server_status_changed')?.size).toBe(1);
    expect(fake.connectionHandlers.size).toBe(1);
  });
});
