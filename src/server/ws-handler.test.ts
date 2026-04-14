import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { WsHandler } from './ws-handler';

type SessionApi = {
  handle: (channel: string, handler: (...args: unknown[]) => unknown | Promise<unknown>) => void;
  sendToWindow: (channel: string, ...args: unknown[]) => void;
  setCleanup: (cleanup: () => Promise<void>) => void;
};

type OnConnect = (session: SessionApi) => void;

let handler: WsHandler;
let wss: WebSocketServer;
let port: number;
let onConnectImpl: OnConnect | undefined;
// Track all client sockets created so we can close them in afterEach
const openClients: WebSocket[] = [];

beforeEach(async () => {
  handler = new WsHandler();
  onConnectImpl = undefined;
  wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  port = (wss.address() as AddressInfo).port;
  wss.on('connection', (ws, req) => {
    // Parse sid=... from the request URL
    let sessionId: string | undefined;
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      sessionId = url.searchParams.get('sid') ?? undefined;
    } catch {
      sessionId = undefined;
    }
    handler.addClient(ws as unknown as Parameters<WsHandler['addClient']>[0], onConnectImpl as Parameters<WsHandler['addClient']>[1], sessionId);
  });
});

afterEach(async () => {
  for (const ws of openClients) {
    try {
      ws.removeAllListeners();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
      }
    } catch {
      // ignore
    }
  }
  openClients.length = 0;
  await handler.cleanupAllSessions();
  for (const client of wss.clients) {
    try {
      client.terminate();
    } catch {
      // ignore
    }
  }
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

const connectClient = async (sessionId?: string): Promise<WebSocket> => {
  const url = `ws://127.0.0.1:${port}${sessionId ? `?sid=${sessionId}` : ''}`;
  const ws = new WebSocket(url);
  openClients.push(ws);
  await new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      ws.off('error', onError);
      resolve();
    };
    const onError = (err: Error): void => {
      ws.off('open', onOpen);
      reject(err);
    };
    ws.once('open', onOpen);
    ws.once('error', onError);
  });
  // Give the server's 'connection' handler a microtask to run addClient
  await new Promise((r) => setImmediate(r));
  return ws;
};

const closeClient = async (ws: WebSocket): Promise<void> => {
  if (ws.readyState === WebSocket.CLOSED) {
return;
}
  await new Promise<void>((resolve) => {
    ws.once('close', () => resolve());
    ws.close();
  });
  // Allow the server-side 'close' handler to run
  await new Promise((r) => setImmediate(r));
};

const invoke = (
  ws: WebSocket,
  id: number,
  channel: string,
  args: unknown[] = []
): Promise<{ result?: unknown; error?: string }> =>
  new Promise((resolve) => {
    const listener = (raw: Buffer): void => {
      try {
        const msg = JSON.parse(String(raw)) as { type?: string; id?: number; result?: unknown; error?: string };
        if (msg.type === 'response' && msg.id === id) {
          ws.off('message', listener);
          resolve({ result: msg.result, error: msg.error });
        }
      } catch {
        // ignore parse errors
      }
    };
    ws.on('message', listener);
    ws.send(JSON.stringify({ type: 'invoke', id, channel, args }));
  });

const waitForEvent = (ws: WebSocket, channel: string, timeoutMs = 1000): Promise<unknown[]> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', listener);
      reject(new Error(`Timed out waiting for event ${channel}`));
    }, timeoutMs);
    const listener = (raw: Buffer): void => {
      try {
        const msg = JSON.parse(String(raw)) as { type?: string; channel?: string; args?: unknown[] };
        if (msg.type === 'event' && msg.channel === channel) {
          clearTimeout(timer);
          ws.off('message', listener);
          resolve(msg.args ?? []);
        }
      } catch {
        // ignore
      }
    };
    ws.on('message', listener);
  });

describe('WsHandler - handler routing', () => {
  it('routes to a registered global handler', async () => {
    handler.handle('store:get-key', () => 42);
    const ws = await connectClient();
    const res = await invoke(ws, 1, 'store:get-key');
    expect(res.error).toBeUndefined();
    expect(res.result).toBe(42);
  });

  it('returns error for unknown channel', async () => {
    const ws = await connectClient();
    const res = await invoke(ws, 1, 'does:not-exist');
    expect(res.result).toBeUndefined();
    expect(res.error).toContain('No handler');
  });

  it('per-session handler shadows global handler for same channel', async () => {
    handler.handle('test:ping', () => 'global');
    onConnectImpl = (session) => {
      session.handle('test:ping', () => 'session');
    };
    const ws = await connectClient();
    const res = await invoke(ws, 1, 'test:ping');
    expect(res.result).toBe('session');
  });

  it('forwards invoke args to the handler', async () => {
    handler.handle('math:add', (a, b) => (a as number) + (b as number));
    const ws = await connectClient();
    const res = await invoke(ws, 1, 'math:add', [2, 3]);
    expect(res.result).toBe(5);
  });
});

describe('WsHandler - session persistence', () => {
  it('reuses persistent session when reconnecting with same sessionId', async () => {
    let onConnectCalls = 0;
    onConnectImpl = (session) => {
      onConnectCalls += 1;
      session.handle('test:who', () => 'session-handler-A');
    };
    const ws1 = await connectClient('abc');
    const res1 = await invoke(ws1, 1, 'test:who');
    expect(res1.result).toBe('session-handler-A');
    await closeClient(ws1);

    const ws2 = await connectClient('abc');
    const res2 = await invoke(ws2, 2, 'test:who');
    expect(res2.result).toBe('session-handler-A');
    expect(onConnectCalls).toBe(1);
  });

  it('creates a new session when connecting without a sessionId', async () => {
    const greetings: string[] = [];
    let counter = 0;
    onConnectImpl = (session) => {
      const mine = `session-${counter++}`;
      greetings.push(mine);
      session.handle('test:whoami', () => mine);
    };
    const wsA = await connectClient();
    const wsB = await connectClient();
    const resA = await invoke(wsA, 1, 'test:whoami');
    const resB = await invoke(wsB, 2, 'test:whoami');
    expect(resA.result).toBe('session-0');
    expect(resB.result).toBe('session-1');
    expect(greetings).toEqual(['session-0', 'session-1']);
  });

  it('sendToWindow routes to the currently-attached WS after reconnect', async () => {
    let capturedSendToWindow: ((channel: string, ...args: unknown[]) => void) | undefined;
    onConnectImpl = (session) => {
      capturedSendToWindow = session.sendToWindow;
    };
    const ws1 = await connectClient('xyz');
    expect(capturedSendToWindow).toBeDefined();
    await closeClient(ws1);

    const ws2 = await connectClient('xyz');
    const eventPromise = waitForEvent(ws2, 'test:broadcast');
    capturedSendToWindow!('test:broadcast', { hello: 'world' });
    const args = await eventPromise;
    expect(args).toEqual([{ hello: 'world' }]);
  });
});

describe('WsHandler - event interceptors', () => {
  it('fires interceptor with cloned args on sendToAll', async () => {
    const interceptor = vi.fn();
    handler.addEventInterceptor(interceptor);
    const ws = await connectClient();
    const eventPromise = waitForEvent(ws, 'some:event');
    (handler.sendToAll as unknown as (channel: string, ...args: unknown[]) => void)('some:event', { data: 1 });
    await eventPromise;
    expect(interceptor).toHaveBeenCalledWith('some:event', [{ data: 1 }]);
  });

  it("interceptor cannot mutate caller's original args", async () => {
    handler.addEventInterceptor((_channel, args) => {
      const first = args[0] as { data: number };
      first.data = 999;
    });
    const ws = await connectClient();
    const original = { data: 1 };
    const eventPromise = waitForEvent(ws, 'some:event');
    (handler.sendToAll as unknown as (channel: string, ...args: unknown[]) => void)('some:event', original);
    await eventPromise;
    expect(original.data).toBe(1);
  });
});

describe('WsHandler - result wrappers', () => {
  it('applies wrapper to invoke response', async () => {
    handler.handle('compute', () => ({ n: 1 }));
    handler.addResultWrapper('compute', (result) => {
      const r = result as { n: number };
      return { n: r.n * 2 };
    });
    const ws = await connectClient();
    const res = await invoke(ws, 1, 'compute');
    expect(res.result).toEqual({ n: 2 });
  });

  it('wrapper receives structuredClone of result (does not pollute next invoke)', async () => {
    handler.handle('fresh', () => ({ n: 1 }));
    handler.addResultWrapper('fresh', (result) => {
      const r = result as { n: number };
      r.n = 999; // mutate the clone we received
      return r;
    });
    const ws = await connectClient();
    const res1 = await invoke(ws, 1, 'fresh');
    const res2 = await invoke(ws, 2, 'fresh');
    expect(res1.result).toEqual({ n: 999 });
    expect(res2.result).toEqual({ n: 999 });
    // Both invocations should produce the same output — meaning the handler's
    // source object was not polluted by the wrapper's mutation on the clone
    expect(res2.result).toEqual(res1.result);
  });
});

describe('WsHandler - cleanupAllSessions', () => {
  it('invokes all registered cleanup callbacks', async () => {
    const cleanup = vi.fn(async () => undefined);
    onConnectImpl = (session) => {
      session.setCleanup(cleanup);
    };
    await connectClient('cleanup-1');
    await handler.cleanupAllSessions();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('clears the persistent session map after cleanup (fresh onConnect on reconnect)', async () => {
    let onConnectCalls = 0;
    onConnectImpl = (session) => {
      onConnectCalls += 1;
      session.handle('test:ping', () => `v${  onConnectCalls}`);
    };
    await connectClient('reuse-me');
    await handler.cleanupAllSessions();

    const ws2 = await connectClient('reuse-me');
    const res = await invoke(ws2, 1, 'test:ping');
    expect(onConnectCalls).toBe(2);
    expect(res.result).toBe('v2');
  });
});

describe('WsHandler - error handling', () => {
  it('returns error response when handler throws', async () => {
    handler.handle('kaboom', () => {
      throw new Error('boom');
    });
    const ws = await connectClient();
    const res = await invoke(ws, 1, 'kaboom');
    expect(res.result).toBeUndefined();
    expect(res.error).toBe('boom');
  });

  it('silently ignores malformed JSON messages', async () => {
    handler.handle('ping', () => 'pong');
    const ws = await connectClient();
    ws.send('not-json-at-all');
    // Wait briefly to confirm no crash/close
    await new Promise((r) => setTimeout(r, 20));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    const res = await invoke(ws, 1, 'ping');
    expect(res.result).toBe('pong');
  });

  it('ignores invoke messages missing required fields', async () => {
    handler.handle('ping', () => 'pong');
    const ws = await connectClient();
    ws.send(JSON.stringify({ type: 'invoke' }));
    ws.send(JSON.stringify({ type: 'invoke', id: 'not-a-number', channel: 'ping' }));
    ws.send(JSON.stringify({ type: 'invoke', id: 1 })); // missing channel
    await new Promise((r) => setTimeout(r, 20));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    const res = await invoke(ws, 42, 'ping');
    expect(res.result).toBe('pong');
  });
});
