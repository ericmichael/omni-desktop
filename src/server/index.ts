import 'dotenv/config';

import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import { existsSync } from 'fs';
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

const main = async () => {
  const fastify = Fastify({ logger: true });

  // Generate (or read) a WebSocket auth token. Clients must present this as
  // a ?token= query param on the /ws connection. Loopback browser clients
  // can fetch it via GET /api/ws-token; non-browser clients should use the
  // OMNI_WS_TOKEN env var printed below.
  const wsToken = process.env['OMNI_WS_TOKEN'] ?? crypto.randomUUID();
  console.log('[auth] WS token:', wsToken);

  // WebSocket plugin
  await fastify.register(fastifyWebsocket);

  // Loopback-only endpoint so the browser SPA can pick up the token before
  // opening its WebSocket connection.
  fastify.get('/api/ws-token', (request, reply) => {
    const addr = request.socket.remoteAddress ?? '';
    const isLoopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
    if (!isLoopback) {
      reply.code(403).send({ error: 'Forbidden' });
      return;
    }
    reply.send({ token: wsToken });
  });

  // Serve the built browser renderer as static files
  const staticDir = resolve(__dirname, '../browser');
  if (existsSync(staticDir)) {
    await fastify.register(fastifyStatic, {
      root: staticDir,
      prefix: '/',
    });
  } else {
    fastify.log.warn(`Static dir not found: ${staticDir}. Renderer will not be served.`);
  }

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
