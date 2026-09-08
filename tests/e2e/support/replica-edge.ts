/** Local test edge only. Simulates authenticated identities; never deploy. */
import { createServer, request as httpRequest } from 'node:http';

import { WebSocket, WebSocketServer } from 'ws';

export async function startReplicaEdge(backends: string[]) {
  let next = 0;
  const routed: number[] = [];
  const choose = () => {
    const index = next++ % backends.length;
    routed.push(index);
    return backends[index]!;
  };
  const upstreams = new Set<WebSocket>();
  const server = createServer((req, res) => {
    const headers = { ...req.headers };
    delete headers['x-ms-client-principal-id'];
    delete headers['x-ms-client-principal'];
    const identity = headers['x-audit-identity'];
    delete headers['x-audit-identity'];
    if (identity !== 'local' && identity !== 'edge-other') {
      res.writeHead(401).end();
      return;
    }
    headers['x-ms-client-principal-id'] = identity;
    const target = new URL(req.url!, choose());
    const upstream = httpRequest(target, { method: req.method, headers }, (response) => {
      res.writeHead(response.statusCode!, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const target = new URL(req.url!, choose());
    target.protocol = 'ws:';
    wss.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(target);
      upstreams.add(upstream);
      const pending: Array<{ data: Buffer; binary: boolean }> = [];
      client.on('message', (data, binary) => {
        const frame = Buffer.from(data as ArrayBuffer);
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(frame, { binary });
        } else {
          pending.push({ data: frame, binary });
        }
      });
      upstream.on('open', () => {
        for (const frame of pending.splice(0)) {
          upstream.send(frame.data, { binary: frame.binary });
        }
      });
      upstream.on('message', (data, binary) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(data, { binary });
        }
      });
      client.on('close', () => upstream.close());
      upstream.on('close', (code) => {
        upstreams.delete(upstream);
        client.close(code === 1006 ? 1011 : code);
      });
      upstream.on('error', () => client.close(1011));
      client.on('error', () => upstream.close());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    routed,
    async close() {
      for (const ws of wss.clients) {
        ws.terminate();
      }
      for (const ws of upstreams) {
        ws.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
