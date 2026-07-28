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
