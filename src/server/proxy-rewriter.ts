import { WebSocket as WsWebSocket } from 'ws';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { WsHandler } from '@/server/ws-handler';

/** Map from proxy prefix (e.g. "chat-uiUrl") to upstream origin (e.g. "http://localhost:8082") */
const upstreamMap = new Map<string, string>();

/**
 * Register a proxy upstream and return the proxy path prefix.
 * Used by the preview system to dynamically route arbitrary URLs through the proxy.
 */
export const registerProxyUpstream = (proxyName: string, upstreamOrigin: string): string => {
  upstreamMap.set(proxyName, upstreamOrigin);
  return `/proxy/${proxyName}/`;
};

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

  // --- Dynamic proxy registration endpoint ---
  fastify.post('/proxy/_register', async (request, reply) => {
    const { name, upstream } = request.body as { name?: string; upstream?: string };
    if (!name || !upstream) {
      reply.code(400).send({ error: 'Missing name or upstream' });
      return;
    }
    try {
      const parsed = new URL(upstream);
      const origin = `${parsed.protocol}//${parsed.host}`;
      upstreamMap.set(name, origin);
      const proxyPath = `/proxy/${name}${parsed.pathname}${parsed.search}`;
      reply.send({ ok: true, proxyPath });
    } catch {
      reply.code(400).send({ error: 'Invalid upstream URL' });
    }
  });

  fastify.log.info('Proxy routes registered at /proxy/:proxyName/*');

  // --- URL rewriting via event interceptor ---
  // Intercepts all outgoing events (both sendToAll and sendTo) to rewrite URLs.
  wsHandler.addEventInterceptor((channel, args) => {
    if (channel === 'agent-process:status') {
      const processId = args[0] as string;
      const status = args[1] as Record<string, unknown> | undefined;
      if (status && (status.type === 'running' || status.type === 'connecting') && status.data) {
        const proxyPrefix = processId === 'chat' ? 'chat' : `code-${processId}`;
        rewriteStatusUrls(status.data as Record<string, string | undefined>, proxyPrefix);
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
  wsHandler.addResultWrapper('agent-process:get-status', (result, args) => {
    const processId = args[0] as string;
    const status = result as Record<string, unknown> | undefined;
    if (status && (status.type === 'running' || status.type === 'connecting') && status.data) {
      const proxyPrefix = processId === 'chat' ? 'chat' : `code-${processId}`;
      rewriteStatusUrls(status.data as Record<string, string | undefined>, proxyPrefix);
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
 * Rewrite URLs in HTML **attributes only** so that absolute and root-relative
 * URLs go through the proxy. Avoids touching inline JS/JSON which would break pages.
 *
 * Targets: href, src, action, formaction, poster, data, srcset attributes.
 */
function rewriteHtmlUrls(html: string, upstream: string, proxyName: string): string {
  const proxyPrefix = `/proxy/${proxyName}`;

  let upstreamHost = '';
  try { upstreamHost = new URL(upstream).host; } catch { /* skip */ }

  // Single regex: match URL-bearing HTML attributes whose value starts with
  // the upstream origin, a protocol-relative //host, or a root-relative /path.
  // The regex captures (attribute-prefix + opening-quote + url-start).
  const attrNames = 'href|src|action|formaction|poster|data|srcset';

  // 1. Absolute upstream URLs in attributes:  href="https://upstream/path" → href="/proxy/name/path"
  if (upstream) {
    const absRe = new RegExp(
      `((?:${attrNames})\\s*=\\s*["'])${escapeForRegex(upstream)}`,
      'gi',
    );
    html = html.replace(absRe, `$1${proxyPrefix}`);
  }

  // 2. Protocol-relative URLs in attributes:  src="//host/path" → src="/proxy/name/path"
  if (upstreamHost) {
    const protoRelRe = new RegExp(
      `((?:${attrNames})\\s*=\\s*["'])//${escapeForRegex(upstreamHost)}`,
      'gi',
    );
    html = html.replace(protoRelRe, `$1${proxyPrefix}`);
  }

  // 3. Root-relative URLs in attributes:  action="/path" → action="/proxy/name/path"
  //    Skips values already starting with /proxy/ or // (protocol-relative)
  html = html.replace(
    new RegExp(`((?:${attrNames})\\s*=\\s*["'])\\/(?!\\/|proxy\\/)`, 'gi'),
    `$1${proxyPrefix}/`,
  );

  // 4. Strip CSP <meta> tags — we already strip the HTTP header, but inline CSP
  //    blocks our injected scripts (console capture, navigation, etc.)
  html = html.replace(/<meta[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi, '');

  return html;
}

/** Escape a string for use in a RegExp. */
function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

      // --- Server-side URL rewriting (primary mechanism) ---
      html = rewriteHtmlUrls(html, upstream, proxyName);

      // Inject <base> tag and minimal scripts (console capture, navigation reporting, WS rewriting)
      const baseTag = `<base href="/proxy/${proxyName}/">`;
      const headPayload = `${baseTag}${navigationCapture()}${consoleCapture()}${wsRewriteScript(proxyName)}`;
      // Handle <head>, <HEAD>, or missing <head> (lookahead excludes <header>, <heading>, etc.)
      if (/<head(?=[\s>])/i.test(html)) {
        html = html.replace(/<head(?=[\s>])[^>]*>/i, `$&${headPayload}`);
      } else if (/<html[\s>]/i.test(html)) {
        html = html.replace(/<html([\s>][^>]*)>/i, `<html$1><head>${headPayload}</head>`);
      } else {
        html = `<head>${headPayload}</head>${html}`;
      }

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

  console.log(`[ws-proxy] ${proxyName}: client → upstream ${targetUrl}`);
  const upstreamSocket = new WsWebSocket(targetUrl, { handshakeTimeout: 10_000 });

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
    console.log(`[ws-proxy] ${proxyName}: upstream connected`);
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

  upstreamSocket.on('close', (code, reason) => {
    console.log(`[ws-proxy] ${proxyName}: upstream closed code=${code} reason=${String(reason)}`);
    safeClose(clientSocket);
  });

  upstreamSocket.on('error', (err) => {
    console.error(`[ws-proxy] ${proxyName}: upstream error:`, err.message);
    safeClose(clientSocket, 4502, 'Upstream WebSocket error');
  });

  clientSocket.on('error', () => {
    safeClose(upstreamSocket);
  });
}

/**
 * Generate a <script> tag for lightweight behaviour capture only.
 * URL rewriting is handled server-side by rewriteHtmlUrls() — this script
 * only handles things that can't be done server-side:
 * 1. target="_blank" → _self (keep navigation in-frame)
 * 2. window.open → location.href
 * 3. Navigation change notifications (pushState/replaceState/popstate)
 * 4. Title change notifications
 */
function navigationCapture(): string {
  return `<script>(function(){` +
    // Keep navigation in-frame
    `document.addEventListener("click",function(e){` +
    `var a=e.target;while(a&&a.tagName!=="A")a=a.parentElement;` +
    `if(a&&(a.target==="_blank"||a.target==="_new"))a.target='_self'` +
    `},true);` +
    `window.open=function(u){if(u)location.href=u;return window};` +
    // Notify parent on navigation
    `function N(){window.parent.postMessage({type:"__preview_navigate__",url:location.href},"*")}` +
    `var oPS=history.pushState,oRS=history.replaceState;` +
    `history.pushState=function(){oPS.apply(this,arguments);N()};` +
    `history.replaceState=function(){oRS.apply(this,arguments);N()};` +
    `window.addEventListener("popstate",N);window.addEventListener("hashchange",N);` +
    // Title notifications
    `function T(){window.parent.postMessage({type:"__preview_title__",title:document.title},"*")}` +
    `new MutationObserver(T).observe(document.querySelector("title")||document.head,{childList:true,subtree:true,characterData:true});T()` +
    `})()</script>`;
}

/**
 * Generate a <script> tag that intercepts console methods and posts
 * them to the parent window so the preview panel can display them.
 * Also sends a connection confirmation so the UI knows capture is active.
 */
function consoleCapture(): string {
  return `<script>(function(){` +
    `var P=function(l,m){try{window.parent.postMessage({type:"__preview_console__",level:l,message:m},"*")}catch(e){}};` +
    `["log","info","debug","warn","error"].forEach(function(l){` +
    `var o=console[l];console[l]=function(){o.apply(console,arguments);` +
    `try{var m=Array.prototype.slice.call(arguments).map(function(a){` +
    `try{return typeof a==="object"?JSON.stringify(a):String(a)}catch(e){return String(a)}` +
    `}).join(" ");P(l==="info"||l==="debug"?"log":l,m)}catch(e){}}});` +
    `P("log","[console connected]")` +
    `})()</script>`;
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
      const proxyKey = `${proxyName}-${field}`;
      const upstream = `${parsed.protocol}//${parsed.host}`;

      upstreamMap.set(proxyKey, upstream);

      const proxyPath = `/proxy/${proxyKey}${parsed.pathname}${parsed.search}`;
      console.log(`[proxy-rewrite] ${field}: ${url} → ${proxyPath} (upstream: ${upstream})`);
      data[field] = proxyPath;
    } catch {
      // Not a valid URL, skip
    }
  }
};
