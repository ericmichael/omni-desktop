/**
 * /ws/chat (docs/chat-v1-plan.md): token/bridge-key auth, JSON-RPC dispatch,
 * notification fan-out, resume-by-cursor, and the OpenRPC parity check that
 * keeps protocol/chat-v1/openrpc.json aligned with the method map.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDatabase, ProjectsRepo, SqliteProjectsRepo } from 'omni-projects-db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import type { ProcessManager } from '@/main/process-manager';
import { ResidentAgentManager } from '@/main/resident-agent-manager';
import { registerChatWsRoute } from '@/server/chat-ws';
import { signRuntimeToken } from '@/server/runtime-token';
import { CHAT_METHOD_NAMES, CHAT_NOTIFICATION_NAMES, type StoreData } from '@/shared/types';

const SECRET = 'test-secret';
const BRIDGE_KEY = 'bridge-key-123';
const now = 1_753_250_000_000;

let tmpDir: string;
let db: ReturnType<typeof openDatabase>;
let manager: ResidentAgentManager;
let fastify: FastifyInstance;
let baseUrl: string;
const clients: WebSocket[] = [];

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'chat-ws-test-'));
  db = openDatabase(join(tmpDir, 'projects.db'));
  manager = new ResidentAgentManager({
    store: {
      get: <K extends keyof StoreData>(key: K): StoreData[K] =>
        (({ residentMorningBeats: {} }) as Partial<StoreData>)[key] as StoreData[K],
      set: () => {},
    } as ConstructorParameters<typeof ResidentAgentManager>[0]['store'],
    repo: new SqliteProjectsRepo(new ProjectsRepo(db)),
    processManager: {} as ProcessManager,
    sendToWindow: () => {},
    now: () => now,
  });
  await manager.whenReady;

  fastify = Fastify();
  await fastify.register(fastifyWebsocket);
  await fastify.register(async (f) => {
    registerChatWsRoute(f, {
      runtimeTokenSecret: SECRET,
      getResidentManager: () => manager,
      teamsEnabled: false,
      principalClaims: () => ({}),
      bridgeKeys: [BRIDGE_KEY],
    });
  });
  await fastify.listen({ port: 0 });
  const address = fastify.server.address();
  baseUrl = `ws://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterEach(async () => {
  for (const ws of clients) {
    try {
      ws.terminate();
    } catch {
      /* ignore */
    }
  }
  clients.length = 0;
  await fastify.close();
  await manager.cleanup();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const mintToken = (): string =>
  signRuntimeToken(SECRET, { tenantId: 'local', principalId: 'local', sessionId: 's1' }, 300);

type Rpc = {
  ws: WebSocket;
  call: (method: string, params?: unknown) => Promise<unknown>;
  notifications: Array<{ method: string; params: unknown }>;
  errors: Array<{ code: number; message: string; data?: { kind?: string } }>;
};

async function connect(token: string): Promise<Rpc> {
  const ws = new WebSocket(`${baseUrl}/ws/chat?token=${encodeURIComponent(token)}`);
  clients.push(ws);
  const notifications: Rpc['notifications'] = [];
  const errors: Rpc['errors'] = [];
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw)) as {
      id?: number | null;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string; data?: { kind?: string } };
    };
    if (typeof msg.method === 'string') {
      notifications.push({ method: msg.method, params: msg.params });
      return;
    }
    if (typeof msg.id === 'number') {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) {
        errors.push(msg.error);
        p?.reject(Object.assign(new Error(msg.error.message), { data: msg.error.data }));
      } else {
        p?.resolve(msg.result);
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('close', (code) => reject(new Error(`closed ${code}`)));
    ws.once('error', reject);
  });
  return {
    ws,
    notifications,
    errors,
    call: (method, params) => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }));
      });
    },
  };
}

const closedWith = (token: string): Promise<number> => {
  const ws = new WebSocket(`${baseUrl}/ws/chat${token ? `?token=${encodeURIComponent(token)}` : ''}`);
  clients.push(ws);
  return new Promise((resolve) => {
    ws.once('close', (code) => resolve(code));
  });
};

describe('auth', () => {
  it('closes 4401 without a token or with a forged one', async () => {
    expect(await closedWith('')).toBe(4401);
    expect(await closedWith('not-a-real-token')).toBe(4401);
  });
});

describe('JSON-RPC surface', () => {
  it('answers hello with the collective-user identity in single-user mode', async () => {
    const rpc = await connect(mintToken());
    expect(await rpc.call('chat.hello')).toEqual({
      protocol: 'chat-v1',
      self: { id: 'user', name: null },
      capabilities: [],
    });
  });

  it('rejects unknown methods with -32601', async () => {
    const rpc = await connect(mintToken());
    await expect(rpc.call('chat.nope')).rejects.toThrow(/Unknown method/);
    expect(rpc.errors[0]?.code).toBe(-32601);
  });

  it('posts, notifies OTHER clients, and resumes by cursor', async () => {
    const alice = await connect(mintToken());
    const bob = await connect(mintToken());
    const posted = (await alice.call('chat.post_message', { channel: 'team', text: 'hello from a' })) as {
      message: { id: number; from: string };
    };
    expect(posted.message.from).toBe('user');
    // The other connection sees the notification.
    await expect.poll(() => bob.notifications.filter((n) => n.method === 'chat.message_added')).toHaveLength(1);
    // Resume: everything after cursor 0 includes the post (durable-log replay).
    const page = (await bob.call('chat.list_messages', { after: 0 })) as { messages: Array<{ id: number }> };
    expect(page.messages.map((m) => m.id)).toContain(posted.message.id);
  });

  it('maps facade errors to -32000 with a data.kind', async () => {
    const rpc = await connect(mintToken());
    await expect(rpc.call('chat.post_message', { channel: 'nope', text: 'x' })).rejects.toThrow(/Unknown channel/);
    expect(rpc.errors[0]).toMatchObject({ code: -32000, data: { kind: 'unknown_channel' } });
  });
});

describe('bridge scope', () => {
  it('authenticates by raw key, requires asExternal, and stamps ext ids', async () => {
    const rpc = await connect(BRIDGE_KEY);
    expect(await rpc.call('chat.hello')).toMatchObject({ self: { id: 'bridge' } });
    await expect(rpc.call('chat.post_message', { channel: 'team', text: 'x' })).rejects.toThrow(/asExternal/);
    const posted = (await rpc.call('chat.post_message', {
      channel: 'team',
      text: 'relayed',
      asExternal: { network: 'slack', id: 'U7', displayName: 'Sam' },
    })) as { message: { from: string; fromName: string } };
    expect(posted.message).toMatchObject({ from: 'ext:slack:U7', fromName: 'Sam' });
  });

  it('never grants bridge scope to minted tokens', async () => {
    const rpc = await connect(mintToken());
    await expect(
      rpc.call('chat.post_message', {
        channel: 'team',
        text: 'x',
        asExternal: { network: 'slack', id: 'U7', displayName: 'Sam' },
      })
    ).rejects.toThrow(/bridge scope/);
    expect(rpc.errors[0]?.data?.kind).toBe('forbidden');
  });
});

describe('OpenRPC parity', () => {
  it('the published document lists exactly the method map + notifications', () => {
    // vitest runs from the repo root; import.meta.url is not file-scheme here.
    const doc = JSON.parse(readFileSync(join(process.cwd(), 'protocol/chat-v1/openrpc.json'), 'utf-8')) as {
      methods: Array<{ name: string; 'x-omni-kind'?: string }>;
    };
    const requests = doc.methods.filter((m) => m['x-omni-kind'] !== 'notification').map((m) => m.name);
    const notifications = doc.methods.filter((m) => m['x-omni-kind'] === 'notification').map((m) => m.name);
    expect(requests.sort()).toEqual([...CHAT_METHOD_NAMES].sort());
    expect(notifications.sort()).toEqual([...CHAT_NOTIFICATION_NAMES].sort());
  });
});
