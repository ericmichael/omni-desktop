import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OmniagentsRpcError } from './client';
import { RPCClient } from './client';

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: MockWebSocket[] = [];

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
  return { client, socket };
}

describe('RPCClient generated protocol integration', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends canonical method params and correlates the response id', async () => {
    const { client, socket } = await connectedClient();
    const response = client.deleteSession('session-1');
    const request = JSON.parse(socket.sent[0]!) as Record<string, unknown>;

    expect(request).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'delete_session',
      params: { session_id: 'session-1' },
    });

    socket.receive({ jsonrpc: '2.0', id: request.id, result: true });
    await expect(response).resolves.toBe(true);
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
    const response = client.deleteSession('session-1');
    const request = JSON.parse(socket.sent[0]!) as Record<string, unknown>;

    socket.receive({
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32602,
        message: 'Invalid params',
        data: { method: 'delete_session' },
      },
    });

    await expect(response).rejects.toMatchObject({
      name: 'OmniagentsRpcError',
      code: -32602,
      message: 'Invalid params',
      data: { method: 'delete_session' },
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
