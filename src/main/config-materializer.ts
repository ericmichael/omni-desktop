/**
 * Materialize the agent's on-disk config from the (per-tenant, in cloud) store.
 *
 * The store is the source of truth for `models.json` / `mcp.json` /
 * `network.json`; `omni serve` still reads them as files from its config dir
 * (resolved via `XDG_CONFIG_HOME`). This module bridges the two.
 *
 * Two modes:
 *   - `'plaintext'` (desktop): write the configs verbatim. Single user, the
 *     file is just a derived copy of the store — same bytes as before.
 *   - `'refs'` (cloud): rewrite every secret field to a stable `${OMNI_SECRET_*}`
 *     reference and return the real values as an env map. The launcher injects
 *     that map into the agent process env (`getExtraEnv`), and the agent's
 *     loaders (`_expand_env_vars`) resolve the refs at load — so a provider key
 *     or MCP secret never lands on the shared, ephemeral container disk.
 *
 * `collectSecretEnv` exposes the same secret map without writing files, for the
 * spawn-time env injection. It and `materializeAgentConfig` share one walk so
 * the on-disk refs and the injected env keys can never drift.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { containsEnvRef } from '@/lib/agent-config';
import { type ManagedMcpEntry, mergeManagedMcpEntry } from '@/shared/mcp-entry';
import type { McpConfig, ModelsConfig, NetworkConfig } from '@/shared/types';

export type MaterializeMode = 'plaintext' | 'refs';

/** `{ envVarName: plaintextSecret }` — spread into the agent process env. */
export type SecretEnv = Record<string, string>;

/**
 * Stable env-var name for a secret, derived from its JSON path (not its value)
 * so the same field always maps to the same ref: re-materializing after an
 * unrelated edit yields an identical file (no churn), and rotating a value
 * keeps the ref. The name matches `[A-Z0-9_]+`, safe for the expansion regex.
 */
function secretRefName(scope: 'MODELS' | 'MCP', jsonPath: string): string {
  const hash = createHash('sha256').update(jsonPath).digest('hex').slice(0, 16);
  return `OMNI_SECRET_${scope}_${hash}`;
}

/** A value is a candidate secret when it's a non-empty string with no user `${ref}`. */
function isLiteralSecret(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !containsEnvRef(value);
}

/**
 * Rewrite `providers[*].api_key` and `providers[*].models[*].api_key` to refs.
 * These are the only credential-bearing fields, and the only ones omni-code
 * runs through `_expand_env_vars` — a ref anywhere else would not resolve.
 */
function extractModelSecrets(models: ModelsConfig): { sanitized: ModelsConfig; secrets: SecretEnv } {
  const secrets: SecretEnv = {};
  const providers: ModelsConfig['providers'] = {};

  for (const [provName, prov] of Object.entries(models.providers)) {
    const nextProvider = { ...prov };
    if (isLiteralSecret(prov.api_key)) {
      const ref = secretRefName('MODELS', `providers.${provName}.api_key`);
      secrets[ref] = prov.api_key;
      nextProvider.api_key = `\${${ref}}`;
    }

    const models_: typeof prov.models = {};
    for (const [modelId, model] of Object.entries(prov.models)) {
      const nextModel = { ...model };
      if (isLiteralSecret(model.api_key)) {
        const ref = secretRefName('MODELS', `providers.${provName}.models.${modelId}.api_key`);
        secrets[ref] = model.api_key;
        nextModel.api_key = `\${${ref}}`;
      }
      models_[modelId] = nextModel;
    }
    nextProvider.models = models_;
    providers[provName] = nextProvider;
  }

  return { sanitized: { ...models, providers }, secrets };
}

/**
 * Rewrite every value under `mcpServers[*].env` and `mcpServers[*].headers` to
 * refs. omniagents expands the whole server entry recursively, so rewriting all
 * env/header values is correct — and a "looks secret" heuristic would be unsafe
 * (a custom header or proxy URL can be a credential). The managed `omni-projects`
 * entry's `${OMNI_RUNTIME_TOKEN}` header is already a ref, so it's left as-is.
 */
function extractMcpSecrets(mcp: McpConfig): { sanitized: McpConfig; secrets: SecretEnv } {
  const secrets: SecretEnv = {};
  const mcpServers: McpConfig['mcpServers'] = {};

  for (const [name, server] of Object.entries(mcp.mcpServers)) {
    const next = { ...server };
    for (const field of ['env', 'headers'] as const) {
      const map = server[field];
      if (!map) {
        continue;
      }
      const nextMap: Record<string, string> = {};
      for (const [key, value] of Object.entries(map)) {
        if (isLiteralSecret(value)) {
          const ref = secretRefName('MCP', `mcpServers.${name}.${field}.${key}`);
          secrets[ref] = value;
          nextMap[key] = `\${${ref}}`;
        } else {
          nextMap[key] = value;
        }
      }
      next[field] = nextMap;
    }
    mcpServers[name] = next;
  }

  return { sanitized: { ...mcp, mcpServers }, secrets };
}

/**
 * The secret env map for a tenant, without touching disk — used by the agent
 * spawn's `getExtraEnv`. Operates on the user's own configs; the managed MCP
 * entry carries no literal secret (only the `${OMNI_RUNTIME_TOKEN}` ref), so it
 * contributes nothing here and is intentionally omitted.
 */
export function collectSecretEnv(models: ModelsConfig, mcp: McpConfig): SecretEnv {
  return {
    ...extractModelSecrets(models).secrets,
    ...extractMcpSecrets(mcp).secrets,
  };
}

function writeJson(path: string, data: unknown): void {
  // 0600 — matches omni-code's models.json permissions; in plaintext mode the
  // file holds real secrets, so keep it owner-only on every config.
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
}

/**
 * Write the three agent config files into `configDir`, merging the managed
 * `omni-projects` MCP entry on top of the tenant's own servers. Returns the
 * secret env map (empty in `'plaintext'` mode). `.env` is deliberately NOT
 * written here — see the callers: desktop writes a real `.env`, cloud injects
 * it straight into the agent env.
 */
export function materializeAgentConfig(opts: {
  configDir: string;
  models: ModelsConfig;
  mcp: McpConfig;
  network: NetworkConfig;
  mode: MaterializeMode;
  managedMcpEntry: ManagedMcpEntry;
}): { secretEnv: SecretEnv } {
  const { configDir, models, mcp, network, mode, managedMcpEntry } = opts;
  mkdirSync(configDir, { recursive: true });

  const mergedMcp: McpConfig = { ...mcp, mcpServers: mergeManagedMcpEntry(mcp.mcpServers, managedMcpEntry) };

  if (mode === 'plaintext') {
    writeJson(join(configDir, 'models.json'), models);
    writeJson(join(configDir, 'mcp.json'), mergedMcp);
    writeJson(join(configDir, 'network.json'), network);
    return { secretEnv: {} };
  }

  const modelsOut = extractModelSecrets(models);
  const mcpOut = extractMcpSecrets(mergedMcp);
  writeJson(join(configDir, 'models.json'), modelsOut.sanitized);
  writeJson(join(configDir, 'mcp.json'), mcpOut.sanitized);
  writeJson(join(configDir, 'network.json'), network);
  return { secretEnv: { ...modelsOut.secrets, ...mcpOut.secrets } };
}
