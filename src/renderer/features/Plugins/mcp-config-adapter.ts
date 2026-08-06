import type {
  McpMutationPersistence,
  McpServerSnapshot,
} from '@/renderer/omniagents-ui/rpc/mcp-management';
import type { McpConfig, McpServerEntry } from '@/shared/types';

const MCP_TYPES = new Set(['stdio', 'sse', 'http', 'streamable_http']);

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const stringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : undefined;

const secretKeys = (value: unknown): string[] => {
  const entries = record(value);
  if (!entries) {
    return [];
  }
  return Object.entries(entries)
    .filter(([, marker]) => record(marker)?.['is_set'] === true)
    .map(([key]) => key)
    .sort();
};

export type StoredMcpSecretKeys = {
  env: string[];
  headers: string[];
};

export const storedMcpSecretKeys = (snapshot: McpServerSnapshot | undefined): StoredMcpSecretKeys => ({
  env: secretKeys(snapshot?.params['env']),
  headers: secretKeys(snapshot?.params['headers']),
});

/** Convert a redacted canonical snapshot to the legacy-shaped view model used
 * by the existing shadcn connector dialog. Secret values become blank
 * write-only placeholders; their key presence is retained separately. */
export function mcpServerEntryFromSnapshot(snapshot: McpServerSnapshot): McpServerEntry {
  const type = MCP_TYPES.has(snapshot.transport)
    ? (snapshot.transport as NonNullable<McpServerEntry['type']>)
    : 'stdio';
  const params = snapshot.params;
  const stored = storedMcpSecretKeys(snapshot);
  const args = stringArray(params['args']);
  return {
    type,
    ...(type === 'stdio'
      ? {
          command: typeof params['command'] === 'string' ? params['command'] : '',
          args: args ?? [],
          ...(stored.env.length > 0 ? { env: Object.fromEntries(stored.env.map((key) => [key, ''])) } : {}),
        }
      : {
          url: typeof params['url'] === 'string' ? params['url'] : '',
          ...(stored.headers.length > 0
            ? { headers: Object.fromEntries(stored.headers.map((key) => [key, ''])) }
            : {}),
        }),
  };
}

export function mcpConfigFromSnapshots(snapshots: readonly McpServerSnapshot[]): McpConfig {
  return {
    mcpServers: Object.fromEntries(
      snapshots.map((snapshot) => [snapshot.server_name, mcpServerEntryFromSnapshot(snapshot)])
    ),
  };
}

export const hasDurableLocalMcpPersistence = (persistence: McpMutationPersistence | null): boolean =>
  persistence?.user_config.durable === true &&
  persistence.user_config.scope === 'host' &&
  persistence.oauth_tokens.durable === true &&
  persistence.oauth_tokens.scope === 'host' &&
  persistence.managed_servers.includes('omni-projects');

function nonEmptySecrets(values: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!values) {
    return undefined;
  }
  const entries = Object.entries(values).filter(([, value]) => value.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function mcpCreateInput(serverName: string, entry: McpServerEntry): {
  serverName: string;
  type: NonNullable<McpServerEntry['type']>;
  params: Record<string, unknown>;
} {
  const type = entry.type ?? 'stdio';
  if (type === 'stdio') {
    const env = nonEmptySecrets(entry.env);
    return {
      serverName,
      type,
      params: {
        command: entry.command ?? '',
        args: entry.args ?? [],
        ...(env ? { env } : {}),
      },
    };
  }
  const headers = nonEmptySecrets(entry.headers);
  return {
    serverName,
    type,
    params: {
      url: entry.url ?? '',
      ...(headers ? { headers } : {}),
    },
  };
}

function secretPatch(
  draft: Record<string, string> | undefined,
  storedKeys: readonly string[]
): Record<string, string | null> | undefined {
  const next = draft ?? {};
  const stored = new Set(storedKeys);
  const patch: Record<string, string | null> = {};
  for (const key of new Set([...stored, ...Object.keys(next)])) {
    if (!(key in next)) {
      if (stored.has(key)) {
        patch[key] = null;
      }
      continue;
    }
    const value = next[key] ?? '';
    if (value.length > 0) {
      patch[key] = value;
    }
    // Blank + stored means preserve; blank + new is only a placeholder.
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

export function mcpUpdateInput(
  entry: McpServerEntry,
  current: McpServerSnapshot
): { type: NonNullable<McpServerEntry['type']>; params: Record<string, unknown> } {
  const type = entry.type ?? 'stdio';
  const stored = storedMcpSecretKeys(current);
  if (type === 'stdio') {
    const env = secretPatch(entry.env, stored.env);
    return {
      type,
      params: {
        command: entry.command ?? '',
        args: entry.args ?? [],
        ...(env ? { env } : {}),
      },
    };
  }
  const headers = secretPatch(entry.headers, stored.headers);
  return {
    type,
    params: {
      url: entry.url ?? '',
      ...(headers ? { headers } : {}),
    },
  };
}
