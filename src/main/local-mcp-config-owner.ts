/**
 * Local-Electron migration from Desktop-owned mcp.json materialization to the
 * canonical Omniagents MCP management RPCs.
 *
 * The transfer is deliberately in-place: both implementations read the same
 * host file. Desktop stops writing it only after the runtime attests durable
 * host stores, protects the launcher-managed server name, and reports a
 * redacted snapshot equivalent to the file Desktop just materialized.
 */
import type { RpcMethodMap } from '@/generated/omniagents-gui-v1/gui-v1';
import { type ManagedMcpEntry, MCP_ENTRY_NAME, mergeManagedMcpEntry } from '@/shared/mcp-entry';
import type { McpConfig, McpServerEntry } from '@/shared/types';

const OWNERSHIP = 'omniagents' as const;
const OPTION_KEYS = [
  'cache_tools_list',
  'client_session_timeout_seconds',
  'tool_filter',
  'use_structured_content',
] as const;

type McpListResult = RpcMethodMap['mcp_list_servers']['result'];

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const durableHostStore = (value: unknown): boolean => {
  const entry = record(value);
  return entry?.['durable'] === true && entry['scope'] === 'host';
};

/** Runtime half of the durable-mutation gate. ProcessManager combines this
 * with an Electron-only topology flag before exposing any MCP mutation. */
export const hasDurableHostMcpMutation = (value: unknown): boolean => {
  const root = record(value);
  const persistence = record(root?.['mutation_persistence']);
  const managed = persistence?.['managed_servers'];
  return (
    durableHostStore(persistence?.['user_config']) &&
    durableHostStore(persistence?.['oauth_tokens']) &&
    Array.isArray(managed) &&
    managed.includes(MCP_ENTRY_NAME)
  );
};

export const durableLocalMcpAgentHostEnv = (env: Record<string, string>): Record<string, string> => ({
  ...env,
  // These are trusted topology assertions, never user preferences.
  OMNIAGENTS_MCP_STORE_DURABILITY: 'host',
  OMNIAGENTS_MANAGED_MCP_SERVERS: MCP_ENTRY_NAME,
});

export const isMcpManagementMethod = (method: string): boolean => method.startsWith('mcp_');

export const isProtectedManagedMcpRequest = (request: { method: string; params: Record<string, unknown> }): boolean =>
  isMcpManagementMethod(request.method) && request.params['server_name'] === MCP_ENTRY_NAME;

export type LocalMcpOwnershipStore = {
  get(key: 'mcpConfigOwnership'): 'omniagents' | undefined;
  get(key: 'mcpConfig'): McpConfig | undefined;
  set(key: 'mcpConfigOwnership', value: 'omniagents'): void;
};

type LocalMcpConfigOwnerOptions = {
  store: LocalMcpOwnershipStore;
  managedEntry: ManagedMcpEntry;
  /** Environment visible to omni serve, used to mirror its ${VAR} expansion
   * for non-secret fields during the one-time parity proof. */
  environment?: () => Record<string, string | undefined>;
};

type ExpectedSnapshot = {
  server_name: string;
  source: 'user' | 'host_managed';
  transport: string;
  params: Record<string, unknown>;
  server_options: Record<string, unknown>;
};

const expandEnv = (value: unknown, env: Record<string, string | undefined>): unknown => {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}:]+)(?::-([^}]*))?\}/g, (_match, name: string, fallback: string | undefined) => {
      return env[name] ?? fallback ?? '';
    });
  }
  if (Array.isArray(value)) {
    return value.map((entry) => expandEnv(entry, env));
  }
  const object = record(value);
  if (object) {
    return Object.fromEntries(Object.entries(object).map(([key, entry]) => [key, expandEnv(entry, env)]));
  }
  return value;
};

const redactSecretMap = (value: unknown): Record<string, { is_set: true }> | undefined => {
  const map = record(value);
  if (!map) {
    return undefined;
  }
  return Object.fromEntries(Object.keys(map).map((key) => [key, { is_set: true }]));
};

const expectedSnapshot = (
  serverName: string,
  rawEntry: McpServerEntry | ManagedMcpEntry,
  source: ExpectedSnapshot['source'],
  env: Record<string, string | undefined>
): ExpectedSnapshot => {
  const entry = rawEntry as Record<string, unknown>;
  const transport = typeof entry['type'] === 'string' ? entry['type'].toLowerCase() : 'stdio';
  const params: Record<string, unknown> = {};
  if (transport === 'stdio') {
    params['command'] = expandEnv(entry['command'], env);
    if ('args' in entry) {
      params['args'] = expandEnv(entry['args'], env);
    }
    if ('env' in entry) {
      params['env'] = redactSecretMap(entry['env']);
    }
  } else {
    params['url'] = expandEnv(entry['url'], env);
    if ('headers' in entry) {
      params['headers'] = redactSecretMap(entry['headers']);
    }
  }
  const serverOptions = Object.fromEntries(
    OPTION_KEYS.filter((key) => key in entry).map((key) => [key, expandEnv(entry[key], env)])
  );
  return { server_name: serverName, source, transport, params, server_options: serverOptions };
};

const comparableSnapshot = (value: unknown): ExpectedSnapshot | undefined => {
  const snapshot = record(value);
  const serverName = snapshot?.['server_name'];
  const source = snapshot?.['source'];
  const transport = snapshot?.['transport'];
  const params = record(snapshot?.['params']);
  const serverOptions = record(snapshot?.['server_options']);
  if (
    typeof serverName !== 'string' ||
    (source !== 'user' && source !== 'host_managed') ||
    typeof transport !== 'string' ||
    !params ||
    !serverOptions
  ) {
    return undefined;
  }
  return { server_name: serverName, source, transport, params, server_options: serverOptions };
};

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  const object = record(value);
  if (object) {
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

export class LocalMcpConfigOwner {
  constructor(private readonly options: LocalMcpConfigOwnerOptions) {}

  isOwned(): boolean {
    return this.options.store.get('mcpConfigOwnership') === OWNERSHIP;
  }

  /** Verify the one-time legacy/canonical snapshot boundary, then transfer
   * ownership. A mismatch leaves Desktop as the writer and fails closed. */
  ensureOwnership(status: McpListResult): void {
    if (!hasDurableHostMcpMutation(status)) {
      throw new Error('Omniagents did not attest durable host-scoped MCP configuration and OAuth stores');
    }
    if (this.isOwned()) {
      return;
    }

    const stored = this.options.store.get('mcpConfig') ?? { mcpServers: {} };
    if (Object.hasOwn(stored.mcpServers, MCP_ENTRY_NAME)) {
      throw new Error(`Desktop user MCP configuration claims the reserved ${MCP_ENTRY_NAME} server name`);
    }
    const merged = mergeManagedMcpEntry(stored.mcpServers, this.options.managedEntry);
    const env = this.options.environment?.() ?? process.env;
    const expected = Object.entries(merged)
      .map(([name, entry]) => expectedSnapshot(name, entry, name === MCP_ENTRY_NAME ? 'host_managed' : 'user', env))
      .sort((a, b) => a.server_name.localeCompare(b.server_name));

    const root = record(status);
    const rawServers = root?.['servers'];
    if (!Array.isArray(rawServers)) {
      throw new Error('Omniagents returned an invalid MCP server list');
    }
    const actual = rawServers
      .map(comparableSnapshot)
      .filter((entry): entry is ExpectedSnapshot => entry !== undefined)
      .sort((a, b) => a.server_name.localeCompare(b.server_name));

    if (stableJson(actual) !== stableJson(expected)) {
      throw new Error('Desktop and Omniagents disagree about the current host MCP configuration');
    }
    this.options.store.set('mcpConfigOwnership', OWNERSHIP);
  }
}
