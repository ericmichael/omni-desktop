import { useSelector } from '@xstate/react';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';

import type { RPCClientActor } from '@/shared/machines/rpc-client.machine';

import { RPCClient } from './rpc/client';
import {
  ManagementRepository,
  type ManagementRepositoryStatus,
  type ManagementSnapshot,
} from './rpc/management-repository';
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

export const RPCClientProvider = ({
  children,
  createClient = defaultRPCClientFactory,
}: {
  children: ReactNode;
  createClient?: RPCClientFactory;
}) => {
  const { wsBaseUrl, token } = useUiConfig();

  const client = useMemo(() => createClient(wsBaseUrl, token), [createClient, token, wsBaseUrl]);
  const management = useMemo(() => new ManagementRepository(client), [client]);

  useEffect(() => {
    // Use disconnect() (reversible) instead of dispose() (permanent) because
    // React StrictMode double-invokes effects — the memoized client reference
    // survives the simulated unmount/remount but dispose() permanently kills it.
    return () => client.disconnect();
  }, [client]);

  useEffect(() => {
    management.start();
    return () => management.stop();
  }, [management]);

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
 * Today RPC ownership is inside each OmniAgentsApp/code column. Lifting this
 * provider above code columns (or attaching a synthetic management consumer
 * to the pooled AgentHost) remains required for one product-scoped Settings
 * and onboarding repository.
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
