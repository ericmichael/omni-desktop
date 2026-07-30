import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WsTransportEmitter } from '@/renderer/transport/ws-transport';
import type { ConnectionState } from '@/shared/lifecycle';

/**
 * Minimal browser-WebSocket stand-in. Tests drive the server side via
 * `serverOpen` / `serverClose` / `serverMessage`.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  serverOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  serverClose(code: number, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  serverMessage(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

/** Flush the microtask chains inside `connect()` (token fetch → dial). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
};

const cloudConfig = () => ({
  baseUrl: 'https://cloud.example.com',
  getWsToken: async () => 'cloud-token',
});

describe('WsTransportEmitter lifecycle', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ token: 'local-token' }) }))
    );
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('remote: a terminal close code rejects pending requests and enters the terminal state', async () => {
    const transport = new WsTransportEmitter(cloudConfig());
    await settle();
    const ws = FakeWebSocket.instances[0]!;
    ws.serverOpen();

    const states: ConnectionState[] = [];
    transport.onStateChange((s) => states.push(s));
    expect(states).toEqual([{ state: 'connected' }]);

    const inFlight = transport.invoke('util:get-launcher-version');
    expect(ws.sent).toHaveLength(1);

    ws.serverClose(4401, 'token revoked');
    await expect(inFlight).rejects.toMatchObject({
      name: 'ConnectionClosedError',
      permanent: true,
      closeCode: 4401,
      reason: 'token revoked',
    });
    expect(transport.getConnectionState()).toEqual({
      state: 'closed',
      permanent: true,
      closeCode: 4401,
      reason: 'token revoked',
    });
    expect(states.at(-1)).toMatchObject({ state: 'closed', permanent: true, closeCode: 4401 });

    // No redial, ever.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(FakeWebSocket.instances).toHaveLength(1);

    // Post-terminal invokes fail fast instead of queueing forever.
    await expect(transport.invoke('util:get-launcher-version')).rejects.toMatchObject({
      name: 'ConnectionClosedError',
      permanent: true,
      closeCode: 4401,
    });
  });

  it('remote: queued (not-yet-sent) invokes are rejected with a structured error on terminal entry', async () => {
    const transport = new WsTransportEmitter(cloudConfig());
    await settle();
    const ws0 = FakeWebSocket.instances[0]!;
    ws0.serverOpen();
    ws0.serverClose(1006); // transient — schedules a redial

    // Invoked while disconnected → queued, unresolved.
    const queued = transport.invoke('util:get-launcher-version');
    expect(transport.getConnectionState()).toMatchObject({ state: 'reconnecting', attempt: 1 });

    await vi.advanceTimersByTimeAsync(1_000);
    const ws1 = FakeWebSocket.instances[1]!;
    ws1.serverClose(4401, 'token revoked'); // dial deterministically rejected

    await expect(queued).rejects.toMatchObject({
      name: 'ConnectionClosedError',
      permanent: true,
      closeCode: 4401,
    });
    expect(transport.getConnectionState()).toMatchObject({ state: 'closed', permanent: true });
  });

  it('rejects in-flight requests on a transient close but keeps queued ones for the reconnect', async () => {
    const transport = new WsTransportEmitter(cloudConfig());
    await settle();
    const ws0 = FakeWebSocket.instances[0]!;
    ws0.serverOpen();

    const inFlight = transport.invoke('util:get-launcher-version');
    ws0.serverClose(1006);
    await expect(inFlight).rejects.toMatchObject({ name: 'ConnectionClosedError', permanent: false, closeCode: 1006 });

    // Queued during the outage; survives the redial and resolves normally.
    const queued = transport.invoke('util:get-launcher-version');
    await vi.advanceTimersByTimeAsync(1_000);
    const ws1 = FakeWebSocket.instances[1]!;
    ws1.serverOpen();
    expect(ws1.sent).toHaveLength(1);
    const frame = JSON.parse(ws1.sent[0]!) as { id: number };
    ws1.serverMessage({ type: 'response', id: frame.id, result: '1.2.3' });
    await expect(queued).resolves.toBe('1.2.3');
    expect(transport.getConnectionState()).toEqual({ state: 'connected' });
  });

  it('remote: exhausts the 10-attempt budget on repeated retryable failures and goes terminal', async () => {
    const transport = new WsTransportEmitter(cloudConfig());
    await settle();

    for (let i = 0; i < 10; i++) {
      expect(FakeWebSocket.instances).toHaveLength(i + 1);
      FakeWebSocket.instances[i]!.serverClose(1006);
      await vi.advanceTimersByTimeAsync(40_000); // > 30s cap + jitter
    }

    // 10th consecutive failure exhausted the budget: terminal, no 11th dial.
    expect(FakeWebSocket.instances).toHaveLength(10);
    expect(transport.getConnectionState()).toMatchObject({ state: 'closed', permanent: true, closeCode: 1006 });
  });

  it('local server-mode: retries forever, even past 10 attempts and on auth-flavored close codes', async () => {
    const transport = new WsTransportEmitter(); // no cloud config → local policy
    await settle();

    for (let i = 0; i < 12; i++) {
      expect(FakeWebSocket.instances).toHaveLength(i + 1);
      // 4401 locally means a stale short-TTL token; the next dial re-fetches
      // a fresh one, so this must never go terminal.
      FakeWebSocket.instances[i]!.serverClose(4401, 'stale token');
      await vi.advanceTimersByTimeAsync(40_000);
    }

    expect(FakeWebSocket.instances).toHaveLength(13);
    expect(transport.getConnectionState()).toMatchObject({ state: 'reconnecting', attempt: 12 });
  });
});
