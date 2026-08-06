import type { RpcMethodMap, RpcNotificationMap } from '@/generated/omniagents-gui-v1/gui-v1';

type McpMethod = Extract<keyof RpcMethodMap, `mcp_${string}`>;

export interface McpManagementTransport {
  request<Method extends McpMethod>(
    method: Method,
    params: RpcMethodMap[Method]['params']
  ): Promise<RpcMethodMap[Method]['result']>;
  on?<Event extends 'mcp_server_status_changed'>(
    event: Event,
    handler: (payload: RpcNotificationMap[Event]) => void
  ): () => void;
}

export type McpServerState = 'configured' | 'starting' | 'ready' | 'failed' | 'disabled';
export type McpAuthFlowState = 'pending' | 'completed';

export type McpServerSnapshot = Record<string, unknown> & {
  server_name: string;
  source: string;
  transport: string;
  params: Record<string, unknown>;
  server_options: Record<string, unknown>;
  enabled: boolean;
  disabled_reason?: string;
  read_only: boolean;
  read_only_reason?: string;
  status: Record<string, unknown> & { state: McpServerState };
  auth: Record<string, unknown> & { kind: string; state: string };
  server_info?: Record<string, unknown> | null;
  capabilities?: Record<string, unknown> | null;
  counts?: Record<string, unknown> & {
    tools: number;
    resources: number;
    resource_templates: number;
    prompts: number;
  };
  tools?: Record<string, unknown>[];
  resources?: Record<string, unknown>[];
  resource_templates?: Record<string, unknown>[];
  prompts?: Record<string, unknown>[];
  supported?: Record<string, boolean>;
};

/** Runtime-owned persistence and topology capabilities for local MCP CRUD.
 * Secret values are never returned here; this only describes where mutations
 * survive and which servers are host-managed/read-only. */
export type McpMutationPersistence = {
  user_config: { durable: boolean; scope: 'host' | null };
  oauth_tokens: { durable: boolean; scope: 'host' | null };
  pending_auth: { durable: false; scope: 'process' };
  managed_servers: string[];
};

export type McpListServersResult = Record<string, unknown> & {
  servers: McpServerSnapshot[];
  user_mcp_allowed: boolean;
  write_target: string;
  mutation_persistence: McpMutationPersistence | null;
};

export type McpAuthState = Record<string, unknown> & {
  state: McpAuthFlowState;
  server_name: string;
  auth_id?: string;
  auth_url?: string;
  redirect_uri?: string;
  auth_state?: string;
};

export type McpServerStatusEvent = Record<string, unknown> & {
  server_name: string;
  status: McpServerState;
  previous_status?: McpServerState;
  reason_code?: string;
  reason?: string;
  auth_state?: string;
  at?: string;
};

export class McpManagementProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpManagementProtocolError';
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new McpManagementProtocolError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new McpManagementProtocolError(`${label} must be a non-empty string`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new McpManagementProtocolError(`${label} must be a boolean`);
  }
  return value;
}

function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new McpManagementProtocolError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function array<T>(value: unknown, parser: (entry: unknown, label: string) => T, label: string): T[] {
  if (!Array.isArray(value)) {
    throw new McpManagementProtocolError(`${label} must be an array`);
  }
  return value.map((entry, index) => parser(entry, `${label}[${index}]`));
}

function optional<T>(
  source: Record<string, unknown>,
  field: string,
  parser: (value: unknown, label: string) => T,
  label: string
): Record<string, T> | Record<string, never> {
  return source[field] === undefined ? {} : { [field]: parser(source[field], `${label}.${field}`) };
}

const serverStates = new Set<McpServerState>(['configured', 'starting', 'ready', 'failed', 'disabled']);

function state(value: unknown, label: string): McpServerState {
  const result = nonEmptyString(value, label) as McpServerState;
  if (!serverStates.has(result)) {
    throw new McpManagementProtocolError(`${label} has unsupported value ${JSON.stringify(result)}`);
  }
  return result;
}

function decodeBooleanMap(value: unknown, label: string): Record<string, boolean> {
  const item = record(value, label);
  return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, boolean(entry, `${label}.${key}`)]));
}

function decodePersistence(value: unknown, label: string): McpMutationPersistence {
  const item = record(value, label);
  const store = (field: 'user_config' | 'oauth_tokens'): { durable: boolean; scope: 'host' | null } => {
    const entry = record(item[field], `${label}.${field}`);
    const durable = boolean(entry.durable, `${label}.${field}.durable`);
    const scope = entry.scope === null ? null : nonEmptyString(entry.scope, `${label}.${field}.scope`);
    if (scope !== null && scope !== 'host') {
      throw new McpManagementProtocolError(`${label}.${field}.scope has unsupported value ${JSON.stringify(scope)}`);
    }
    if (durable !== (scope === 'host')) {
      throw new McpManagementProtocolError(`${label}.${field} durable/scope combination is invalid`);
    }
    return { durable, scope };
  };
  const pending = record(item.pending_auth, `${label}.pending_auth`);
  if (pending.durable !== false || pending.scope !== 'process') {
    throw new McpManagementProtocolError(`${label}.pending_auth must be process-scoped and non-durable`);
  }
  const managed = array(item.managed_servers, nonEmptyString, `${label}.managed_servers`);
  return {
    user_config: store('user_config'),
    oauth_tokens: store('oauth_tokens'),
    pending_auth: { durable: false, scope: 'process' },
    managed_servers: managed,
  };
}

function decodeSnapshot(value: unknown, label: string): McpServerSnapshot {
  const item = record(value, label);
  const status = record(item.status, `${label}.status`);
  const auth = record(item.auth, `${label}.auth`);
  const counts = item.counts === undefined ? undefined : record(item.counts, `${label}.counts`);
  return {
    ...item,
    server_name: nonEmptyString(item.server_name, `${label}.server_name`),
    source: nonEmptyString(item.source, `${label}.source`),
    transport: nonEmptyString(item.transport, `${label}.transport`),
    params: record(item.params, `${label}.params`),
    server_options: record(item.server_options, `${label}.server_options`),
    enabled: boolean(item.enabled, `${label}.enabled`),
    ...optional(item, 'disabled_reason', nonEmptyString, label),
    read_only: boolean(item.read_only, `${label}.read_only`),
    ...optional(item, 'read_only_reason', nonEmptyString, label),
    status: { ...status, state: state(status.state, `${label}.status.state`) },
    auth: {
      ...auth,
      kind: nonEmptyString(auth.kind, `${label}.auth.kind`),
      state: nonEmptyString(auth.state, `${label}.auth.state`),
    },
    ...(item.server_info === undefined
      ? {}
      : { server_info: item.server_info === null ? null : record(item.server_info, `${label}.server_info`) }),
    ...(item.capabilities === undefined
      ? {}
      : { capabilities: item.capabilities === null ? null : record(item.capabilities, `${label}.capabilities`) }),
    ...(counts === undefined
      ? {}
      : {
          counts: {
            ...counts,
            tools: count(counts.tools, `${label}.counts.tools`),
            resources: count(counts.resources, `${label}.counts.resources`),
            resource_templates: count(counts.resource_templates, `${label}.counts.resource_templates`),
            prompts: count(counts.prompts, `${label}.counts.prompts`),
          },
        }),
    ...(item.tools === undefined ? {} : { tools: array(item.tools, record, `${label}.tools`) }),
    ...(item.resources === undefined ? {} : { resources: array(item.resources, record, `${label}.resources`) }),
    ...(item.resource_templates === undefined
      ? {}
      : { resource_templates: array(item.resource_templates, record, `${label}.resource_templates`) }),
    ...(item.prompts === undefined ? {} : { prompts: array(item.prompts, record, `${label}.prompts`) }),
    ...(item.supported === undefined ? {} : { supported: decodeBooleanMap(item.supported, `${label}.supported`) }),
  } as McpServerSnapshot;
}

function decodeAuthState(value: unknown, label: string, expectedServerName?: string): McpAuthState {
  const item = record(value, label);
  const flowState = nonEmptyString(item.state, `${label}.state`);
  if (flowState !== 'pending' && flowState !== 'completed') {
    throw new McpManagementProtocolError(`${label}.state has unsupported value ${JSON.stringify(flowState)}`);
  }
  const serverName = nonEmptyString(item.server_name, `${label}.server_name`);
  if (expectedServerName !== undefined && serverName !== expectedServerName) {
    throw new McpManagementProtocolError(`${label} returned a different server_name`);
  }
  if (flowState === 'pending' && (item.auth_id === undefined || item.auth_url === undefined)) {
    throw new McpManagementProtocolError(`${label} pending flow requires auth_id and auth_url`);
  }
  return {
    ...item,
    state: flowState,
    server_name: serverName,
    ...optional(item, 'auth_id', nonEmptyString, label),
    ...optional(item, 'auth_url', nonEmptyString, label),
    ...optional(item, 'redirect_uri', nonEmptyString, label),
    ...optional(item, 'auth_state', nonEmptyString, label),
  } as McpAuthState;
}

function validateInput(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function decodeStatusEvent(value: unknown): McpServerStatusEvent {
  const item = record(value, 'mcp_server_status_changed');
  return {
    ...item,
    server_name: nonEmptyString(item.server_name, 'mcp_server_status_changed.server_name'),
    status: state(item.status, 'mcp_server_status_changed.status'),
    ...(item.previous_status === undefined
      ? {}
      : { previous_status: state(item.previous_status, 'mcp_server_status_changed.previous_status') }),
    ...optional(item, 'reason_code', nonEmptyString, 'mcp_server_status_changed'),
    ...optional(item, 'reason', nonEmptyString, 'mcp_server_status_changed'),
    ...optional(item, 'auth_state', nonEmptyString, 'mcp_server_status_changed'),
    ...optional(item, 'at', nonEmptyString, 'mcp_server_status_changed'),
  } as McpServerStatusEvent;
}

export class McpManagementClient {
  constructor(
    private readonly rpc: McpManagementTransport,
    private readonly supportsExperimentalOperation: (operation: string) => boolean = () => true
  ) {}

  onStatusChanged(handler: (event: McpServerStatusEvent) => void): () => void {
    if (!this.rpc.on) {
      throw new TypeError('MCP transport does not support notifications');
    }
    return this.rpc.on('mcp_server_status_changed', (payload) => handler(decodeStatusEvent(payload)));
  }

  async listServers(sessionId?: string): Promise<McpListServersResult> {
    const params = sessionId === undefined ? {} : { session_id: validateInput(sessionId, 'sessionId') };
    const raw = record(await this.rpc.request('mcp_list_servers', params), 'mcp_list_servers');
    return {
      ...raw,
      servers: array(raw.servers, decodeSnapshot, 'mcp_list_servers.servers'),
      user_mcp_allowed: boolean(raw.user_mcp_allowed, 'mcp_list_servers.user_mcp_allowed'),
      write_target: nonEmptyString(raw.write_target, 'mcp_list_servers.write_target'),
      mutation_persistence:
        raw.mutation_persistence === undefined
          ? null
          : decodePersistence(raw.mutation_persistence, 'mcp_list_servers.mutation_persistence'),
    };
  }

  async getServer(serverName: string, refresh?: boolean): Promise<McpServerSnapshot> {
    const expected = validateInput(serverName, 'serverName');
    if (refresh !== undefined && typeof refresh !== 'boolean') {
      throw new TypeError('refresh must be a boolean');
    }
    const result = decodeSnapshot(
      await this.rpc.request('mcp_get_server', {
        server_name: expected,
        ...(refresh === undefined ? {} : { refresh }),
      }),
      'mcp_get_server'
    );
    if (result.server_name !== expected) {
      throw new McpManagementProtocolError('mcp_get_server returned another server');
    }
    return result;
  }

  async createServer(input: {
    serverName: string;
    type: string;
    params: Record<string, unknown>;
    serverOptions?: Record<string, unknown>;
  }): Promise<McpServerSnapshot> {
    return this.decodeServerMutation(
      'mcp_create_server',
      {
        server_name: validateInput(input.serverName, 'serverName'),
        type: validateInput(input.type, 'type'),
        params: input.params,
        ...(input.serverOptions === undefined ? {} : { server_options: input.serverOptions }),
      },
      input.serverName
    );
  }

  async updateServer(
    serverName: string,
    updates: { type?: string; params?: Record<string, unknown>; serverOptions?: Record<string, unknown> }
  ): Promise<McpServerSnapshot> {
    if (updates.type === undefined && updates.params === undefined && updates.serverOptions === undefined) {
      throw new TypeError('MCP server update must not be empty');
    }
    const expected = validateInput(serverName, 'serverName');
    return this.decodeServerMutation(
      'mcp_update_server',
      {
        server_name: expected,
        ...(updates.type === undefined ? {} : { type: validateInput(updates.type, 'type') }),
        ...(updates.params === undefined ? {} : { params: updates.params }),
        ...(updates.serverOptions === undefined ? {} : { server_options: updates.serverOptions }),
      },
      expected
    );
  }

  async deleteServer(serverName: string): Promise<void> {
    const expected = validateInput(serverName, 'serverName');
    const raw = record(await this.rpc.request('mcp_delete_server', { server_name: expected }), 'mcp_delete_server');
    if (
      !boolean(raw.ok, 'mcp_delete_server.ok') ||
      nonEmptyString(raw.server_name, 'mcp_delete_server.server_name') !== expected
    ) {
      throw new McpManagementProtocolError('mcp_delete_server returned an invalid result');
    }
  }

  async reloadServer(serverName?: string): Promise<number> {
    const raw = record(
      await this.rpc.request(
        'mcp_reload_server',
        serverName === undefined ? {} : { server_name: validateInput(serverName, 'serverName') }
      ),
      'mcp_reload_server'
    );
    if (!boolean(raw.ok, 'mcp_reload_server.ok')) {
      throw new McpManagementProtocolError('mcp_reload_server failed');
    }
    return count(raw.reloaded_sessions, 'mcp_reload_server.reloaded_sessions');
  }

  async startAuth(
    serverName: string,
    options: { redirectUri?: string; sessionId?: string } = {}
  ): Promise<McpAuthState> {
    const expected = validateInput(serverName, 'serverName');
    return decodeAuthState(
      await this.rpc.request('mcp_auth_start', {
        server_name: expected,
        ...(options.redirectUri === undefined
          ? {}
          : { redirect_uri: validateInput(options.redirectUri, 'redirectUri') }),
        ...(options.sessionId === undefined ? {} : { session_id: validateInput(options.sessionId, 'sessionId') }),
      }),
      'mcp_auth_start',
      expected
    );
  }

  async completeAuth(authId: string, code: string): Promise<McpAuthState> {
    return decodeAuthState(
      await this.rpc.request('mcp_auth_complete', {
        auth_id: validateInput(authId, 'authId'),
        code: validateInput(code, 'code'),
      }),
      'mcp_auth_complete'
    );
  }

  async cancelAuth(authId: string): Promise<boolean> {
    return boolean(
      await this.rpc.request('mcp_auth_cancel', { auth_id: validateInput(authId, 'authId') }),
      'mcp_auth_cancel result'
    );
  }

  async readResource(serverName: string, uri: string, sessionId?: string): Promise<Record<string, unknown>> {
    this.requireExperimentalOperation('mcp_read_resource');
    const expected = validateInput(serverName, 'serverName');
    const expectedUri = validateInput(uri, 'uri');
    const raw = record(
      await this.rpc.request('mcp_read_resource', {
        server_name: expected,
        uri: expectedUri,
        ...(sessionId === undefined ? {} : { session_id: validateInput(sessionId, 'sessionId') }),
      }),
      'mcp_read_resource'
    );
    this.assertOperationIdentity(raw, expected, 'mcp_read_resource');
    if (nonEmptyString(raw.uri, 'mcp_read_resource.uri') !== expectedUri) {
      throw new McpManagementProtocolError('resource URI mismatch');
    }
    return { ...raw, contents: array(raw.contents, record, 'mcp_read_resource.contents') };
  }

  async callTool(
    serverName: string,
    toolName: string,
    sessionId: string,
    args?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    this.requireExperimentalOperation('mcp_call_tool');
    const expected = validateInput(serverName, 'serverName');
    const expectedTool = validateInput(toolName, 'toolName');
    const raw = record(
      await this.rpc.request('mcp_call_tool', {
        server_name: expected,
        tool_name: expectedTool,
        session_id: validateInput(sessionId, 'sessionId'),
        ...(args === undefined ? {} : { args }),
      }),
      'mcp_call_tool'
    );
    this.assertOperationIdentity(raw, expected, 'mcp_call_tool');
    if (nonEmptyString(raw.tool_name, 'mcp_call_tool.tool_name') !== expectedTool) {
      throw new McpManagementProtocolError('tool name mismatch');
    }
    return { ...raw, result: record(raw.result, 'mcp_call_tool.result') };
  }

  async getPrompt(
    serverName: string,
    promptName: string,
    options: { args?: Record<string, unknown>; sessionId?: string } = {}
  ): Promise<Record<string, unknown>> {
    this.requireExperimentalOperation('mcp_get_prompt');
    const expected = validateInput(serverName, 'serverName');
    const expectedPrompt = validateInput(promptName, 'promptName');
    const raw = record(
      await this.rpc.request('mcp_get_prompt', {
        server_name: expected,
        prompt_name: expectedPrompt,
        ...(options.args === undefined ? {} : { args: options.args }),
        ...(options.sessionId === undefined ? {} : { session_id: validateInput(options.sessionId, 'sessionId') }),
      }),
      'mcp_get_prompt'
    );
    this.assertOperationIdentity(raw, expected, 'mcp_get_prompt');
    if (nonEmptyString(raw.prompt_name, 'mcp_get_prompt.prompt_name') !== expectedPrompt) {
      throw new McpManagementProtocolError('prompt name mismatch');
    }
    return { ...raw, result: record(raw.result, 'mcp_get_prompt.result') };
  }

  private async decodeServerMutation<Method extends 'mcp_create_server' | 'mcp_update_server'>(
    method: Method,
    params: RpcMethodMap[Method]['params'],
    expectedServerName: string
  ): Promise<McpServerSnapshot> {
    const raw = record(await this.rpc.request(method, params), method);
    if (!boolean(raw.ok, `${method}.ok`)) {
      throw new McpManagementProtocolError(`${method} failed`);
    }
    const server = decodeSnapshot(raw.server, `${method}.server`);
    if (server.server_name !== expectedServerName) {
      throw new McpManagementProtocolError(`${method} returned another server`);
    }
    return server;
  }

  private assertOperationIdentity(raw: Record<string, unknown>, expected: string, label: string): void {
    if (nonEmptyString(raw.server_name, `${label}.server_name`) !== expected) {
      throw new McpManagementProtocolError(`${label} returned another server`);
    }
  }

  private requireExperimentalOperation(operation: string): void {
    if (!this.supportsExperimentalOperation(operation)) {
      throw new McpManagementProtocolError(`${operation} was not negotiated for this connection`);
    }
  }
}
