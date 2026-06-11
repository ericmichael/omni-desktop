import { beforeEach, describe, expect, it, vi } from 'vitest';

async function loadBridge() {
  vi.resetModules();
  return import('@/renderer/features/Tickets/preview-bridge');
}

describe('preview-bridge', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('keeps preview URLs canonical and does not pre-register proxy paths', async () => {
    const { resolvePreviewUrl } = await loadBridge();
    const url = 'https://github.com/acme/repo/pull/42';

    await expect(resolvePreviewUrl(url, 'tab-1')).resolves.toBe(url);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('stores PR preview requests with canonical URLs', async () => {
    const { $previewRequest, requestPreviewOpen } = await loadBridge();
    const url = 'https://github.com/acme/repo/pull/42';

    requestPreviewOpen(url, 'tab-1');
    await Promise.resolve();

    expect($previewRequest.get()).toEqual({ id: 'preview-1', url, tabId: 'tab-1' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
