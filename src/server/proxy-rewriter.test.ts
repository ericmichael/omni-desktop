/**
 * Tests for proxy-rewriter.ts — pure URL rewriting functions.
 *
 * Covers: HTML attribute URL rewriting (absolute, protocol-relative,
 * root-relative), CSP meta tag stripping, already-proxied URL skipping,
 * escapeForRegex, and status URL rewriting with upstream registration.
 */
import { describe, expect, it } from 'vitest';

import { escapeForRegex, rewriteHtmlUrls, rewriteStatusUrls } from '@/server/proxy-rewriter';

// ---------------------------------------------------------------------------
// escapeForRegex
// ---------------------------------------------------------------------------

describe('escapeForRegex', () => {
  it('escapes regex metacharacters', () => {
    expect(escapeForRegex('http://host:8080/path?a=1&b=2')).toBe(
      'http://host:8080/path\\?a=1&b=2'
    );
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

  it('handles upstream URLs with special regex characters in origin', () => {
    // Port with special chars in path shouldn't break regex
    const html = '<a href="http://localhost:8082/path?q=1">Link</a>';
    const result = rewriteHtmlUrls(html, upstream, proxyName);
    expect(result).toContain('/proxy/chat-uiUrl/path?q=1');
  });
});

// ---------------------------------------------------------------------------
// rewriteStatusUrls
// ---------------------------------------------------------------------------

describe('rewriteStatusUrls', () => {
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
});
