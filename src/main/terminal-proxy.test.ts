import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProcessManager } from '@/main/process-manager';
import { TerminalProxy } from '@/main/terminal-proxy';

const { FakeWs } = vi.hoisted(() => {
  /**
   * Minimal `ws` stand-in (Node-style event API). Tests drive the server side
   * via `serverOpen` / `emit`.
   */
  class FakeWs {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static instances: FakeWs[] = [];

    readonly url: string;
    readyState = FakeWs.CONNECTING;
    sent: string[] = [];
    private handlers = new Map<string, ((...args: unknown[]) => void)[]>();

    constructor(url: string) {
      this.url = url;
      FakeWs.instances.push(this);
    }

    on(event: string, cb: (...args: unknown[]) => void): this {
      const list = this.handlers.get(event) ?? [];
      list.push(cb);
      this.handlers.set(event, list);
      return this;
    }

    once(event: string, cb: (...args: unknown[]) => void): this {
      const wrapper = (...args: unknown[]): void => {
        this.off(event, wrapper);
        cb(...args);
      };
      return this.on(event, wrapper);
    }

    off(event: string, cb: (...args: unknown[]) => void): this {
      const list = this.handlers.get(event) ?? [];
      this.handlers.set(
        event,
        list.filter((h) => h !== cb)
      );
      return this;
    }

    send(data: unknown): void {
      this.sent.push(String(data));
    }

    close(): void {
      this.readyState = FakeWs.CLOSED;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const cb of [...(this.handlers.get(event) ?? [])]) {
        cb(...args);
      }
    }

    serverOpen(): void {
      this.readyState = FakeWs.OPEN;
      this.emit('open');
    }
  }
  return { FakeWs };
});

vi.mock('ws', () => ({ WebSocket: FakeWs }));

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
};

const makeProxy = () => {
  const sendToWindow = vi.fn();
  const processManager = {
    getStatus: () => ({ type: 'running', data: { wsUrl: 'ws://127.0.0.1:9000/ws?token=abc' } }),
  } as unknown as ProcessManager;
  return { proxy: new TerminalProxy({ processManager, sendToWindow }), sendToWindow };
};

type FakeWsInstance = InstanceType<typeof FakeWs>;

/** Drive create() through session.ensure + terminal.create against the fake server. */
const completeCreate = async (
  proxy: TerminalProxy,
  tabId: string
): Promise<{ rpcWs: FakeWsInstance; ioWs: FakeWsInstance }> => {
  const createP = proxy.create(tabId);
  await settle();
  const rpcWs = FakeWs.instances[0]!;
  rpcWs.serverOpen();
  await settle();
  const ensureFrame = JSON.parse(rpcWs.sent[0]!) as { id: number };
  rpcWs.emit('message', JSON.stringify({ jsonrpc: '2.0', id: ensureFrame.id, result: { session_id: 'sess-1' } }));
  await settle();
  const createFrame = JSON.parse(rpcWs.sent[1]!) as { id: number };
  rpcWs.emit(
    'message',
    JSON.stringify({
      jsonrpc: '2.0',
      id: createFrame.id,
      result: { terminal_id: 'term-1', terminal_token: 'tt', path: '/ws/terminal', session_id: 'sess-1' },
    })
  );
  await expect(createP).resolves.toBe('term-1');
  return { rpcWs, ioWs: FakeWs.instances[1]! };
};

describe('TerminalProxy lifecycle', () => {
  beforeEach(() => {
    FakeWs.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects pending RPC calls with a permanent structured error on a 4401 close', async () => {
    const { proxy } = makeProxy();
    const createP = proxy.create('tab-1');
    createP.catch(() => undefined); // assertion attaches below
    await settle();
    const rpcWs = FakeWs.instances[0]!;
    rpcWs.serverOpen();
    await settle();
    expect(rpcWs.sent).toHaveLength(1); // session.ensure is in flight

    rpcWs.emit('close', 4401, Buffer.from('token rejected'));
    await expect(createP).rejects.toMatchObject({
      name: 'ConsoleError',
      kind: 'rpc_failed',
      permanent: true,
      closeCode: 4401,
    });
  });

  it('marks pending rejections retryable on an abnormal (1006) close', async () => {
    const { proxy } = makeProxy();
    const createP = proxy.create('tab-1');
    createP.catch(() => undefined);
    await settle();
    const rpcWs = FakeWs.instances[0]!;
    rpcWs.serverOpen();
    await settle();

    rpcWs.emit('close', 1006, Buffer.from(''));
    await expect(createP).rejects.toMatchObject({
      name: 'ConsoleError',
      kind: 'rpc_failed',
      permanent: false,
      closeCode: 1006,
    });
  });

  it('surfaces a permanent io-socket close as a non-zero terminal exit', async () => {
    const { proxy, sendToWindow } = makeProxy();
    const { ioWs } = await completeCreate(proxy, 'tab-1');

    ioWs.emit('close', 4401, Buffer.from(''));
    expect(sendToWindow).toHaveBeenCalledWith('terminal:exited', 'tab-1', 'term-1', 1);
  });

  it('keeps a clean io-socket close as exit code 0', async () => {
    const { proxy, sendToWindow } = makeProxy();
    const { ioWs } = await completeCreate(proxy, 'tab-1');

    ioWs.emit('close', 1000, Buffer.from(''));
    expect(sendToWindow).toHaveBeenCalledWith('terminal:exited', 'tab-1', 'term-1', 0);
  });

  it('uses the standard 60s lifecycle RPC deadline (not the old 15s)', async () => {
    vi.useFakeTimers();
    const { proxy } = makeProxy();
    const createP = proxy.create('tab-1');
    let settled = false;
    createP.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await settle();
    FakeWs.instances[0]!.serverOpen();
    await settle();

    await vi.advanceTimersByTimeAsync(15_001);
    expect(settled).toBe(false); // would already have timed out under the old 15s deadline

    await vi.advanceTimersByTimeAsync(45_000);
    await expect(createP).rejects.toMatchObject({ kind: 'rpc_failed' });
    expect(settled).toBe(true);
  });
});
