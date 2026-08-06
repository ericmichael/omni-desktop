import type { RpcMethodMap, RpcNotificationMap } from '@/generated/omniagents-gui-v1/gui-v1';

import { AccountManagementClient } from './account-management';
import type { RPCConnectionState } from './client';
import { LayeredConfigClient } from './layered-config';
import { McpManagementClient } from './mcp-management';
import { ModelCatalogClient } from './model-catalog';

export const MANAGEMENT_EXPERIMENTAL_OPERATIONS = {
  mcp: ['mcp_read_resource', 'mcp_call_tool', 'mcp_get_prompt'],
  config: ['get_config', 'validate_config', 'write_config'],
} as const;

export interface ManagementTransport {
  readonly connectionState: RPCConnectionState;
  request<Method extends keyof RpcMethodMap>(
    method: Method,
    params: RpcMethodMap[Method]['params']
  ): Promise<RpcMethodMap[Method]['result']>;
  on<Event extends keyof RpcNotificationMap>(
    event: Event,
    handler: (payload: RpcNotificationMap[Event]) => void
  ): () => void;
  onConnectionState(handler: (state: RPCConnectionState) => void): () => void;
  supportsExperimentalOperation(operation: string): boolean;
}

export type ManagementResourceStatus = 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';

export type ManagementResource<T> = {
  status: ManagementResourceStatus;
  data: T | null;
  error: string | null;
  updatedAt: number | null;
};

export type ModelCatalogSnapshot = Awaited<ReturnType<ModelCatalogClient['listModels']>>;
export type ProviderCatalogSnapshot = Awaited<ReturnType<ModelCatalogClient['listProviders']>>;
export type AccountStatusSnapshot = Awaited<ReturnType<AccountManagementClient['status']>>;
export type McpManagementSnapshot = Awaited<ReturnType<McpManagementClient['listServers']>>;
export type LayeredConfigSnapshot = Awaited<ReturnType<LayeredConfigClient['getConfig']>>;

export type ManagementExperimentalSupport = {
  mcpReadResource: boolean;
  mcpCallTool: boolean;
  mcpGetPrompt: boolean;
  configRead: boolean;
  configValidate: boolean;
  configWrite: boolean;
};

export type ManagementRepositoryStatus = 'disconnected' | 'loading' | 'ready' | 'degraded';

export type ManagementSnapshot = {
  revision: number;
  connection: RPCConnectionState;
  status: ManagementRepositoryStatus;
  experimental: ManagementExperimentalSupport;
  models: ManagementResource<ModelCatalogSnapshot>;
  providers: ManagementResource<ProviderCatalogSnapshot>;
  accounts: ManagementResource<AccountStatusSnapshot>;
  mcp: ManagementResource<McpManagementSnapshot>;
  config: ManagementResource<LayeredConfigSnapshot>;
};

type RefreshScope = 'all' | 'accounts' | 'mcp';
type ManagementResourceKey = 'models' | 'providers' | 'accounts' | 'mcp' | 'config';
type Listener = () => void;

const emptyResource = <T>(): ManagementResource<T> => ({
  status: 'idle',
  data: null,
  error: null,
  updatedAt: null,
});

const initialExperimentalSupport = (): ManagementExperimentalSupport => ({
  mcpReadResource: false,
  mcpCallTool: false,
  mcpGetPrompt: false,
  configRead: false,
  configValidate: false,
  configWrite: false,
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One management cache per GUI RPC connection.
 *
 * Account and MCP status notifications are deliberately treated only as
 * invalidation signals: both streams are process-global and non-journaled,
 * so this repository always refetches the authoritative snapshot. No global
 * mutation is ever issued by lifecycle or notification handling.
 */
export class ManagementRepository {
  readonly modelCatalog: ModelCatalogClient;
  readonly accountManagement: AccountManagementClient;
  readonly mcpManagement: McpManagementClient;
  readonly layeredConfig: LayeredConfigClient;

  private snapshotValue: ManagementSnapshot = {
    revision: 0,
    connection: 'disconnected',
    status: 'disconnected',
    experimental: initialExperimentalSupport(),
    models: emptyResource(),
    providers: emptyResource(),
    accounts: emptyResource(),
    mcp: emptyResource(),
    config: emptyResource(),
  };
  private listeners = new Set<Listener>();
  private unsubscribers: Array<() => void> = [];
  private refreshQueue: Promise<void> = Promise.resolve();
  private connectionGeneration = 0;
  private started = false;

  constructor(private readonly rpc: ManagementTransport) {
    this.modelCatalog = new ModelCatalogClient(rpc);
    this.accountManagement = new AccountManagementClient(rpc);
    const supportsExperimentalOperation = (operation: string) => rpc.supportsExperimentalOperation(operation);
    this.mcpManagement = new McpManagementClient(rpc, supportsExperimentalOperation);
    this.layeredConfig = new LayeredConfigClient(rpc, supportsExperimentalOperation);
  }

  getSnapshot = (): ManagementSnapshot => this.snapshotValue;

  get status(): ManagementRepositoryStatus {
    return this.snapshotValue.status;
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Reversible lifecycle for React StrictMode's simulated unmount/remount. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.unsubscribers = [
      this.accountManagement.onChanged(() => {
        void this.enqueueRefresh('accounts');
      }),
      this.mcpManagement.onStatusChanged(() => {
        void this.enqueueRefresh('mcp');
      }),
      this.rpc.onConnectionState((state) => this.handleConnectionState(state)),
    ];
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.connectionGeneration += 1;
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe();
    }
  }

  /** Force a read-only authoritative refresh for the current connection. */
  refresh(): Promise<void> {
    return this.enqueueRefresh('all');
  }

  /** Resolves after lifecycle/event-triggered refresh work queued so far. */
  whenSettled(): Promise<void> {
    return this.refreshQueue;
  }

  supportsExperimentalOperation(operation: string): boolean {
    return this.rpc.supportsExperimentalOperation(operation);
  }

  private handleConnectionState(connection: RPCConnectionState): void {
    if (!this.started) {
      return;
    }
    const transitionedToConnected = connection === 'connected' && this.snapshotValue.connection !== 'connected';
    if (connection !== this.snapshotValue.connection) {
      this.connectionGeneration += 1;
    }
    const experimental = connection === 'connected' ? this.readExperimentalSupport() : initialExperimentalSupport();
    this.commit({ connection, experimental });
    if (transitionedToConnected) {
      void this.enqueueRefresh('all');
    }
  }

  private readExperimentalSupport(): ManagementExperimentalSupport {
    return {
      mcpReadResource: this.rpc.supportsExperimentalOperation('mcp_read_resource'),
      mcpCallTool: this.rpc.supportsExperimentalOperation('mcp_call_tool'),
      mcpGetPrompt: this.rpc.supportsExperimentalOperation('mcp_get_prompt'),
      configRead: this.rpc.supportsExperimentalOperation('get_config'),
      configValidate: this.rpc.supportsExperimentalOperation('validate_config'),
      configWrite: this.rpc.supportsExperimentalOperation('write_config'),
    };
  }

  private enqueueRefresh(scope: RefreshScope): Promise<void> {
    const generation = this.connectionGeneration;
    this.refreshQueue = this.refreshQueue
      .catch(() => {})
      .then(async () => {
        if (
          !this.started ||
          this.snapshotValue.connection !== 'connected' ||
          generation !== this.connectionGeneration
        ) {
          return;
        }
        await this.performRefresh(scope, generation);
      });
    return this.refreshQueue;
  }

  private async performRefresh(scope: RefreshScope, generation: number): Promise<void> {
    const keys: ManagementResourceKey[] =
      scope === 'all'
        ? ['models', 'providers', 'accounts', 'mcp', 'config']
        : scope === 'accounts'
          ? ['models', 'providers', 'accounts']
          : ['mcp'];
    const loadingPatch: Partial<ManagementSnapshot> = {};
    for (const key of keys) {
      if (key === 'config' && !this.snapshotValue.experimental.configRead) {
        loadingPatch.config = {
          ...this.snapshotValue.config,
          status: 'unsupported',
          error: null,
        };
      } else {
        loadingPatch[key] = {
          ...this.snapshotValue[key],
          status: 'loading',
          error: null,
        } as never;
      }
    }
    this.commit(loadingPatch);

    const tasks: Promise<void>[] = [];
    if (keys.includes('models')) {
      tasks.push(this.load('models', () => this.modelCatalog.listModels(), generation));
    }
    if (keys.includes('providers')) {
      tasks.push(this.load('providers', () => this.modelCatalog.listProviders(), generation));
    }
    if (keys.includes('accounts')) {
      tasks.push(this.load('accounts', () => this.accountManagement.status(), generation));
    }
    if (keys.includes('mcp')) {
      tasks.push(this.load('mcp', () => this.mcpManagement.listServers(), generation));
    }
    if (keys.includes('config') && this.snapshotValue.experimental.configRead) {
      tasks.push(this.load('config', () => this.layeredConfig.getConfig(), generation));
    }
    await Promise.all(tasks);
  }

  private async load<Key extends ManagementResourceKey>(
    key: Key,
    fetcher: () => Promise<ManagementSnapshot[Key]['data']>,
    generation: number
  ): Promise<void> {
    try {
      const data = await fetcher();
      if (this.isCurrent(generation)) {
        this.commit({
          [key]: { status: 'ready', data, error: null, updatedAt: Date.now() },
        } as Pick<ManagementSnapshot, Key>);
      }
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.commit({
          [key]: {
            ...this.snapshotValue[key],
            status: 'error',
            error: errorMessage(error),
          },
        } as Pick<ManagementSnapshot, Key>);
      }
    }
  }

  private isCurrent(generation: number): boolean {
    return this.started && this.snapshotValue.connection === 'connected' && generation === this.connectionGeneration;
  }

  private commit(patch: Partial<ManagementSnapshot>): void {
    const next = { ...this.snapshotValue, ...patch, revision: this.snapshotValue.revision + 1 };
    next.status = this.calculateStatus(next);
    this.snapshotValue = next;
    for (const listener of this.listeners) {
      listener();
    }
  }

  private calculateStatus(snapshot: ManagementSnapshot): ManagementRepositoryStatus {
    if (snapshot.connection !== 'connected') {
      return 'disconnected';
    }
    const resources = [snapshot.models, snapshot.providers, snapshot.accounts, snapshot.mcp, snapshot.config];
    if (resources.some((resource) => resource.status === 'loading' || resource.status === 'idle')) {
      return 'loading';
    }
    return resources.some((resource) => resource.status === 'error') ? 'degraded' : 'ready';
  }
}
