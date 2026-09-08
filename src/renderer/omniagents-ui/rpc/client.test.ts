import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OmniagentsRpcError } from './client';
import { EXPERIMENTAL_FEATURE_MANIFESTS, RPCClient, WORKSPACE_EXPERIMENTAL_OPERATIONS } from './client';

type InitializeRequest = {
  id: number;
  method: 'initialize';
  params: {
    protocol_version: string;
    identity: { name: string; version: string };
    platform: { os: string; arch: string };
    capabilities: {
      experimental_operations: string[];
      [key: string]: unknown;
    };
  };
};

const initializeResult = (request: InitializeRequest) => ({
  protocol_version: '2.0.0',
  identity: { name: 'omniagents', version: '1.0.0' },
  platform: { os: 'linux', arch: 'x86_64' },
  capabilities: request.params.capabilities,
  agent_host: { agent_host_id: 'test-host' },
});

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: MockWebSocket[] = [];
  static autoInitialize = true;

  readyState = MockWebSocket.CONNECTING;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  private listeners = new Map<string, Set<() => void>>();

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(event: string, listener: () => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeEventListener(event: string, listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    for (const listener of this.listeners.get('open') ?? []) {
      listener();
    }
  }

  send(payload: string): void {
    this.sent.push(payload);
    const request = JSON.parse(payload) as { method?: string };
    if (request.method === 'initialize' && MockWebSocket.autoInitialize) {
      queueMicrotask(() => {
        const initialize = request as InitializeRequest;
        this.receive({ jsonrpc: '2.0', id: initialize.id, result: initializeResult(initialize) });
      });
    }
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  close(): void {
    this.readyState = 3;
  }
}

async function connectedClient(): Promise<{ client: RPCClient; socket: MockWebSocket }> {
  const client = new RPCClient('ws://example.test/ws');
  const connection = client.connect();
  const socket = MockWebSocket.instances.at(-1)!;
  socket.open();
  await connection;
  // Most tests below exercise post-connect calls. Handshake ordering has
  // dedicated assertions and request ids intentionally remain monotonic.
  socket.sent.length = 0;
  return { client, socket };
}

describe('RPCClient GUI protocol handshake', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    MockWebSocket.autoInitialize = true;
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    MockWebSocket.autoInitialize = true;
    vi.unstubAllGlobals();
  });

  it.each(['helper', 'raw'] as const)(
    'keeps %s compaction pending beyond 20 minutes while probes succeed',
    async (entry) => {
      vi.useFakeTimers();
      const { client, socket } = await connectedClient();
      try {
        const send = socket.send.bind(socket);
        vi.spyOn(socket, 'send').mockImplementation((payload) => {
          send(payload);
          const request = JSON.parse(payload);
          if (request.method === 'get_agent_info') {
            queueMicrotask(() => socket.receive({ jsonrpc: '2.0', id: request.id, result: {} }));
          }
        });
        const pending =
          entry === 'helper'
            ? client.serverCall('compact', {}, 'session-1')
            : client.request('server_call', { function: 'compact', session_id: 'session-1' });
        let settled = false;
        void pending.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          }
        );
        const request = JSON.parse(socket.sent[0]!);
        await vi.advanceTimersByTimeAsync(21 * 60_000);
        expect(settled).toBe(false);
        expect(client.isConnected).toBe(true);
        expect(socket.sent.filter((row) => JSON.parse(row).method === 'get_agent_info').length).toBeGreaterThan(1);
        socket.receive({ jsonrpc: '2.0', id: request.id, result: { ok: true } });
        await expect(pending).resolves.toEqual({ ok: true });
      } finally {
        client.dispose();
        vi.useRealTimers();
      }
    }
  );

  it('cannot reopen a permanently retired client from late async work', async () => {
    const { client, socket } = await connectedClient();
    client.dispose();
    await expect(client.connect()).rejects.toThrow('disposed');
    await expect(client.connectAndWait()).rejects.toThrow('disposed');
    await expect(client.getAgentInfo()).rejects.toThrow('not connected');
    expect(socket.readyState).toBe(3);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(client.actor.getSnapshot().status).toBe('stopped');
  });

  it('retires a silent open socket without resending pending mutations', async () => {
    vi.useFakeTimers();
    const { client, socket } = await connectedClient();
    try {
      const pending = client.request('set_session_model', { session_id: 'A', model: 'model' }, { timeoutMs: null });
      const rejected = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(40_001);
      expect(client.isConnected).toBe(false);
      expect(socket.readyState).toBe(3);
      await rejected;
      expect(socket.sent.filter((s) => JSON.parse(s).method === 'set_session_model')).toHaveLength(1);
      expect(socket.sent.filter((s) => JSON.parse(s).method === 'get_agent_info')).toHaveLength(1);
    } finally {
      client.dispose();
      vi.useRealTimers();
    }
  });

  it('can check liveness even when every ordinary request slot is occupied', async () => {
    vi.useFakeTimers();
    const { client, socket } = await connectedClient();
    try {
      const pending = Array.from({ length: 100 }, () =>
        client.request('get_agent_info', {}, { timeoutMs: null }).catch((error) => error)
      );
      await vi.advanceTimersByTimeAsync(40_001);
      expect(client.isConnected).toBe(false);
      expect(socket.readyState).toBe(3);
      await Promise.all(pending);
    } finally {
      client.dispose();
      vi.useRealTimers();
    }
  });

  it.each([401, 403])('parks rejected credentials (%s) instead of retrying them forever', async (status) => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue({ ok: false, status });
    vi.stubGlobal('fetch', fetch);
    const client = new RPCClient('ws://example.test/ws', 'expired');
    try {
      await expect(client.connect()).rejects.toThrow(`Authentication failed (${status})`);
      expect(client.actor.getSnapshot().context.permanent).toBe(true);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(MockWebSocket.instances).toHaveLength(0);
    } finally {
      client.dispose();
      vi.useRealTimers();
    }
  });

  it('keeps temporary ticket-service failures retryable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const client = new RPCClient('ws://example.test/ws', 'valid-token');
    try {
      await expect(client.connect()).rejects.toThrow('Authentication failed (503)');
      expect(client.connectionState).toBe('reconnecting');
      expect(client.actor.getSnapshot().context.permanent).toBe(false);
    } finally {
      client.dispose();
    }
  });

  it('stops automatic recovery when credentials expire after a successful connection', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ticket: 'initial-ticket' }) })
      .mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal('fetch', fetch);
    const client = new RPCClient('ws://example.test/ws', 'expiring-token');
    try {
      const connected = client.connect();
      await vi.advanceTimersByTimeAsync(0);
      const socket = MockWebSocket.instances[0]!;
      socket.open();
      await connected;
      socket.close();
      socket.onclose?.({ code: 1006 });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(MockWebSocket.instances).toHaveLength(1);
      expect(client.connectionState).toBe('disconnected');
      expect(client.actor.getSnapshot().context.permanent).toBe(true);
    } finally {
      client.dispose();
      vi.useRealTimers();
    }
  });

  it('keeps a healthy idle connection and stops probes after disposal', async () => {
    vi.useFakeTimers();
    const { client, socket } = await connectedClient();
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      const probe = JSON.parse(socket.sent[0]!);
      expect(probe.method).toBe('get_agent_info');
      socket.receive({ jsonrpc: '2.0', id: probe.id, result: {} });
      await vi.advanceTimersByTimeAsync(10_001);
      expect(client.isConnected).toBe(true);
      client.dispose();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(socket.sent).toHaveLength(1);
      expect(MockWebSocket.instances).toHaveLength(1);
    } finally {
      client.dispose();
      vi.useRealTimers();
    }
  });

  it('keeps a slow application call pending when the liveness read succeeds', async () => {
    vi.useFakeTimers();
    const { client, socket } = await connectedClient();
    try {
      const pending = client.request('get_agent_info', {}, { timeoutMs: null });
      const original = JSON.parse(socket.sent[0]!);
      await vi.advanceTimersByTimeAsync(30_000);
      const probe = JSON.parse(socket.sent[1]!);
      socket.receive({ jsonrpc: '2.0', id: probe.id, result: {} });
      await vi.advanceTimersByTimeAsync(10_001);
      expect(client.isConnected).toBe(true);
      expect(client.actor.getSnapshot().context.pendingCount).toBe(1);
      socket.receive({ jsonrpc: '2.0', id: original.id, result: { name: 'late response' } });
      await expect(pending).resolves.toEqual({ name: 'late response' });
    } finally {
      client.dispose();
      vi.useRealTimers();
    }
  });

  it('does not let an old probe timeout retire a replacement connection', async () => {
    vi.useFakeTimers();
    const { client } = await connectedClient();
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      client.disconnect();
      const fresh = client.connect();
      const socket = MockWebSocket.instances.at(-1)!;
      socket.open();
      await fresh;
      await vi.advanceTimersByTimeAsync(10_001);
      expect(client.isConnected).toBe(true);
      expect(socket.readyState).toBe(1);
    } finally {
      client.dispose();
      vi.useRealTimers();
    }
  });

  it('aborts ticket acquisition and cannot open a socket after disposal', async () => {
    let release!: (response: unknown) => void;
    const fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    vi.stubGlobal('fetch', fetch);
    const client = new RPCClient('ws://example.test/ws', 'ordinary-token');
    const pending = client.connect();
    const rejection = expect(pending).rejects.toThrow('disconnected');
    client.dispose();
    await rejection;
    expect((fetch.mock.calls[0] as any)[1].signal.aborted).toBe(true);
    // A transport which ignores AbortSignal still must not resurrect a dial.
    release({ ok: true, json: async () => ({ ticket: 'late-ticket' }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('does not let a retired ticket attempt close its replacement', async () => {
    let rejectOld!: (reason: Error) => void;
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectOld = reject;
          })
      )
      .mockResolvedValue({ ok: true, json: async () => ({ ticket: 'new-ticket' }) });
    vi.stubGlobal('fetch', fetch);
    const client = new RPCClient('ws://example.test/ws', 'ordinary-token');
    const old = client.connect();
    const rejection = expect(old).rejects.toThrow('disconnected');
    client.disconnect();
    const fresh = client.connect();
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0]!;
    socket.open();
    await fresh;
    await rejection;
    rejectOld(new Error('old request failed late'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.isConnected).toBe(true);
    expect(socket.readyState).toBe(MockWebSocket.OPEN);
    client.dispose();
  });

  it('coalesces a reentrant reconnect callback before starting its dial', async () => {
    const { client } = await connectedClient();
    client.actor.send({ type: 'WS_ERROR', error: 'temporary outage' });
    expect(client.actor.getSnapshot().context.reconnectAttempt).toBeGreaterThan(0);
    client.disconnect();
    const pending = client.connect();
    expect(MockWebSocket.instances).toHaveLength(2);
    MockWebSocket.instances[1]!.open();
    await pending;
    expect(client.isConnected).toBe(true);
    client.dispose();
  });

  it.each(['1.0.0', '3.0.0', 'invalid'])(
    'rejects false-success %s before events, replay or initialized',
    async (version) => {
      MockWebSocket.autoInitialize = false;
      const client = new RPCClient('ws://example.test/ws');
      const event = vi.fn();
      client.on('message_output', event);
      const connection = client.connect();
      const rejected = expect(connection).rejects.toMatchObject({ code: -32012 });
      const socket = MockWebSocket.instances[0]!;
      socket.open();
      await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
      const request = JSON.parse(socket.sent[0]!) as InitializeRequest;
      socket.receive({ jsonrpc: '2.0', method: 'message_output', params: { content: 'untrusted' } });
      socket.receive({
        jsonrpc: '2.0',
        id: request.id,
        result: { ...initializeResult(request), protocol_version: version },
      });
      await rejected;
      expect(event).not.toHaveBeenCalled();
      expect(client.initializeResult).toBeNull();
      expect(client.actor.getSnapshot().context.permanent).toBe(true);
      expect(socket.sent.map((frame) => JSON.parse(frame).method)).toEqual(['initialize']);
      client.dispose();
    }
  );

  it('sends initialize then initialized before connect resolves', async () => {
    MockWebSocket.autoInitialize = false;
    const client = new RPCClient('ws://example.test/ws');
    let connected = false;
    const connection = client.connect().then(() => {
      connected = true;
    });
    const socket = MockWebSocket.instances[0]!;

    socket.open();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    const initialize = JSON.parse(socket.sent[0]!) as InitializeRequest;
    expect(connected).toBe(false);
    expect(client.connectionState).toBe('connecting');
    expect(initialize).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocol_version: '2.0.0',
        identity: { name: 'omni-desktop', version: '1.0.0' },
        platform: { os: 'browser', arch: 'unknown' },
        capabilities: {
          realtime: true,
          mcp_apps: true,
          client_functions: true,
          approvals: true,
          artifacts: true,
          replay: true,
          terminal: true,
          experimental_operations: [...WORKSPACE_EXPERIMENTAL_OPERATIONS],
          disabled_notifications: [],
        },
      },
    });

    socket.receive({ jsonrpc: '2.0', id: initialize.id, result: initializeResult(initialize) });
    await connection;

    expect(socket.sent.map((frame) => JSON.parse(frame))).toEqual([
      initialize,
      { jsonrpc: '2.0', method: 'initialized', params: {} },
    ]);
    expect(client.isConnected).toBe(true);
    expect(client.initializeResult).toEqual(initializeResult(initialize));
    expect(initialize.params.capabilities.experimental_operations).toContain('get_config');
    expect(initialize.params.capabilities.experimental_operations).not.toContain('validate_config');
    expect(initialize.params.capabilities.experimental_operations).not.toContain('write_config');
    expect(EXPERIMENTAL_FEATURE_MANIFESTS.conversationOrganization).toEqual([
      'list_threads',
      'search_threads',
      'update_thread',
      'thread_updated',
    ]);
    expect(EXPERIMENTAL_FEATURE_MANIFESTS.plansAndDiffs).toEqual(['get_plan', 'get_run_diff', 'item_updated']);
    expect(initialize.params.capabilities.experimental_operations).not.toContain('fork_session');
    expect(initialize.params.capabilities.experimental_operations).not.toContain('export_thread');
    expect(initialize.params.capabilities.experimental_operations).not.toContain('purge_threads');
    client.dispose();
  });

  it('exposes typed requests and handshake-level connection state changes', async () => {
    const client = new RPCClient('ws://example.test/ws');
    const states: string[] = [];
    const unsubscribe = client.onConnectionState((state) => states.push(state));
    const connection = client.connect();
    const socket = MockWebSocket.instances[0]!;
    socket.open();
    await connection;

    const request = client.request('fs_stat', { environment_id: 'environment', path: '.' });
    const frame = JSON.parse(socket.sent.at(-1)!) as { id: number; method: string; params: unknown };
    expect(frame).toMatchObject({ method: 'fs_stat', params: { environment_id: 'environment', path: '.' } });
    socket.receive({ jsonrpc: '2.0', id: frame.id, result: { path: '.', type: 'directory' } });

    await expect(request).resolves.toEqual({ path: '.', type: 'directory' });
    expect(states).toEqual(['disconnected', 'connecting', 'connected']);
    unsubscribe();
    client.dispose();
  });

  it('addresses start_run with an explicit environment selection', async () => {
    const { client, socket } = await connectedClient();

    const pending = client.startRun(
      'inspect the project',
      {
        mode: 'explicit',
        environment_id: 'environment-1',
        environment_generation: 4,
      },
      'session-1'
    );
    const frame = JSON.parse(socket.sent.at(-1)!) as {
      id: number;
      method: string;
      params: unknown;
    };
    expect(frame).toMatchObject({
      method: 'start_run',
      params: {
        prompt: 'inspect the project',
        session_id: 'session-1',
        environment_selection: {
          mode: 'explicit',
          environment_id: 'environment-1',
          environment_generation: 4,
        },
      },
    });
    socket.receive({
      jsonrpc: '2.0',
      id: frame.id,
      result: { run_id: 'run-1', session_id: 'session-1' },
    });

    await expect(pending).resolves.toEqual({
      run_id: 'run-1',
      session_id: 'session-1',
    });
    client.dispose();
  });

  it('does not allow public fs/git requests onto a raw-open socket before initialized', async () => {
    MockWebSocket.autoInitialize = false;
    const client = new RPCClient('ws://example.test/ws');
    const connection = client.connect();
    const socket = MockWebSocket.instances[0]!;
    socket.open();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    await expect(client.request('fs_stat', { environment_id: 'environment', path: '.' })).rejects.toThrow(
      'handshake is not complete'
    );
    await expect(client.request('git_status', { environment_id: 'environment', repo: '.' })).rejects.toThrow(
      'handshake is not complete'
    );
    expect(socket.sent.map((frame) => JSON.parse(frame).method)).toEqual(['initialize']);

    const initialize = JSON.parse(socket.sent[0]!) as InitializeRequest;
    socket.receive({ jsonrpc: '2.0', id: initialize.id, result: initializeResult(initialize) });
    await connection;
    expect(socket.sent.map((frame) => JSON.parse(frame).method)).toEqual(['initialize', 'initialized']);
    client.dispose();
  });

  it('retries without explicitly unsupported experimental operations', async () => {
    MockWebSocket.autoInitialize = false;
    const client = new RPCClient('ws://example.test/ws');
    const connection = client.connect();
    const socket = MockWebSocket.instances[0]!;
    socket.open();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    const first = JSON.parse(socket.sent[0]!) as InitializeRequest;
    socket.receive({
      jsonrpc: '2.0',
      id: first.id,
      error: {
        code: -32013,
        message: 'Unsupported experimental capabilities',
        data: { kind: 'capability_not_negotiated', unsupported_capabilities: ['git_push'] },
      },
    });

    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    const second = JSON.parse(socket.sent[1]!) as InitializeRequest;
    expect(first.params.capabilities.experimental_operations).toContain('git_push');
    expect(second.params.capabilities.experimental_operations).not.toContain('git_push');
    expect(second.params.capabilities.experimental_operations).toHaveLength(
      WORKSPACE_EXPERIMENTAL_OPERATIONS.length - 1
    );

    socket.receive({ jsonrpc: '2.0', id: second.id, result: initializeResult(second) });
    await connection;

    expect(JSON.parse(socket.sent[2]!)).toEqual({ jsonrpc: '2.0', method: 'initialized', params: {} });
    expect(client.degradedExperimentalOperations).toEqual(['git_push']);
    expect(client.supportsExperimentalOperation('git_push')).toBe(false);
    expect(client.supportsExperimentalOperation('fs_stat')).toBe(true);
    client.dispose();
  });

  it('gates experimental features atomically when a required notification is unsupported', async () => {
    MockWebSocket.autoInitialize = false;
    const client = new RPCClient('ws://example.test/ws');
    const connection = client.connect();
    const socket = MockWebSocket.instances[0]!;
    socket.open();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    const first = JSON.parse(socket.sent[0]!) as InitializeRequest;
    socket.receive({
      jsonrpc: '2.0',
      id: first.id,
      error: {
        code: -32013,
        message: 'Unsupported experimental capabilities',
        data: { kind: 'capability_not_negotiated', unsupported_capabilities: ['item_updated'] },
      },
    });

    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    const second = JSON.parse(socket.sent[1]!) as InitializeRequest;
    expect(second.params.capabilities.experimental_operations).toContain('get_plan');
    expect(second.params.capabilities.experimental_operations).toContain('get_run_diff');
    expect(second.params.capabilities.experimental_operations).not.toContain('item_updated');
    socket.receive({ jsonrpc: '2.0', id: second.id, result: initializeResult(second) });
    await connection;

    expect(client.supportsExperimentalFeature('plansAndDiffs')).toBe(false);
    expect(client.supportsExperimentalFeature('conversationOrganization')).toBe(true);
    expect(client.degradedExperimentalOperations).toEqual(['item_updated']);
    client.dispose();
  });

  it('does not degrade an unrelated capability mismatch', async () => {
    MockWebSocket.autoInitialize = false;
    const client = new RPCClient('ws://example.test/ws');
    const connection = client.connect();
    const socket = MockWebSocket.instances[0]!;
    socket.open();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    const initialize = JSON.parse(socket.sent[0]!) as InitializeRequest;
    socket.receive({
      jsonrpc: '2.0',
      id: initialize.id,
      error: {
        code: -32013,
        message: 'A mandatory notification cannot be disabled',
        data: { kind: 'mandatory_capability_disabled', disabled: ['run_started'] },
      },
    });

    await expect(connection).rejects.toMatchObject({
      name: 'OmniagentsRpcError',
      code: -32013,
      message: 'A mandatory notification cannot be disabled',
    });
    expect(socket.sent).toHaveLength(1);
    expect(client.initializeResult).toBeNull();
    client.dispose();
  });

  it('bounds the whole socket plus initialize attempt and closes the timed-out transport', async () => {
    vi.useFakeTimers();
    const client = new RPCClient('ws://example.test/ws');
    try {
      const connection = client.connect();
      const socket = MockWebSocket.instances[0]!;
      const rejection = expect(connection).rejects.toMatchObject({
        name: 'RpcTimeoutError',
        method: 'initialize',
        timeoutMs: 10_000,
      });

      await vi.advanceTimersByTimeAsync(10_001);

      await rejection;
      expect(socket.readyState).toBe(3);
    } finally {
      client.dispose();
      vi.useRealTimers();
    }
  });
});

describe('RPCClient generated protocol integration', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    MockWebSocket.autoInitialize = true;
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps conversation and execution identities separate in server_call', async () => {
    const { client, socket } = await connectedClient();
    const response = client.serverCall('bash_jobs.list', {}, 'session-1', {
      workspaceId: 'workspace-1',
      environmentId: 'environment-1',
      environmentGeneration: 3,
    });
    const request = JSON.parse(socket.sent[0]!) as Record<string, unknown>;

    expect(request).toEqual({
      jsonrpc: '2.0',
      id: 2,
      method: 'server_call',
      params: {
        function: 'bash_jobs.list',
        args: {},
        session_id: 'session-1',
        workspace_id: 'workspace-1',
        environment_id: 'environment-1',
        environment_generation: 3,
      },
    });

    socket.receive({ jsonrpc: '2.0', id: request.id, result: { snapshot: [] } });
    await expect(response).resolves.toEqual({ snapshot: [] });
    client.dispose();
  });

  it('omits params for methods whose canonical params are all optional', async () => {
    const { client, socket } = await connectedClient();
    const response = client.listSessions();
    const request = JSON.parse(socket.sent[0]!) as { id: number; params?: unknown };

    expect(request).not.toHaveProperty('params');
    socket.receive({ jsonrpc: '2.0', id: request.id, result: [] });
    await expect(response).resolves.toEqual([]);
    client.dispose();
  });

  it('uses typed MCP resource and tool operations with their exact generated params', async () => {
    const { client, socket } = await connectedClient();

    const resource = client.mcpReadResource('github', 'file:///readme', 'session-1');
    const resourceFrame = JSON.parse(socket.sent.at(-1)!) as Record<string, unknown>;
    expect(resourceFrame).toEqual({
      jsonrpc: '2.0',
      id: 2,
      method: 'mcp_read_resource',
      params: { server_name: 'github', uri: 'file:///readme', session_id: 'session-1' },
    });
    socket.receive({
      jsonrpc: '2.0',
      id: resourceFrame.id,
      result: { server_name: 'github', uri: 'file:///readme', contents: [{ text: 'hello' }] },
    });
    await expect(resource).resolves.toEqual({
      server_name: 'github',
      uri: 'file:///readme',
      contents: [{ text: 'hello' }],
    });

    const tool = client.mcpCallTool('github', 'open_issue', { title: 'Bug' }, 'session-1');
    const toolFrame = JSON.parse(socket.sent.at(-1)!) as Record<string, unknown>;
    expect(toolFrame).toEqual({
      jsonrpc: '2.0',
      id: 3,
      method: 'mcp_call_tool',
      params: {
        server_name: 'github',
        tool_name: 'open_issue',
        session_id: 'session-1',
        args: { title: 'Bug' },
      },
    });
    socket.receive({
      jsonrpc: '2.0',
      id: toolFrame.id,
      result: { server_name: 'github', tool_name: 'open_issue', result: { content: [] } },
    });
    await expect(tool).resolves.toEqual({
      server_name: 'github',
      tool_name: 'open_issue',
      result: { content: [] },
    });
    client.dispose();
  });

  it('rejects malformed typed MCP results and a missing call-tool session locally', async () => {
    const { client, socket } = await connectedClient();

    const missingSession = client.mcpCallTool('github', 'open_issue', {});
    await expect(missingSession).rejects.toThrow('sessionId must be a non-empty string');
    expect(socket.sent).toHaveLength(0);

    const resource = client.mcpReadResource('github', 'file:///readme', 'session-1');
    const resourceFrame = JSON.parse(socket.sent.at(-1)!) as Record<string, unknown>;
    socket.receive({
      jsonrpc: '2.0',
      id: resourceFrame.id,
      result: { server_name: 'github', uri: 'file:///readme', contents: 'not-an-array' },
    });
    await expect(resource).rejects.toThrow('mcp_read_resource.contents must be an array');

    const tool = client.mcpCallTool('github', 'open_issue', {}, 'session-1');
    const toolFrame = JSON.parse(socket.sent.at(-1)!) as Record<string, unknown>;
    socket.receive({
      jsonrpc: '2.0',
      id: toolFrame.id,
      result: { server_name: 'github', tool_name: 'open_issue', result: [] },
    });
    await expect(tool).rejects.toThrow('mcp_call_tool.result must be an object');
    client.dispose();
  });

  it('rejects an unnegotiated typed MCP operation without sending a request', async () => {
    MockWebSocket.autoInitialize = false;
    const client = new RPCClient('ws://example.test/ws');
    const connection = client.connect();
    const socket = MockWebSocket.instances[0]!;
    socket.open();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    const first = JSON.parse(socket.sent[0]!) as InitializeRequest;
    socket.receive({
      jsonrpc: '2.0',
      id: first.id,
      error: {
        code: -32013,
        message: 'Unsupported experimental capabilities',
        data: { kind: 'capability_not_negotiated', unsupported_capabilities: ['mcp_call_tool'] },
      },
    });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    const second = JSON.parse(socket.sent[1]!) as InitializeRequest;
    socket.receive({ jsonrpc: '2.0', id: second.id, result: initializeResult(second) });
    await connection;
    socket.sent.length = 0;

    await expect(client.mcpCallTool('github', 'open_issue', {}, 'session-1')).rejects.toThrow(
      'mcp_call_tool was not negotiated for this connection'
    );
    expect(socket.sent).toHaveLength(0);
    client.dispose();
  });

  it('preserves structured JSON-RPC error code and data', async () => {
    const { client, socket } = await connectedClient();
    const response = client.getSessionHistory('session-1');
    const request = JSON.parse(socket.sent[0]!) as Record<string, unknown>;

    socket.receive({
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32602,
        message: 'Invalid params',
        data: { method: 'get_session_history' },
      },
    });

    await expect(response).rejects.toMatchObject({
      name: 'OmniagentsRpcError',
      code: -32602,
      message: 'Invalid params',
      data: { method: 'get_session_history' },
    } satisfies Partial<OmniagentsRpcError>);
    client.dispose();
  });

  it('supports per-call deadlines and AbortSignal cleanup without retrying', async () => {
    const { client, socket } = await connectedClient();

    const timedOut = client.request('fs_stat', { environment_id: 'environment', path: 'slow' }, { timeoutMs: 5 });
    await expect(timedOut).rejects.toMatchObject({ name: 'RpcTimeoutError', method: 'fs_stat', timeoutMs: 5 });
    expect(client.actor.getSnapshot().context.pendingCount).toBe(0);

    const controller = new AbortController();
    const aborted = client.request(
      'fs_stat',
      { environment_id: 'environment', path: 'cancelled' },
      { timeoutMs: null, signal: controller.signal }
    );
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'RpcAbortError', method: 'fs_stat' });
    expect(client.actor.getSnapshot().context.pendingCount).toBe(0);
    expect(socket.sent.filter((frame) => JSON.parse(frame).method === 'fs_stat')).toHaveLength(2);
    client.dispose();
  });

  it('classifies permanent close metadata and rejects pending calls structurally', async () => {
    const { client, socket } = await connectedClient();
    const pending = client.getSessionHistory('session-1');

    socket.onclose?.({ code: 4401, reason: 'credentials rejected' });

    await expect(pending).rejects.toMatchObject({
      name: 'ConnectionClosedError',
      permanent: true,
      closeCode: 4401,
      reason: 'credentials rejected',
    });
    expect(client.actor.getSnapshot().context).toMatchObject({
      permanent: true,
      closeCode: 4401,
      error: 'credentials rejected',
    });
    expect(client.connectionState).toBe('disconnected');
    client.dispose();
  });

  it.each([
    [false, 'no longer pending'],
    [null, 'did not confirm'],
  ])('rejects an unaccepted client response (%s) instead of clearing the answer as sent', async (value, message) => {
    const { client, socket } = await connectedClient();
    const response = client.clientResponse('expired-question', true, { reply: 'keep this answer' });
    const assertion = expect(response).rejects.toThrow(String(message));
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const frame = JSON.parse(socket.sent[0]!);
    socket.receive({ jsonrpc: '2.0', id: frame.id, result: value });
    await assertion;
    client.dispose();
  });

  it('correlates no-id client_request through params.request_id', async () => {
    const { client, socket } = await connectedClient();
    client.on('client_request', (params) => {
      void client.clientResponse(params.request_id, true, { acknowledged: true });
    });

    socket.receive({
      jsonrpc: '2.0',
      method: 'client_request',
      params: {
        request_id: 'request-1',
        function: 'ui.test',
        args: {},
      },
    });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    const response = JSON.parse(socket.sent[0]!) as { id: number };
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      method: 'client_response',
      params: {
        request_id: 'request-1',
        ok: true,
        result: { acknowledged: true },
      },
    });
    socket.receive({ jsonrpc: '2.0', id: response.id, result: true });
    await vi.waitFor(() => expect(client.actor.getSnapshot().context.pendingCount).toBe(0));
    client.dispose();
  });
});

// ---------------------------------------------------------------------------
// Durable sequenced event replay at the dispatch point
// (protocol.md § "Durable Sequenced Event Replay", omniagents PR #295)
// ---------------------------------------------------------------------------

describe('RPCClient durable event replay', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const notify = (socket: MockWebSocket, method: string, params: Record<string, unknown>) => {
    socket.receive({ jsonrpc: '2.0', method, params });
  };

  const envelope = (seq: number, extra: Record<string, unknown> = {}, streamId = 'stream-1') => ({
    session_id: 's',
    stream_id: streamId,
    seq,
    ...extra,
  });

  const sentRequests = (socket: MockWebSocket, method: string) =>
    socket.sent
      .map((raw) => JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> })
      .filter((req) => req.method === method);

  it('drops duplicate deliveries by (stream_id, seq) before dispatch', async () => {
    const { client, socket } = await connectedClient();
    const seen: unknown[] = [];
    client.on('message_output', (p: any) => seen.push(p.seq));

    notify(socket, 'message_output', envelope(1, { content: 'a' }));
    notify(socket, 'message_output', envelope(1, { content: 'a' }));
    notify(socket, 'message_output', envelope(2, { content: 'b' }));
    notify(socket, 'message_output', envelope(2, { content: 'b' }));

    expect(seen).toEqual([1, 2]);
    client.dispose();
  });

  it('never re-executes a client function for a replayed client_request', async () => {
    const { client, socket } = await connectedClient();
    const invocations: string[] = [];
    client.on('client_request', (p: any) => invocations.push(p.request_id));

    const params = envelope(1, { request_id: 'request-1', function: 'ui.test', args: {} });
    notify(socket, 'client_request', params);
    notify(socket, 'client_request', params);

    expect(invocations).toEqual(['request-1']);
    client.dispose();
  });

  it('routes sequenced elicitation notifications through the shared interaction queue', async () => {
    const { client, socket } = await connectedClient();
    const changes: string[] = [];
    client.elicitations.onChange((event) => changes.push(event.type));

    notify(
      socket,
      'elicitation_requested',
      envelope(1, {
        elicitation_id: 'elicit-1',
        kind: 'question',
        message: 'Which environment?',
      })
    );

    expect(client.elicitations.get('elicit-1')).toMatchObject({
      kind: 'question',
      sessionId: 's',
      message: 'Which environment?',
    });
    expect(changes).toEqual(['requested']);

    const response = client.elicitations.respond('elicit-1', {
      action: 'accept',
      value: { text: 'staging' },
    });
    const frame = sentRequests(socket, 'elicitation_response')[0]!;
    expect(frame.params).toEqual({
      elicitation_id: 'elicit-1',
      action: 'accept',
      value: { text: 'staging' },
    });
    socket.receive({ jsonrpc: '2.0', id: frame.id, result: { status: 'accepted' } });

    await expect(response).resolves.toMatchObject({ status: 'accepted', won: true });
    expect(client.elicitations.get('elicit-1')).toBeUndefined();
    expect(changes).toEqual(['requested', 'removed']);
    client.dispose();
  });

  it('passes transient events (no seq) through untouched', async () => {
    const { client, socket } = await connectedClient();
    const seen: unknown[] = [];
    client.on('token', (p: any) => seen.push(p.session_id));

    notify(socket, 'token', { session_id: 's', delta: {} });
    notify(socket, 'token', { session_id: 's', delta: {} });

    expect(seen).toEqual(['s', 's']);
    client.dispose();
  });

  it('backfills a gap via resume_session and flushes the buffered live event', async () => {
    const { client, socket } = await connectedClient();
    const seen: Array<[string, unknown]> = [];
    client.on('message_output', (p: any) => seen.push(['message_output', p.seq]));
    client.on('tool_called', (p: any) => seen.push(['tool_called', p.seq]));
    client.on('tool_result', (p: any) => seen.push(['tool_result', p.seq]));

    notify(socket, 'message_output', envelope(1, { content: 'a' }));
    // seq 4 arrives next: gap — the client must hold it and backfill.
    notify(socket, 'message_output', envelope(4, { content: 'd' }));

    await vi.waitFor(() => expect(sentRequests(socket, 'resume_session')).toHaveLength(1));
    const resume = sentRequests(socket, 'resume_session')[0]!;
    expect(resume.params).toEqual({ session_id: 's', stream_id: 'stream-1', after_seq: 1 });

    socket.receive({
      jsonrpc: '2.0',
      id: resume.id,
      result: {
        session_id: 's',
        stream_id: 'stream-1',
        last_seq: 4,
        events: [
          { method: 'tool_called', params: envelope(2, { call_id: 'c1', tool: 't' }) },
          { method: 'tool_result', params: envelope(3, { call_id: 'c1', tool: 't' }) },
          { method: 'message_output', params: envelope(4, { content: 'd' }) },
        ],
      },
    });

    await vi.waitFor(() =>
      expect(seen).toEqual([
        ['message_output', 1],
        ['tool_called', 2],
        ['tool_result', 3],
        ['message_output', 4],
      ])
    );
    client.dispose();
  });

  it('degrades to the resync fallback when resume_session rejects with -32030', async () => {
    const { client, socket } = await connectedClient();
    const seen: unknown[] = [];
    const resyncs: string[] = [];
    client.on('message_output', (p: any) => seen.push(p.seq));
    client.onResyncRequired((sessionId) => resyncs.push(sessionId));

    notify(socket, 'message_output', envelope(1, { content: 'a' }));
    notify(socket, 'message_output', envelope(5, { content: 'e' }));

    await vi.waitFor(() => expect(sentRequests(socket, 'resume_session')).toHaveLength(1));
    const resume = sentRequests(socket, 'resume_session')[0]!;
    socket.receive({
      jsonrpc: '2.0',
      id: resume.id,
      error: {
        code: -32030,
        message: 'Resync required',
        data: { kind: 'resync_required', session_id: 's', stream_id: 'stream-2' },
      },
    });

    await vi.waitFor(() => expect(resyncs).toEqual(['s']));
    // The held live event remains quarantined. Delivering it before the host
    // completes its authoritative reload could apply an event from a new
    // stream epoch onto stale state.
    expect(seen).toEqual([1]);
    client.dispose();
  });

  it('acks applied events once per debounce window with the latest cursor', async () => {
    const { client, socket } = await connectedClient();

    notify(socket, 'message_output', envelope(1, { content: 'a' }));
    notify(socket, 'message_output', envelope(2, { content: 'b' }));
    notify(socket, 'message_output', envelope(3, { content: 'c' }));

    await vi.waitFor(() => expect(sentRequests(socket, 'ack_events')).toHaveLength(1), { timeout: 2000 });
    const acks = sentRequests(socket, 'ack_events');
    expect(acks).toHaveLength(1);
    expect(acks[0]!.params).toEqual({ session_id: 's', stream_id: 'stream-1', seq: 3 });
    socket.receive({ jsonrpc: '2.0', id: acks[0]!.id, result: {} });
    await vi.waitFor(() => expect(client.actor.getSnapshot().context.pendingCount).toBe(0));
    client.dispose();
  });

  it('does not ack sessions that only produced transient events', async () => {
    const { client, socket } = await connectedClient();

    notify(socket, 'token', { session_id: 's', delta: {} });
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(sentRequests(socket, 'ack_events')).toHaveLength(0);
    client.dispose();
  });

  it('registers a selected cursorless session immediately from sequence zero', async () => {
    const { client, socket } = await connectedClient();

    const registration = client.registerSession('selected-session');
    await vi.waitFor(() => expect(sentRequests(socket, 'resume_session')).toHaveLength(1));
    const resume = sentRequests(socket, 'resume_session')[0]!;
    expect(resume.params).toEqual({ session_id: 'selected-session', after_seq: 0 });
    socket.receive({
      jsonrpc: '2.0',
      id: resume.id,
      result: { session_id: 'selected-session', stream_id: 'stream-selected', last_seq: 0, events: [] },
    });

    await registration;
    client.dispose();
  });

  it('routes ack_events -32030 through the same authoritative resync quarantine', async () => {
    const { client, socket } = await connectedClient();
    const resyncs: string[] = [];
    const seen: number[] = [];
    client.onResyncRequired((sessionId) => resyncs.push(sessionId));
    client.on('message_output', (params: any) => seen.push(params.seq));

    notify(socket, 'message_output', envelope(1, { content: 'a' }));
    await vi.waitFor(() => expect(sentRequests(socket, 'ack_events')).toHaveLength(1), { timeout: 2000 });
    const ack = sentRequests(socket, 'ack_events')[0]!;
    socket.receive({
      jsonrpc: '2.0',
      id: ack.id,
      error: { code: -32030, message: 'cursor compacted', data: { kind: 'resync_required' } },
    });

    await vi.waitFor(() => expect(resyncs).toEqual(['s']));
    notify(socket, 'message_output', envelope(2, { content: 'quarantined' }));
    expect(seen).toEqual([1]);
    client.dispose();
  });

  it('resumes tracked sessions from the stored cursor after a reconnect', async () => {
    const { client, socket } = await connectedClient();
    const seen: unknown[] = [];
    client.on('message_output', (p: any) => seen.push(p.seq));
    client.on('run_end', (p: any) => seen.push(p.seq));

    notify(socket, 'message_output', envelope(1, { content: 'a' }));
    notify(socket, 'message_output', envelope(2, { content: 'b' }));

    // Drop the connection; the machine schedules an automatic reconnect.
    socket.onclose?.();
    await vi.waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(1), { timeout: 3000 });
    const socket2 = MockWebSocket.instances.at(-1)!;
    socket2.open();

    await vi.waitFor(() => expect(sentRequests(socket2, 'resume_session')).toHaveLength(1), { timeout: 3000 });
    expect(socket2.sent.slice(0, 2).map((frame) => (JSON.parse(frame) as { method: string }).method)).toEqual([
      'initialize',
      'initialized',
    ]);

    // The fresh connection must resume from the stored cursor before any
    // live event arrives, recovering exactly the missed events.
    const resume = sentRequests(socket2, 'resume_session')[0]!;
    expect(resume.params).toEqual({ session_id: 's', stream_id: 'stream-1', after_seq: 2 });
    expect(client.connectionState).toBe('connecting');

    socket2.receive({
      jsonrpc: '2.0',
      id: resume.id,
      result: {
        session_id: 's',
        stream_id: 'stream-1',
        last_seq: 4,
        events: [
          { method: 'message_output', params: envelope(3, { content: 'c' }) },
          { method: 'run_end', params: envelope(4, {}) },
        ],
      },
    });

    await vi.waitFor(() => expect(seen).toEqual([1, 2, 3, 4]));
    expect(client.connectionState).toBe('connected');
    // A duplicate of a replayed event (legacy pending-event replay) is dropped.
    notify(socket2, 'message_output', envelope(3, { content: 'c' }));
    expect(seen).toEqual([1, 2, 3, 4]);
    client.dispose();
  });
});
