import { useSelector } from '@xstate/react';
import { createContext, type ReactNode,useContext, useEffect, useMemo } from 'react';

import type { RPCClientActor } from '@/shared/machines/rpc-client.machine';

import { RPCClient } from './rpc/client';
import { useUiConfig } from './ui-config';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

type RPCClientContextValue = {
  client: RPCClient;
  actor: RPCClientActor;
};

const RPCClientContext = createContext<RPCClientContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const RPCClientProvider = ({ children }: { children: ReactNode }) => {
  const { wsBaseUrl, token } = useUiConfig();

  const client = useMemo(() => new RPCClient(wsBaseUrl, token), [wsBaseUrl, token]);

  useEffect(() => {
    // Use disconnect() (reversible) instead of dispose() (permanent) because
    // React StrictMode double-invokes effects — the memoized client reference
    // survives the simulated unmount/remount but dispose() permanently kills it.
    return () => client.disconnect();
  }, [client]);

  const value = useMemo<RPCClientContextValue>(
    () => ({ client, actor: client.actor }),
    [client],
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
