import { describe, expect, it, vi } from 'vitest';

import {
  durableLocalMcpAgentHostEnv,
  hasDurableHostMcpMutation,
  isProtectedManagedMcpRequest,
  LocalMcpConfigOwner,
} from '@/main/local-mcp-config-owner';
import { buildStdioMcpEntry } from '@/shared/mcp-entry';
import type { McpConfig } from '@/shared/types';

const durable = (servers: unknown[]) => ({
  servers,
  user_mcp_allowed: true,
  write_target: '/ignored/mcp.json',
  mutation_persistence: {
    user_config: { durable: true, scope: 'host' },
    oauth_tokens: { durable: true, scope: 'host' },
    pending_auth: { durable: false, scope: 'process' },
    managed_servers: ['omni-projects'],
  },
});

const managedSnapshot = {
  server_name: 'omni-projects',
  source: 'host_managed',
  transport: 'stdio',
  params: { command: 'node', args: ['/bin/projects.js'] },
  server_options: {},
  read_only: true,
  read_only_reason: 'host_managed',
};

const setup = (mcpConfig: McpConfig = { mcpServers: {} }) => {
  let ownership: 'omniagents' | undefined;
  const set = vi.fn((_key: 'mcpConfigOwnership', value: 'omniagents') => {
    ownership = value;
  });
  const owner = new LocalMcpConfigOwner({
    store: {
      get: ((key: 'mcpConfigOwnership' | 'mcpConfig') =>
        key === 'mcpConfigOwnership' ? ownership : mcpConfig) as never,
      set,
    },
    managedEntry: buildStdioMcpEntry('/bin/projects.js'),
    environment: () => ({ MCP_URL: 'https://expanded.test' }),
  });
  return { owner, set };
};

describe('local MCP ownership', () => {
  it('overrides spoofed durability and managed-name environment claims', () => {
    expect(
      durableLocalMcpAgentHostEnv({
        KEEP: 'yes',
        OMNIAGENTS_MCP_STORE_DURABILITY: 'process',
        OMNIAGENTS_MANAGED_MCP_SERVERS: 'evil',
      })
    ).toEqual({
      KEEP: 'yes',
      OMNIAGENTS_MCP_STORE_DURABILITY: 'host',
      OMNIAGENTS_MANAGED_MCP_SERVERS: 'omni-projects',
    });
  });

  it('requires both durable stores and the managed-name attestation', () => {
    expect(hasDurableHostMcpMutation(durable([]))).toBe(true);
    expect(
      hasDurableHostMcpMutation({
        ...durable([]),
        mutation_persistence: {
          ...durable([]).mutation_persistence,
          oauth_tokens: { durable: false, scope: null },
        },
      })
    ).toBe(false);
    expect(
      hasDurableHostMcpMutation({
        ...durable([]),
        mutation_persistence: { ...durable([]).mutation_persistence, managed_servers: [] },
      })
    ).toBe(false);
  });

  it('marks ownership after exact redacted user and host-managed parity', () => {
    const { owner, set } = setup({
      mcpServers: {
        github: {
          type: 'http',
          url: '${MCP_URL}',
          headers: { Authorization: 'secret', 'X-Empty': '' },
        },
      },
    });
    owner.ensureOwnership(
      durable([
        {
          server_name: 'github',
          source: 'user',
          transport: 'http',
          params: {
            url: 'https://expanded.test',
            headers: { Authorization: { is_set: true }, 'X-Empty': { is_set: true } },
          },
          server_options: {},
        },
        managedSnapshot,
        { server_name: 'project-only', source: 'project', transport: 'stdio', params: {}, server_options: {} },
      ])
    );
    expect(set).toHaveBeenCalledWith('mcpConfigOwnership', 'omniagents');
    expect(owner.isOwned()).toBe(true);
  });

  it('does not compare or expose secret values', () => {
    const { owner } = setup({
      mcpServers: { github: { type: 'http', url: 'https://mcp', headers: { Authorization: 'one-secret' } } },
    });
    expect(() =>
      owner.ensureOwnership(
        durable([
          {
            server_name: 'github',
            source: 'user',
            transport: 'http',
            params: { url: 'https://mcp', headers: { Authorization: { is_set: true } } },
            server_options: {},
          },
          managedSnapshot,
        ])
      )
    ).not.toThrow();
  });

  it('refuses mismatch, missing durability, and a user-claimed managed name', () => {
    const mismatch = setup({ mcpServers: { github: { type: 'http', url: 'https://expected' } } });
    expect(() => mismatch.owner.ensureOwnership(durable([managedSnapshot]))).toThrow('disagree');
    expect(mismatch.set).not.toHaveBeenCalled();

    const unattested = setup();
    expect(() => unattested.owner.ensureOwnership({ ...durable([managedSnapshot]), mutation_persistence: {} })).toThrow(
      'did not attest'
    );

    const claimed = setup({ mcpServers: { 'omni-projects': { type: 'stdio', command: 'mine' } } });
    expect(() => claimed.owner.ensureOwnership(durable([managedSnapshot]))).toThrow('reserved omni-projects');
  });

  it('still checks runtime durability after ownership but does not rerun parity', () => {
    const { owner, set } = setup();
    owner.ensureOwnership(durable([managedSnapshot]));
    owner.ensureOwnership(durable([]));
    expect(set).toHaveBeenCalledTimes(1);
    expect(() => owner.ensureOwnership({ ...durable([]), mutation_persistence: {} })).toThrow('did not attest');
  });

  it('recognizes requests that target the managed server', () => {
    expect(
      isProtectedManagedMcpRequest({ method: 'mcp_update_server', params: { server_name: 'omni-projects' } })
    ).toBe(true);
    expect(isProtectedManagedMcpRequest({ method: 'mcp_update_server', params: { server_name: 'github' } })).toBe(
      false
    );
    expect(isProtectedManagedMcpRequest({ method: 'write_config', params: { server_name: 'omni-projects' } })).toBe(
      false
    );
  });
});
