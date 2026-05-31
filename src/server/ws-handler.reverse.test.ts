/**
 * Unit tests for the cloud→client reverse-RPC layer in {@link WsHandler}.
 *
 * Drives a real `WsHandler` against a stub WebSocket that records the JSON
 * frames it would send and synthesises responses by calling
 * `synthIncoming(...)`. Exercises the happy path, timeout, ws-closed mid-
 * flight, and the WS-not-open guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

import { WsHandler } from '@/server/ws-handler';

/** Minimal `ws.WebSocket` stand-in that records sent frames + supports `on`. */
class StubWs {
  readyState = 1; // OPEN
  sent: string[] = [];
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  send = vi.fn((data: string) => {
    this.sent.push(data);
  });

  on(event: string, cb: (...args: unknown[]) => void): this {
    (this.listeners[event] ??= []).push(cb);
    return this;
  }

  /** Test helper — pretend the client just sent us this message. */
  synthIncoming(message: unknown): void {
    for (const cb of this.listeners['message'] ?? []) {
      cb(typeof message === 'string' ? message : JSON.stringify(message));
    }
  }

  /** Test helper — pretend the WS closed; runs every close listener. */
  synthClose(): void {
    this.readyState = 3; // CLOSED
    for (const cb of this.listeners['close'] ?? []) {
      cb();
    }
  }
}

const asWs = (s: StubWs): WebSocket => s as unknown as WebSocket;

describe('WsHandler reverse-RPC', () => {
  let handler: WsHandler;
  let ws: StubWs;

  beforeEach(() => {
    handler = new WsHandler();
    ws = new StubWs();
    handler.addClient(asWs(ws), undefined, undefined, 'tenant', undefined, 'principal');
    ws.sent.length = 0; // clear any addClient-time noise
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits a reverse-invoke frame with a monotonic id', async () => {
    const a = handler.invokeOnWs(asWs(ws), 'compute:start-session', [{ x: 1 }]);
    const b = handler.invokeOnWs(asWs(ws), 'compute:get-status', ['session-1']);

    expect(ws.sent).toHaveLength(2);
    const f1 = JSON.parse(ws.sent[0]!);
    const f2 = JSON.parse(ws.sent[1]!);
    expect(f1.type).toBe('reverse-invoke');
    expect(f2.type).toBe('reverse-invoke');
    expect(f1.channel).toBe('compute:start-session');
    expect(f2.channel).toBe('compute:get-status');
    expect(f2.id - f1.id).toBeGreaterThan(0);

    // Resolve them out of order — the dispatcher routes by id, not arrival.
    ws.synthIncoming({ type: 'reverse-response', id: f2.id, result: { type: 'running' } });
    ws.synthIncoming({ type: 'reverse-response', id: f1.id, result: { wsUrl: 'ws://...' } });
    await expect(a).resolves.toEqual({ wsUrl: 'ws://...' });
    await expect(b).resolves.toEqual({ type: 'running' });
  });

  it('rejects when the client returns an error', async () => {
    const p = handler.invokeOnWs(asWs(ws), 'compute:start-session', []);
    const frame = JSON.parse(ws.sent[0]!);
    ws.synthIncoming({ type: 'reverse-response', id: frame.id, error: 'host-at-capacity' });
    await expect(p).rejects.toThrow('host-at-capacity');
  });

  it('rejects on timeout', async () => {
    const p = handler.invokeOnWs(asWs(ws), 'compute:start-session', [], { timeoutMs: 500 });
    vi.advanceTimersByTime(600);
    await expect(p).rejects.toThrow(/timeout/);
  });

  it('rejects every pending request when the WS closes', async () => {
    const a = handler.invokeOnWs(asWs(ws), 'compute:start-session', []);
    const b = handler.invokeOnWs(asWs(ws), 'compute:get-status', []);
    ws.synthClose();
    await expect(a).rejects.toThrow('ws-closed');
    await expect(b).rejects.toThrow('ws-closed');
  });

  it('refuses to send on a closed ws', async () => {
    ws.readyState = 3;
    await expect(handler.invokeOnWs(asWs(ws), 'compute:noop', [])).rejects.toThrow('ws-not-open');
  });

  it('drops late / unknown response ids silently', () => {
    // Should not throw — guarantees a misbehaving client can't crash the dispatcher.
    ws.synthIncoming({ type: 'reverse-response', id: 9999, result: 'irrelevant' });
  });
});
