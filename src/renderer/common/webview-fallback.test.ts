import { describe, expect, it } from 'vitest';

import {
  getWebviewFallbackDiagnostics,
  isProxyTransportUrl,
  redactUrlForDiagnostics,
} from '@/renderer/common/webview-fallback';

describe('webview fallback diagnostics', () => {
  it('maps forbidden proxy registration failures to an actionable browser/server message', () => {
    const diagnostics = getWebviewFallbackDiagnostics(
      {
        code: 403,
        description: 'Proxy registration failed (403): Forbidden: caller not in trusted network',
        url: 'https://github.com/acme/repo/pull/42?tab=files',
      },
      'https://github.com/acme/repo/pull/42?tab=files'
    );

    expect(diagnostics).toMatchObject({
      title: 'Proxy registration was blocked',
      reason: 'Omni was not allowed to register this site with the browser/server proxy.',
      canonicalUrl: 'https://github.com/acme/repo/pull/42?tab=files',
      displayUrl: 'https://github.com/acme/repo/pull/42?tab=files',
    });
  });

  it('recognizes denied upstream, DNS, TLS, timeout, redirect loop, and unsupported feature hints', () => {
    expect(
      getWebviewFallbackDiagnostics(
        { code: 400, description: 'Invalid upstream URL: expected http(s)', url: 'ftp://example.test/file' },
        'ftp://example.test/file'
      ).title
    ).toBe('This address cannot be proxied');
    expect(
      getWebviewFallbackDiagnostics(
        { code: -105, description: 'ERR_NAME_NOT_RESOLVED', url: 'https://missing.example.test/' },
        'https://missing.example.test/'
      ).title
    ).toBe('DNS lookup failed');
    expect(
      getWebviewFallbackDiagnostics(
        { code: -202, description: 'ERR_CERT_AUTHORITY_INVALID', url: 'https://tls.example.test/' },
        'https://tls.example.test/'
      ).title
    ).toBe('Secure connection failed');
    expect(
      getWebviewFallbackDiagnostics(
        { code: -118, description: 'ERR_CONNECTION_TIMED_OUT', url: 'https://slow.example.test/' },
        'https://slow.example.test/'
      ).title
    ).toBe('The site took too long to respond');
    expect(
      getWebviewFallbackDiagnostics(
        { code: -310, description: 'ERR_TOO_MANY_REDIRECTS', url: 'https://loop.example.test/' },
        'https://loop.example.test/'
      ).title
    ).toBe('Redirect loop detected');
    expect(
      getWebviewFallbackDiagnostics(
        {
          code: -1,
          description: 'Unsupported browser feature: service worker registration',
          url: 'https://app.example.test/',
        },
        'https://app.example.test/'
      ).title
    ).toBe('Browser feature not supported here');
  });

  it('keeps proxy transport URLs out of primary diagnostics but exposes redacted debug details', () => {
    const diagnostics = getWebviewFallbackDiagnostics(
      {
        code: -1,
        description: 'Failed to load page',
        url: 'https://docs.example.test/private?token=secret#access_token=abc',
        transportUrl: '/proxy/dyn-docs/private?token=secret#access_token=abc',
      },
      'https://docs.example.test/private?token=secret#access_token=abc'
    );

    expect(diagnostics.canonicalUrl).toBe('https://docs.example.test/private?token=secret#access_token=abc');
    expect(diagnostics.displayUrl).toBe('https://docs.example.test/private?token=%5Bredacted%5D#[redacted]');
    expect(diagnostics.transportUrl).toBe('/proxy/dyn-docs/private?token=%5Bredacted%5D#[redacted]');
    expect(isProxyTransportUrl(diagnostics.displayUrl)).toBe(false);
    expect(isProxyTransportUrl('/proxy/dyn-docs/private')).toBe(true);
  });

  it('redacts sensitive query and hash values without changing non-sensitive URLs', () => {
    expect(redactUrlForDiagnostics('https://example.test/path?code=abc&tab=files#token=secret')).toBe(
      'https://example.test/path?code=%5Bredacted%5D&tab=files#[redacted]'
    );
    expect(redactUrlForDiagnostics('https://example.test/path?tab=files#section')).toBe(
      'https://example.test/path?tab=files#section'
    );
  });
});
