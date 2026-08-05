import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OmniagentsRpcError } from './client';
import { RPCClient, WORKSPACE_EXPERIMENTAL_OPERATIONS } from './client';

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
  protocol_version: '1.0.0',
  identity: { name: 'omniagents', version: '1.0.0' },
  platform: { os: 'linux', arch: 'x86_64' },
  capabilities: request.params.capabilities,
});

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: MockWebSocket[] = [];
  static autoInitialize = true;

  readyState = MockWebSocket.CONNECTING;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
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
        protocol_version: '1.0.0',
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
    const response = client.serverCall('bash_jobs.list', {}, 'session-1', 'environment-1');
    const request = JSON.parse(socket.sent[0]!) as Record<string, unknown>;

    expect(request).toEqual({
      jsonrpc: '2.0',
      id: 2,
      method: 'server_call',
      params: {
        function: 'bash_jobs.list',
        args: {},
        session_id: 'session-1',
        environment_id: 'environment-1',
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
    // The held live event is delivered anyway (loop-safe degradation) while
    // the host performs its full get_session_history refetch.
    await vi.waitFor(() => expect(seen).toEqual([1, 5]));
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

    await vi.waitFor(() => expect(socket2.sent).toHaveLength(3), { timeout: 3000 });
    expect(socket2.sent.slice(0, 2).map((frame) => (JSON.parse(frame) as { method: string }).method)).toEqual([
      'initialize',
      'initialized',
    ]);

    // The fresh connection must resume from the stored cursor before any
    // live event arrives, recovering exactly the missed events.
    await vi.waitFor(() => expect(sentRequests(socket2, 'resume_session')).toHaveLength(1), { timeout: 3000 });
    const resume = sentRequests(socket2, 'resume_session')[0]!;
    expect(resume.params).toEqual({ session_id: 's', stream_id: 'stream-1', after_seq: 2 });

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
    // A duplicate of a replayed event (legacy pending-event replay) is dropped.
    notify(socket2, 'message_output', envelope(3, { content: 'c' }));
    expect(seen).toEqual([1, 2, 3, 4]);
    client.dispose();
  });
});
