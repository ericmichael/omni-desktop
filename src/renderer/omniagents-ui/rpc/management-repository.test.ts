import { describe, expect, it, vi } from 'vitest';

import type { RpcMethodMap, RpcNotificationMap } from '@/generated/omniagents-gui-v1/gui-v1';

import type { RPCConnectionState } from './client';
import { ManagementRepository, type ManagementTransport } from './management-repository';

const model = {
  id: 'codex/gpt-5',
  model: 'gpt-5',
  label: 'GPT-5',
  description: null,
  provider: { name: 'codex', type: 'openai-oauth' },
  modalities: ['text'],
  realtime: false,
  limits: { max_input_tokens: 100, max_output_tokens: 50 },
  reasoning: { default: 'medium', options: ['medium'] },
  tiers: { service: null, speed: null },
  personality: { supported: false, options: [], default: null },
  availability: { available: true, reasons: [] },
  entitlement: { entitled: true, credential: 'oauth' },
  deprecation: { deprecated: false, message: null, replace_with: null },
  hidden: false,
  is_default: true,
  is_voice_default: false,
  is_user_defined: false,
};

const provider = {
  name: 'codex',
  type: 'openai-oauth',
  base_url: null,
  is_default_provider: true,
  is_user_defined: false,
  model_count: 1,
  hidden_model_count: 0,
  capabilities: { realtime: false, reasoning: true, modalities: ['text'] },
  health: { status: 'ok', detail: null },
};

const account = {
  id: 'codex',
  label: 'Codex',
  kind: 'oauth',
  capabilities: { login_modes: ['browser'], logout: true, refresh: true, usage: true },
  state: 'signed_in',
  source: 'oauth',
  identity: { plan: 'team' },
  error: null,
  selected: true,
};

const mcpServer = {
  server_name: 'github',
  source: 'user',
  transport: 'http',
  params: { url: 'https://mcp.example.test' },
  server_options: {},
  enabled: true,
  read_only: false,
  status: { state: 'ready' },
  auth: { kind: 'oauth', state: 'authenticated' },
};

const configField = {
  key: 'security.mode',
  type: 'string',
  label: 'Mode',
  description: '',
  secret: false,
  reload: 'session',
  read_only: false,
  read_only_reason: null,
  is_set: true,
  effective_layer: 'project',
  layers: [{ layer: 'project', source: '/project/agent.yml', is_set: true, value: 'safe' }],
  value: 'safe',
};

const defaultResults: Partial<Record<keyof RpcMethodMap, unknown>> = {
  list_models: {
    models: [model],
    default_model: 'codex/gpt-5',
    voice_default_model: null,
    errors: [],
    reasons: [],
  },
  list_providers: { providers: [provider], errors: [], reasons: [] },
  account_status: { providers: [account], selected_provider: 'codex' },
  mcp_list_servers: { servers: [mcpServer], user_mcp_allowed: true, write_target: '/config/mcp.json' },
  get_config: {
    layers: [{ name: 'project', writable: false, sources: ['/project/agent.yml'] }],
    fields: [configField],
  },
};

class FakeManagementRpc implements ManagementTransport {
  connectionState: RPCConnectionState = 'disconnected';
  readonly calls: Array<keyof RpcMethodMap> = [];
  readonly subscriptions = new Map<keyof RpcNotificationMap, Set<(payload: never) => void>>();
  private readonly connectionHandlers = new Set<(state: RPCConnectionState) => void>();

  constructor(
    readonly experimental = new Set<string>(),
    readonly results: Partial<Record<keyof RpcMethodMap, unknown>> = { ...defaultResults }
  ) {}

  request = vi.fn(
    async <Method extends keyof RpcMethodMap>(
      method: Method,
      _params: RpcMethodMap[Method]['params']
    ): Promise<RpcMethodMap[Method]['result']> => {
      this.calls.push(method);
      const result = this.results[method];
      if (result instanceof Error) {
        throw result;
      }
      if (result === undefined) {
        throw new Error(`No fake result for ${String(method)}`);
      }
      return result as RpcMethodMap[Method]['result'];
    }
  );

  on<Event extends keyof RpcNotificationMap>(
    event: Event,
    handler: (payload: RpcNotificationMap[Event]) => void
  ): () => void {
    const handlers = this.subscriptions.get(event) ?? new Set();
    handlers.add(handler as (payload: never) => void);
    this.subscriptions.set(event, handlers);
    return () => handlers.delete(handler as (payload: never) => void);
  }

  onConnectionState(handler: (state: RPCConnectionState) => void): () => void {
    this.connectionHandlers.add(handler);
    handler(this.connectionState);
    return () => this.connectionHandlers.delete(handler);
  }

  supportsExperimentalOperation(operation: string): boolean {
    return this.experimental.has(operation);
  }

  setConnection(state: RPCConnectionState): void {
    this.connectionState = state;
    for (const handler of this.connectionHandlers) {
      handler(state);
    }
  }

  emit<Event extends keyof RpcNotificationMap>(event: Event, payload: RpcNotificationMap[Event]): void {
    for (const handler of this.subscriptions.get(event) ?? []) {
      handler(payload as never);
    }
  }
}

describe('ManagementRepository', () => {
  it('loads authoritative management snapshots on every connected transition without mutating globals', async () => {
    const rpc = new FakeManagementRpc(new Set(['get_config', 'validate_config', 'mcp_read_resource']));
    const repository = new ManagementRepository(rpc);
    repository.start();

    rpc.setConnection('connected');
    await repository.whenSettled();

    expect(rpc.calls).toEqual(['list_models', 'list_providers', 'account_status', 'mcp_list_servers', 'get_config']);
    expect(repository.getSnapshot()).toMatchObject({
      status: 'ready',
      experimental: {
        mcpReadResource: true,
        mcpCallTool: false,
        configRead: true,
        configValidate: true,
        configWrite: false,
      },
      models: { status: 'ready', data: { default_model: 'codex/gpt-5' } },
      accounts: { status: 'ready', data: { selected_provider: 'codex' } },
      mcp: { status: 'ready', data: { servers: [{ server_name: 'github' }] } },
      config: { status: 'ready', data: { fields: [{ key: 'security.mode' }] } },
    });
    expect(rpc.calls.some((method) => /login|logout|create|update|delete|write|reload/.test(method))).toBe(false);

    rpc.setConnection('reconnecting');
    rpc.setConnection('connected');
    await repository.whenSettled();
    expect(rpc.calls.filter((method) => method === 'account_status')).toHaveLength(2);
    expect(rpc.calls.filter((method) => method === 'mcp_list_servers')).toHaveLength(2);
  });

  it('subscribes once and treats non-journaled account/MCP events as authoritative refetch invalidations', async () => {
    const rpc = new FakeManagementRpc();
    const repository = new ManagementRepository(rpc);
    repository.start();
    repository.start();
    expect(rpc.subscriptions.get('account_changed')?.size).toBe(1);
    expect(rpc.subscriptions.get('mcp_server_status_changed')?.size).toBe(1);

    rpc.setConnection('connected');
    await repository.whenSettled();
    rpc.calls.splice(0);

    rpc.emit('account_changed', { provider: 'codex', reason: 'refresh', account });
    await repository.whenSettled();
    expect(rpc.calls).toEqual(['list_models', 'list_providers', 'account_status']);

    rpc.calls.splice(0);
    rpc.emit('mcp_server_status_changed', {
      server_name: 'github',
      status: 'ready',
      previous_status: 'starting',
    });
    await repository.whenSettled();
    expect(rpc.calls).toEqual(['mcp_list_servers']);

    repository.stop();
    expect(rpc.subscriptions.get('account_changed')?.size).toBe(0);
    expect(rpc.subscriptions.get('mcp_server_status_changed')?.size).toBe(0);
  });

  it('does not start layered config unless get_config was negotiated', async () => {
    const rpc = new FakeManagementRpc(new Set(['validate_config', 'write_config']));
    const repository = new ManagementRepository(rpc);
    repository.start();
    rpc.setConnection('connected');
    await repository.whenSettled();

    expect(rpc.calls).not.toContain('get_config');
    expect(repository.getSnapshot()).toMatchObject({
      status: 'ready',
      experimental: { configRead: false, configValidate: true, configWrite: true },
      config: { status: 'unsupported', data: null },
    });
    await expect(repository.layeredConfig.getConfig()).rejects.toThrow(/get_config was not negotiated/);
    await expect(repository.mcpManagement.readResource('github', 'file:///README.md')).rejects.toThrow(
      /mcp_read_resource was not negotiated/
    );
    expect(rpc.calls).not.toContain('mcp_read_resource');
  });

  it('isolates malformed or failed resources and reports a degraded typed snapshot', async () => {
    const rpc = new FakeManagementRpc(new Set(), {
      ...defaultResults,
      account_status: new Error('account store unavailable'),
    });
    const repository = new ManagementRepository(rpc);
    const listener = vi.fn();
    repository.subscribe(listener);
    repository.start();
    rpc.setConnection('connected');
    await repository.whenSettled();

    expect(repository.status).toBe('degraded');
    expect(repository.getSnapshot().accounts).toMatchObject({
      status: 'error',
      error: 'account store unavailable',
    });
    expect(repository.getSnapshot().models.status).toBe('ready');
    expect(listener).toHaveBeenCalled();
  });
});
