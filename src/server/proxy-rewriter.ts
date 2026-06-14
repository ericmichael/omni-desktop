import { Readable } from 'node:stream';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { WebSocket as WsWebSocket } from 'ws';

import { uuidv4 } from '@/lib/uuid';
import type { WsHandler } from '@/server/ws-handler';

const DYNAMIC_PROXY_TTL_MS = 30 * 60 * 1000;
const REDACTED_QUERY_VALUE = '[REDACTED]';
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const SENSITIVE_QUERY_PARAM_RE = /(?:^|[-_])(token|secret|password|passwd|key|auth|code|sig|signature)(?:$|[-_])/i;
const HTML_URL_ATTR_RE =
  /(\s(?:href|src|action|formaction|poster|data|srcset)\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
const META_ATTR_RE = /(\s(?:http-equiv|content)\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s][^)]*?))\s*\)/gi;
const SKIPPED_STATIC_URL_RE = /^(?:$|#|data:|blob:|javascript:|mailto:|tel:|about:)/i;
const PROXY_RUNTIME_SHIM_VERSION = 1;

export type ProxySiteClass = 'trusted-internal' | 'dynamic';

export type ProxyRuntimePolicy = {
  version: typeof PROXY_RUNTIME_SHIM_VERSION;
  expandedRuntimeUrls: boolean;
  blockServiceWorkerRegistration: boolean;
};

type ProxyEntry = {
  upstream: string;
  kind: ProxySiteClass;
  ownerKey?: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt?: number;
};

/** Map from proxy prefix (e.g. "chat-uiUrl") to upstream metadata. */
const upstreamMap = new Map<string, ProxyEntry>();

/** Default allowlist when none is supplied: loopback only. */
const defaultIsTrusted = (addr: string): boolean => {
  if (!addr) {
    return false;
  }
  const normalized = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return normalized === '127.0.0.1' || normalized === '::1';
};

/**
 * Register a proxy upstream and return the proxy path prefix.
 * Used by the preview system to dynamically route arbitrary URLs through the proxy.
 */
export const registerProxyUpstream = (proxyName: string, upstreamOrigin: string): string => {
  const now = Date.now();
  upstreamMap.set(proxyName, {
    upstream: upstreamOrigin,
    kind: 'trusted-internal',
    createdAt: now,
    lastUsedAt: now,
  });
  return `/proxy/${proxyName}/`;
};

export const cleanupExpiredProxyRegistrations = (now: number = Date.now()): number => {
  let deleted = 0;
  for (const [proxyName, entry] of upstreamMap.entries()) {
    if (entry.kind === 'dynamic' && entry.expiresAt !== undefined && entry.expiresAt <= now) {
      upstreamMap.delete(proxyName);
      deleted += 1;
    }
  }
  return deleted;
};

export const resetProxyRegistrationsForTests = (): void => {
  upstreamMap.clear();
};

const isTruthyEnv = (value: string | undefined): boolean => /^(1|true|yes|on)$/i.test(value ?? '');
const isFalsyEnv = (value: string | undefined): boolean => /^(0|false|no|off)$/i.test(value ?? '');

export const getProxyRuntimePolicy = (siteClass: ProxySiteClass): ProxyRuntimePolicy => {
  const runtimeEnv = process.env['OMNI_PROXY_RUNTIME_SHIMS'];
  const dynamicRuntimeEnv = process.env['OMNI_PROXY_DYNAMIC_RUNTIME_SHIMS'];
  const expandedRuntimeUrls =
    !isFalsyEnv(runtimeEnv) &&
    (siteClass === 'trusted-internal' || isTruthyEnv(dynamicRuntimeEnv) || isTruthyEnv(runtimeEnv));

  return {
    version: PROXY_RUNTIME_SHIM_VERSION,
    expandedRuntimeUrls,
    blockServiceWorkerRegistration: siteClass !== 'trusted-internal',
  };
};

const ownerKeyForRequest = (request: FastifyRequest): string | null => {
  if ((process.env['OMNI_AUTH_MODE'] ?? '') !== 'easyauth') {
    return 'local-single-tenant';
  }
  const principalId = request.headers['x-ms-client-principal-id'];
  return typeof principalId === 'string' && principalId.trim() ? `principal:${principalId.trim()}` : null;
};

const mintDynamicProxyName = (): string => `dyn-${uuidv4().replace(/-/g, '')}`;

const parseHttpUpstream = (upstream: string | undefined): URL | null => {
  if (!upstream || upstream.length > 4096) {
    return null;
  }
  try {
    const parsed = new URL(upstream);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
};

const getProxyEntry = (
  request: FastifyRequest,
  proxyName: string
): ProxyEntry | null | 'forbidden' | 'unauthorized' => {
  const entry = upstreamMap.get(proxyName);
  if (!entry) {
    return null;
  }
  const now = Date.now();
  if (entry.kind === 'dynamic' && entry.expiresAt !== undefined && entry.expiresAt <= now) {
    upstreamMap.delete(proxyName);
    return null;
  }
  if (entry.kind === 'dynamic') {
    const ownerKey = ownerKeyForRequest(request);
    if (!ownerKey) {
      return 'unauthorized';
    }
    if (entry.ownerKey !== ownerKey) {
      return 'forbidden';
    }
  }
  entry.lastUsedAt = now;
  if (entry.kind === 'dynamic') {
    entry.expiresAt = now + DYNAMIC_PROXY_TTL_MS;
  }
  return entry;
};

/**
 * Register the wildcard proxy route, WebSocket proxy routes, and URL rewriting interceptors.
 * Must be called BEFORE fastify.listen() so routes are registered at boot time.
 *
 * `isTrusted` decides whether a remote address may call `/proxy/_register`.
 * Pass the same allowlist used by `/api/ws-token` so `OMNI_TRUSTED_CIDRS`
 * controls both endpoints uniformly (Tailscale, WireGuard, etc.).
 */
export const setupProxyRewriter = (
  fastify: FastifyInstance,
  wsHandler: WsHandler,
  isTrusted: (remoteAddress: string) => boolean = defaultIsTrusted
): void => {
  // --- Combined HTTP + WebSocket proxy ---
  // Register inside a plugin so GET can handle both HTTP and WS upgrades on the same path.
  void fastify.register(async function proxyRoutes(f) {
    f.removeAllContentTypeParsers();
    f.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });

    // GET handles both normal HTTP GET and WebSocket upgrades via full declaration syntax
    f.route({
      method: 'GET',
      url: '/proxy/:proxyName/*',
      handler: async (request, reply) => {
        return handleHttpProxy(request, reply);
      },
      wsHandler: (clientSocket, request) => {
        const upstreamPath = `/${(request.params as { '*': string })['*']}`;
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
  // Gated by the same allowlist as /api/ws-token (loopback + OMNI_TRUSTED_CIDRS).
  // OMNI_ALLOW_EXTERNAL_REGISTER=1 is a backstop escape hatch for environments
  // where the CIDR list can't be expressed cleanly (e.g. dynamic peer ranges).
  fastify.post('/proxy/_register', {
    onRequest: async (request, reply) => {
      const addr = request.socket.remoteAddress ?? '';
      if (!isTrusted(addr) && !process.env['OMNI_ALLOW_EXTERNAL_REGISTER']) {
        reply.code(403).send({ error: 'Forbidden: caller not in trusted network' });
        return;
      }
    },
    handler: async (request, reply) => {
      cleanupExpiredProxyRegistrations();
      const { upstream } = request.body as { name?: string; upstream?: string };
      const ownerKey = ownerKeyForRequest(request);
      if (!ownerKey) {
        reply.code(401).send({ error: 'Unauthorized: missing authenticated principal' });
        return;
      }
      const parsed = parseHttpUpstream(upstream);
      if (!parsed) {
        reply.code(400).send({ error: 'Invalid upstream URL: expected http(s)' });
        return;
      }
      const now = Date.now();
      const proxyName = mintDynamicProxyName();
      const origin = `${parsed.protocol}//${parsed.host}`;
      upstreamMap.set(proxyName, {
        upstream: origin,
        kind: 'dynamic',
        ownerKey,
        createdAt: now,
        lastUsedAt: now,
        expiresAt: now + DYNAMIC_PROXY_TTL_MS,
      });
      const proxyPath = `/proxy/${proxyName}${parsed.pathname}${parsed.search}`;
      reply.send({ ok: true, proxyName, proxyPath, expiresAt: now + DYNAMIC_PROXY_TTL_MS });
    },
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
        rewriteStatusUrls(status.data as Record<string, string | undefined>, proxyPrefix, processId);
      }
    }

    if (channel === 'project:task-status') {
      const taskId = args[0] as string;
      const status = args[1] as Record<string, unknown> | undefined;
      if (status && (status.type === 'running' || status.type === 'connecting') && status.data) {
        rewriteStatusUrls(status.data as Record<string, string | undefined>, `project-${taskId}`, taskId);
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
      rewriteStatusUrls(status.data as Record<string, string | undefined>, proxyPrefix, processId);
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
 * Rewrite URLs in HTML attributes only so static same-upstream and root-relative
 * URLs go through the proxy. Avoids touching inline JS/JSON which would break pages.
 */
export function rewriteHtmlUrls(html: string, upstream: string, proxyName: string): string {
  html = html.replace(
    HTML_URL_ATTR_RE,
    (match, prefix: string, doubleValue?: string, singleValue?: string, bareValue?: string) => {
      const value = doubleValue ?? singleValue ?? bareValue ?? '';
      const attrName = prefix.match(/\s([^\s=]+)\s*=/)?.[1]?.toLowerCase();
      const rewritten =
        attrName === 'srcset'
          ? rewriteSrcset(value, upstream, proxyName)
          : rewriteStaticUrl(value, upstream, proxyName);

      if (doubleValue !== undefined) {
        return `${prefix}"${rewritten}"`;
      }
      if (singleValue !== undefined) {
        return `${prefix}'${rewritten}'`;
      }
      return `${prefix}${rewritten}`;
    }
  );

  html = rewriteMetaRefresh(html, upstream, proxyName);

  // Strip CSP <meta> tags — we already strip the HTTP header, but inline CSP
  // blocks our injected scripts (console capture, navigation, etc.)
  html = html.replace(/<meta[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi, '');

  return html;
}

export function rewriteMetaRefresh(html: string, upstream: string, proxyName: string): string {
  return html.replace(/<meta\b[^>]*>/gi, (tag) => {
    const attrs = parseMetaAttrs(tag);
    if (attrs['http-equiv']?.toLowerCase() !== 'refresh' || !attrs.content) {
      return tag;
    }
    return tag.replace(
      META_ATTR_RE,
      (match, prefix: string, doubleValue?: string, singleValue?: string, bareValue?: string) => {
        const attrName = prefix.match(/\s([^\s=]+)\s*=/)?.[1]?.toLowerCase();
        if (attrName !== 'content') {
          return match;
        }
        const value = doubleValue ?? singleValue ?? bareValue ?? '';
        const rewritten = rewriteMetaRefreshContent(value, upstream, proxyName);
        if (doubleValue !== undefined) {
          return `${prefix}"${rewritten}"`;
        }
        if (singleValue !== undefined) {
          return `${prefix}'${rewritten}'`;
        }
        return `${prefix}${rewritten}`;
      }
    );
  });
}

export function rewriteCssUrls(css: string, upstream: string, proxyName: string): string {
  return css.replace(CSS_URL_RE, (match, doubleValue?: string, singleValue?: string, bareValue?: string) => {
    const value = (doubleValue ?? singleValue ?? bareValue ?? '').trim();
    const rewritten = rewriteStaticUrl(value, upstream, proxyName);
    if (doubleValue !== undefined) {
      return `url("${rewritten}")`;
    }
    if (singleValue !== undefined) {
      return `url('${rewritten}')`;
    }
    return `url(${rewritten})`;
  });
}

function parseMetaAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of tag.matchAll(META_ATTR_RE)) {
    const name = match[1]?.match(/\s([^\s=]+)\s*=/)?.[1]?.toLowerCase();
    if (name) {
      attrs[name] = match[2] ?? match[3] ?? match[4] ?? '';
    }
  }
  return attrs;
}

function rewriteMetaRefreshContent(content: string, upstream: string, proxyName: string): string {
  return content.replace(/(\burl\s*=\s*)(['"]?)([^'";\s]+)\2/i, (match, prefix: string, quote: string, url: string) => {
    const rewritten = rewriteStaticUrl(url, upstream, proxyName);
    return `${prefix}${quote}${rewritten}${quote}`;
  });
}

function rewriteSrcset(srcset: string, upstream: string, proxyName: string): string {
  return srcset
    .split(',')
    .map((candidate) => {
      const match = candidate.match(/^(\s*)(\S+)(.*)$/s);
      if (!match) {
        return candidate;
      }
      const [, leading = '', url = '', descriptor = ''] = match;
      return `${leading}${rewriteStaticUrl(url, upstream, proxyName)}${descriptor}`;
    })
    .join(',');
}

function rewriteStaticUrl(url: string, upstream: string, proxyName: string): string {
  if (SKIPPED_STATIC_URL_RE.test(url) || url.startsWith('/proxy/')) {
    return url;
  }

  const proxyPrefix = `/proxy/${proxyName}`;

  try {
    const upstreamUrl = new URL(upstream);
    if (url.startsWith('/')) {
      if (url.startsWith('//')) {
        const protocolRelative = new URL(`${upstreamUrl.protocol}${url}`);
        if (protocolRelative.host !== upstreamUrl.host) {
          return url;
        }
        return `${proxyPrefix}${protocolRelative.pathname}${protocolRelative.search}${protocolRelative.hash}`;
      }
      return `${proxyPrefix}${url}`;
    }

    const parsed = new URL(url);
    if (parsed.origin !== upstreamUrl.origin) {
      return url;
    }
    return `${proxyPrefix}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    if (url.startsWith('/') && !url.startsWith('//')) {
      return `${proxyPrefix}${url}`;
    }
    return url;
  }
}

const equivalentWebRuntimeProtocol = (runtimeProtocol: string, upstreamProtocol: string): boolean => {
  if (runtimeProtocol === upstreamProtocol) {
    return true;
  }
  return (
    (runtimeProtocol === 'ws:' && upstreamProtocol === 'http:') ||
    (runtimeProtocol === 'wss:' && upstreamProtocol === 'https:') ||
    (runtimeProtocol === 'http:' && upstreamProtocol === 'ws:') ||
    (runtimeProtocol === 'https:' && upstreamProtocol === 'wss:')
  );
};

export function rewriteProxyRuntimeUrl(
  input: string,
  currentHref: string,
  upstream: string,
  proxyName: string,
  transport: 'http' | 'websocket' = 'http'
): string {
  if (SKIPPED_STATIC_URL_RE.test(input)) {
    return input;
  }

  try {
    const locationUrl = new URL(currentHref);
    const upstreamUrl = new URL(upstream);
    const runtimeUrl = new URL(input, currentHref);
    const proxyPrefix = `/proxy/${proxyName}`;

    if (!['http:', 'https:', 'ws:', 'wss:'].includes(runtimeUrl.protocol)) {
      return input;
    }

    // ws://<launcher-host>/… is the launcher's origin too — WHATWG origins
    // include the scheme, so a plain origin equality check misses WebSocket
    // URLs derived from the page's location (e.g. noVNC's ws://host:port/
    // websockify) and they'd bypass the proxy.
    const launcherHostRuntimeUrl =
      runtimeUrl.host === locationUrl.host && equivalentWebRuntimeProtocol(runtimeUrl.protocol, locationUrl.protocol);

    const alreadyActiveProxy =
      launcherHostRuntimeUrl &&
      (runtimeUrl.pathname === proxyPrefix || runtimeUrl.pathname.startsWith(`${proxyPrefix}/`));

    if (alreadyActiveProxy) {
      const rewritten = new URL(runtimeUrl.toString());
      if (transport === 'websocket') {
        rewritten.protocol = locationUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      }
      return rewritten.toString();
    }

    const sameUpstream =
      runtimeUrl.host === upstreamUrl.host && equivalentWebRuntimeProtocol(runtimeUrl.protocol, upstreamUrl.protocol);

    if (!sameUpstream && !launcherHostRuntimeUrl) {
      return input;
    }

    const rewritten = new URL(locationUrl.origin);
    if (transport === 'websocket') {
      rewritten.protocol = locationUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    }
    rewritten.pathname = `${proxyPrefix}${runtimeUrl.pathname}`;
    rewritten.search = runtimeUrl.search;
    rewritten.hash = runtimeUrl.hash;
    return rewritten.toString();
  } catch {
    return input;
  }
}

/** Escape a string for use in a RegExp. */
export function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function rewriteLocationHeader(location: string, upstream: string, proxyName: string): string {
  try {
    const upstreamUrl = new URL(upstream);
    const resolved = new URL(location, upstreamUrl);
    if (resolved.origin !== upstreamUrl.origin) {
      return resolved.toString();
    }
    return `/proxy/${proxyName}${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return location;
  }
}

export function rewriteSetCookieHeader(cookie: string, proxyName: string): string {
  const parts = cookie
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  const [nameValue, ...attributes] = parts;
  if (!nameValue) {
    return cookie;
  }

  const rewritten = [nameValue, `Path=/proxy/${proxyName}`];
  for (const attribute of attributes) {
    const [rawName = '', ...rawValueParts] = attribute.split('=');
    const name = rawName.trim();
    const lowerName = name.toLowerCase();

    if (lowerName === 'path' || lowerName === 'domain') {
      continue;
    }
    if (lowerName === 'samesite') {
      const value = rawValueParts.join('=').trim();
      if (/^(strict|lax|none)$/i.test(value)) {
        rewritten.push(`${name}=${value}`);
      }
      continue;
    }
    rewritten.push(attribute);
  }

  return rewritten.join('; ');
}

export function redactProxyUrlForLog(url: string): string {
  try {
    const isRelative = url.startsWith('/');
    const parsed = new URL(url, 'http://omni.invalid');
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_QUERY_PARAM_RE.test(key)) {
        parsed.searchParams.set(key, REDACTED_QUERY_VALUE);
      }
    }
    if (isRelative) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function isHopByHopHeader(key: string, connectionHeaderNames: Set<string>): boolean {
  const normalized = key.toLowerCase();
  return HOP_BY_HOP_HEADERS.has(normalized) || connectionHeaderNames.has(normalized);
}

function getConnectionHeaderNames(headers: FastifyRequest['headers'] | Headers): Set<string> {
  const value = headers instanceof Headers ? headers.get('connection') : headers.connection;
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return new Set(
    values
      .flatMap((headerValue) => String(headerValue).split(','))
      .map((headerName) => headerName.trim().toLowerCase())
      .filter(Boolean)
  );
}

function rewriteRefererHeader(referer: string, upstream: string, proxyName: string): string | undefined {
  try {
    const upstreamUrl = new URL(upstream);
    const parsed = referer.startsWith('/') ? new URL(referer, upstreamUrl) : new URL(referer);
    const proxyPrefix = `/proxy/${proxyName}`;
    if (parsed.pathname === proxyPrefix || parsed.pathname.startsWith(`${proxyPrefix}/`)) {
      const upstreamPath = parsed.pathname.slice(proxyPrefix.length) || '/';
      return `${upstreamUrl.origin}${upstreamPath}${parsed.search}${parsed.hash}`;
    }
    if (parsed.origin === upstreamUrl.origin) {
      return parsed.toString();
    }
  } catch {
    /* drop invalid referer */
  }
  return undefined;
}

function buildUpstreamHeaders(request: FastifyRequest, upstream: string, proxyName: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const connectionHeaderNames = getConnectionHeaderNames(request.headers);
  const upstreamUrl = new URL(upstream);

  for (const [key, value] of Object.entries(request.headers)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'host' || lowerKey === 'content-length' || isHopByHopHeader(lowerKey, connectionHeaderNames)) {
      continue;
    }
    if (lowerKey === 'origin' || lowerKey === 'referer') {
      continue;
    }
    if (typeof value === 'string') {
      headers[key] = value;
    }
  }

  headers.host = upstreamUrl.host;
  if (request.headers.origin) {
    headers.origin = upstreamUrl.origin;
  }
  const referer = request.headers.referer;
  if (typeof referer === 'string') {
    const rewrittenReferer = rewriteRefererHeader(referer, upstream, proxyName);
    if (rewrittenReferer) {
      headers.referer = rewrittenReferer;
    }
  }

  return headers;
}

function splitSetCookieHeader(header: string): string[] {
  return header.split(/,(?=\s*[^;,\s]+=)/g).map((cookie) => cookie.trim());
}

function getSetCookieHeaders(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (getSetCookie) {
    return getSetCookie.call(headers);
  }
  const combined = headers.get('set-cookie');
  return combined ? splitSetCookieHeader(combined) : [];
}

async function* readResponseBodyStream(body: ReadableStream<Uint8Array>): AsyncGenerator<Buffer> {
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      if (value) {
        yield Buffer.from(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Proxy an HTTP request to the upstream service.
 */
async function handleHttpProxy(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> {
  const { proxyName } = request.params as { proxyName: string; '*': string };
  const wildcard = (request.params as { '*': string })['*'];
  const entry = getProxyEntry(request, proxyName);

  if (entry === 'unauthorized') {
    reply.code(401).send({ error: 'Unauthorized: missing authenticated principal' });
    return;
  }
  if (entry === 'forbidden') {
    reply.code(403).send({ error: `Forbidden: proxy "${proxyName}" belongs to another session` });
    return;
  }
  if (!entry) {
    reply.code(502).send({ error: `No upstream registered for proxy "${proxyName}"` });
    return;
  }
  const { upstream } = entry;

  const targetUrl = `${upstream}/${wildcard}${request.url.includes('?') ? `?${request.url.split('?')[1]}` : ''}`;

  try {
    const headers = buildUpstreamHeaders(request, upstream, proxyName);
    const body =
      request.method !== 'GET' && request.method !== 'HEAD' ? (request.body as BodyInit | undefined) : undefined;
    const fetchInit: RequestInit & { duplex?: 'half' } = {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
    };
    if (body !== undefined) {
      fetchInit.duplex = 'half';
    }

    const response = await globalThis.fetch(targetUrl, fetchInit);

    const contentType = response.headers.get('content-type') ?? '';
    const normalizedContentType = contentType.toLowerCase();
    const isHtml = normalizedContentType.includes('text/html');
    const isCss = normalizedContentType.includes('text/css');

    reply.status(response.status);
    const connectionHeaderNames = getConnectionHeaderNames(response.headers);
    for (const [key, value] of response.headers.entries()) {
      const lowerKey = key.toLowerCase();
      if (isHopByHopHeader(lowerKey, connectionHeaderNames)) {
        continue;
      }
      if (lowerKey === 'content-security-policy' || lowerKey === 'x-frame-options') {
        continue;
      }
      // Strip content-encoding and content-length: fetch() auto-decompresses, so the
      // upstream's compressed content-length/encoding no longer match the decompressed body
      if (lowerKey === 'content-encoding' || lowerKey === 'content-length') {
        continue;
      }
      if (lowerKey === 'location') {
        reply.header(key, rewriteLocationHeader(value, upstream, proxyName));
        continue;
      }
      if (lowerKey === 'set-cookie') {
        continue;
      }
      reply.header(key, value);
    }
    const setCookieHeaders = getSetCookieHeaders(response.headers).map((cookie) =>
      rewriteSetCookieHeader(cookie, proxyName)
    );
    if (setCookieHeaders.length > 0) {
      reply.header('set-cookie', setCookieHeaders);
    }

    if (isHtml && response.body) {
      let html = await response.text();

      // --- Server-side URL rewriting (primary mechanism) ---
      html = rewriteHtmlUrls(html, upstream, proxyName);

      // Inject <base> tag and runtime scripts.
      const baseTag = `<base href="/proxy/${proxyName}/">`;
      const headPayload = `${baseTag}${buildProxyRuntimeShim({
        proxyName,
        upstream,
        policy: getProxyRuntimePolicy(entry.kind),
      })}${consoleCapture()}`;
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
      return reply.send(html);
    }

    if (isCss && response.body) {
      return reply.send(rewriteCssUrls(await response.text(), upstream, proxyName));
    }

    if (response.body) {
      return reply.send(Readable.from(readResponseBodyStream(response.body as ReadableStream<Uint8Array>)));
    }
    return reply.send();
  } catch (error) {
    request.log.error({ err: error, targetUrl: redactProxyUrlForLog(targetUrl) }, 'Proxy request failed');
    return reply.code(502).send({ error: 'Proxy request failed' });
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
  const entry = getProxyEntry(request, proxyName);

  if (entry === 'unauthorized') {
    clientSocket.close(4401, 'Unauthorized');
    return;
  }
  if (entry === 'forbidden') {
    clientSocket.close(4403, 'Forbidden');
    return;
  }
  if (!entry) {
    clientSocket.close(4502, `No upstream for "${proxyName}"`);
    return;
  }
  const { upstream } = entry;

  // Convert http(s) upstream to ws(s)
  const wsUpstream = upstream.replace(/^http/, 'ws');
  const query = request.url.includes('?') ? `?${request.url.split('?')[1]}` : '';
  const targetUrl = `${wsUpstream}${upstreamPath}${query}`;

  console.log(`[ws-proxy] ${proxyName}: client → upstream ${redactProxyUrlForLog(targetUrl)}`);
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

export function buildProxyRuntimeShim({
  proxyName,
  upstream,
  policy,
}: {
  proxyName: string;
  upstream: string;
  policy: ProxyRuntimePolicy;
}): string {
  const config = JSON.stringify({
    version: policy.version,
    proxyName,
    upstreamOrigin: upstream,
    expandedRuntimeUrls: policy.expandedRuntimeUrls,
    blockServiceWorkerRegistration: policy.blockServiceWorkerRegistration,
  });

  return `<script data-omni-proxy-runtime-shim="${PROXY_RUNTIME_SHIM_VERSION}">(function(){"use strict";var C=${config};var P="/proxy/"+C.proxyName;function pair(a,b){return a===b||(a==="ws:"&&b==="http:")||(a==="wss:"&&b==="https:")||(a==="http:"&&b==="ws:")||(a==="https:"&&b==="wss:")}function ignored(v){return /^(?:$|#|data:|blob:|javascript:|mailto:|tel:|about:)/i.test(String(v))}function proxied(u,t){var o=new URL(location.origin);if(t==="websocket")o.protocol=location.protocol==="https:"?"wss:":"ws:";o.pathname=P+u.pathname;o.search=u.search;o.hash=u.hash;return o.toString()}function rewrite(input,t){try{if(ignored(input))return input;var u=new URL(input, location.href);if(["http:","https:","ws:","wss:"].indexOf(u.protocol)===-1)return input;var up=new URL(C.upstreamOrigin);var launcherHost=u.host===location.host&&pair(u.protocol,location.protocol);if(launcherHost&&(u.pathname===P||u.pathname.indexOf(P+"/")===0)){if(t==="websocket")u.protocol=location.protocol==="https:"?"wss:":"ws:";return u.toString()}if(u.host===up.host&&pair(u.protocol,up.protocol))return proxied(u,t);if(launcherHost)return proxied(u,t);return input}catch(e){return input}}function canonical(){try{var u=new URL(location.href);if(u.origin===location.origin&&(u.pathname===P||u.pathname.indexOf(P+"/")===0)){var up=new URL(C.upstreamOrigin);var path=u.pathname.slice(P.length)||"/";return up.origin+path+u.search+u.hash}}catch(e){}return location.href}function nav(){try{window.parent.postMessage({type:"__preview_navigate__",url:canonical()},"*")}catch(e){}}function title(){try{window.parent.postMessage({type:"__preview_title__",title:document.title},"*")}catch(e){}}document.addEventListener("click",function(e){var a=e.target;while(a&&a.tagName!=="A")a=a.parentElement;if(!a)return;if(a.target==="_blank"||a.target==="_new")a.target="_self";if(C.expandedRuntimeUrls&&a.href)a.href=rewrite(a.href,"http")},true);document.addEventListener("submit",function(e){var f=e.target;if(C.expandedRuntimeUrls&&f&&f.action)f.action=rewrite(f.action,"http")},true);var open=window.open;window.open=function(u,n,s){if(u){var next=C.expandedRuntimeUrls?rewrite(u,"http"):u;location.href=next;return window}return open?open.call(window,u,n,s):null};var ps=history.pushState,rs=history.replaceState;history.pushState=function(){ps.apply(this,arguments);nav()};history.replaceState=function(){rs.apply(this,arguments);nav()};window.addEventListener("popstate",nav);window.addEventListener("hashchange",nav);if(document.head){new MutationObserver(title).observe(document.querySelector("title")||document.head,{childList:true,subtree:true,characterData:true});title()}if(C.blockServiceWorkerRegistration&&navigator.serviceWorker&&navigator.serviceWorker.register){navigator.serviceWorker.register=function(){return Promise.reject(new DOMException("Service worker registration is blocked for this proxied page","SecurityError"))}}if(!C.expandedRuntimeUrls)return;var fetchOrig=window.fetch;if(fetchOrig){window.fetch=function(input,init){var next=input;if(typeof Request!=="undefined"&&input instanceof Request){var url=rewrite(input.url,"http");if(url!==input.url)next=new Request(url,input)}else if(typeof input==="string"||input instanceof URL){next=rewrite(String(input),"http")}return fetchOrig.call(this,next,init)}}var xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=rewrite(u,"http");return xo.apply(this,arguments)};if(window.EventSource){var ES=window.EventSource;window.EventSource=function(u,c){return new ES(rewrite(u,"http"),c)};window.EventSource.prototype=ES.prototype}if(window.WebSocket){var WS=window.WebSocket;window.WebSocket=function(u,p){var next=rewrite(u,"websocket");return p?new WS(next,p):new WS(next)};window.WebSocket.prototype=WS.prototype;window.WebSocket.CONNECTING=WS.CONNECTING;window.WebSocket.OPEN=WS.OPEN;window.WebSocket.CLOSING=WS.CLOSING;window.WebSocket.CLOSED=WS.CLOSED}if(window.Worker){var W=window.Worker;window.Worker=function(u,o){return new W(rewrite(u,"http"),o)};window.Worker.prototype=W.prototype}})()</script>`;
}

/**
 * Generate a <script> tag that intercepts console methods and posts
 * them to the parent window so the preview panel can display them.
 * Also sends a connection confirmation so the UI knows capture is active.
 */
function consoleCapture(): string {
  return (
    `<script>(function(){` +
    `var P=function(l,m){try{window.parent.postMessage({type:"__preview_console__",level:l,message:m},"*")}catch(e){}};` +
    `["log","info","debug","warn","error"].forEach(function(l){` +
    `var o=console[l];console[l]=function(){o.apply(console,arguments);` +
    `try{var m=Array.prototype.slice.call(arguments).map(function(a){` +
    `try{return typeof a==="object"?JSON.stringify(a):String(a)}catch(e){return String(a)}` +
    `}).join(" ");P(l==="info"||l==="debug"?"log":l,m)}catch(e){}}});` +
    `P("log","[console connected]")` +
    `})()</script>`
  );
}

/**
 * Rewrite localhost URLs in a status data object to relative `/proxy/<name>/...`
 * paths and register their upstream origins.
 *
 * For computer-as-sandbox (`host_bridge`) sessions this needs no special
 * handling: the agent's `ws_url`/`ui_url` belong to the cloud's own
 * `omni serve` (reachable here, like ACI), so they go through the normal proxy.
 * The laptop is reached only by the cloud `omni serve` itself, via the
 * `/proxy/local/<machineId>/<sessionId>/<port>` relay configured in its
 * `host_bridge` profile — never surfaced in this readiness payload.
 */
export const rewriteStatusUrls = (
  data: Record<string, string | Record<string, string> | undefined>,
  proxyName: string,
  _processId?: string
): void => {
  const urlFields = ['uiUrl', 'wsUrl', 'sandboxUrl', 'codeServerUrl', 'noVncUrl'];

  for (const field of urlFields) {
    const url = data[field];
    if (typeof url !== 'string' || !url) {
      continue;
    }
    const proxyPath = registerAndRewrite(url, `${proxyName}-${field}`);
    if (proxyPath) {
      data[field] = proxyPath;
    }
  }

  // Sandbox service URLs (code_server, vnc, …) live in a nested map, not flat
  // fields. Rewrite each so they too route through the launcher's proxy — the
  // raw upstream (e.g. a private ACI IP) never reaches the browser.
  const services = data['services'];
  if (services && typeof services === 'object') {
    for (const [name, url] of Object.entries(services)) {
      if (typeof url !== 'string' || !url) {
        continue;
      }
      const proxyPath = registerAndRewrite(url, `${proxyName}-svc-${name}`);
      if (proxyPath) {
        services[name] = proxyPath;
      }
    }
  }
};

/**
 * Register ``url``'s origin as an upstream under ``proxyKey`` and return the
 * relative ``/proxy/<key>/...`` path. Returns ``null`` if the value is already
 * proxied or isn't a valid URL.
 */
function registerAndRewrite(url: string, proxyKey: string): string | null {
  try {
    if (url.includes('/proxy/')) {
      return null;
    }
    const parsed = new URL(url);
    const upstream = `${parsed.protocol}//${parsed.host}`;
    const now = Date.now();
    upstreamMap.set(proxyKey, {
      upstream,
      kind: 'trusted-internal',
      createdAt: now,
      lastUsedAt: now,
    });
    const proxyPath = `/proxy/${proxyKey}${parsed.pathname}${parsed.search}`;
    console.log(`[proxy-rewrite] ${proxyKey}: ${redactProxyUrlForLog(url)} → ${proxyPath} (upstream: ${upstream})`);
    return proxyPath;
  } catch {
    return null;
  }
}
