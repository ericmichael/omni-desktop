/**
 * Server-side masking of secret values before a settings snapshot leaves the
 * server for the renderer (teams mode). Team-shared model/MCP keys are *usable*
 * by members but must never be echoed back into the UI — a member could
 * otherwise read and exfiltrate the org key.
 *
 * Strategy: replace every secret-bearing field with {@link SECRET_SENTINEL} on
 * the way out. On save, {@link restoreMaskedSecrets} treats a sentinel value as
 * "unchanged" and re-applies the stored value, so a round-trip never clobbers
 * the real secret with the placeholder. Rotating a secret means sending a real
 * (non-sentinel) value.
 */
import type { McpConfig, ModelsConfig } from '@/shared/types';

export const SECRET_SENTINEL = '__OMNI_TEAM_SECRET__';

/** Replace all `api_key` values in a models config with the sentinel. */
export function maskModelsConfig(config: ModelsConfig): ModelsConfig {
  const providers: ModelsConfig['providers'] = {};
  for (const [name, prov] of Object.entries(config.providers)) {
    const models: typeof prov.models = {};
    for (const [id, m] of Object.entries(prov.models)) {
      models[id] = m.api_key ? { ...m, api_key: SECRET_SENTINEL } : m;
    }
    providers[name] = { ...prov, models, ...(prov.api_key ? { api_key: SECRET_SENTINEL } : {}) };
  }
  return { ...config, providers };
}

/** Replace MCP server `headers`/`env` values with the sentinel. */
export function maskMcpConfig(config: McpConfig): McpConfig {
  const mcpServers: McpConfig['mcpServers'] = {};
  for (const [name, srv] of Object.entries(config.mcpServers)) {
    mcpServers[name] = {
      ...srv,
      ...(srv.headers ? { headers: maskValues(srv.headers) } : {}),
      ...(srv.env ? { env: maskValues(srv.env) } : {}),
    };
  }
  return { mcpServers };
}

function maskValues(rec: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(rec)) {
    out[k] = SECRET_SENTINEL;
  }
  return out;
}

/**
 * Restore sentinel values in an incoming models config from the stored config,
 * so a save that didn't change a (masked) secret preserves the real value.
 * A non-sentinel incoming value is a genuine rotation and is kept.
 */
export function restoreMaskedModels(incoming: ModelsConfig, stored: ModelsConfig): ModelsConfig {
  const providers: ModelsConfig['providers'] = {};
  for (const [name, prov] of Object.entries(incoming.providers)) {
    const storedProv = stored.providers[name];
    const models: typeof prov.models = {};
    for (const [id, m] of Object.entries(prov.models)) {
      const storedKey = storedProv?.models[id]?.api_key;
      models[id] = m.api_key === SECRET_SENTINEL ? { ...m, api_key: storedKey } : m;
    }
    const provKey = prov.api_key === SECRET_SENTINEL ? storedProv?.api_key : prov.api_key;
    providers[name] = { ...prov, models, ...(provKey !== undefined ? { api_key: provKey } : {}) };
  }
  return { ...incoming, providers };
}
