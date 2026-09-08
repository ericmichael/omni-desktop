import { useSelector } from '@xstate/react';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';

import type { RPCClientActor } from '@/shared/machines/rpc-client.machine';

import { RPCClient } from './rpc/client';
import {
  ManagementRepository,
  type ManagementRepositoryStatus,
  type ManagementSnapshot,
} from './rpc/management-repository';
import { getSessionRegistry } from './session/session-registry';
import { useUiConfig } from './ui-config';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

type RPCClientContextValue = {
  client: RPCClient;
  actor: RPCClientActor;
  management: ManagementRepository;
};

const RPCClientContext = createContext<RPCClientContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export type RPCClientFactory = (url: string, token?: string) => RPCClient;

const defaultRPCClientFactory: RPCClientFactory = (url, token) => new RPCClient(url, token);

type SharedConnection = {
  client: RPCClient;
  management: ManagementRepository;
  owners: number;
  generation: number;
  running: boolean;
};

// Provider wrappers are view boundaries, not connection owners. The endpoint
// AND authentication identity form the pool key; never pool across credentials.
// Keys stay in memory and must not be logged or persisted.
const connectionPools = new WeakMap<RPCClientFactory, Map<string, SharedConnection>>();
function sharedConnection(factory: RPCClientFactory, url: string, token?: string) {
  let pool = connectionPools.get(factory);
  if (!pool) {
    pool = new Map();
    connectionPools.set(factory, pool);
  }
  const key = JSON.stringify([url, token ?? null]);
  let entry = pool.get(key);
  if (!entry) {
    const client = factory(url, token);
    entry = { client, management: new ManagementRepository(client), owners: 0, generation: 0, running: false };
    pool.set(key, entry);
  }
  const connection = entry;
  return {
    client: connection.client,
    management: connection.management,
    retain() {
      connection.owners++;
      connection.generation++;
      const releaseSessions = getSessionRegistry(connection.client).retain();
      if (!connection.running) {
        connection.running = true;
        connection.management.start();
      }
      return () => {
        releaseSessions();
        connection.owners--;
        const generation = ++connection.generation;
        queueMicrotask(() => {
          if (connection.owners || generation !== connection.generation) {
            return;
          }
          connection.management.stop();
          // This pool entry is permanently retired. Merely disconnecting
          // lets a late async consumer reconnect an ownerless client.
          connection.client.dispose();
          connection.running = false;
          if (pool.get(key) === connection) {
            pool.delete(key);
          }
        });
      };
    },
  };
}

export const RPCClientProvider = ({
  children,
  createClient = defaultRPCClientFactory,
}: {
  children: ReactNode;
  createClient?: RPCClientFactory;
}) => {
  const { wsBaseUrl, token } = useUiConfig();

  const connection = useMemo(() => sharedConnection(createClient, wsBaseUrl, token), [createClient, token, wsBaseUrl]);
  const { client, management } = connection;
  useEffect(() => connection.retain(), [connection]);

  const value = useMemo<RPCClientContextValue>(
    () => ({ client, actor: client.actor, management }),
    [client, management]
  );

  return <RPCClientContext.Provider value={value}>{children}</RPCClientContext.Provider>;
};

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Access the RPCClient instance for sending RPC calls. */
export const useRPCClient = (): RPCClient => {
  const ctx = useContext(RPCClientContext);
  if (!ctx) {
    throw new Error('RPCClientProvider is missing');
  }
  return ctx.client;
};

/**
 * Connection-scoped runtime management cache and typed RPC boundaries.
 *
 * Providers for the same endpoint and authentication identity share this
 * cache and the session registry. Product Settings still uses its dedicated
 * management connection, independent of whether any chat is open.
 */
export const useManagementRepository = (): ManagementRepository => {
  const ctx = useContext(RPCClientContext);
  if (!ctx) {
    throw new Error('RPCClientProvider is missing');
  }
  return ctx.management;
};

/** Subscribe to immutable management snapshots with React tear protection. */
export const useManagementSnapshot = (): ManagementSnapshot => {
  const repository = useManagementRepository();
  return useSyncExternalStore(repository.subscribe, repository.getSnapshot, repository.getSnapshot);
};

export const useManagementStatus = (): ManagementRepositoryStatus => useManagementSnapshot().status;

/** Reactive boolean — true only when the WebSocket is in the `connected` state. */
export const useRPCConnected = (): boolean => {
  const ctx = useContext(RPCClientContext);
  if (!ctx) {
    throw new Error('RPCClientProvider is missing');
  }
  return useSelector(ctx.actor, (snap) => snap.value === 'connected');
};

/** Reactive connection state string from the machine. */
export const useRPCConnectionState = (): 'disconnected' | 'connecting' | 'connected' | 'reconnecting' => {
  const ctx = useContext(RPCClientContext);
  if (!ctx) {
    throw new Error('RPCClientProvider is missing');
  }
  return useSelector(ctx.actor, (snap) => snap.value as 'disconnected' | 'connecting' | 'connected' | 'reconnecting');
};
