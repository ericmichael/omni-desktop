import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RpcMethodMap, RpcNotificationMap } from '@/generated/omniagents-gui-v2/gui-v2';

import type { RPCClient, RPCConnectionState } from './rpc/client';
import type { ManagementRepository } from './rpc/management-repository';
import { RPCClientProvider, useManagementRepository, useManagementSnapshot, useRPCClient } from './rpc-context';
import { getSessionRegistry } from './session/session-registry';

const config = vi.hoisted(() => ({ wsBaseUrl: 'ws://runtime.test/gui', token: 'ticket-secret' }));

vi.mock('./ui-config', () => ({
  useUiConfig: () => config,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class ContextClient {
  readonly actor = { subscribe: () => ({ unsubscribe: () => {} }) };
  readonly onResyncRequired = () => () => {};
  connectionState: RPCConnectionState = 'disconnected';
  readonly disconnect = vi.fn();
  readonly dispose = vi.fn(() => this.disconnect());
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
    config.token = 'ticket-secret';
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

  it('shares the socket and session owner across separate providers and survives one view closing', async () => {
    const fake = new ContextClient();
    const factory = vi.fn(() => fake as unknown as RPCClient);
    const observed: RPCClient[] = [];
    function View() {
      const client = useRPCClient();
      observed.push(client);
      return null;
    }
    await act(async () =>
      root.render(
        <>
          <RPCClientProvider key="A" createClient={factory}>
            <View />
          </RPCClientProvider>
          <RPCClientProvider key="B" createClient={factory}>
            <View />
          </RPCClientProvider>
        </>
      )
    );
    expect(factory).toHaveBeenCalledTimes(1);
    expect(observed[0]).toBe(observed[1]);
    const session = getSessionRegistry(observed[0]!).get('shared');
    expect(getSessionRegistry(observed[1]!).get('shared')).toBe(session);
    await act(async () =>
      root.render(
        <RPCClientProvider key="B" createClient={factory}>
          <View />
        </RPCClientProvider>
      )
    );
    expect(fake.disconnect).not.toHaveBeenCalled();
    expect(session.disposed).toBe(false);
    await act(async () => root.render(null));
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
    expect(fake.dispose).toHaveBeenCalledTimes(1);
    expect(session.disposed).toBe(true);
  });

  it('does not disconnect or duplicate the shared transport during StrictMode effect replay', async () => {
    const fake = new ContextClient();
    const factory = vi.fn(() => fake as unknown as RPCClient);
    await act(async () =>
      root.render(
        <StrictMode>
          <RPCClientProvider createClient={factory}>
            <span>view</span>
          </RPCClientProvider>
        </StrictMode>
      )
    );
    expect(factory).toHaveBeenCalledTimes(1);
    expect(fake.disconnect).not.toHaveBeenCalled();
    expect(fake.connectionHandlers.size).toBe(1);
    await act(async () => root.render(null));
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
    expect(fake.connectionHandlers.size).toBe(0);
  });

  it('never pools connections across authentication identities', async () => {
    const clients: ContextClient[] = [];
    const factory = vi.fn(() => {
      const client = new ContextClient();
      clients.push(client);
      return client as unknown as RPCClient;
    });
    await act(async () =>
      root.render(
        <RPCClientProvider createClient={factory}>
          <span>view</span>
        </RPCClientProvider>
      )
    );
    config.token = 'another-identity';
    await act(async () =>
      root.render(
        <RPCClientProvider createClient={factory}>
          <span>view</span>
        </RPCClientProvider>
      )
    );
    expect(factory).toHaveBeenCalledTimes(2);
    expect(clients[0]!.disconnect).toHaveBeenCalledTimes(1);
    expect(clients[1]!.disconnect).not.toHaveBeenCalled();
  });
});
