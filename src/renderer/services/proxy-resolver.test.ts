import { beforeEach, describe, expect, it, vi } from 'vitest';

async function loadResolver() {
  vi.resetModules();
  vi.doMock('@/renderer/services/ipc', () => ({
    isCloudLinked: false,
    isElectron: false,
    serverOrigin: () => window.location.origin,
  }));
  return import('@/renderer/services/proxy-resolver');
}

function fetchMock() {
  return vi.mocked(fetch);
}

describe('proxy-resolver', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('returns explicit success metadata and registers external origins', async () => {
    fetchMock().mockResolvedValue(
      new Response(
        JSON.stringify({
          proxyName: 'dyn-github',
          proxyPath: '/proxy/dyn-github/acme/repo/pull/42?tab=files',
        }),
        { status: 200 }
      )
    );
    const { resolveProxiedSrc } = await loadResolver();

    const result = await resolveProxiedSrc('https://github.com/acme/repo/pull/42?tab=files#diff');

    expect(result).toEqual({
      ok: true,
      canonicalUrl: 'https://github.com/acme/repo/pull/42?tab=files#diff',
      iframeSrc: '/proxy/dyn-github/acme/repo/pull/42?tab=files#diff',
      proxyName: 'dyn-github',
    });
    expect(fetchMock()).toHaveBeenCalledWith(
      `${window.location.origin}/proxy/_register`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ upstream: 'https://github.com/acme/repo/pull/42?tab=files#diff' }),
      })
    );
  });

  it('returns explicit failure and retries after non-OK registration without caching', async () => {
    fetchMock()
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ proxyName: 'dyn-example', proxyPath: '/proxy/dyn-example/docs?q=1' }), {
          status: 200,
        })
      );
    const { resolveProxiedSrc, unproxyUrl } = await loadResolver();

    const failed = await resolveProxiedSrc('https://example.com/docs?q=1#top');

    expect(failed).toEqual({
      ok: false,
      canonicalUrl: 'https://example.com/docs?q=1#top',
      reason: 'Proxy registration failed (403): forbidden',
      status: 403,
    });
    expect(unproxyUrl('/proxy/ext-https-example-com/docs?q=1#top')).toBe('/proxy/ext-https-example-com/docs?q=1#top');

    const retried = await resolveProxiedSrc('https://example.com/docs?q=1#top');

    expect(retried).toMatchObject({
      ok: true,
      canonicalUrl: 'https://example.com/docs?q=1#top',
      iframeSrc: '/proxy/dyn-example/docs?q=1#top',
      proxyName: 'dyn-example',
    });
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });

  it('unproxies known transport URLs while preserving query and hash', async () => {
    fetchMock().mockResolvedValue(
      new Response(JSON.stringify({ proxyName: 'dyn-example', proxyPath: '/proxy/dyn-example/first' }), { status: 200 })
    );
    const { resolveProxiedSrc, unproxyUrl } = await loadResolver();

    await resolveProxiedSrc('https://example.com/first');

    expect(unproxyUrl('/proxy/dyn-example/path/to/page?q=1#section')).toBe(
      'https://example.com/path/to/page?q=1#section'
    );
    await expect(resolveProxiedSrc('/proxy/dyn-example/path/to/page?q=1#section')).resolves.toEqual({
      ok: true,
      canonicalUrl: 'https://example.com/path/to/page?q=1#section',
      iframeSrc: '/proxy/dyn-example/path/to/page?q=1#section',
      proxyName: 'dyn-example',
    });
  });

  it('leaves unknown proxy transport paths safe and unregistered', async () => {
    const { resolveProxiedSrc, unproxyUrl } = await loadResolver();

    expect(unproxyUrl('/proxy/unknown/path?q=1#hash')).toBe('/proxy/unknown/path?q=1#hash');
    await expect(resolveProxiedSrc('/proxy/unknown/path?q=1#hash')).resolves.toEqual({
      ok: true,
      canonicalUrl: '/proxy/unknown/path?q=1#hash',
      iframeSrc: '/proxy/unknown/path?q=1#hash',
      proxyName: 'unknown',
    });
    expect(fetchMock()).not.toHaveBeenCalled();
  });
});
