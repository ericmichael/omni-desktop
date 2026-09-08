// @vitest-environment node
import { createServer } from 'node:http';

import { expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { WsHandler } from './ws-handler';

const duration = Number(process.env.OMNI_CONNECTION_SOAK_MS ?? 0);
it.skipIf(!duration)(
  'soaks real document sockets and verifies cleanup returns to baseline each cycle',
  async () => {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    const handler = new WsHandler(20);
    let created = 0;
    let cleaned = 0;
    handler.handle('ping', () => 'pong');
    wss.on('connection', (ws) =>
      handler.addClient(ws, (session) => {
        created++;
        session.setCleanup(async () => {
          cleaned++;
        });
      })
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const baseline = process.memoryUsage();
    const started = Date.now();
    let cycles = 0;
    try {
      while (Date.now() - started < duration) {
        const clients = await Promise.all(
          Array.from({ length: 20 }, async () => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}`);
            await new Promise<void>((resolve, reject) => {
              ws.once('open', resolve);
              ws.once('error', reject);
            });
            const response = new Promise((resolve) => ws.once('message', (raw) => resolve(JSON.parse(String(raw)))));
            ws.send(JSON.stringify({ type: 'invoke', id: 1, channel: 'ping', args: [] }));
            expect(await response).toMatchObject({ result: 'pong' });
            return ws;
          })
        );
        await Promise.all(
          clients.map(
            (ws) =>
              new Promise<void>((resolve) => {
                ws.once('close', resolve);
                ws.close();
              })
          )
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(cleaned).toBe(created);
        const state = handler as unknown as {
          wsSessions: Map<unknown, unknown>;
          persistentSessions: Map<unknown, unknown>;
          cleanupJobs: Set<unknown>;
        };
        expect([state.wsSessions.size, state.persistentSessions.size, state.cleanupJobs.size]).toEqual([0, 0, 0]);
        cycles++;
        await new Promise((resolve) => setTimeout(resolve, 1900));
      }
      console.log(
        'SOAK_RESULT',
        JSON.stringify({
          durationMs: Date.now() - started,
          cycles,
          created,
          cleaned,
          baseline,
          final: process.memoryUsage(),
        })
      );
    } finally {
      for (const client of wss.clients) {
        client.terminate();
      }
      await handler.cleanupAllSessions();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  duration + 30_000
);
