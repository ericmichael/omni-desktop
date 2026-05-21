/**
 * Maintains the `omni-projects` entry in `~/.config/omni_code/mcp.json` so
 * the agent connects to the bundled `omni-projects-mcp` stdio server. The
 * same entry works for omni-code running standalone (the launcher bundles
 * the MCP cli, so the absolute path stays valid as long as the launcher is
 * installed).
 *
 * The entry is marked with `_managed: "omni-launcher"` so reruns are
 * idempotent and the user can manually clear the marker to "freeze" the
 * entry.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { app } from 'electron';

import { getOmniConfigDir, isDevelopment } from '@/main/util';
import {
  buildHttpMcpEntry,
  buildStdioMcpEntry,
  type HttpMcpEntry,
  MCP_ENTRY_NAME,
  MCP_MANAGED_MARKER,
  type StdioMcpEntry,
} from '@/shared/mcp-entry';

const MARKER = MCP_MANAGED_MARKER;
const ENTRY_NAME = MCP_ENTRY_NAME;

type ManagedEntry = StdioMcpEntry | HttpMcpEntry;

interface McpJson {
  mcpServers?: Record<string, ManagedEntry | Record<string, unknown>>;
}

/**
 * Resolve the absolute path to the bundled `omni-projects-mcp` cli.js.
 *
 * Dev:  <repo>/packages/projects-mcp/dist/cli.js (workspace path)
 * Prod: <app-resources>/app.asar.unpacked/packages/projects-mcp/dist/cli.js
 *
 * The `packages/projects-mcp/dist/**` glob is added to electron-builder's
 * `asarUnpack` so the file is reachable by `node` (asar contents aren't
 * readable by raw fs).
 */
export function getMcpBinPath(): string {
  if (isDevelopment() || !app.isPackaged) {
    return resolve(__dirname, '..', '..', 'packages', 'projects-mcp', 'dist', 'cli.js');
  }
  const appPath = app.getAppPath();
  const unpacked = appPath.endsWith('.asar') ? `${appPath}.unpacked` : appPath;
  return join(unpacked, 'packages', 'projects-mcp', 'dist', 'cli.js');
}

/** Insert or refresh the managed `omni-projects` entry in mcp.json. */
function writeManagedEntry(desired: ManagedEntry): void {
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
  const existing = servers[ENTRY_NAME] as ManagedEntry | undefined;

  // User claimed the entry — don't overwrite.
  if (existing && existing._managed !== MARKER) {
    return;
  }
  if (existing && JSON.stringify(existing) === JSON.stringify(desired)) {
    return;
  }

  servers[ENTRY_NAME] = desired;
  parsed.mcpServers = servers;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
  console.log(`[mcp-config] wrote ${ENTRY_NAME} entry to ${path}`);
}

/** Local/desktop: stdio entry → the bundled MCP cli over the local SQLite DB. */
export function syncMcpConfig(): void {
  writeManagedEntry(buildStdioMcpEntry(getMcpBinPath()));
}

/**
 * Cloud: streamable-http entry → the launcher server's tenant-scoped MCP route.
 * The agent supplies the per-tenant token via the `${OMNI_RUNTIME_TOKEN}` env
 * placeholder (set per omni-serve process); the file itself is tenant-agnostic.
 */
export function syncMcpConfigHttp(url: string): void {
  writeManagedEntry(buildHttpMcpEntry(url));
}
