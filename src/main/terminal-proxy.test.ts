// @vitest-environment node
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import type { ProcessManager } from '@/main/process-manager';
import { TerminalProxy } from '@/main/terminal-proxy';
import type { AgentProcessStatus, WithTimestamp } from '@/shared/types';

/**
 * Dial-shape tests against a real WebSocket server standing in for
 * `omni serve` (omniagents rpc/protocol.md): connection auth arrives as an
 * `Authorization: Bearer` upgrade header — never in the URL — and the
 * `/ws/terminal` attach credentials ride in the FIRST frame, not query
 * params.
 */

type CapturedConn = {
  path: string;
  query: string;
  authorization: string | undefined;
  messages: string[];
};

type FakeServe = {
  wsUrl: string;
  connections: CapturedConn[];
  close: () => Promise<void>;
};

const startFakeServe = async (): Promise<FakeServe> => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const connections: CapturedConn[] = [];

  wss.on('connection', (socket, req) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const conn: CapturedConn = {
      path: url.pathname,
      query: url.search,
      authorization: req.headers.authorization,
      messages: [],
    };
    connections.push(conn);

    socket.on('message', (raw) => {
      const text = String(raw);
      conn.messages.push(text);
      if (url.pathname !== '/ws') {
        return;
      }
      // Minimal JSON-RPC responder for the tab RPC channel.
      const msg = JSON.parse(text) as { id: number; params: { function: string } };
      const fn = msg.params.function;
      const result =
        fn === 'session.ensure'
          ? { session_id: 'sess-1' }
          : fn === 'terminal.create'
            ? { terminal_id: 'term-1', terminal_token: 'attach-tok-1', path: '/ws/terminal', session_id: 'sess-1' }
            : {};
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });

  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const { port } = wss.address() as AddressInfo;
  return {
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    connections,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close(() => resolve());
      }),
  };
};

const makeProcessManager = (status: WithTimestamp<AgentProcessStatus>): ProcessManager =>
  ({ getStatus: () => status }) as unknown as ProcessManager;

const runningStatus = (wsUrl: string, authToken?: string): WithTimestamp<AgentProcessStatus> => ({
  type: 'running',
  timestamp: Date.now(),
  data: { uiUrl: wsUrl.replace(/^ws:/, 'http:').replace(/\/ws$/, ''), wsUrl, ...(authToken ? { authToken } : {}) },
});

const waitFor = async (cond: () => boolean, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('TerminalProxy dials', () => {
  let serve: FakeServe;
  let proxy: TerminalProxy;

  beforeEach(async () => {
    serve = await startFakeServe();
  });

  afterEach(async () => {
    await proxy?.disposeAll();
    await serve.close();
  });

  it('sends Authorization upgrade headers and a first-message attach frame (no credentials in URLs)', async () => {
    proxy = new TerminalProxy({
      processManager: makeProcessManager(runningStatus(serve.wsUrl, 'serve-token-1')),
      sendToWindow: () => {},
    });

    const id = await proxy.create('tab-1');
    expect(id).toBe('term-1');

    // Two connections: the tab JSON-RPC channel (/ws) and the terminal IO
    // socket (/ws/terminal). Both authenticate via the upgrade header.
    await waitFor(() => serve.connections.length === 2);
    const rpcConn = serve.connections.find((c) => c.path === '/ws');
    const ioConn = serve.connections.find((c) => c.path === '/ws/terminal');
    expect(rpcConn?.authorization).toBe('Bearer serve-token-1');
    expect(ioConn?.authorization).toBe('Bearer serve-token-1');

    // No token / terminal credentials in either dial URL.
    expect(rpcConn?.query).toBe('');
    expect(ioConn?.query).toBe('');

    // The attach frame is the FIRST message on the IO socket…
    await waitFor(() => (ioConn?.messages.length ?? 0) >= 1);
    expect(JSON.parse(ioConn!.messages[0]!)).toEqual({
      type: 'attach',
      session_id: 'sess-1',
      terminal_id: 'term-1',
      terminal_token: 'attach-tok-1',
    });

    // …and ordinary IO frames follow it.
    await waitFor(() => proxy.listIdsForTab('tab-1').length === 1);
    proxy.write('term-1', 'ls\n');
    await waitFor(() => (ioConn?.messages.length ?? 0) >= 2);
    expect(JSON.parse(ioConn!.messages[1]!)).toEqual({
      type: 'input',
      data: Buffer.from('ls\n', 'utf-8').toString('base64'),
    });
  });

  it('omits the Authorization header when the server is unauthenticated', async () => {
    proxy = new TerminalProxy({
      processManager: makeProcessManager(runningStatus(serve.wsUrl)),
      sendToWindow: () => {},
    });

    await proxy.create('tab-1');
    await waitFor(() => serve.connections.length === 2);
    expect(serve.connections.every((c) => c.authorization === undefined)).toBe(true);
  });
});
