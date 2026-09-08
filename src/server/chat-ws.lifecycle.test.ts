import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import type { ResidentAgentManager } from '@/main/resident-agent-manager';
import { registerChatWsRoute } from '@/server/chat-ws';
import { signRuntimeToken } from '@/server/runtime-token';

const state = vi.hoisted(() => ({
  listeners: new Set<(event: unknown) => void>(),
  hello: vi.fn(() => ({ self: 'human' })),
}));
vi.mock('@/main/chat-service', () => ({
  ChatService: class {
    hello = state.hello;
    subscribe(cb: (event: unknown) => void) {
      state.listeners.add(cb);
      return () => state.listeners.delete(cb);
    }
  },
}));

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const stop of cleanup.reverse()) {
    await stop();
  }
  cleanup.length = 0;
  state.listeners.clear();
  vi.clearAllMocks();
});

async function start(ready = Promise.resolve()) {
  let member = true;
  const app = Fastify();
  await app.register(fastifyWebsocket);
  registerChatWsRoute(app, {
    runtimeTokenSecret: 'secret',
    teamsEnabled: true,
    principalClaims: () => ({}),
    bridgeKeys: [],
    resolveActiveTeam: async () => (member ? 'team' : null),
    getResidentManager: () => ({ whenReady: ready }) as ResidentAgentManager,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  cleanup.push(() => app.close());
  const address = app.server.address() as { port: number };
  const token = signRuntimeToken('secret', { purpose: 'launcher', tenantId: 'human', sessionId: 'doc' });
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws/chat?token=${token}`);
  cleanup.push(() => ws.terminate());
  const frames: unknown[] = [];
  ws.on('message', (raw) => frames.push(JSON.parse(String(raw))));
  await new Promise<void>((resolve) => ws.once('open', resolve));
  return {
    ws,
    frames,
    revoke: () => {
      member = false;
    },
  };
}

it('retains an immediate request through delayed startup', async () => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { ws, frames } = await start(ready);
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chat.hello' }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  await expect.poll(() => frames.length).toBe(1);
  expect(frames[0]).toMatchObject({ id: 1, result: { self: 'human' } });
});

it('does not install a subscription after disconnect during startup', async () => {
  let release!: () => void;
  const { ws } = await start(
    new Promise<void>((resolve) => {
      release = resolve;
    })
  );
  const closed = new Promise((resolve) => ws.once('close', resolve));
  ws.close();
  await closed;
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(state.listeners.size).toBe(0);
});

it('blocks dispatch and notifications after membership revocation', async () => {
  const { ws, frames, revoke } = await start();
  await expect.poll(() => state.listeners.size).toBe(1);
  const closed = new Promise((resolve) => ws.once('close', resolve));
  revoke();
  for (const listener of state.listeners) {
    listener({ method: 'chat.message_added', params: { secret: true } });
  }
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chat.hello' }));
  expect(await closed).toBe(4403);
  expect(frames).toEqual([]);
  expect(state.hello).not.toHaveBeenCalled();
  await expect.poll(() => state.listeners.size).toBe(0);
});

it('rejects JSON null without an unhandled rejection', async () => {
  const { ws, frames } = await start();
  ws.send('null');
  await expect.poll(() => frames.length).toBe(1);
  expect(frames[0]).toMatchObject({ error: { code: -32600 } });
});
