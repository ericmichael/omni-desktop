/**
 * Pure helpers for the agent's runtime config (models / MCP / network / env).
 *
 * No fs, Electron, or node:crypto imports — safe for the renderer, main, and
 * server bundles alike. The secret-rewrite logic that DOES need hashing lives
 * in `src/main/config-materializer.ts` (main/server only); this module holds
 * the default shapes, the `.env` parser, and the env-ref predicate they share.
 */
import type { McpConfig, ModelsConfig, NetworkConfig } from '@/shared/types';

/** Empty `models.json` (current schema version). */
export function emptyModelsConfig(): ModelsConfig {
  return { version: 3, default: null, voice_default: null, providers: {} };
}

/** Empty `mcp.json`. */
export function emptyMcpConfig(): McpConfig {
  return { mcpServers: {} };
}

/** Empty `network.json` (egress disabled, no rules). */
export function emptyNetworkConfig(): NetworkConfig {
  return {
    enabled: false,
    presets: [],
    allowlist: [],
    denylist: [],
    allow_private_ips: false,
    enable_socks5: false,
  };
}

/**
 * Matches a `${VAR}` or `${VAR:-default}` reference anywhere in a string —
 * the same grammar both omni-code (`models.py`) and omniagents (`user_mcp.py`)
 * expand at load time. Used to detect user-authored refs so the materializer
 * never double-rewrites them into launcher secrets.
 */
const ENV_REF_RE = /\$\{[^}:]+(?::-[^}]*)?\}/;

/** True when `value` already contains a `${...}` reference (user-supplied). */
export function containsEnvRef(value: string): boolean {
  return ENV_REF_RE.test(value);
}

/**
 * Parse raw `.env` text into a `{ KEY: value }` map for direct injection into
 * the agent process env (cloud, where no `.env` file is written). Mirrors the
 * structure the Environment tab round-trips: `#` comments and blank lines are
 * skipped, the first `=` splits key from value, surrounding whitespace on the
 * key is trimmed, the value is taken verbatim (no quote stripping — the agent
 * env should receive exactly what the user typed).
 */
export function parseEnvVars(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const eq = raw.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = raw.slice(0, eq).trim();
    if (key === '') {
      continue;
    }
    out[key] = raw.slice(eq + 1);
  }
  return out;
}
