/**
 * Pure merge operators for teams-mode settings (see docs/teams-settings-merge.md).
 *
 * Each `team`-class key combines a team base with the launching user's overlay:
 *   - models   — providers union (user shadows by name) + user-preferred default
 *   - mcp      — servers union (user shadows; user may tombstone a team server)
 *   - env      — overlay map (user key wins; team may lock keys)
 *   - network  — deployment floor ∩ team policy (no user overlay)
 *   - records  — generic union (user shadows by key)
 *
 * No IPC/DB/Electron imports — unit-testable in isolation.
 */
import { parseEnvVars } from '@/lib/agent-config';
import type { McpConfig, ModelsConfig, NetworkConfig } from '@/shared/types';

/** Providers union; user shadows team by provider name. Default: user ?? team. */
export function mergeModelsConfig(team: ModelsConfig, user: ModelsConfig): ModelsConfig {
  return {
    version: 3,
    default: user.default ?? team.default,
    voice_default: user.voice_default ?? team.voice_default,
    providers: { ...team.providers, ...user.providers },
  };
}

/**
 * Servers union; user shadows team by name. Names in `tombstones` are dropped
 * (a user hiding a team-provided server).
 */
export function mergeMcpConfig(team: McpConfig, user: McpConfig, tombstones: readonly string[] = []): McpConfig {
  const merged = { ...team.mcpServers, ...user.mcpServers };
  for (const name of tombstones) {
    delete merged[name];
  }
  return { mcpServers: merged };
}

/** Serialize an env map back to `.env` text (stable key order). */
export function serializeEnvVars(map: Record<string, string>): string {
  return Object.keys(map)
    .sort()
    .map((k) => `${k}=${map[k]}`)
    .join('\n');
}

/**
 * Env overlay: user keys win over team keys, except keys in `lockedKeys` where
 * the team value is re-applied (team lock). Returns merged `.env` text.
 */
export function mergeEnvVars(teamStr: string, userStr: string, lockedKeys: readonly string[] = []): string {
  const teamMap = parseEnvVars(teamStr || '');
  const userMap = parseEnvVars(userStr || '');
  const merged: Record<string, string> = { ...teamMap, ...userMap };
  for (const k of lockedKeys) {
    if (k in teamMap) {
      merged[k] = teamMap[k]!;
    }
  }
  return serializeEnvVars(merged);
}

/**
 * Network policy = deployment floor ∩ team (most-restrictive). No user overlay.
 * When there is no floor, the team policy passes through unchanged.
 */
export function mergeNetworkConfig(floor: NetworkConfig | undefined, team: NetworkConfig): NetworkConfig {
  if (!floor) {
    return team;
  }
  const intersect = (a: string[], b: string[]): string[] => a.filter((x) => b.includes(x));
  const union = (a: string[], b: string[]): string[] => Array.from(new Set([...a, ...b]));
  return {
    // Egress is allowed only if both layers enable it.
    enabled: floor.enabled && team.enabled,
    // Allow only what both allow; deny what either denies.
    presets: intersect(floor.presets, team.presets),
    allowlist: intersect(floor.allowlist, team.allowlist),
    denylist: union(floor.denylist, team.denylist),
    allow_private_ips: floor.allow_private_ips && team.allow_private_ips,
    enable_socks5: floor.enable_socks5 && team.enable_socks5,
  };
}

/**
 * Generic record union (skillSources, installedBundles, enabledExtensions,
 * customApps-by-id): user entries shadow team entries by key.
 */
export function mergeRecord<V>(
  team: Record<string, V> | undefined,
  user: Record<string, V> | undefined
): Record<string, V> {
  return { ...(team ?? {}), ...(user ?? {}) };
}

/** Union of two id-keyed arrays; user entries shadow team entries by `id`. */
export function mergeById<T extends { id: string }>(team: T[] | undefined, user: T[] | undefined): T[] {
  const byId = new Map<string, T>();
  for (const item of team ?? []) {
    byId.set(item.id, item);
  }
  for (const item of user ?? []) {
    byId.set(item.id, item);
  }
  return Array.from(byId.values());
}
