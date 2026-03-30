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

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);
const HOST = process.env['HOST'] ?? '0.0.0.0';

const main = async () => {
  const fastify = Fastify({ logger: true });

  // WebSocket plugin
  await fastify.register(fastifyWebsocket);

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

  // Wire global (shared) IPC handlers — store, util, config, project
  const { cleanupProject } = wireGlobalHandlers({ wsHandler, store });

  // WebSocket route — each new connection gets its own manager instances.
  // Clients send a sessionId query param; if the server has an existing session
  // for that ID the client reattaches to its running managers/containers.
  await fastify.register(async function wsRoutes(f) {
    f.get('/ws', { websocket: true }, (socket, request) => {
      const url = new URL(request.url, `http://${request.hostname}`);
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

  // Graceful shutdown — clean up all persistent sessions + project manager
  const shutdown = async () => {
    fastify.log.info('Shutting down...');
    await wsHandler.cleanupAllSessions();
    await cleanupProject();
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
