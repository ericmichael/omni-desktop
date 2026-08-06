import { describe, expect, it } from 'vitest';

import type { McpServerSnapshot } from '@/renderer/omniagents-ui/rpc/mcp-management';

import {
  hasDurableLocalMcpPersistence,
  mcpCreateInput,
  mcpServerEntryFromSnapshot,
  mcpUpdateInput,
} from './mcp-config-adapter';

const snapshot = (overrides: Partial<McpServerSnapshot> = {}): McpServerSnapshot => ({
  server_name: 'github',
  source: 'user',
  transport: 'stdio',
  params: {
    command: 'node',
    args: ['server.mjs'],
    env: { TOKEN: { is_set: true }, REMOVE_ME: { is_set: true } },
  },
  server_options: {},
  enabled: true,
  read_only: false,
  status: { state: 'configured' },
  auth: { kind: 'env', state: 'configured' },
  ...overrides,
});

describe('canonical MCP config adapter', () => {
  it('turns redacted secrets into blank write-only placeholders', () => {
    expect(mcpServerEntryFromSnapshot(snapshot())).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['server.mjs'],
      env: { REMOVE_ME: '', TOKEN: '' },
    });
  });

  it('preserves blank stored secrets, deletes removed keys, and writes replacements', () => {
    expect(
      mcpUpdateInput(
        {
          type: 'stdio',
          command: 'node',
          args: ['server-v2.mjs'],
          env: { TOKEN: '', NEW_TOKEN: 'new-secret' },
        },
        snapshot()
      )
    ).toEqual({
      type: 'stdio',
      params: {
        command: 'node',
        args: ['server-v2.mjs'],
        env: { REMOVE_ME: null, NEW_TOKEN: 'new-secret' },
      },
    });
  });

  it('does not store empty secret placeholders on create', () => {
    expect(
      mcpCreateInput('github', {
        type: 'streamable_http',
        url: 'https://example.test/mcp',
        headers: { Authorization: '', 'X-Token': 'secret' },
      })
    ).toEqual({
      serverName: 'github',
      type: 'streamable_http',
      params: { url: 'https://example.test/mcp', headers: { 'X-Token': 'secret' } },
    });
  });

  it('requires both durable stores and managed connector protection', () => {
    expect(
      hasDurableLocalMcpPersistence({
        user_config: { durable: true, scope: 'host' },
        oauth_tokens: { durable: true, scope: 'host' },
        pending_auth: { durable: false, scope: 'process' },
        managed_servers: ['omni-projects'],
      })
    ).toBe(true);
    expect(
      hasDurableLocalMcpPersistence({
        user_config: { durable: true, scope: 'host' },
        oauth_tokens: { durable: false, scope: null },
        pending_auth: { durable: false, scope: 'process' },
        managed_servers: ['omni-projects'],
      })
    ).toBe(false);
  });
});
