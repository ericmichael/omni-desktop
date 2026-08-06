import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionClosedError, RpcTimeoutError } from '@/shared/lifecycle';
import { DEFAULT_LIFECYCLE_POLICY, RpcAbortError } from '@/shared/lifecycle';
import type { OmniagentsRpcError } from '@/shared/omniagents-rpc';

import { RealtimeRPCClient } from './realtime';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  serverClose(code: number, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  message(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent);
  }
}

const policy = {
  ...DEFAULT_LIFECYCLE_POLICY,
  connectTimeoutMs: 100,
  rpcTimeoutMs: 50,
  reconnectJitter: 0,
  reconnectMaxAttempts: 2,
};

async function beginConnect(client: RealtimeRPCClient): Promise<{ promise: Promise<void>; socket: FakeWebSocket }> {
  const promise = client.connect();
  await Promise.resolve();
  await Promise.resolve();
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) {
    throw new Error('Expected a WebSocket dial');
  }
  return { promise, socket };
}

describe('RealtimeRPCClient lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('bounds RPC calls with the shared default deadline and preserves timeout metadata', async () => {
    const client = new RealtimeRPCClient('ws://localhost/ws/realtime', undefined, false, policy);
    const { promise: connecting, socket } = await beginConnect(client);
    socket.open();
    await connecting;

    const request = client.request('capabilities');
    const rejection = expect(request).rejects.toMatchObject({
      name: 'RpcTimeoutError',
      method: 'capabilities',
      timeoutMs: policy.rpcTimeoutMs,
    } satisfies Partial<RpcTimeoutError>);
    await vi.advanceTimersByTimeAsync(policy.rpcTimeoutMs);
    await rejection;
    client.disconnect();
  });

  it('supports AbortSignal cancellation without closing the socket', async () => {
    const client = new RealtimeRPCClient('ws://localhost/ws/realtime', undefined, false, policy);
    const { promise: connecting, socket } = await beginConnect(client);
    socket.open();
    await connecting;

    const controller = new AbortController();
    const request = client.request('start_session', {}, { signal: controller.signal });
    controller.abort();

    await expect(request).rejects.toBeInstanceOf(RpcAbortError);
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    client.disconnect();
  });

  it('preserves structured JSON-RPC errors', async () => {
    const client = new RealtimeRPCClient('ws://localhost/ws/realtime', undefined, false, policy);
    const { promise: connecting, socket } = await beginConnect(client);
    socket.open();
    await connecting;

    const request = client.request('capabilities');
    const sent = JSON.parse(socket.sent[0]!) as { id: number };
    socket.message({
      jsonrpc: '2.0',
      id: sent.id,
      error: { code: -32020, message: 'busy', data: { retry_after_ms: 250 } },
    });

    await expect(request).rejects.toMatchObject({
      name: 'OmniagentsRpcError',
      code: -32020,
      data: { retry_after_ms: 250 },
    } satisfies Partial<OmniagentsRpcError>);
    client.disconnect();
  });

  it('rejects pending calls and never reconnects after a permanent close', async () => {
    const client = new RealtimeRPCClient('ws://localhost/ws/realtime', undefined, false, policy);
    const { promise: connecting, socket } = await beginConnect(client);
    socket.open();
    await connecting;

    const request = client.request('capabilities', undefined, { timeoutMs: null });
    socket.serverClose(4401, 'token rejected');

    await expect(request).rejects.toMatchObject({
      name: 'ConnectionClosedError',
      permanent: true,
      closeCode: 4401,
      reason: 'token rejected',
    } satisfies Partial<ConnectionClosedError>);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('reconnects retryable closes on the canonical 500ms first delay', async () => {
    const client = new RealtimeRPCClient('ws://localhost/ws/realtime', undefined, false, policy, () => 0.5);
    const { promise: connecting, socket } = await beginConnect(client);
    socket.open();
    await connecting;

    socket.serverClose(1011, 'server restarting');
    await vi.advanceTimersByTimeAsync(499);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1]!.open();
    client.disconnect();
  });

  it('bounds the whole connect attempt', async () => {
    const oneAttempt = { ...policy, connectTimeoutMs: 25, reconnectMaxAttempts: 1 };
    const client = new RealtimeRPCClient('ws://localhost/ws/realtime', undefined, false, oneAttempt);
    const { promise } = await beginConnect(client);
    const rejection = expect(promise).rejects.toMatchObject({
      name: 'ConnectionClosedError',
      permanent: true,
    } satisfies Partial<ConnectionClosedError>);

    await vi.advanceTimersByTimeAsync(oneAttempt.connectTimeoutMs);
    await rejection;
  });
});
