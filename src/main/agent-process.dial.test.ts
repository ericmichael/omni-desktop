// @vitest-environment node
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';

/**
 * Dial tests for AgentProcess against a REAL WebSocket server (the `ws`
 * module is deliberately not mocked here, unlike agent-process.test.ts):
 * both the readiness WS probe and one-shot `server_call` dials must
 * authenticate with an `Authorization: Bearer` upgrade header carrying the
 * readiness payload's `auth_token` — never a query-string token.
 */

const hoisted = vi.hoisted(() => ({
  nextChild: null as unknown,
}));

vi.mock('node:child_process', async () => {
  const actual = (await vi.importActual('node:child_process')) as typeof import('node:child_process');
  const spawnMock = (() => hoisted.nextChild) as unknown as typeof import('node:child_process').spawn;
  return { ...actual, spawn: spawnMock };
});

vi.mock('@/main/util', () => ({
  getOmniCliPath: vi.fn(() => '/fake/bin/omni'),
  getOmniConfigDir: vi.fn(() => '/fake/config'),
  isDirectory: vi.fn(async () => true),
  pathExists: vi.fn(async () => true),
}));

vi.mock('@/main/product-runtime', () => ({
  assertServeProtocolSupported: vi.fn(async () => {}),
}));

vi.mock('@/main/profile-resolver', () => ({
  resolveProfile: vi.fn(() => ({ kind: 'builtin-default' })),
}));

vi.mock('shell-env', () => ({ shellEnvSync: () => ({}) }));
vi.mock('@/lib/pty-utils', () => ({ DEFAULT_ENV: {} }));
vi.mock('@/main/workspace-sync', () => ({ downloadWorkspace: vi.fn(async () => {}) }));
vi.mock('@/lib/simple-logger', () => ({
  SimpleLogger: class {
    constructor(_handler: unknown) {}
    debug(): void {}
    info(): void {}
    warn(): void {}
    error(): void {}
  },
}));

import { AgentProcess } from '@/main/agent-process';
import type { AgentProcessStatus, WithTimestamp } from '@/shared/types';

type MockChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  emitStdout: (data: string) => void;
};

const makeMockChild = (): MockChild => {
  const child = new EventEmitter() as MockChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.kill = vi.fn(() => {
    if (child.exitCode === null) {
      child.exitCode = 0;
      setImmediate(() => child.emit('close', 0, null));
    }
    return true;
  }) as unknown as MockChild['kill'];
  child.emitStdout = (data: string) => child.stdout.emit('data', Buffer.from(data));
  return child;
};

type ServeConn = {
  path: string;
  query: string;
  authorization: string | undefined;
  methods: string[];
  calls: string[];
  environmentIds: unknown[];
};

const startFakeServe = async () => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const connections: ServeConn[] = [];
  wss.on('connection', (socket, req) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const conn: ServeConn = {
      path: url.pathname,
      query: url.search,
      authorization: req.headers.authorization,
      methods: [],
      calls: [],
      environmentIds: [],
    };
    connections.push(conn);
    socket.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as {
        id?: number;
        method: string;
        params: { function?: string; environment_id?: unknown };
      };
      conn.methods.push(msg.method);
      if (msg.method === 'initialized') {
        return;
      }
      if (msg.method === 'initialize') {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocol_version: '1.0.0' } }));
        return;
      }
      if (msg.params.function) {
        conn.calls.push(msg.params.function);
      }
      conn.environmentIds.push(msg.params.environment_id);
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true, supported: true, paused: true } }));
    });
  });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const { port } = wss.address() as AddressInfo;
  return {
    port,
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

const waitFor = async (cond: () => boolean, ms = 10_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('AgentProcess dial auth (serve mode)', () => {
  let serve: Awaited<ReturnType<typeof startFakeServe>>;

  beforeEach(async () => {
    serve = await startFakeServe();
  });

  afterEach(async () => {
    await serve.close();
    vi.clearAllMocks();
  });

  it('reads auth_token from the readiness payload and dials with Authorization headers', async () => {
    const child = makeMockChild();
    hoisted.nextChild = child;
    const statuses: WithTimestamp<AgentProcessStatus>[] = [];
    const rawOutput: string[] = [];
    const proc = new AgentProcess({
      mode: 'serve',
      ipcRawOutput: (data) => rawOutput.push(data),
      onStatusChange: (s) => statuses.push(s),
      // uiUrl HTTP readiness probe: always up.
      fetchFn: (async () => ({ status: 200 })) as unknown as typeof globalThis.fetch,
    });

    await proc.start({ profileName: 'host', sources: [] });
    child.emitStdout(
      `${JSON.stringify({
        sandbox_url: `http://127.0.0.1:${serve.port}`,
        ws_url: `ws://127.0.0.1:${serve.port}/ws`,
        ui_url: `http://127.0.0.1:${serve.port}`,
        agent_host_id: 'agent-host-authenticated',
        workspace_id: 'workspace-authenticated',
        environment_id: 'environment-authenticated',
        auth_token: 'serve-token-1',
        services: {},
        ports: { ui: serve.port },
      })}\n`
    );

    // Readiness payload parse: dedicated auth_token field, token-free ws_url.
    await waitFor(() => statuses.some((s) => s.type === 'connecting'));
    const connecting = statuses.find((s) => s.type === 'connecting');
    if (connecting?.type !== 'connecting') {
      throw new Error('no connecting status');
    }
    expect(connecting.data.authToken).toBe('serve-token-1');
    expect(connecting.data.wsUrl).toBe(`ws://127.0.0.1:${serve.port}/ws`);
    expect(connecting.data.wsUrl).not.toContain('token=');

    // The readiness WS probe authenticated via the upgrade header, URL clean.
    await waitFor(() => statuses.some((s) => s.type === 'running'));
    expect(serve.connections.length).toBeGreaterThan(0);
    expect(serve.connections[0]!.authorization).toBe('Bearer serve-token-1');
    expect(serve.connections[0]!.query).toBe('');

    // One-shot server_call dials (pause) carry the same header.
    const result = await proc.pause('environment-authenticated');
    expect(result.ok).toBe(true);
    const callConn = serve.connections.find((c) => c.calls.includes('sandbox.pause'));
    expect(callConn?.authorization).toBe('Bearer serve-token-1');
    expect(callConn?.query).toBe('');
    expect(callConn?.methods.slice(0, 3)).toEqual(['initialize', 'initialized', 'server_call']);
    expect(callConn?.environmentIds).toEqual(['environment-authenticated']);

    // The echoed readiness line (renderer log viewer / stdout) never carries
    // the token — it is redacted at the echo chokepoint.
    const echoed = rawOutput.join('');
    expect(echoed).toContain('"auth_token":"[redacted]"');
    expect(echoed).not.toContain('serve-token-1');
  });

  it('leaves authToken unset and dials without headers for an unauthenticated server', async () => {
    const child = makeMockChild();
    hoisted.nextChild = child;
    const statuses: WithTimestamp<AgentProcessStatus>[] = [];
    const proc = new AgentProcess({
      mode: 'serve',
      ipcRawOutput: () => {},
      onStatusChange: (s) => statuses.push(s),
      fetchFn: (async () => ({ status: 200 })) as unknown as typeof globalThis.fetch,
    });

    await proc.start({ profileName: 'host', sources: [] });
    child.emitStdout(
      `${JSON.stringify({
        sandbox_url: `http://127.0.0.1:${serve.port}`,
        ws_url: `ws://127.0.0.1:${serve.port}/ws`,
        ui_url: `http://127.0.0.1:${serve.port}`,
        agent_host_id: 'agent-host-unauthenticated',
        workspace_id: 'workspace-unauthenticated',
        environment_id: 'environment-unauthenticated',
        auth_token: null,
        services: {},
        ports: { ui: serve.port },
      })}\n`
    );

    await waitFor(() => statuses.some((s) => s.type === 'running'));
    const connecting = statuses.find((s) => s.type === 'connecting');
    if (connecting?.type !== 'connecting') {
      throw new Error('no connecting status');
    }
    expect(connecting.data.authToken).toBeUndefined();
    expect(serve.connections[0]!.authorization).toBeUndefined();
  });
});
