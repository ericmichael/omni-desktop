import { describe, expect, it } from 'vitest';

import { mergeById, mergeEnvVars, mergeMcpConfig, mergeModelsConfig, mergeNetworkConfig, mergeRecord } from '@/main/config-merge';
import type { McpConfig, ModelsConfig, NetworkConfig } from '@/shared/types';

const models = (providers: ModelsConfig['providers'], def: string | null = null): ModelsConfig => ({
  version: 3,
  default: def,
  voice_default: null,
  providers,
});

describe('mergeModelsConfig', () => {
  it('unions providers; user shadows team by name; user default wins', () => {
    const team = models({ openai: { type: 'openai', api_key: 'team', models: {} } }, 'openai/gpt');
    const user = models(
      {
        openai: { type: 'openai', api_key: 'mine', models: {} },
        anthropic: { type: 'openai-compatible', models: {} },
      },
      'anthropic/claude'
    );
    const m = mergeModelsConfig(team, user);
    expect(m.providers.openai!.api_key).toBe('mine'); // user shadows
    expect(m.providers.anthropic).toBeDefined();
    expect(m.default).toBe('anthropic/claude');
  });

  it('falls back to team default when user has none', () => {
    expect(mergeModelsConfig(models({}, 'team/x'), models({})).default).toBe('team/x');
  });
});

describe('mergeMcpConfig', () => {
  it('unions servers, user shadows, tombstones drop team servers', () => {
    const team: McpConfig = { mcpServers: { a: { type: 'stdio' }, b: { type: 'http' } } };
    const user: McpConfig = { mcpServers: { c: { type: 'stdio' } } };
    const m = mergeMcpConfig(team, user, ['a']);
    expect(Object.keys(m.mcpServers).sort()).toEqual(['b', 'c']);
  });
});

describe('mergeEnvVars', () => {
  it('user keys win except locked team keys', () => {
    const merged = mergeEnvVars('FOO=team\nBASE_URL=team', 'FOO=user\nEXTRA=user', ['BASE_URL']);
    const map = Object.fromEntries(merged.split('\n').map((l) => l.split('=')));
    expect(map['FOO']).toBe('user'); // user wins
    expect(map['BASE_URL']).toBe('team'); // locked
    expect(map['EXTRA']).toBe('user');
  });
});

describe('mergeNetworkConfig', () => {
  const floor: NetworkConfig = {
    enabled: true,
    presets: ['pkg'],
    allowlist: ['a.com', 'b.com'],
    denylist: ['evil.com'],
    allow_private_ips: false,
    enable_socks5: false,
  };
  it('intersects allowlist, unions denylist, ANDs booleans (deployment floor wins restrictive)', () => {
    const team: NetworkConfig = {
      enabled: true,
      presets: ['pkg', 'other'],
      allowlist: ['b.com', 'c.com'],
      denylist: ['bad.com'],
      allow_private_ips: true, // team wants it, floor forbids → false
      enable_socks5: true,
    };
    const m = mergeNetworkConfig(floor, team);
    expect(m.allowlist).toEqual(['b.com']); // intersection
    expect(m.denylist.sort()).toEqual(['bad.com', 'evil.com']); // union
    expect(m.allow_private_ips).toBe(false); // floor forbids
    expect(m.presets).toEqual(['pkg']);
  });
  it('passes team through when no floor', () => {
    const team = { ...floor, allow_private_ips: true };
    expect(mergeNetworkConfig(undefined, team)).toEqual(team);
  });
});

describe('mergeRecord / mergeById', () => {
  it('record union, user shadows', () => {
    expect(mergeRecord({ a: 1, b: 2 }, { b: 3, c: 4 })).toEqual({ a: 1, b: 3, c: 4 });
  });
  it('array union by id, user shadows', () => {
    const team = [{ id: 'x', v: 1 }, { id: 'y', v: 2 }];
    const user = [{ id: 'y', v: 9 }, { id: 'z', v: 3 }];
    const m = mergeById(team, user);
    expect(m.find((i) => i.id === 'y')!.v).toBe(9);
    expect(m.map((i) => i.id).sort()).toEqual(['x', 'y', 'z']);
  });
});
