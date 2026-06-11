/**
 * Pure builders for the `omni-projects` entry in an agent's
 * `~/.config/omni_code/mcp.json`. No Electron / fs imports, so both the desktop
 * config writer (src/main/mcp-config-manager.ts) and the Azure container spec
 * (src/main/azure-compute/spec.ts) share one definition of the entry shape.
 *
 * Two transports, matched to where the agent runs and where its data lives:
 *   - stdio  → local desktop / single-tenant server: the agent spawns the
 *     bundled `cli.js`, which opens the local SQLite `projects.db`.
 *   - http   → remote cloud sandbox: the agent can't see a local DB, so it
 *     calls the launcher server's tenant-scoped HTTP MCP route, authenticated
 *     by the signed runtime token.
 */

/** Channel name; also the `_managed` marker value the desktop writer uses. */
export const MCP_ENTRY_NAME = 'omni-projects';
export const MCP_MANAGED_MARKER = 'omni-launcher';

export interface StdioMcpEntry {
  type: 'stdio';
  command: string;
  args: string[];
  _managed?: string;
}

export interface HttpMcpEntry {
  type: 'streamable_http';
  url: string;
  headers: Record<string, string>;
  /** The route builds a fresh server per request; cache the listing client-side. */
  cache_tools_list: true;
  _managed?: string;
}

/** Either managed entry shape the launcher injects into a tenant's mcp.json. */
export type ManagedMcpEntry = StdioMcpEntry | HttpMcpEntry;

/**
 * Merge the launcher-managed `omni-projects` entry into a set of user MCP
 * servers. Idempotent and respectful of a user override: if an `omni-projects`
 * entry exists WITHOUT the managed marker the user has "claimed" the name, so
 * it is left untouched; otherwise the managed entry is (re)written. Pure — the
 * config materializer calls this before writing `mcp.json`.
 */
export function mergeManagedMcpEntry<T>(
  servers: Record<string, T>,
  managed: ManagedMcpEntry
): Record<string, T | ManagedMcpEntry> {
  const existing = servers[MCP_ENTRY_NAME] as { _managed?: string } | undefined;
  if (existing && existing._managed !== MCP_MANAGED_MARKER) {
    return servers;
  }
  return { ...servers, [MCP_ENTRY_NAME]: managed };
}

/** Local desktop/server: spawn the bundled stdio MCP cli over the local DB. */
export function buildStdioMcpEntry(binPath: string): StdioMcpEntry {
  return { type: 'stdio', command: 'node', args: [binPath], _managed: MCP_MANAGED_MARKER };
}

/**
 * Remote sandbox: talk to the launcher server's HTTP MCP route. The
 * `${OMNI_RUNTIME_TOKEN}` placeholder is expanded by the agent's config loader
 * (omniagents `_expand_env_vars`) from the container env, so the token itself
 * never has to be written into the file.
 *
 * @param url Externally reachable URL of the server's MCP route (…/mcp/projects).
 */
export function buildHttpMcpEntry(url: string): HttpMcpEntry {
  return {
    type: 'streamable_http',
    url,
    headers: { Authorization: 'Bearer ${OMNI_RUNTIME_TOKEN}' },
    cache_tools_list: true,
    _managed: MCP_MANAGED_MARKER,
  };
}
