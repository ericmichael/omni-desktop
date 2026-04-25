/**
 * Maintains the `omni-projects` entry in `~/.config/omni_code/mcp.json` so
 * the agent (running inside any sandbox mode that mounts the omni config
 * dir) connects to the launcher's in-process HTTP MCP server.
 *
 * URL is templated on `${OMNI_MCP_URL}` and the auth header on
 * `${OMNI_MCP_TOKEN}`. The launcher injects both env vars into the agent
 * process at start time, choosing the correct host (`127.0.0.1` for
 * bwrap/none/server, `host.docker.internal` for Docker) per sandbox mode.
 *
 * Marked with `_managed: "omni-launcher"` so reruns are idempotent and the
 * user can manually clear the marker to "freeze" the entry.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getOmniConfigDir } from '@/main/util';

const MARKER = 'omni-launcher';
const ENTRY_NAME = 'omni-projects';

interface ManagedServerEntry {
  type: 'streamable_http';
  url: string;
  headers: Record<string, string>;
  _managed?: string;
}

interface McpJson {
  mcpServers?: Record<string, ManagedServerEntry | Record<string, unknown>>;
}

// `${...}` placeholders are read literally — omniagents/user_mcp.py expands
// them at agent startup against the launcher-injected env vars. Suppressing
// the lint rule that flags template-curlies in plain strings.
// eslint-disable-next-line no-template-curly-in-string
const URL_TEMPLATE = '${OMNI_MCP_URL}';
// eslint-disable-next-line no-template-curly-in-string
const TOKEN_HEADER = 'Bearer ${OMNI_MCP_TOKEN}';

const DESIRED: ManagedServerEntry = {
  type: 'streamable_http',
  url: URL_TEMPLATE,
  headers: { Authorization: TOKEN_HEADER },
  _managed: MARKER,
};

/** Insert or refresh the `omni-projects` entry in mcp.json. */
export function syncMcpConfig(): void {
  const path = join(getOmniConfigDir(), 'mcp.json');

  let parsed: McpJson = {};
  if (existsSync(path)) {
    try {
      parsed = JSON.parse(readFileSync(path, 'utf-8')) as McpJson;
    } catch (err) {
      console.warn(`[mcp-config] failed to parse ${path}; leaving file alone:`, err);
      return;
    }
  }

  const servers = parsed.mcpServers ?? {};
  const existing = servers[ENTRY_NAME] as ManagedServerEntry | undefined;

  // User claimed the entry — don't overwrite.
  if (existing && existing._managed !== MARKER) {
return;
}

  if (existing && JSON.stringify(existing) === JSON.stringify(DESIRED)) {
return;
}

  servers[ENTRY_NAME] = DESIRED;
  parsed.mcpServers = servers;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)  }\n`, 'utf-8');
  console.log(`[mcp-config] wrote ${ENTRY_NAME} entry to ${path}`);
}
