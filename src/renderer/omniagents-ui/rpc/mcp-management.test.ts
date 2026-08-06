import { describe, expect, it, vi } from 'vitest';

import type { RpcMethodMap, RpcNotificationMap } from '@/generated/omniagents-gui-v1/gui-v1';

import { McpManagementClient, McpManagementProtocolError, type McpManagementTransport } from './mcp-management';

type McpMethod = Extract<keyof RpcMethodMap, `mcp_${string}`>;

const server = (overrides: Record<string, unknown> = {}) => ({
  server_name: 'github',
  source: 'user',
  transport: 'http',
  params: { url: 'https://mcp.example.test', headers: { Authorization: { is_set: true } } },
  server_options: {},
  enabled: true,
  read_only: false,
  status: { state: 'ready', origin: 'probe' },
  auth: { kind: 'oauth', state: 'authenticated' },
  ...overrides,
});

class FakeMcpRpc implements McpManagementTransport {
  readonly calls: Array<{ method: McpMethod; params: unknown }> = [];
  statusHandler?: (payload: RpcNotificationMap['mcp_server_status_changed']) => void;
  readonly request = vi.fn(
    async <Method extends McpMethod>(
      method: Method,
      params: RpcMethodMap[Method]['params']
    ): Promise<RpcMethodMap[Method]['result']> => {
      this.calls.push({ method, params });
      return this.results[method] as RpcMethodMap[Method]['result'];
    }
  );
  readonly on = vi.fn(
    (
      _event: 'mcp_server_status_changed',
      handler: (payload: RpcNotificationMap['mcp_server_status_changed']) => void
    ) => {
      this.statusHandler = handler;
      return () => {
        this.statusHandler = undefined;
      };
    }
  );

  constructor(private readonly results: Partial<Record<McpMethod, unknown>>) {}
}

describe('McpManagementClient', () => {
  it('lists session-scoped servers while preserving redacted and additive records', async () => {
    const rpc = new FakeMcpRpc({
      mcp_list_servers: {
        servers: [
          server({
            counts: { tools: 2, resources: 1, resource_templates: 0, prompts: 1, future_count: 3 },
            future_server_field: true,
          }),
        ],
        user_mcp_allowed: true,
        write_target: '/config/mcp.json',
        mutation_persistence: {
          user_config: { durable: true, scope: 'host' },
          oauth_tokens: { durable: true, scope: 'host' },
          pending_auth: { durable: false, scope: 'process' },
          managed_servers: ['omni-projects'],
        },
        future_list_field: 'kept',
      },
    });
    const result = await new McpManagementClient(rpc).listServers('session-1');

    expect(rpc.calls).toEqual([{ method: 'mcp_list_servers', params: { session_id: 'session-1' } }]);
    expect(result).toMatchObject({
      servers: [
        {
          params: { headers: { Authorization: { is_set: true } } },
          counts: { future_count: 3 },
          future_server_field: true,
        },
      ],
      future_list_field: 'kept',
    });
    expect(result.mutation_persistence).toEqual({
      user_config: { durable: true, scope: 'host' },
      oauth_tokens: { durable: true, scope: 'host' },
      pending_auth: { durable: false, scope: 'process' },
      managed_servers: ['omni-projects'],
    });
  });

  it('rejects malformed persistence capability claims', async () => {
    const rpc = new FakeMcpRpc({
      mcp_list_servers: {
        servers: [server()],
        user_mcp_allowed: true,
        write_target: '/config/mcp.json',
        mutation_persistence: {
          user_config: { durable: true, scope: null },
          oauth_tokens: { durable: false, scope: null },
          pending_auth: { durable: false, scope: 'process' },
          managed_servers: [],
        },
      },
    });
    await expect(new McpManagementClient(rpc).listServers()).rejects.toThrow(/durable\/scope/);
  });

  it('gets refreshed discovery with opaque MCP-spec records', async () => {
    const rpc = new FakeMcpRpc({
      mcp_get_server: server({
        tools: [{ name: 'search', future_tool_field: true }],
        resources: [{ uri: 'file:///a', mimeType: 'text/plain' }],
        resource_templates: [],
        prompts: [{ name: 'review' }],
        supported: { tools: true, resources: true, prompts: true },
      }),
    });
    const result = await new McpManagementClient(rpc).getServer('github', true);
    expect(rpc.calls).toEqual([{ method: 'mcp_get_server', params: { server_name: 'github', refresh: true } }]);
    expect(result.tools?.[0]).toMatchObject({ future_tool_field: true });
  });

  it('creates, updates, deletes, and reloads servers with generated parameter names', async () => {
    const rpc = new FakeMcpRpc({
      mcp_create_server: { ok: true, server: server() },
      mcp_update_server: { ok: true, server: server({ transport: 'sse' }) },
      mcp_delete_server: { ok: true, server_name: 'github' },
      mcp_reload_server: { ok: true, reloaded_sessions: 2 },
    });
    const client = new McpManagementClient(rpc);

    await client.createServer({ serverName: 'github', type: 'http', params: { url: 'https://mcp.test' } });
    await client.updateServer('github', { type: 'sse', serverOptions: { timeout: 10 } });
    await client.deleteServer('github');
    await expect(client.reloadServer('github')).resolves.toBe(2);

    expect(rpc.calls).toEqual([
      {
        method: 'mcp_create_server',
        params: { server_name: 'github', type: 'http', params: { url: 'https://mcp.test' } },
      },
      {
        method: 'mcp_update_server',
        params: { server_name: 'github', type: 'sse', server_options: { timeout: 10 } },
      },
      { method: 'mcp_delete_server', params: { server_name: 'github' } },
      { method: 'mcp_reload_server', params: { server_name: 'github' } },
    ]);
  });

  it('covers pending/completed/cancelled OAuth flows without exposing token fields', async () => {
    const rpc = new FakeMcpRpc({
      mcp_auth_start: {
        state: 'pending',
        server_name: 'github',
        auth_id: 'auth-1',
        auth_url: 'https://auth.test',
        redirect_uri: 'http://localhost/callback',
      },
      mcp_auth_complete: { state: 'completed', server_name: 'github', auth_state: 'authenticated' },
      mcp_auth_cancel: true,
    });
    const client = new McpManagementClient(rpc);

    await client.startAuth('github', { redirectUri: 'http://localhost/callback', sessionId: 'session-1' });
    await client.completeAuth('auth-1', 'code-1');
    await expect(client.cancelAuth('auth-1')).resolves.toBe(true);

    expect(rpc.calls).toEqual([
      {
        method: 'mcp_auth_start',
        params: {
          server_name: 'github',
          redirect_uri: 'http://localhost/callback',
          session_id: 'session-1',
        },
      },
      { method: 'mcp_auth_complete', params: { auth_id: 'auth-1', code: 'code-1' } },
      { method: 'mcp_auth_cancel', params: { auth_id: 'auth-1' } },
    ]);
  });

  it('wraps experimental MCP resource, app-tool, and prompt operations', async () => {
    const rpc = new FakeMcpRpc({
      mcp_read_resource: {
        server_name: 'github',
        uri: 'file:///readme',
        contents: [{ uri: 'file:///readme', text: 'hello', future_content_field: 1 }],
      },
      mcp_call_tool: {
        server_name: 'github',
        tool_name: 'open_issue',
        result: { content: [{ type: 'text', text: 'done' }], future_result_field: true },
      },
      mcp_get_prompt: {
        server_name: 'github',
        prompt_name: 'review',
        result: { messages: [], future_prompt_field: true },
      },
    });
    const client = new McpManagementClient(rpc);

    await client.readResource('github', 'file:///readme', 'session-1');
    await client.callTool('github', 'open_issue', 'session-1', { title: 'Bug' });
    await client.getPrompt('github', 'review', { args: { topic: 'PR' } });

    expect(rpc.calls).toEqual([
      {
        method: 'mcp_read_resource',
        params: { server_name: 'github', uri: 'file:///readme', session_id: 'session-1' },
      },
      {
        method: 'mcp_call_tool',
        params: { server_name: 'github', tool_name: 'open_issue', session_id: 'session-1', args: { title: 'Bug' } },
      },
      {
        method: 'mcp_get_prompt',
        params: { server_name: 'github', prompt_name: 'review', args: { topic: 'PR' } },
      },
    ]);
  });

  it('decodes live status and rejects malformed state transitions', () => {
    const rpc = new FakeMcpRpc({});
    const received: unknown[] = [];
    const unsubscribe = new McpManagementClient(rpc).onStatusChanged((event) => received.push(event));

    rpc.statusHandler?.({ server_name: 'github', status: 'ready', previous_status: 'starting' });
    expect(received).toEqual([expect.objectContaining({ server_name: 'github', status: 'ready' })]);
    expect(() => rpc.statusHandler?.({ server_name: 'github', status: 'offline' })).toThrow(/unsupported value/);
    unsubscribe();
    expect(rpc.statusHandler).toBeUndefined();
  });

  it.each([
    ['bad server state', server({ status: { state: 'offline' } }), /unsupported value/],
    [
      'bad discovery count',
      server({ counts: { tools: -1, resources: 0, resource_templates: 0, prompts: 0 } }),
      /non-negative/,
    ],
    ['missing auth state', server({ auth: { kind: 'oauth' } }), /auth.state/],
  ])('rejects malformed server snapshots: %s', async (_name, payload, message) => {
    const client = new McpManagementClient(new FakeMcpRpc({ mcp_get_server: payload }));
    await expect(client.getServer('github')).rejects.toThrow(message);
  });

  it('rejects identity drift and malformed results', async () => {
    const wrong = new McpManagementClient(new FakeMcpRpc({ mcp_get_server: server({ server_name: 'other' }) }));
    await expect(wrong.getServer('github')).rejects.toThrow(/another server/);

    const malformed = new McpManagementClient(new FakeMcpRpc({ mcp_list_servers: { servers: 'bad' } }));
    await expect(malformed.listServers()).rejects.toBeInstanceOf(McpManagementProtocolError);
  });
});
