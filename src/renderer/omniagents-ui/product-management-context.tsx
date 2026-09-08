import { createContext, type ReactNode, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { emitter, wsEmitter } from '@/renderer/services/ipc';
import type {
  ManagementMutationCapabilities,
  ManagementRuntimeConnection,
  ReasoningEffort,
  RuntimeModelList,
} from '@/shared/types';

import { RPCClient } from './rpc/client';
import { ManagementRepository, type ManagementSnapshot, type ManagementTransport } from './rpc/management-repository';
import { resolveUiConfig } from './ui-config';

export type ProductManagementBootstrapStatus = 'starting' | 'connecting' | 'ready' | 'error';

export interface ProductManagementClient extends ManagementTransport {
  connect(): Promise<void>;
  disconnect(): void;
  dispose?(): void;
}

export type ProductManagementClientFactory = (url: string, token?: string) => ProductManagementClient;

type ProductManagementContextValue = {
  repository: ManagementRepository | null;
  status: ProductManagementBootstrapStatus;
  error: string | null;
  mutationCapabilities: ManagementMutationCapabilities;
  refresh: () => Promise<ManagementSnapshot>;
};

const NO_MUTATION_CAPABILITIES: ManagementMutationCapabilities = {
  validateConfig: false,
  writeConfig: false,
};

const FALLBACK_CONTEXT: ProductManagementContextValue = {
  repository: null,
  status: 'error',
  error: 'Product management runtime is unavailable',
  mutationCapabilities: NO_MUTATION_CAPABILITIES,
  refresh: async () => EMPTY_SNAPSHOT,
};

const ProductManagementContext = createContext<ProductManagementContextValue>(FALLBACK_CONTEXT);

const EMPTY_SNAPSHOT: ManagementSnapshot = {
  revision: 0,
  connection: 'disconnected',
  status: 'disconnected',
  experimental: {
    mcpReadResource: false,
    mcpCallTool: false,
    mcpGetPrompt: false,
    configRead: false,
    configValidate: false,
    configWrite: false,
  },
  models: { status: 'idle', data: null, error: null, updatedAt: null },
  providers: { status: 'idle', data: null, error: null, updatedAt: null },
  accounts: { status: 'idle', data: null, error: null, updatedAt: null },
  mcp: { status: 'idle', data: null, error: null, updatedAt: null },
  config: { status: 'idle', data: null, error: null, updatedAt: null },
};

const noSubscribe = (): (() => void) => () => {};
const getEmptySnapshot = (): ManagementSnapshot => EMPTY_SNAPSHOT;
const defaultClientFactory: ProductManagementClientFactory = (url, token) => new RPCClient(url, token);
const ensureProductConnection = (): Promise<ManagementRuntimeConnection> => emitter.invoke('management-runtime:ensure');

/**
 * Product-scoped management runtime for surfaces that exist independently of
 * a conversation column. Boot failures never block the product shell: the
 * legacy persistence editors can still configure/install the runtime, and a
 * later provider mount (or app reload) retries the synthetic host lease.
 */
export const ProductManagementProvider = ({
  children,
  ensureConnection = ensureProductConnection,
  createClient = defaultClientFactory,
  retryDelayMs = 5_000,
}: {
  children: ReactNode;
  ensureConnection?: () => Promise<ManagementRuntimeConnection>;
  createClient?: ProductManagementClientFactory;
  retryDelayMs?: number;
}) => {
  const [value, setValue] = useState<ProductManagementContextValue>({
    repository: null,
    status: 'starting',
    error: null,
    mutationCapabilities: NO_MUTATION_CAPABILITIES,
    refresh: async () => EMPTY_SNAPSHOT,
  });

  useEffect(() => {
    let active = true;
    let client: ProductManagementClient | null = null;
    let repository: ManagementRepository | null = null;
    let unsubscribeConnection: (() => void) | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let revision = 0;
    let connectionKey: string | null = null;

    const releaseClient = () => {
      unsubscribeConnection?.();
      repository?.stop();
      if (client?.dispose) {
        client.dispose();
      } else {
        client?.disconnect();
      }
      unsubscribeConnection = null;
      repository = null;
      client = null;
      connectionKey = null;
    };

    const boot = (): void => {
      const attempt = ++revision;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      void ensureConnection()
        .then((connection) => {
          if (!active || attempt !== revision) {
            return;
          }
          const config = resolveUiConfig(connection);
          const key = JSON.stringify([config.wsBaseUrl, config.token, connection.mutationCapabilities]);
          // A transient launcher disconnect need not disturb an unchanged
          // runtime. A new backend, however, returns a new endpoint/lease;
          // reconnecting the old RPC URL forever cannot recover that lease.
          if (key === connectionKey) {
            return;
          }
          releaseClient();
          connectionKey = key;
          client = createClient(config.wsBaseUrl, config.token);
          repository = new ManagementRepository(client);
          repository.start();
          unsubscribeConnection = client.onConnectionState((connectionState) => {
            if (!active) {
              return;
            }
            setValue({
              repository,
              status: connectionState === 'connected' ? 'ready' : 'connecting',
              error: null,
              mutationCapabilities: connection.mutationCapabilities,
              refresh: async () => {
                if (!repository) {
                  return EMPTY_SNAPSHOT;
                }
                await repository.refresh();
                return repository.getSnapshot();
              },
            });
          });
          setValue({
            repository,
            status: 'connecting',
            error: null,
            mutationCapabilities: connection.mutationCapabilities,
            refresh: async () => {
              if (!repository) {
                return EMPTY_SNAPSHOT;
              }
              await repository.refresh();
              return repository.getSnapshot();
            },
          });
          return client.connect();
        })
        .catch((error: unknown) => {
          if (!active || attempt !== revision) {
            return;
          }
          setValue((current) => ({
            repository: current.repository,
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
            mutationCapabilities: current.mutationCapabilities,
            refresh: current.refresh,
          }));
          // A fresh install or onboarding credential write can make the
          // targetless runtime available without remounting the product root.
          // Retry lease acquisition even if a previous client exists: its
          // reconnect loop cannot replace a dead backend's endpoint.
          retryTimer = setTimeout(boot, retryDelayMs);
        });
    };
    boot();
    let initialConnection = true;
    const unsubscribeLauncher = wsEmitter?.onConnect(() => {
      // The initial boot already queues its ensure on the first connection.
      if (initialConnection) {
        initialConnection = false;
        return;
      }
      boot();
    });

    return () => {
      active = false;
      revision++;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      unsubscribeLauncher?.();
      releaseClient();
    };
  }, [createClient, ensureConnection, retryDelayMs]);

  const context = useMemo(() => value, [value]);
  return <ProductManagementContext.Provider value={context}>{children}</ProductManagementContext.Provider>;
};

export const useProductManagement = (): Omit<ProductManagementContextValue, 'repository' | 'refresh'> => {
  const { status, error, mutationCapabilities } = useContext(ProductManagementContext);
  return { status, error, mutationCapabilities };
};

/** Read-only refresh boundary. Product management mutations are intentionally
 * not exposed; process-wide writes belong to main's admin broker. */
export const useProductManagementRefresh = (): (() => Promise<ManagementSnapshot>) =>
  useContext(ProductManagementContext).refresh;

export const useProductManagementSnapshot = (): ManagementSnapshot => {
  const repository = useContext(ProductManagementContext).repository;
  return useSyncExternalStore(
    repository?.subscribe ?? noSubscribe,
    repository?.getSnapshot ?? getEmptySnapshot,
    repository?.getSnapshot ?? getEmptySnapshot
  );
};

const reasoningEfforts = new Set<ReasoningEffort>(['low', 'medium', 'high', 'xhigh']);

/** Compatibility adapter for the few launcher flows that still consume the
 * old `util:list-models` shape. The source is the canonical typed catalog. */
export const runtimeModelListFromManagement = (snapshot: ManagementSnapshot): RuntimeModelList | null => {
  if (snapshot.models.status !== 'ready' || !snapshot.models.data) {
    return null;
  }
  const catalog = snapshot.models.data;
  return {
    models: catalog.models.map((model) => {
      const reasoning = model.reasoning.default;
      return {
        name: model.id,
        label: model.label || undefined,
        provider: model.provider.type ?? model.provider.name ?? undefined,
        realtime: model.realtime,
        ...(reasoning && reasoningEfforts.has(reasoning as ReasoningEffort)
          ? { reasoning: reasoning as ReasoningEffort }
          : {}),
      };
    }),
    default: catalog.default_model,
    voice_default: catalog.voice_default_model,
  };
};
