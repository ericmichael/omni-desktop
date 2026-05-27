import 'dotenv/config';

import { BlockList, isIPv4, isIPv6 } from 'node:net';

import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

// Server mode always runs as "development" so util.ts resolves paths from project root
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

import type { IncomingHttpHeaders } from 'node:http';

import { wireClientManagers, wireGlobalHandlers } from '@/server/managers';
import { MCP_PROJECTS_PATH, registerMcpHttpRoute } from '@/server/mcp-http';
import { setupProxyRewriter } from '@/server/proxy-rewriter';
import { ServerStore } from '@/server/store';
import { DEFAULT_TENANT, WsHandler } from '@/server/ws-handler';

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
 * When OMNI_AUTH_MODE=easyauth, the server runs behind Azure App Service
 * EasyAuth, which terminates authentication at the platform edge and injects
 * `X-MS-Client-Principal-*` headers it strips from inbound spoofing attempts.
 * In that mode we trust the principal id as the tenant. In every other mode
 * (loopback / Tailscale / dev) the server is single-tenant and the principal
 * headers are ignored — a client could otherwise forge them.
 */
const IS_EASYAUTH = (process.env['OMNI_AUTH_MODE'] ?? '') === 'easyauth';

/**
 * Resolve the authenticated tenant for a request. Returns null only in
 * easyauth mode when the principal header is missing (misconfiguration or an
 * unauthenticated request that slipped past the edge) — callers reject those.
 */
function resolveTenantId(headers: IncomingHttpHeaders): string | null {
  if (!IS_EASYAUTH) {
    return DEFAULT_TENANT;
  }
  const principalId = headers['x-ms-client-principal-id'];
  if (typeof principalId === 'string' && principalId.trim()) {
    return principalId.trim();
  }
  return null;
}

/**
 * Best-effort profile claims for the `users` table, from the EasyAuth headers
 * the edge injects: `x-ms-client-principal-name` (UPN/email), `-idp`, and the
 * base64 `x-ms-client-principal` claims blob (parsed for a display name).
 */
function principalClaims(headers: IncomingHttpHeaders): { email?: string; displayName?: string; idp?: string } {
  const str = (v: string | string[] | undefined): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;
  const email = str(headers['x-ms-client-principal-name']);
  const idp = str(headers['x-ms-client-principal-idp']);
  let displayName: string | undefined;
  const blob = str(headers['x-ms-client-principal']);
  if (blob) {
    try {
      const decoded = JSON.parse(Buffer.from(blob, 'base64').toString('utf-8')) as {
        claims?: Array<{ typ?: string; val?: string }>;
      };
      const nameClaim = decoded.claims?.find(
        (c) => c.typ === 'name' || c.typ === 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'
      );
      displayName = nameClaim?.val;
    } catch {
      // malformed blob — fall back to email-derived name
    }
  }
  return { email, idp, displayName: displayName ?? email };
}

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
    if (!addr) {
      return false;
    }
    // Strip IPv4-mapped IPv6 prefix so 100.x addresses match the IPv4 rules
    const normalized = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
    if (isIPv4(normalized)) {
      return list.check(normalized, 'ipv4');
    }
    if (isIPv6(normalized)) {
      return list.check(normalized, 'ipv6');
    }
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
    // Behind EasyAuth the request arrives via the platform edge (not loopback),
    // but it's already authenticated — the presence of the principal header is
    // sufficient. Otherwise fall back to the trusted-network allowlist.
    const easyauthOk = IS_EASYAUTH && typeof request.headers['x-ms-client-principal-id'] === 'string';
    if (!easyauthOk && !tokenAllowList.check(addr)) {
      reply.code(403).send({ error: 'Forbidden' });
      return;
    }
    reply.send({ token: wsToken });
  });

  // WebSocket handler
  const wsHandler = new WsHandler();
  const store = new ServerStore();

  // Set up reverse proxy URL rewriting for internal services (chat, sandbox, etc.).
  // Share the ws-token allowlist so /proxy/_register honors OMNI_TRUSTED_CIDRS too.
  setupProxyRewriter(fastify, wsHandler, tokenAllowList.check);

  // Wire global (shared) IPC handlers — store, util, config, project, code, chat, sandbox, install
  const {
    cleanupGlobalManagers,
    getProcessManager,
    ensureTenantReady,
    getTenantRepo,
    runtimeTokenSecret,
    teamsEnabled,
    ensureUserBootstrapped,
    resolveActiveTeam,
  } = await wireGlobalHandlers({
    wsHandler,
    store,
  });

  // HTTP MCP route — remote agent sandboxes reach their tenant's project data
  // here (authenticated by the signed runtime token). Local Electron/stdio
  // doesn't use it; it's harmless when no sandbox calls it.
  registerMcpHttpRoute(fastify, { runtimeTokenSecret, getTenantRepo });
  console.log(`[mcp-http] omni-projects MCP available at ${MCP_PROJECTS_PATH}`);

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
      // The authenticated identity (EasyAuth principal, or DEFAULT_TENANT).
      const principal = resolveTenantId(request.headers);
      if (principal === null) {
        socket.close(4401, 'Unauthorized');
        return;
      }
      const sessionId = url.searchParams.get('sessionId') ?? undefined;
      const requestedTeam = url.searchParams.get('team') ?? undefined;

      // In single-user/local mode the data scope IS the principal — bind
      // synchronously (no control plane). In teams/cloud mode we must first
      // bootstrap the user + resolve/verify their active team, which is async;
      // buffer any early frames and replay them so nothing is dropped.
      if (!teamsEnabled) {
        const ready = ensureTenantReady(principal);
        wsHandler.addClient(
          socket,
          (session) => {
            const cleanup = wireClientManagers({
              handle: session.handle,
              sendToWindow: session.sendToWindow,
              store,
              processManager: getProcessManager(principal),
            });
            session.setCleanup(cleanup);
          },
          sessionId,
          principal,
          ready,
          principal
        );
        return;
      }

      // Teams mode: buffer frames until (team, principal) is resolved.
      const buffered: unknown[] = [];
      const buffer = (raw: unknown): void => {
        buffered.push(raw);
      };
      socket.on('message', buffer);
      void (async () => {
        try {
          const claims = principalClaims(request.headers);
          await ensureUserBootstrapped(principal, claims);
          const teamId = await resolveActiveTeam(principal, requestedTeam);
          if (teamId === null) {
            socket.close(4403, 'Forbidden: not a member of the requested team');
            return;
          }
          const ready = ensureTenantReady(teamId, principal);
          socket.off('message', buffer);
          wsHandler.addClient(
            socket,
            (session) => {
              const cleanup = wireClientManagers({
                handle: session.handle,
                sendToWindow: session.sendToWindow,
                store,
                processManager: getProcessManager(teamId, principal),
              });
              session.setCleanup(cleanup);
            },
            sessionId,
            teamId,
            ready,
            principal
          );
          // Replay frames that arrived during async resolution.
          for (const raw of buffered) socket.emit('message', raw);
        } catch (err) {
          console.error('[ws] team resolution failed:', err);
          socket.close(4500, 'Server error during team resolution');
        }
      })();
    });
  });

  // MCP-Apps sandbox proxy. Mirrors the ``mcp-sandbox://`` Electron
  // protocol (see src/main/index.ts) but with a same-origin caveat:
  // in browser mode the proxy URL shares an origin with the renderer,
  // so guest UIs get less isolation than under Electron. The mcp-ui
  // double-iframe + document.write pattern still buys some separation
  // for the rawhtml flow. Use Electron for full cross-origin sandboxing.
  const sandboxHtmlPath = resolve(__dirname, '../..', 'assets', 'mcp-sandbox', 'index.html');
  fastify.get('/mcp-sandbox/index.html', (_request, reply) => {
    if (!existsSync(sandboxHtmlPath)) {
      return reply.code(404).send('Not found');
    }
    return reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header(
        'Content-Security-Policy',
        [
          "default-src 'none'",
          "script-src 'unsafe-inline' https:",
          "style-src 'unsafe-inline' https:",
          'font-src https: data:',
          'img-src https: data: blob:',
          'connect-src https: wss: ws: data: blob:',
          'frame-src about: data: blob: https: http:',
        ].join('; ')
      )
      .send(readFileSync(sandboxHtmlPath));
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
