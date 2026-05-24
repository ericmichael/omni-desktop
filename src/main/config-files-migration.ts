/**
 * One-time import of the agent's on-disk config files into the store.
 *
 * Before v23 the Settings UI wrote `models.json` / `mcp.json` / `network.json`
 * / `.env` directly to the config dir. Those are now store-backed (per-tenant
 * in cloud) and the files are a derived artifact. This migration lifts any
 * existing files into the store once, then `config-materializer.ts` owns the
 * files going forward.
 *
 * Idempotent (guarded by `agentConfigMigratedFromFiles`) and conservative: it
 * runs only for desktop and the local single-tenant server — cloud tenants
 * start empty, so a shared container file is never imported into a tenant.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SettingsConfigStore } from '@/shared/ipc-handlers';
import { MCP_ENTRY_NAME } from '@/shared/mcp-entry';
import type { McpConfig, ModelsConfig, NetworkConfig } from '@/shared/types';

function readJson(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch {
    return null;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Import on-disk config files into `store` (once). Returns true if anything was
 * imported. The managed `omni-projects` MCP entry is stripped on import — it's
 * re-merged by the materializer, so importing it would let it accumulate.
 */
export function migrateAgentConfigFromFiles(store: SettingsConfigStore, configDir: string): boolean {
  if (store.get('agentConfigMigratedFromFiles')) {
    return false;
  }
  let imported = false;

  const models = readJson(join(configDir, 'models.json'));
  if (models && typeof models === 'object' && 'version' in models) {
    store.set('modelsConfig', models as ModelsConfig);
    imported = true;
  }

  const mcp = readJson(join(configDir, 'mcp.json'));
  if (mcp && typeof mcp === 'object' && 'mcpServers' in mcp) {
    const servers = { ...(mcp as McpConfig).mcpServers };
    delete servers[MCP_ENTRY_NAME];
    store.set('mcpConfig', { mcpServers: servers });
    imported = true;
  }

  const network = readJson(join(configDir, 'network.json'));
  if (network && typeof network === 'object') {
    store.set('networkConfig', network as NetworkConfig);
    imported = true;
  }

  const env = readText(join(configDir, '.env'));
  if (env !== null) {
    store.set('envVars', env);
    imported = true;
  }

  store.set('agentConfigMigratedFromFiles', true);
  return imported;
}
