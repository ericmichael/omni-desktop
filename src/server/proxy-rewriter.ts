import { WebSocket as WsWebSocket } from 'ws';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { WsHandler } from '@/server/ws-handler';

/** Map from proxy prefix (e.g. "chat-uiUrl") to upstream origin (e.g. "http://localhost:8082") */
const upstreamMap = new Map<string, string>();

/**
 * Register the wildcard proxy route, WebSocket proxy routes, and URL rewriting interceptors.
 * Must be called BEFORE fastify.listen() so routes are registered at boot time.
 */
export const setupProxyRewriter = (fastify: FastifyInstance, wsHandler: WsHandler): void => {
  // --- Combined HTTP + WebSocket proxy ---
  // Register inside a plugin so GET can handle both HTTP and WS upgrades on the same path.
  void fastify.register(async function proxyRoutes(f) {
    // GET handles both normal HTTP GET and WebSocket upgrades via full declaration syntax
    f.route({
      method: 'GET',
      url: '/proxy/:proxyName/*',
      handler: async (request, reply) => {
        return handleHttpProxy(request, reply);
      },
      wsHandler: (clientSocket, request) => {
        const upstreamPath = '/' + (request.params as { '*': string })['*'];
        handleWsProxy(clientSocket, request, upstreamPath);
      },
    });

    // Non-GET HTTP methods (POST, PUT, DELETE, etc.)
    const methods = ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] as const;
    for (const method of methods) {
      f.route({
        method,
        url: '/proxy/:proxyName/*',
        handler: async (request, reply) => {
          return handleHttpProxy(request, reply);
        },
      });
    }
  });

  fastify.log.info('Proxy routes registered at /proxy/:proxyName/*');

  // --- URL rewriting via event interceptor ---
  // Intercepts all outgoing events (both sendToAll and sendTo) to rewrite URLs.
  wsHandler.addEventInterceptor((channel, args) => {
    if (channel === 'sandbox-process:status' || channel === 'chat-process:status') {
      const status = args[0] as Record<string, unknown> | undefined;
      if (status && (status.type === 'running' || status.type === 'connecting') && status.data) {
        rewriteStatusUrls(status.data as Record<string, string | undefined>, channel === 'chat-process:status' ? 'chat' : 'sandbox');
      }
    }

    if (channel === 'code:sandbox-status') {
      const tabId = args[0] as string;
      const status = args[1] as Record<string, unknown> | undefined;
      if (status && (status.type === 'running' || status.type === 'connecting') && status.data) {
        rewriteStatusUrls(status.data as Record<string, string | undefined>, `code-${tabId}`);
      }
    }

    if (channel === 'project:task-status') {
      const taskId = args[0] as string;
      const status = args[1] as Record<string, unknown> | undefined;
      if (status && (status.type === 'running' || status.type === 'connecting') && status.data) {
        rewriteStatusUrls(status.data as Record<string, string | undefined>, `project-${taskId}`);
      }
    }
  });

  // --- URL rewriting for invoke responses via result wrappers ---
  // Result wrappers receive a structuredClone from WsHandler, safe to mutate directly.
  wsHandler.addResultWrapper('sandbox-process:get-status', (result) => {
    const status = result as Record<string, unknown> | undefined;
    if (status && (status.type === 'running' || status.type === 'connecting') && status.data) {
      rewriteStatusUrls(status.data as Record<string, string | undefined>, 'sandbox');
    }
    return result;
  });

  wsHandler.addResultWrapper('chat-process:get-status', (result) => {
    const status = result as Record<string, unknown> | undefined;
    if (status && (status.type === 'running' || status.type === 'connecting') && status.data) {
      rewriteStatusUrls(status.data as Record<string, string | undefined>, 'chat');
    }
    return result;
  });

  wsHandler.addResultWrapper('code:get-sandbox-status', (result, args) => {
    const tabId = args[0] as string;
    const status = result as Record<string, unknown> | undefined;
    if (status && (status.type === 'running' || status.type === 'connecting') && status.data) {
      rewriteStatusUrls(status.data as Record<string, string | undefined>, `code-${tabId}`);
    }
    return result;
  });

  wsHandler.addResultWrapper('project:get-tasks', (result) => {
    const tasks = result as Array<{ id: string; status: Record<string, unknown> }> | undefined;
    if (Array.isArray(tasks)) {
      for (const task of tasks) {
        if (task.status && task.status.type === 'running' && task.status.data) {
          rewriteStatusUrls(task.status.data as Record<string, string | undefined>, `project-${task.id}`);
        }
      }
    }
    return result;
  });
};

/**
 * Proxy an HTTP request to the upstream service.
 */
async function handleHttpProxy(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { proxyName } = request.params as { proxyName: string; '*': string };
  const wildcard = (request.params as { '*': string })['*'];
  const upstream = upstreamMap.get(proxyName);

  if (!upstream) {
    reply.code(502).send({ error: `No upstream registered for proxy "${proxyName}"` });
    return;
  }

  const targetUrl = `${upstream}/${wildcard}${request.url.includes('?') ? `?${request.url.split('?')[1]}` : ''}`;

  try {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (key === 'host' || key === 'connection') continue;
      if (typeof value === 'string') headers[key] = value;
    }

    const response = await globalThis.fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? (request.body as BodyInit) : undefined,
      // @ts-expect-error -- Node fetch supports duplex for streaming
      duplex: request.method !== 'GET' && request.method !== 'HEAD' ? 'half' : undefined,
    });

    const contentType = response.headers.get('content-type') ?? '';
    const isHtml = contentType.includes('text/html');

    reply.status(response.status);
    for (const [key, value] of response.headers.entries()) {
      if (key === 'transfer-encoding' || key === 'content-security-policy' || key === 'x-frame-options') continue;
      // Strip content-encoding and content-length: fetch() auto-decompresses, so the
      // upstream's compressed content-length/encoding no longer match the decompressed body
      if (key === 'content-encoding' || key === 'content-length') continue;
      reply.header(key, value);
    }

    if (isHtml && response.body) {
      let html = await response.text();
      const baseTag = `<base href="/proxy/${proxyName}/">`;
      html = html.replace('<head>', `<head>${baseTag}${wsRewriteScript(proxyName)}`);
      html = html.replace(/(src|href)="\/assets\//g, '$1="assets/');
      // Prevent caching of rewritten HTML
      reply.header('cache-control', 'no-store');
      reply.send(html);
      return;
    }

    if (response.body) {
      const buffer = Buffer.from(await response.arrayBuffer());
      reply.send(buffer);
      return;
    }
    reply.send();
  } catch {
    reply.code(502).send({ error: 'Proxy request failed' });
  }
}

/**
 * Proxy a WebSocket connection from the client to the upstream service.
 */
function handleWsProxy(
  clientSocket: import('ws').WebSocket,
  request: import('fastify').FastifyRequest,
  upstreamPath: string
): void {
  const proxyName = (request.params as { proxyName: string }).proxyName;
  const upstream = upstreamMap.get(proxyName);

  if (!upstream) {
    clientSocket.close(4502, `No upstream for "${proxyName}"`);
    return;
  }

  // Convert http(s) upstream to ws(s)
  const wsUpstream = upstream.replace(/^http/, 'ws');
  const query = request.url.includes('?') ? `?${request.url.split('?')[1]}` : '';
  const targetUrl = `${wsUpstream}${upstreamPath}${query}`;

  const upstreamSocket = new WsWebSocket(targetUrl);

  // Buffer client messages until upstream is ready
  const pendingMessages: (string | Buffer)[] = [];

  clientSocket.on('message', (data, isBinary) => {
    // Preserve frame type: binary for VNC/noVNC, text for JSON-RPC chat
    const msg: string | Buffer = isBinary ? Buffer.from(data as ArrayBuffer) : String(data);
    if (upstreamSocket.readyState === WsWebSocket.OPEN) {
      upstreamSocket.send(msg);
    } else {
      pendingMessages.push(msg);
    }
  });

  upstreamSocket.on('open', () => {
    for (const msg of pendingMessages) {
      upstreamSocket.send(msg);
    }
    pendingMessages.length = 0;
  });

  upstreamSocket.on('message', (data, isBinary) => {
    if (clientSocket.readyState === 1 /* OPEN */) {
      clientSocket.send(isBinary ? data : String(data));
    }
  });

  const safeClose = (socket: import('ws').WebSocket, code?: number, reason?: string) => {
    try {
      const safeCode = code !== undefined && code >= 1000 && code <= 4999 ? code : 1000;
      socket.close(safeCode, reason);
    } catch {
      try {
        socket.terminate();
      } catch {
        /* ignore */
      }
    }
  };

  clientSocket.on('close', () => {
    safeClose(upstreamSocket);
  });

  upstreamSocket.on('close', () => {
    safeClose(clientSocket);
  });

  upstreamSocket.on('error', () => {
    safeClose(clientSocket, 4502, 'Upstream WebSocket error');
  });

  clientSocket.on('error', () => {
    safeClose(upstreamSocket);
  });
}

/**
 * Generate a <script> tag that patches the WebSocket constructor to rewrite
 * all same-host WS connections through the proxy prefix.
 */
function wsRewriteScript(proxyName: string): string {
  // Rewrites ALL same-host WebSocket URLs through the proxy:
  // ws://host/ws → ws://host/proxy/<proxyName>/ws
  // ws://host/websockify → ws://host/proxy/<proxyName>/websockify
  // Already-proxied paths (starting with /proxy/) are left untouched.
  return `<script>(function(){var P="/proxy/${proxyName}",O=WebSocket;window.WebSocket=function(u,p){var a=new URL(u);if(a.host===location.host&&!a.pathname.startsWith("/proxy/")){a.pathname=P+a.pathname}return p?new O(a.toString(),p):new O(a.toString())};window.WebSocket.prototype=O.prototype;window.WebSocket.CONNECTING=O.CONNECTING;window.WebSocket.OPEN=O.OPEN;window.WebSocket.CLOSING=O.CLOSING;window.WebSocket.CLOSED=O.CLOSED})()</script>`;
}

/**
 * Rewrite localhost URLs in a status data object to relative proxy paths and register upstreams.
 */
const rewriteStatusUrls = (data: Record<string, string | undefined>, proxyName: string): void => {
  const urlFields = ['uiUrl', 'wsUrl', 'sandboxUrl', 'codeServerUrl', 'noVncUrl'];

  for (const field of urlFields) {
    const url = data[field];
    if (!url) {
      continue;
    }

    try {
      if (url.includes('/proxy/')) {
        continue;
      }
      const parsed = new URL(url);
      if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
        const proxyKey = `${proxyName}-${field}`;
        const upstream = `${parsed.protocol}//${parsed.host}`;

        upstreamMap.set(proxyKey, upstream);

        data[field] = `/proxy/${proxyKey}${parsed.pathname}${parsed.search}`;
      }
    } catch {
      // Not a valid URL, skip
    }
  }
};
