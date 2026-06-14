/**
 * Cloud-side reverse proxy for `/proxy/local/:machineId/:sessionId/*`.
 *
 * Sandbox WS URLs the cloud's `ProcessManager` returns to a renderer that is
 * NOT on the same outbound IP as the laptop are rewritten through this route
 * (see `proxy-rewriter.rewriteStatusUrls`). The cloud:
 *
 *   - For HTTP: invokes `compute:tunnel-http` reverse-RPC against the
 *     laptop's WS, returns the response to the client.
 *   - For WS: assigns a `tunnelId`, opens the inner WS via
 *     `compute:tunnel-ws-open`, writes every client frame via
 *     `compute:tunnel-ws-write`. The laptop pushes inbound frames back
 *     through the renderer's `tunnel:incoming` invoke, which this module
 *     routes by `tunnelId` to the awaiting client socket.
 *
 * For v1 we don't try to be clever about flow control or backpressure — a
 * misbehaving sandbox can wedge a single tunnel but each tunnel is isolated
 * to one sessionId, so the blast radius is contained.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';

import { uuidv4 } from '@/lib/uuid';
import type { MachineRegistry } from '@/server/machine-registry';
import type { WsHandler } from '@/server/ws-handler';

type ActiveTunnel = {
  clientSocket: WebSocket;
};

/** Per-cloud-process tunnel registry, keyed by the cloud-minted tunnelId. */
const tunnels = new Map<string, ActiveTunnel>();

let listenerWired = false;

const newTunnelId = (): string => `tn-${uuidv4()}`;

export const setupLocalTunnelProxy = (
  fastify: FastifyInstance,
  wsHandler: WsHandler,
  registry: MachineRegistry
): void => {
  if (!listenerWired) {
    // Receive laptop → cloud inbound tunnel frames. Route by tunnelId to the
    // awaiting client socket; close + cleanup on `close: true`.
    wsHandler.handleCtx('tunnel:incoming', async (_ctx, raw: unknown) => {
      const evt = (raw ?? {}) as {
        tunnelId: string;
        dataBase64: string;
        binary: boolean;
        close?: boolean;
      };
      const tunnel = tunnels.get(evt.tunnelId);
      if (!tunnel) {
        return;
      } // unknown / late frame
      if (evt.close) {
        try {
          tunnel.clientSocket.close();
        } catch {
          /* ignore */
        }
        tunnels.delete(evt.tunnelId);
        return;
      }
      if (tunnel.clientSocket.readyState !== 1 /* OPEN */) {
        return;
      }
      const buf = Buffer.from(evt.dataBase64, 'base64');
      tunnel.clientSocket.send(evt.binary ? buf : buf.toString('utf-8'));
    });
    listenerWired = true;
  }

  void fastify.register(async function localTunnelRoutes(f) {
    // HTTP + WS share the same path. WS upgrades go to `wsHandler`; everything
    // else is a request/response round-trip relayed via reverse-RPC.
    f.route({
      method: 'GET',
      url: '/proxy/local/:machineId/:sessionId/:port/*',
      handler: async (request, reply) => {
        return handleHttp(request, reply, wsHandler, registry);
      },
      wsHandler: (clientSocket, request) => {
        handleWs(clientSocket, request, wsHandler, registry);
      },
    });
    const methods = ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] as const;
    for (const method of methods) {
      f.route({
        method,
        url: '/proxy/local/:machineId/:sessionId/:port/*',
        handler: async (request, reply) => {
          return handleHttp(request, reply, wsHandler, registry);
        },
      });
    }
  });
};

/**
 * Target on the laptop is derived purely from the `:port` path segment — the
 * cloud (or renderer) addresses a specific loopback port on the machine
 * (the `omni sandbox-host` exec server, or an exposed service port). The
 * `tunnel-handler` on the laptop dials `127.0.0.1:<port>`.
 */
const resolveUpstream = (port: string, subPath: string, query: string): string | null => {
  const n = Number.parseInt(port, 10);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    return null;
  }
  return `http://127.0.0.1:${n}/${subPath}${query}`;
};

async function handleHttp(
  request: FastifyRequest,
  reply: FastifyReply,
  wsHandler: WsHandler,
  registry: MachineRegistry
): Promise<void> {
  const { machineId, port } = request.params as { machineId: string; port: string };
  const wildcard = (request.params as { '*': string })['*'] ?? '';
  const query = request.url.includes('?') ? `?${request.url.split('?')[1]}` : '';
  const url = resolveUpstream(port, wildcard, query);
  if (!url) {
    reply.code(502).send({ error: 'Invalid local tunnel port' });
    return;
  }
  const ws = registry.getActiveWs(machineId);
  if (!ws) {
    reply.code(503).send({ error: 'host-offline' });
    return;
  }
  // Strip hop-by-hop / sensitive headers; the laptop's fetch will set its own.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(request.headers)) {
    if (k === 'host' || k === 'connection' || k === 'keep-alive') {
      continue;
    }
    if (typeof v === 'string') {
      headers[k] = v;
    }
  }
  const body =
    request.method !== 'GET' && request.method !== 'HEAD'
      ? typeof request.body === 'string'
        ? request.body
        : JSON.stringify(request.body ?? '')
      : undefined;
  try {
    const envelope = await wsHandler.invokeOnWs<{
      status: number;
      statusText: string;
      headers: Record<string, string>;
      bodyBase64: string;
    }>(ws, 'compute:tunnel-http', [{ url, method: request.method, headers, body }]);
    reply.status(envelope.status);
    for (const [k, v] of Object.entries(envelope.headers ?? {})) {
      if (k === 'transfer-encoding' || k === 'content-encoding' || k === 'content-length') {
        continue;
      }
      reply.header(k, v);
    }
    reply.send(Buffer.from(envelope.bodyBase64, 'base64'));
  } catch (err) {
    reply.code(502).send({ error: 'tunnel-http failed', message: (err as Error).message });
  }
}

function handleWs(
  clientSocket: WebSocket,
  request: FastifyRequest,
  wsHandler: WsHandler,
  registry: MachineRegistry
): void {
  const { machineId, port } = request.params as { machineId: string; port: string };
  const wildcard = (request.params as { '*': string })['*'] ?? '';
  const query = request.url.includes('?') ? `?${request.url.split('?')[1]}` : '';
  const url = resolveUpstream(port, wildcard, query);
  if (!url) {
    clientSocket.close(4502, 'Invalid local tunnel port');
    return;
  }
  // http(s):// → ws(s):// for the upstream WS open call.
  const wsUrl = url.replace(/^http/i, 'ws');
  const laptopWs = registry.getActiveWs(machineId);
  if (!laptopWs) {
    clientSocket.close(4503, 'host-offline');
    return;
  }
  const tunnelId = newTunnelId();
  tunnels.set(tunnelId, { clientSocket });

  const closeClient = (code: number, reason?: string): void => {
    try {
      clientSocket.close(code, reason);
    } catch {
      /* ignore */
    }
    tunnels.delete(tunnelId);
  };

  const closeLaptop = (): void => {
    // Best-effort tell the laptop to release its half.
    const liveWs = registry.getActiveWs(machineId);
    if (!liveWs) {
      return;
    }
    void wsHandler.invokeOnWs(liveWs, 'compute:tunnel-ws-close', [{ tunnelId }]).catch(() => {});
  };

  // Open the inner WS on the laptop, THEN pump. `compute:tunnel-ws-open` is
  // async (the laptop has to dial 127.0.0.1:<port> and await its `open`), so a
  // client frame that arrives before it resolves would race ahead and hit
  // `tunnel-not-open` on the laptop — which is exactly what broke the
  // host_bridge exec channel (omni-serve sends `create` immediately on
  // connect). Buffer client frames until the open resolves, then flush in order.
  let opened = false;
  const pending: Array<{ b64: string; binary: boolean }> = [];

  const writeFrame = (b64: string, binary: boolean): void => {
    const liveWs = registry.getActiveWs(machineId);
    if (!liveWs) {
      closeClient(4503, 'host-offline');
      return;
    }
    void wsHandler
      .invokeOnWs(liveWs, 'compute:tunnel-ws-write', [{ tunnelId, dataBase64: b64, binary }])
      .catch((err) => {
        closeClient(4502, `tunnel-write failed: ${err.message ?? 'unknown'}`);
      });
  };

  void wsHandler
    .invokeOnWs(laptopWs, 'compute:tunnel-ws-open', [{ tunnelId, url: wsUrl }])
    .then(() => {
      opened = true;
      const queued = pending.splice(0);
      for (const f of queued) {
        writeFrame(f.b64, f.binary);
      }
    })
    .catch((err) => {
      closeClient(4502, `tunnel-open failed: ${err.message ?? 'unknown'}`);
    });

  clientSocket.on('message', (data, isBinary) => {
    const buf = isBinary ? Buffer.from(data as ArrayBuffer) : Buffer.from(String(data), 'utf-8');
    const b64 = buf.toString('base64');
    if (!opened) {
      pending.push({ b64, binary: isBinary });
      return;
    }
    writeFrame(b64, isBinary);
  });

  clientSocket.on('close', () => {
    closeLaptop();
    tunnels.delete(tunnelId);
  });
  clientSocket.on('error', () => {
    closeLaptop();
    tunnels.delete(tunnelId);
  });
}
