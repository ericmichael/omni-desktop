import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectSecretEnv, materializeAgentConfig } from '@/main/config-materializer';
import { buildHttpMcpEntry, buildStdioMcpEntry, MCP_ENTRY_NAME } from '@/shared/mcp-entry';
import type { McpConfig, ModelsConfig, NetworkConfig } from '@/shared/types';

const STDIO = buildStdioMcpEntry('/bin/cli.js');
const HTTP = buildHttpMcpEntry('http://127.0.0.1:3001/mcp/projects');
const NET: NetworkConfig = {
  enabled: true,
  presets: [],
  allowlist: ['api.openai.com'],
  denylist: [],
  allow_private_ips: false,
  enable_socks5: false,
};

const models = (): ModelsConfig => ({
  version: 3,
  default: 'openai/gpt',
  voice_default: null,
  providers: {
    openai: { type: 'openai', api_key: 'sk-secret', models: { gpt: { model: 'gpt', api_key: 'sk-model' } } },
    azure: { type: 'azure', api_key: '${USER_AZURE_KEY}', base_url: 'https://x', models: {} },
  },
});

const mcp = (): McpConfig => ({
  mcpServers: {
    github: { type: 'http', url: 'https://mcp', headers: { Authorization: 'token ghp_xxx' }, env: { DEBUG: '1' } },
  },
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'matz-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf-8'));

describe('materializeAgentConfig — plaintext', () => {
  it('writes configs verbatim, merges the managed entry, emits no secrets', () => {
    const { secretEnv } = materializeAgentConfig({
      configDir: dir,
      models: models(),
      mcp: mcp(),
      network: NET,
      mode: 'plaintext',
      managedMcpEntry: STDIO,
    });
    expect(secretEnv).toEqual({});
    expect(read('models.json').providers.openai.api_key).toBe('sk-secret');
    expect(read('mcp.json').mcpServers[MCP_ENTRY_NAME]).toEqual(STDIO);
    expect(read('mcp.json').mcpServers.github.headers.Authorization).toBe('token ghp_xxx');
    expect(read('network.json')).toEqual(NET);
  });
});

describe('materializeAgentConfig — refs', () => {
  it('rewrites literal secrets to ${OMNI_SECRET_*} refs and returns their values', () => {
    const { secretEnv } = materializeAgentConfig({
      configDir: dir,
      models: models(),
      mcp: mcp(),
      network: NET,
      mode: 'refs',
      managedMcpEntry: HTTP,
    });

    const provKey = read('models.json').providers.openai.api_key;
    const modelKey = read('models.json').providers.openai.models.gpt.api_key;
    const ghHeader = read('mcp.json').mcpServers.github.headers.Authorization;
    expect(provKey).toMatch(/^\$\{OMNI_SECRET_MODELS_[a-f0-9]{16}\}$/);
    expect(modelKey).toMatch(/^\$\{OMNI_SECRET_MODELS_[a-f0-9]{16}\}$/);
    expect(ghHeader).toMatch(/^\$\{OMNI_SECRET_MCP_[a-f0-9]{16}\}$/);

    // The ref resolves back to the original secret via the env map.
    const refOf = (s: string) => s.slice(2, -1);
    expect(secretEnv[refOf(provKey)]).toBe('sk-secret');
    expect(secretEnv[refOf(modelKey)]).toBe('sk-model');
    expect(secretEnv[refOf(ghHeader)]).toBe('token ghp_xxx');
    // network is non-secret and untouched
    expect(read('network.json')).toEqual(NET);
  });

  it('leaves user-authored ${ENV} refs alone and does not collect them', () => {
    const { secretEnv } = materializeAgentConfig({
      configDir: dir,
      models: models(),
      mcp: mcp(),
      network: NET,
      mode: 'refs',
      managedMcpEntry: HTTP,
    });
    expect(read('models.json').providers.azure.api_key).toBe('${USER_AZURE_KEY}');
    expect(Object.values(secretEnv)).not.toContain('${USER_AZURE_KEY}');
  });

  it('keeps the managed entry’s ${OMNI_RUNTIME_TOKEN} header as a ref, not a secret', () => {
    const { secretEnv } = materializeAgentConfig({
      configDir: dir,
      models: models(),
      mcp: mcp(),
      network: NET,
      mode: 'refs',
      managedMcpEntry: HTTP,
    });
    expect(read('mcp.json').mcpServers[MCP_ENTRY_NAME].headers.Authorization).toBe('Bearer ${OMNI_RUNTIME_TOKEN}');
    expect(Object.keys(secretEnv).some((k) => k.includes('RUNTIME_TOKEN'))).toBe(false);
  });

  it('produces stable refs across re-materialization (identical file bytes)', () => {
    const opts = { configDir: dir, models: models(), mcp: mcp(), network: NET, mode: 'refs' as const, managedMcpEntry: HTTP };
    materializeAgentConfig(opts);
    const first = readFileSync(join(dir, 'models.json'), 'utf-8');
    materializeAgentConfig(opts);
    expect(readFileSync(join(dir, 'models.json'), 'utf-8')).toBe(first);
  });
});

describe('collectSecretEnv', () => {
  it('matches the refs/values the materializer writes to disk', () => {
    const { secretEnv } = materializeAgentConfig({
      configDir: dir,
      models: models(),
      mcp: mcp(),
      network: NET,
      mode: 'refs',
      managedMcpEntry: HTTP,
    });
    expect(collectSecretEnv(models(), mcp())).toEqual(secretEnv);
  });
});
