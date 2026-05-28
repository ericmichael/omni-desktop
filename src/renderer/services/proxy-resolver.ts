/**
 * Browser-mode iframe proxy bridge.
 *
 * In server/browser mode the renderer is a plain SPA — `<iframe src=…>` loads
 * external URLs directly, and almost every modern site refuses to be framed
 * via `X-Frame-Options` or CSP `frame-ancestors`. The server already strips
 * those headers in its `/proxy/:proxyName/*` reverse-proxy (see
 * `src/server/proxy-rewriter.ts`); this module wires arbitrary upstreams
 * through that proxy so `<Webview>` can embed them.
 *
 * Pre-proxied URLs (e.g. emitted by the server's `rewriteStatusUrls` for
 * chat/codeServer/noVNC) pass through unchanged — only external origins are
 * registered + rewritten.
 *
 * Electron uses `<webview>` (a guest BrowserView), which is not subject to
 * frame-ancestors, so this code is a no-op there.
 */

import { isCloudLinked, isElectron, serverOrigin } from '@/renderer/services/ipc';

/** Reverse map populated as we register upstreams, used to "un-proxy" reported URLs. */
const upstreamByName = new Map<string, string>();
const nameByOrigin = new Map<string, string>();
/** De-dup in-flight registrations per origin. */
const pendingByOrigin = new Map<string, Promise<void>>();

/**
 * The launcher's origin from the renderer's perspective. In browser server
 * mode that's same-origin. In cloud-linked Electron the renderer is loaded
 * from localhost:5173 (dev) or file:// (prod) but the launcher lives at
 * the cloud baseUrl — so all ``/proxy/...`` URL construction and "is this
 * already proxied?" detection must anchor against the cloud, not the
 * renderer's own origin.
 */
const launcherOrigin = (): string => serverOrigin();

const slug = (origin: string): string =>
  origin
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

const proxyNameFor = (origin: string): string => `ext-${slug(origin)}`;

const tryParseUrl = (raw: string): URL | null => {
  try {
    return new URL(raw, launcherOrigin());
  } catch {
    return null;
  }
};

const isExternalHttp = (url: URL): boolean => {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false;
  }
  if (url.origin !== launcherOrigin()) {
    return true;
  }
  // Same launcher origin but not already proxied → leave it alone (dev assets,
  // launcher's own SPA pages, etc.).
  return false;
};

const ensureRegistered = (origin: string, name: string): Promise<void> => {
  if (upstreamByName.has(name)) {
    return Promise.resolve();
  }
  const existing = pendingByOrigin.get(origin);
  if (existing) {
    return existing;
  }
  const pending = (async () => {
    try {
      // Absolute URL so cloud-linked Electron hits the cloud's /proxy/_register
      // instead of localhost:5173 (which has no such route). Browser server-
      // mode resolves to same-origin same as before.
      await fetch(`${launcherOrigin()}/proxy/_register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, upstream: origin }),
      });
      upstreamByName.set(name, origin);
    } catch {
      // Server unreachable — leave unregistered; the iframe load will
      // surface a normal load error and the retry path will kick in.
    } finally {
      pendingByOrigin.delete(origin);
    }
  })();
  pendingByOrigin.set(origin, pending);
  return pending;
};

/**
 * Resolve a raw URL into one safe to set as an `<iframe>` `src` attribute.
 * For external http(s) origins, registers the upstream with the server and
 * returns the corresponding `/proxy/<name>/<path>` path. Otherwise returns
 * the input unchanged.
 */
export const resolveProxiedSrc = async (rawSrc: string): Promise<string> => {
  if (!rawSrc || isElectron) {
    return rawSrc;
  }
  const parsed = tryParseUrl(rawSrc);
  if (!parsed) {
    return rawSrc;
  }
  if (parsed.origin === launcherOrigin() && parsed.pathname.startsWith('/proxy/')) {
    // Already proxied — record the mapping if we recognize the name so
    // unproxyUrl can reverse it later.
    const name = parsed.pathname.slice('/proxy/'.length).split('/')[0] ?? '';
    if (name && !upstreamByName.has(name)) {
      // We don't know the upstream origin from the path alone, so leave it.
    }
    // In cloud-linked Electron the iframe needs the absolute URL — Vite
    // would otherwise resolve the relative path against localhost:5173.
    return isCloudLinked
      ? `${launcherOrigin()}${parsed.pathname}${parsed.search}${parsed.hash}`
      : parsed.pathname + parsed.search + parsed.hash;
  }
  if (!isExternalHttp(parsed)) {
    return rawSrc;
  }
  const origin = parsed.origin;
  let name = nameByOrigin.get(origin);
  if (!name) {
    name = proxyNameFor(origin);
    nameByOrigin.set(origin, name);
  }
  await ensureRegistered(origin, name);
  // Absolute when cloud-linked so the iframe doesn't resolve against the
  // renderer's own origin (localhost:5173 / file://).
  const path = `/proxy/${name}${parsed.pathname}${parsed.search}${parsed.hash}`;
  return isCloudLinked ? `${launcherOrigin()}${path}` : path;
};

/**
 * Reverse of `resolveProxiedSrc`. Takes a (possibly absolute) `/proxy/<name>/…`
 * URL and returns the original upstream URL, so the omnibox/history can keep
 * showing pretty external addresses instead of proxy paths.
 */
export const unproxyUrl = (url: string): string => {
  if (!url || isElectron) {
    return url;
  }
  const parsed = tryParseUrl(url);
  if (!parsed) {
    return url;
  }
  if (parsed.origin !== launcherOrigin()) {
    return url;
  }
  if (!parsed.pathname.startsWith('/proxy/')) {
    return url;
  }
  const rest = parsed.pathname.slice('/proxy/'.length);
  const slash = rest.indexOf('/');
  const name = slash === -1 ? rest : rest.slice(0, slash);
  const subPath = slash === -1 ? '/' : rest.slice(slash);
  const upstream = upstreamByName.get(name);
  if (!upstream) {
    return url;
  }
  return `${upstream}${subPath}${parsed.search}${parsed.hash}`;
};
