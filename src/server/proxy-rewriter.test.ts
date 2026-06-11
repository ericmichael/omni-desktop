/**
 * Tests for proxy-rewriter.ts — pure URL rewriting functions.
 *
 * Covers: HTML attribute URL rewriting (absolute, protocol-relative,
 * root-relative), CSP meta tag stripping, already-proxied URL skipping,
 * escapeForRegex, and status URL rewriting with upstream registration.
 */
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildProxyRuntimeShim,
  cleanupExpiredProxyRegistrations,
  escapeForRegex,
  getProxyRuntimePolicy,
  redactProxyUrlForLog,
  registerProxyUpstream,
  resetProxyRegistrationsForTests,
  rewriteCssUrls,
  rewriteHtmlUrls,
  rewriteLocationHeader,
  rewriteProxyRuntimeUrl,
  rewriteMetaRefresh,
  rewriteSetCookieHeader,
  rewriteStatusUrls,
  setupProxyRewriter,
} from '@/server/proxy-rewriter';
import type { WsHandler } from '@/server/ws-handler';

const createProxyTestServer = async (isTrusted: (remoteAddress: string) => boolean) => {
  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  const wsHandler = {
    addEventInterceptor: vi.fn(),
    addResultWrapper: vi.fn(),
  } as unknown as WsHandler;
  setupProxyRewriter(app, wsHandler, isTrusted);
  await app.ready();
  return app;
};

afterEach(() => {
  delete process.env['OMNI_ALLOW_EXTERNAL_REGISTER'];
  delete process.env['OMNI_AUTH_MODE'];
  delete process.env['OMNI_PROXY_DYNAMIC_RUNTIME_SHIMS'];
  delete process.env['OMNI_PROXY_RUNTIME_SHIMS'];
  vi.unstubAllGlobals();
  resetProxyRegistrationsForTests();
});

// ---------------------------------------------------------------------------
// escapeForRegex
// ---------------------------------------------------------------------------

describe('escapeForRegex', () => {
  it('escapes regex metacharacters', () => {
    expect(escapeForRegex('http://host:8080/path?a=1&b=2')).toBe('http://host:8080/path\\?a=1&b=2');
  });

  it('escapes dots, brackets, parens, and pipes', () => {
    expect(escapeForRegex('a.b[c](d)|e')).toBe('a\\.b\\[c\\]\\(d\\)\\|e');
  });

  it('escapes curly braces and caret', () => {
    expect(escapeForRegex('{foo}^bar$')).toBe('\\{foo\\}\\^bar\\$');
  });

  it('leaves alphanumerics untouched', () => {
    expect(escapeForRegex('abc123')).toBe('abc123');
  });

  it('handles empty string', () => {
    expect(escapeForRegex('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// rewriteHtmlUrls
// ---------------------------------------------------------------------------

describe('rewriteHtmlUrls', () => {
  const upstream = 'http://localhost:8082';
  const proxyName = 'chat-uiUrl';

  it('rewrites absolute upstream URLs in href attributes', () => {
    const html = '<a href="http://localhost:8082/page">Link</a>';
    const result = rewriteHtmlUrls(html, upstream, proxyName);
    expect(result).toBe('<a href="/proxy/chat-uiUrl/page">Link</a>');
  });

  it('rewrites absolute upstream URLs in src attributes', () => {
    const html = '<script src="http://localhost:8082/app.js"></script>';
    const result = rewriteHtmlUrls(html, upstream, proxyName);
    expect(result).toBe('<script src="/proxy/chat-uiUrl/app.js"></script>');
  });

  it('rewrites absolute upstream URLs in action attributes', () => {
    const html = '<form action="http://localhost:8082/submit">';
    const result = rewriteHtmlUrls(html, upstream, proxyName);
    expect(result).toBe('<form action="/proxy/chat-uiUrl/submit">');
  });

  it('rewrites protocol-relative URLs matching upstream host', () => {
    const html = '<img src="//localhost:8082/image.png">';
    const result = rewriteHtmlUrls(html, upstream, proxyName);
    expect(result).toBe('<img src="/proxy/chat-uiUrl/image.png">');
  });

  it('rewrites root-relative URLs in attributes', () => {
    const html = '<link href="/styles/main.css">';
    const result = rewriteHtmlUrls(html, upstream, proxyName);
    expect(result).toBe('<link href="/proxy/chat-uiUrl/styles/main.css">');
  });

  it('skips already-proxied root-relative URLs', () => {
    const html = '<a href="/proxy/other/page">Link</a>';
    const result = rewriteHtmlUrls(html, upstream, proxyName);
    // Should NOT double-proxy
    expect(result).toBe('<a href="/proxy/other/page">Link</a>');
  });

  it('skips protocol-relative URLs for non-matching hosts', () => {
    const html = '<img src="//cdn.example.com/image.png">';
    const result = rewriteHtmlUrls(html, upstream, proxyName);
    // Protocol-relative to a different host should not be rewritten
    expect(result).not.toContain('/proxy/chat-uiUrl');
    expect(result).toContain('//cdn.example.com/image.png');
  });

  it('does not rewrite URLs in inline JavaScript', () => {
    const html = '<script>var url = "/api/data";</script>';
    const result = rewriteHtmlUrls(html, upstream, proxyName);
    // The regex targets attributes only — inline JS should not match
    expect(result).toContain('var url = "/api/data"');
  });

  it('strips CSP meta tags', () => {
    const html =
      '<head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'"><title>Test</title></head>';
    const result = rewriteHtmlUrls(html, upstream, proxyName);
    expect(result).not.toContain('Content-Security-Policy');
    expect(result).toContain('<title>Test</title>');
  });

  it('strips CSP meta tags with varying quote styles', () => {
    const html = `<meta http-equiv='Content-Security-Policy' content='default-src'>`;
    const result = rewriteHtmlUrls(html, upstream, proxyName);
    expect(result).not.toContain('Content-Security-Policy');
  });

  it('handles multiple attributes in one document', () => {
    const html = [
      '<a href="http://localhost:8082/page1">P1</a>',
      '<img src="http://localhost:8082/img.png">',
      '<link href="/style.css">',
    ].join('\n');
    const result = rewriteHtmlUrls(html, upstream, proxyName);
    expect(result).toContain('href="/proxy/chat-uiUrl/page1"');
    expect(result).toContain('src="/proxy/chat-uiUrl/img.png"');
    expect(result).toContain('href="/proxy/chat-uiUrl/style.css"');
  });

  it('handles empty upstream gracefully', () => {
    const html = '<a href="/path">Link</a>';
    // Empty upstream should still handle root-relative rewriting
    const result = rewriteHtmlUrls(html, '', proxyName);
    expect(result).toContain('/proxy/chat-uiUrl/path');
  });

  it('rewrites formaction and poster attributes', () => {
    const html = '<button formaction="/submit"><video poster="/thumb.jpg">';
    const result = rewriteHtmlUrls(html, upstream, proxyName);
    expect(result).toContain('formaction="/proxy/chat-uiUrl/submit"');
    expect(result).toContain('poster="/proxy/chat-uiUrl/thumb.jpg"');
  });

  it('rewrites data, iframe src, source src, and track src attributes', () => {
    const html = [
      '<object data="/movie.swf"></object>',
      '<iframe src="/frame.html"></iframe>',
      '<source src="http://localhost:8082/video.mp4">',
      '<track src="//localhost:8082/captions.vtt">',
    ].join('');

    const result = rewriteHtmlUrls(html, upstream, proxyName);

    expect(result).toContain('data="/proxy/chat-uiUrl/movie.swf"');
    expect(result).toContain('src="/proxy/chat-uiUrl/frame.html"');
    expect(result).toContain('src="/proxy/chat-uiUrl/video.mp4"');
    expect(result).toContain('src="/proxy/chat-uiUrl/captions.vtt"');
  });

  it('rewrites preload, prefetch, and modulepreload link hrefs', () => {
    const html = [
      '<link rel="preload" href="/fonts/app.woff2">',
      '<link rel="prefetch" href="http://localhost:8082/next.html">',
      '<link rel="modulepreload" href="//localhost:8082/app.mjs">',
    ].join('');

    const result = rewriteHtmlUrls(html, upstream, proxyName);

    expect(result).toContain('href="/proxy/chat-uiUrl/fonts/app.woff2"');
    expect(result).toContain('href="/proxy/chat-uiUrl/next.html"');
    expect(result).toContain('href="/proxy/chat-uiUrl/app.mjs"');
  });

  it('rewrites multiple srcset candidates independently', () => {
    const html = '<img srcset="/small.png 1x, http://localhost:8082/large.png 2x, //localhost:8082/hero.png 1200w">';

    const result = rewriteHtmlUrls(html, upstream, proxyName);

    expect(result).toBe(
      '<img srcset="/proxy/chat-uiUrl/small.png 1x, /proxy/chat-uiUrl/large.png 2x, /proxy/chat-uiUrl/hero.png 1200w">'
    );
  });

  it('rewrites meta refresh URLs', () => {
    const html = '<meta http-equiv="refresh" content="0; url=/login?next=%2Fhome">';

    const result = rewriteHtmlUrls(html, upstream, proxyName);

    expect(result).toBe('<meta http-equiv="refresh" content="0; url=/proxy/chat-uiUrl/login?next=%2Fhome">');
  });

  it('leaves data, blob, fragment, and third-party absolute HTML URLs untouched', () => {
    const html = [
      '<img src="data:image/png;base64,abc">',
      '<a href="blob:http://localhost:8082/id">blob</a>',
      '<a href="#section">fragment</a>',
      '<a href="https://cdn.example.test/app.js">third party</a>',
      '<img srcset="data:image/png;base64,abc 1x, https://cdn.example.test/img.png 2x">',
    ].join('');

    const result = rewriteHtmlUrls(html, upstream, proxyName);

    expect(result).toBe(html);
  });

  it('handles upstream URLs with special regex characters in origin', () => {
    // Port with special chars in path shouldn't break regex
    const html = '<a href="http://localhost:8082/path?q=1">Link</a>';
    const result = rewriteHtmlUrls(html, upstream, proxyName);
    expect(result).toContain('/proxy/chat-uiUrl/path?q=1');
  });

  it('keeps launcher-looking static links under the proxy prefix and documents proxy route gaps', () => {
    const html = [
      '<a href="/api/config">launcher api</a>',
      '<form action="/proxy/_register" method="post"></form>',
      '<img src="/ws-token-pixel.png">',
    ].join('');

    const result = rewriteHtmlUrls(html, upstream, proxyName);

    expect(result).toContain('href="/proxy/chat-uiUrl/api/config"');
    expect(result).toContain('action="/proxy/_register"');
    expect(result).toContain('src="/proxy/chat-uiUrl/ws-token-pixel.png"');
    expect(result).not.toContain('href="/api/config"');
  });

  it('documents the current hostile-script gap for launcher APIs and service workers', () => {
    const html = [
      '<script>fetch("/api/config")</script>',
      '<script>navigator.serviceWorker.register("/sw.js")</script>',
    ].join('');

    const result = rewriteHtmlUrls(html, upstream, proxyName);

    expect(result).toContain('fetch("/api/config")');
    expect(result).toContain('navigator.serviceWorker.register("/sw.js")');
  });
});

// ---------------------------------------------------------------------------
// Phase 4 CSS and meta refresh helpers
// ---------------------------------------------------------------------------

describe('Phase 4 static rewriting helpers', () => {
  const upstream = 'http://localhost:8082';
  const proxyName = 'chat-uiUrl';

  it('rewrites meta refresh helper output directly', () => {
    expect(
      rewriteMetaRefresh("<meta content='5; url=http://localhost:8082/next' http-equiv='refresh'>", upstream, proxyName)
    ).toBe("<meta content='5; url=/proxy/chat-uiUrl/next' http-equiv='refresh'>");
  });

  it('rewrites CSS url() values with single, double, and unquoted syntax', () => {
    const css = [
      '.a{background:url("/a.png")}',
      ".b{background:url('http://localhost:8082/b.png')}",
      '.c{background:url(//localhost:8082/c.png)}',
    ].join('\n');

    const result = rewriteCssUrls(css, upstream, proxyName);

    expect(result).toContain('url("/proxy/chat-uiUrl/a.png")');
    expect(result).toContain("url('/proxy/chat-uiUrl/b.png')");
    expect(result).toContain('url(/proxy/chat-uiUrl/c.png)');
  });

  it('leaves CSS data, blob, fragment, and third-party absolute URLs untouched', () => {
    const css = [
      '.a{background:url(data:image/png;base64,abc)}',
      '.b{background:url("blob:http://localhost:8082/id")}',
      ".c{mask:url('#icon')}",
      '.d{background:url(https://cdn.example.test/img.png)}',
    ].join('\n');

    expect(rewriteCssUrls(css, upstream, proxyName)).toBe(css);
  });
});

// ---------------------------------------------------------------------------
// Phase 5 runtime compatibility shim helpers
// ---------------------------------------------------------------------------

describe('Phase 5 runtime compatibility shims', () => {
  const upstream = 'http://localhost:8082';
  const currentHref = 'http://launcher.test/proxy/chat-uiUrl/app/page.html?view=1#top';

  it('defaults expanded runtime URL rewriting to trusted-internal entries only', () => {
    expect(getProxyRuntimePolicy('trusted-internal')).toEqual({
      version: 1,
      expandedRuntimeUrls: true,
      blockServiceWorkerRegistration: false,
    });
    expect(getProxyRuntimePolicy('dynamic')).toEqual({
      version: 1,
      expandedRuntimeUrls: false,
      blockServiceWorkerRegistration: true,
    });
  });

  it('allows expanded dynamic runtime shims only behind an explicit gate', () => {
    process.env['OMNI_PROXY_DYNAMIC_RUNTIME_SHIMS'] = '1';

    expect(getProxyRuntimePolicy('dynamic')).toMatchObject({
      expandedRuntimeUrls: true,
      blockServiceWorkerRegistration: true,
    });

    process.env['OMNI_PROXY_RUNTIME_SHIMS'] = '0';
    expect(getProxyRuntimePolicy('dynamic').expandedRuntimeUrls).toBe(false);
  });

  it('rewrites same-upstream and root-relative runtime URLs through the active proxy prefix', () => {
    expect(rewriteProxyRuntimeUrl('http://localhost:8082/api/data?q=1', currentHref, upstream, 'chat-uiUrl')).toBe(
      'http://launcher.test/proxy/chat-uiUrl/api/data?q=1'
    );
    expect(rewriteProxyRuntimeUrl('/api/config', currentHref, upstream, 'chat-uiUrl')).toBe(
      'http://launcher.test/proxy/chat-uiUrl/api/config'
    );
    expect(rewriteProxyRuntimeUrl('/ws', currentHref, upstream, 'chat-uiUrl', 'websocket')).toBe(
      'ws://launcher.test/proxy/chat-uiUrl/ws'
    );
  });

  it('does not rewrite third-party absolute runtime URLs', () => {
    expect(rewriteProxyRuntimeUrl('https://cdn.example.test/app.js', currentHref, upstream, 'chat-uiUrl')).toBe(
      'https://cdn.example.test/app.js'
    );
    expect(
      rewriteProxyRuntimeUrl('wss://socket.example.test/ws', currentHref, upstream, 'chat-uiUrl', 'websocket')
    ).toBe('wss://socket.example.test/ws');
  });

  it('keeps launcher API and unrelated proxy paths under the active proxy prefix', () => {
    expect(rewriteProxyRuntimeUrl('/proxy/_register', currentHref, upstream, 'chat-uiUrl')).toBe(
      'http://launcher.test/proxy/chat-uiUrl/proxy/_register'
    );
    expect(rewriteProxyRuntimeUrl('/proxy/other/private', currentHref, upstream, 'chat-uiUrl')).toBe(
      'http://launcher.test/proxy/chat-uiUrl/proxy/other/private'
    );
  });

  it('handles relative WebSocket URLs with the current proxied page URL as base', () => {
    expect(rewriteProxyRuntimeUrl('../socket', currentHref, upstream, 'chat-uiUrl', 'websocket')).toBe(
      'ws://launcher.test/proxy/chat-uiUrl/socket'
    );
    expect(rewriteProxyRuntimeUrl('ws://localhost:8082/live', currentHref, upstream, 'chat-uiUrl', 'websocket')).toBe(
      'ws://launcher.test/proxy/chat-uiUrl/live'
    );
  });

  it('rewrites absolute launcher-host ws:// URLs despite the scheme-bearing origin mismatch', () => {
    // noVNC builds ws://<location.hostname>:<location.port>/websockify — the
    // launcher's host with a ws: scheme. WHATWG origins include the scheme, so
    // an origin equality check alone would miss it and the RFB socket would
    // bypass the proxy.
    expect(
      rewriteProxyRuntimeUrl('ws://launcher.test/websockify', currentHref, upstream, 'chat-svc-vnc', 'websocket')
    ).toBe('ws://launcher.test/proxy/chat-svc-vnc/websockify');
    // Already-proxied ws:// URLs on the launcher host must pass through, not
    // get double-prefixed.
    expect(
      rewriteProxyRuntimeUrl(
        'ws://launcher.test/proxy/chat-svc-vnc/websockify',
        currentHref,
        upstream,
        'chat-svc-vnc',
        'websocket'
      )
    ).toBe('ws://launcher.test/proxy/chat-svc-vnc/websockify');
  });

  it('generates a versioned shim with URL hooks and service worker policy controls', () => {
    const shim = buildProxyRuntimeShim({
      proxyName: 'dyn-abc',
      upstream: 'https://docs.example.test',
      policy: { version: 1, expandedRuntimeUrls: true, blockServiceWorkerRegistration: true },
    });

    expect(shim).toContain('data-omni-proxy-runtime-shim="1"');
    expect(shim).toContain('"proxyName":"dyn-abc"');
    expect(shim).toContain('"expandedRuntimeUrls":true');
    expect(shim).toContain('new URL(input, location.href)');
    expect(shim).toContain('window.fetch=function');
    expect(shim).toContain('XMLHttpRequest.prototype.open');
    expect(shim).toContain('window.WebSocket=function');
    expect(shim).toContain('window.Worker=function');
    expect(shim).toContain('navigator.serviceWorker.register=function');
    expect(shim).toContain('__preview_navigate__');
  });

  it('injects trusted-internal pages with expanded runtime shims and dynamic pages with blocked service workers', async () => {
    const app = await createProxyTestServer(() => true);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(
          () => new Response('<html><head></head><body>ok</body></html>', { headers: { 'content-type': 'text/html' } })
        )
    );
    registerProxyUpstream('chat-uiUrl', upstream);

    try {
      const trusted = await app.inject({ method: 'GET', url: '/proxy/chat-uiUrl/app' });
      expect(trusted.body).toContain('data-omni-proxy-runtime-shim="1"');
      expect(trusted.body).toContain('"proxyName":"chat-uiUrl"');
      expect(trusted.body).toContain('"expandedRuntimeUrls":true');
      expect(trusted.body).toContain('"blockServiceWorkerRegistration":false');

      const registration = await app.inject({
        method: 'POST',
        url: '/proxy/_register',
        payload: { upstream: 'https://docs.example.test/app' },
      });
      const { proxyPath, proxyName } = registration.json() as { proxyPath: string; proxyName: string };
      const dynamic = await app.inject({ method: 'GET', url: proxyPath });

      expect(dynamic.body).toContain(`"proxyName":"${proxyName}"`);
      expect(dynamic.body).toContain('"expandedRuntimeUrls":false');
      expect(dynamic.body).toContain('"blockServiceWorkerRegistration":true');
      expect(dynamic.body).toContain('navigator.serviceWorker.register=function');
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 3 response/request helpers
// ---------------------------------------------------------------------------

describe('Phase 3 proxy helpers', () => {
  it('rewrites same-upstream Location headers under the active proxy prefix', () => {
    expect(rewriteLocationHeader('/next?ok=1#done', 'https://docs.example.test', 'dyn-abc')).toBe(
      '/proxy/dyn-abc/next?ok=1#done'
    );
    expect(rewriteLocationHeader('https://docs.example.test/next', 'https://docs.example.test', 'dyn-abc')).toBe(
      '/proxy/dyn-abc/next'
    );
  });

  it('leaves cross-origin Location headers absolute and intentional', () => {
    expect(rewriteLocationHeader('https://login.example.test/oauth', 'https://docs.example.test', 'dyn-abc')).toBe(
      'https://login.example.test/oauth'
    );
  });

  it('rewrites Set-Cookie Path and Domain while preserving safe attributes', () => {
    expect(
      rewriteSetCookieHeader(
        'sid=abc; Domain=docs.example.test; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=60',
        'dyn-abc'
      )
    ).toBe('sid=abc; Path=/proxy/dyn-abc; HttpOnly; Secure; SameSite=Lax; Max-Age=60');
  });

  it('drops invalid SameSite values during Set-Cookie rewriting', () => {
    expect(rewriteSetCookieHeader('sid=abc; SameSite=Unexpected; HttpOnly', 'dyn-abc')).toBe(
      'sid=abc; Path=/proxy/dyn-abc; HttpOnly'
    );
  });

  it('redacts sensitive query parameters from log URLs', () => {
    expect(redactProxyUrlForLog('https://docs.example.test/path?token=abc&mode=read&api_key=secret#section')).toBe(
      'https://docs.example.test/path?token=%5BREDACTED%5D&mode=read&api_key=%5BREDACTED%5D#section'
    );
    expect(redactProxyUrlForLog('/proxy/name/path?code=abc&tab=1')).toBe('/proxy/name/path?code=%5BREDACTED%5D&tab=1');
  });
});

// ---------------------------------------------------------------------------
// Phase 3 HTTP proxy semantics
// ---------------------------------------------------------------------------

describe('Phase 3 HTTP proxy semantics', () => {
  it('preserves method, query string, body, content type, and normalized upstream headers', async () => {
    const app = await createProxyTestServer(() => true);
    const fetchMock = vi.fn().mockResolvedValue(new Response('created', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    registerProxyUpstream('docs', 'https://docs.example.test');

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/proxy/docs/forms/submit?token=abc&mode=edit',
        headers: {
          'content-type': 'application/json',
          connection: 'keep-alive, x-drop-me',
          'x-drop-me': 'remove-this',
          'x-keep-me': 'keep-this',
          host: 'launcher.example.test',
          origin: 'https://launcher.example.test',
          referer: 'https://launcher.example.test/proxy/docs/forms/start?step=1',
        },
        payload: JSON.stringify({ hello: 'world' }),
      });

      expect(response.statusCode).toBe(201);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://docs.example.test/forms/submit?token=abc&mode=edit',
        expect.objectContaining({
          method: 'POST',
          redirect: 'manual',
          body: expect.any(Buffer),
          duplex: 'half',
        })
      );
      const init = fetchMock.mock.calls[0]![1] as RequestInit & { headers: Record<string, string> };
      expect(Buffer.isBuffer(init.body)).toBe(true);
      expect(Buffer.from(init.body as Buffer).toString()).toBe('{"hello":"world"}');
      expect(init.headers['content-type']).toContain('application/json');
      expect(init.headers.host).toBe('docs.example.test');
      expect(init.headers.origin).toBe('https://docs.example.test');
      expect(init.headers.referer).toBe('https://docs.example.test/forms/start?step=1');
      expect(init.headers['x-keep-me']).toBe('keep-this');
      expect(init.headers.connection).toBeUndefined();
      expect(init.headers['x-drop-me']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('rewrites redirect Location and Set-Cookie response headers', async () => {
    const app = await createProxyTestServer(() => true);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: [
            ['location', '/after-login?ok=1'],
            ['set-cookie', 'sid=abc; Domain=docs.example.test; Path=/; HttpOnly; Secure; SameSite=None'],
            ['set-cookie', 'pref=light; Path=/settings; SameSite=Lax'],
          ],
        })
      )
    );
    registerProxyUpstream('docs', 'https://docs.example.test');

    try {
      const response = await app.inject({ method: 'GET', url: '/proxy/docs/login' });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/proxy/docs/after-login?ok=1');
      expect(response.cookies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'sid', path: '/proxy/docs', httpOnly: true, secure: true, sameSite: 'None' }),
          expect.objectContaining({ name: 'pref', path: '/proxy/docs', sameSite: 'Lax' }),
        ])
      );
    } finally {
      await app.close();
    }
  });

  it('leaves cross-origin redirects absolute', async () => {
    const app = await createProxyTestServer(() => true);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(null, { status: 302, headers: { location: 'https://login.example.test/oauth' } })
        )
    );
    registerProxyUpstream('docs', 'https://docs.example.test');

    try {
      const response = await app.inject({ method: 'GET', url: '/proxy/docs/login' });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('https://login.example.test/oauth');
    } finally {
      await app.close();
    }
  });

  it('streams non-HTML response bodies without using arrayBuffer', async () => {
    const app = await createProxyTestServer(() => true);
    const arrayBufferSpy = vi.spyOn(Response.prototype, 'arrayBuffer');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(new Uint8Array([0, 1, 2, 255]), { headers: { 'content-type': 'application/octet-stream' } })
        )
    );
    registerProxyUpstream('docs', 'https://docs.example.test');

    try {
      const response = await app.inject({ method: 'GET', url: '/proxy/docs/blob.bin' });

      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(Buffer.from([0, 1, 2, 255]));
      expect(arrayBufferSpy).not.toHaveBeenCalled();
    } finally {
      arrayBufferSpy.mockRestore();
      await app.close();
    }
  });

  it('rewrites CSS responses only when content-type is text/css', async () => {
    const app = await createProxyTestServer(() => true);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('.hero{background:url(/hero.png)}', { headers: { 'content-type': 'text/css' } })
        )
    );
    registerProxyUpstream('docs', 'https://docs.example.test');

    try {
      const response = await app.inject({ method: 'GET', url: '/proxy/docs/app.css' });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('.hero{background:url(/proxy/docs/hero.png)}');
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// /proxy/_register current-state security contract
// ---------------------------------------------------------------------------

describe('/proxy/_register dynamic capabilities', () => {
  it('rejects registration when the caller is outside the trusted network', async () => {
    const app = await createProxyTestServer(() => false);

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/proxy/_register',
        payload: { name: 'blocked', upstream: 'https://example.com/path' },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'Forbidden: caller not in trusted network' });
    } finally {
      await app.close();
    }
  });

  it('mints an opaque proxy name and preserves the initial path and query', async () => {
    const app = await createProxyTestServer(() => true);

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/proxy/_register',
        payload: { upstream: 'https://docs.example.test/guide?q=proxy#section' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { ok: true; proxyName: string; proxyPath: string; expiresAt: number };
      expect(body.ok).toBe(true);
      expect(body.proxyName).toMatch(/^dyn-[a-f0-9]{32}$/);
      expect(body.proxyPath).toBe(`/proxy/${body.proxyName}/guide?q=proxy`);
      expect(body.expiresAt).toBeGreaterThan(Date.now());
    } finally {
      await app.close();
    }
  });

  it('ignores renderer-supplied names for dynamic registrations', async () => {
    const app = await createProxyTestServer(() => true);

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/proxy/_register',
        payload: { name: 'renderer-controlled', upstream: 'https://example.test/' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { proxyName: string; proxyPath: string };
      expect(body.proxyName).not.toBe('renderer-controlled');
      expect(body.proxyPath).not.toBe('/proxy/renderer-controlled/');
      expect(body.proxyPath).toBe(`/proxy/${body.proxyName}/`);
    } finally {
      await app.close();
    }
  });

  it('keeps the current operator escape hatch for untrusted callers', async () => {
    process.env['OMNI_ALLOW_EXTERNAL_REGISTER'] = '1';
    const app = await createProxyTestServer(() => false);

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/proxy/_register',
        payload: { upstream: 'https://example.test/' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { proxyName: string; proxyPath: string };
      expect(body.proxyName).toMatch(/^dyn-[a-f0-9]{32}$/);
      expect(body.proxyPath).toBe(`/proxy/${body.proxyName}/`);
    } finally {
      await app.close();
    }
  });

  it('rejects non-HTTP URL schemes', async () => {
    const app = await createProxyTestServer(() => true);

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/proxy/_register',
        payload: { name: 'file-gap', upstream: 'file:///etc/passwd' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'Invalid upstream URL: expected http(s)' });
    } finally {
      await app.close();
    }
  });

  it('allows access to a minted proxy capability', async () => {
    const app = await createProxyTestServer(() => true);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('proxied ok', { headers: { 'content-type': 'text/plain' } }))
    );

    try {
      const register = await app.inject({
        method: 'POST',
        url: '/proxy/_register',
        payload: { upstream: 'https://docs.example.test/guide?q=proxy' },
      });
      const body = register.json() as { proxyPath: string };

      const proxied = await app.inject({ method: 'GET', url: body.proxyPath });

      expect(proxied.statusCode).toBe(200);
      expect(proxied.body).toBe('proxied ok');
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        'https://docs.example.test/guide?q=proxy',
        expect.objectContaining({ method: 'GET' })
      );
    } finally {
      await app.close();
    }
  });

  it('checks EasyAuth owner metadata before serving dynamic proxy capabilities', async () => {
    process.env['OMNI_AUTH_MODE'] = 'easyauth';
    const app = await createProxyTestServer(() => true);

    try {
      const register = await app.inject({
        method: 'POST',
        url: '/proxy/_register',
        headers: { 'x-ms-client-principal-id': 'alice' },
        payload: { upstream: 'https://docs.example.test/' },
      });
      const body = register.json() as { proxyPath: string };

      const missingPrincipal = await app.inject({ method: 'GET', url: body.proxyPath });
      const wrongPrincipal = await app.inject({
        method: 'GET',
        url: body.proxyPath,
        headers: { 'x-ms-client-principal-id': 'bob' },
      });

      expect(missingPrincipal.statusCode).toBe(401);
      expect(wrongPrincipal.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('cleans up expired dynamic registrations deterministically', async () => {
    const app = await createProxyTestServer(() => true);

    try {
      const register = await app.inject({
        method: 'POST',
        url: '/proxy/_register',
        payload: { upstream: 'https://docs.example.test/' },
      });
      const body = register.json() as { proxyPath: string; expiresAt: number };

      expect(cleanupExpiredProxyRegistrations(body.expiresAt + 1)).toBe(1);
      const proxied = await app.inject({ method: 'GET', url: body.proxyPath });

      expect(proxied.statusCode).toBe(502);
      expect(proxied.json()).toEqual({ error: expect.stringContaining('No upstream registered') });
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// rewriteStatusUrls
// ---------------------------------------------------------------------------

describe('rewriteStatusUrls', () => {
  it('keeps trusted internal status registrations named and owner-independent', async () => {
    process.env['OMNI_AUTH_MODE'] = 'easyauth';
    const app = await createProxyTestServer(() => true);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('internal ok', { headers: { 'content-type': 'text/plain' } }))
    );

    try {
      const data: Record<string, string | undefined> = {
        uiUrl: 'http://localhost:8082/app',
      };
      rewriteStatusUrls(data, 'chat');

      expect(data.uiUrl).toBe('/proxy/chat-uiUrl/app');
      const proxied = await app.inject({ method: 'GET', url: data.uiUrl });

      expect(proxied.statusCode).toBe(200);
      expect(proxied.body).toBe('internal ok');
    } finally {
      await app.close();
    }
  });

  it('rewrites uiUrl to proxy path', () => {
    const data: Record<string, string | undefined> = {
      uiUrl: 'http://localhost:8082/app',
    };
    rewriteStatusUrls(data, 'chat');
    expect(data.uiUrl).toBe('/proxy/chat-uiUrl/app');
  });

  it('rewrites wsUrl to proxy path', () => {
    const data: Record<string, string | undefined> = {
      wsUrl: 'ws://localhost:9000/ws',
    };
    rewriteStatusUrls(data, 'agent');
    expect(data.wsUrl).toBe('/proxy/agent-wsUrl/ws');
  });

  it('rewrites multiple URL fields at once', () => {
    const data: Record<string, string | undefined> = {
      uiUrl: 'http://localhost:8082/',
      wsUrl: 'ws://localhost:9000/ws',
      sandboxUrl: 'http://localhost:3000/sandbox',
    };
    rewriteStatusUrls(data, 'test');
    expect(data.uiUrl).toBe('/proxy/test-uiUrl/');
    expect(data.wsUrl).toBe('/proxy/test-wsUrl/ws');
    expect(data.sandboxUrl).toBe('/proxy/test-sandboxUrl/sandbox');
  });

  it('skips undefined URL fields', () => {
    const data: Record<string, string | undefined> = {
      uiUrl: undefined,
      wsUrl: 'ws://localhost:9000/ws',
    };
    rewriteStatusUrls(data, 'test');
    expect(data.uiUrl).toBeUndefined();
    expect(data.wsUrl).toBe('/proxy/test-wsUrl/ws');
  });

  it('skips already-proxied URLs', () => {
    const data: Record<string, string | undefined> = {
      uiUrl: '/proxy/chat-uiUrl/app',
    };
    rewriteStatusUrls(data, 'chat');
    // Should not double-proxy
    expect(data.uiUrl).toBe('/proxy/chat-uiUrl/app');
  });

  it('skips invalid URLs without throwing', () => {
    const data: Record<string, string | undefined> = {
      uiUrl: 'not-a-url',
    };
    // Should not throw
    rewriteStatusUrls(data, 'test');
    // Invalid URL stays as-is
    expect(data.uiUrl).toBe('not-a-url');
  });

  it('preserves query strings in rewritten URLs', () => {
    const data: Record<string, string | undefined> = {
      uiUrl: 'http://localhost:8082/app?token=abc&mode=dev',
    };
    rewriteStatusUrls(data, 'chat');
    expect(data.uiUrl).toBe('/proxy/chat-uiUrl/app?token=abc&mode=dev');
  });

  it('handles all recognized URL fields', () => {
    const data: Record<string, string | undefined> = {
      uiUrl: 'http://localhost:1001/',
      wsUrl: 'ws://localhost:1002/',
      sandboxUrl: 'http://localhost:1003/',
      codeServerUrl: 'http://localhost:1004/',
      noVncUrl: 'http://localhost:1005/',
    };
    rewriteStatusUrls(data, 'x');
    expect(data.uiUrl).toBe('/proxy/x-uiUrl/');
    expect(data.wsUrl).toBe('/proxy/x-wsUrl/');
    expect(data.sandboxUrl).toBe('/proxy/x-sandboxUrl/');
    expect(data.codeServerUrl).toBe('/proxy/x-codeServerUrl/');
    expect(data.noVncUrl).toBe('/proxy/x-noVncUrl/');
  });

  it('ignores non-URL fields in the data object', () => {
    const data: Record<string, string | undefined> = {
      uiUrl: 'http://localhost:8082/',
      someOtherField: 'http://localhost:9999/should-not-change',
    };
    rewriteStatusUrls(data, 'test');
    expect(data.someOtherField).toBe('http://localhost:9999/should-not-change');
  });

  it('rewrites entries in the nested services map', () => {
    const data: Record<string, string | Record<string, string> | undefined> = {
      uiUrl: 'http://localhost:8082/',
      services: {
        code_server: 'http://10.40.1.4:8080/',
        vnc: 'http://10.40.1.4:6080/vnc.html',
      },
    };
    rewriteStatusUrls(data, 'chat');
    const services = data.services as Record<string, string>;
    expect(services.code_server).toBe('/proxy/chat-svc-code_server/');
    expect(services.vnc).toBe('/proxy/chat-svc-vnc/vnc.html');
  });

  it('leaves already-proxied service URLs untouched', () => {
    const data: Record<string, string | Record<string, string> | undefined> = {
      services: { code_server: '/proxy/chat-svc-code_server/' },
    };
    rewriteStatusUrls(data, 'chat');
    const services = data.services as Record<string, string>;
    expect(services.code_server).toBe('/proxy/chat-svc-code_server/');
  });
});
