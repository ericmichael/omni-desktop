import 'dotenv/config';

import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import { existsSync } from 'fs';
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { join, resolve } from 'path';

// Server mode always runs as "development" so util.ts resolves paths from project root
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

import { wireClientManagers, wireGlobalHandlers } from '@/server/managers';
import { setupProxyRewriter } from '@/server/proxy-rewriter';
import { ServerStore } from '@/server/store';
import { WsHandler } from '@/server/ws-handler';

// Process-level crash visibility. Log only — do not exit. The server
// process is typically managed externally (systemd, pm2, docker), so
// killing on an unhandled rejection would mask the underlying bug under
// a restart loop. Log loudly and let the operator decide.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err);
});

const PORT = parseInt(process.env['PORT'] ?? '3001', 10);
const HOST = process.env['HOST'] ?? '0.0.0.0';

/**
 * Build the allowlist for /api/ws-token. Loopback is always trusted; additional
 * networks can be opted in via OMNI_TRUSTED_CIDRS (comma-separated).
 *
 * Example for Tailscale: OMNI_TRUSTED_CIDRS=100.64.0.0/10,fd7a:115c:a1e0::/48
 *
 * Anything outside this allowlist must supply the token explicitly via
 * ?token= or OMNI_WS_TOKEN, since the token endpoint is what gates /ws auth.
 */
function buildTokenAllowList(): { check: (addr: string) => boolean; describe: () => string } {
  const list = new BlockList();
  list.addAddress('127.0.0.1', 'ipv4');
  list.addAddress('::1', 'ipv6');

  const cidrs = (process.env['OMNI_TRUSTED_CIDRS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const cidr of cidrs) {
    const slash = cidr.indexOf('/');
    if (slash < 0) {
      console.warn(`[auth] OMNI_TRUSTED_CIDRS entry missing prefix length, skipping: "${cidr}"`);
      continue;
    }
    const base = cidr.slice(0, slash);
    const prefix = parseInt(cidr.slice(slash + 1), 10);
    const family = isIPv6(base) ? 'ipv6' : isIPv4(base) ? 'ipv4' : null;
    if (!family || !Number.isFinite(prefix)) {
      console.warn(`[auth] OMNI_TRUSTED_CIDRS invalid entry, skipping: "${cidr}"`);
      continue;
    }
    list.addSubnet(base, prefix, family);
  }

  const check = (addr: string): boolean => {
    if (!addr) return false;
    // Strip IPv4-mapped IPv6 prefix so 100.x addresses match the IPv4 rules
    const normalized = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
    if (isIPv4(normalized)) return list.check(normalized, 'ipv4');
    if (isIPv6(normalized)) return list.check(normalized, 'ipv6');
    return false;
  };

  return { check, describe: () => (cidrs.length > 0 ? `loopback + ${cidrs.join(', ')}` : 'loopback only') };
}

const main = async () => {
  const fastify = Fastify({ logger: true });

  // Generate (or read) a WebSocket auth token. Clients must present this as
  // a ?token= query param on the /ws connection. Trusted-network browser
  // clients can fetch it via GET /api/ws-token; non-browser clients should
  // use the OMNI_WS_TOKEN env var printed below.
  const wsToken = process.env['OMNI_WS_TOKEN'] ?? crypto.randomUUID();
  console.log('[auth] WS token:', wsToken);

  const tokenAllowList = buildTokenAllowList();
  console.log(`[auth] /api/ws-token trusted networks: ${tokenAllowList.describe()}`);

  // WebSocket plugin
  await fastify.register(fastifyWebsocket);

  // Token endpoint — restricted to trusted networks (loopback by default;
  // extend via OMNI_TRUSTED_CIDRS, e.g. "100.64.0.0/10" for Tailscale).
  fastify.get('/api/ws-token', (request, reply) => {
    const addr = request.socket.remoteAddress ?? '';
    if (!tokenAllowList.check(addr)) {
      reply.code(403).send({ error: 'Forbidden' });
      return;
    }
    reply.send({ token: wsToken });
  });

  // WebSocket handler
  const wsHandler = new WsHandler();
  const store = new ServerStore();

  // Set up reverse proxy URL rewriting for internal services (chat, sandbox, etc.)
  setupProxyRewriter(fastify, wsHandler);

  // Wire global (shared) IPC handlers — store, util, config, project, code, chat, sandbox, install
  const { cleanupGlobalManagers } = wireGlobalHandlers({ wsHandler, store });

  // WebSocket route — each new connection gets its own manager instances.
  // Clients send a sessionId query param; if the server has an existing session
  // for that ID the client reattaches to its running managers/containers.
  await fastify.register(async function wsRoutes(f) {
    f.get('/ws', { websocket: true }, (socket, request) => {
      const url = new URL(request.url, `http://${request.hostname}`);
      const token = url.searchParams.get('token');
      if (token !== wsToken) {
        socket.close(4401, 'Unauthorized');
        return;
      }
      const sessionId = url.searchParams.get('sessionId') ?? undefined;

      wsHandler.addClient(
        socket,
        (session) => {
          const cleanup = wireClientManagers({
            handle: session.handle,
            sendToWindow: session.sendToWindow,
            store,
          });
          session.setCleanup(cleanup);
        },
        sessionId
      );
    });
  });

  // Serve the built browser renderer as static files. In dev:server mode the
  // browser bundle is rebuilt on save (`vite build --watch`), so saves
  // propagate without a manual rebuild — but the page still has to be
  // reloaded (no HMR via this path). For full HMR, hit Vite directly on its
  // dev port (`http://<host>:5173`); Vite is configured to proxy /api, /ws,
  // and /proxy back to this server.
  const staticDir = resolve(__dirname, '../browser');
  if (existsSync(staticDir)) {
    await fastify.register(fastifyStatic, {
      root: staticDir,
      prefix: '/',
    });
  } else {
    fastify.log.warn(`Static dir not found: ${staticDir}. Renderer will not be served.`);
  }

  // SPA fallback: serve index.html for non-API, non-WS routes
  fastify.setNotFoundHandler((_request, reply) => {
    const indexPath = join(staticDir, 'index.html');
    if (existsSync(indexPath)) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'Not found' });
  });

  // Graceful shutdown — clean up all persistent sessions + global managers
  const shutdown = async () => {
    fastify.log.info('Shutting down...');
    await wsHandler.cleanupAllSessions();
    await cleanupGlobalManagers();
    await fastify.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  // Start
  await fastify.listen({ port: PORT, host: HOST });
  fastify.log.info(`Server listening on http://${HOST}:${PORT}`);
};

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
