/**
 * Tests for PlatformClient — enterprise auth, compute lifecycle, workspace
 * operations, and 401 auto-refresh.
 *
 * PlatformClient already accepts `fetchFn` in its constructor — tests
 * provide a mock function, no vi.mock needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PlatformClient, type PlatformConfig } from '@/main/platform-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = 'https://platform.example.com';

const makeConfig = (overrides: Partial<PlatformConfig> = {}): PlatformConfig => ({
  url: BASE_URL,
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  ...overrides,
});

type MockFetch = ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

// ---------------------------------------------------------------------------
// Static methods
// ---------------------------------------------------------------------------

describe('PlatformClient static methods', () => {
  it('initiateDeviceCode sends POST to /api/v1/auth/device_code', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ device_code: 'dc-1', user_code: 'ABCD', verification_uri: 'https://auth', expires_in: 300, interval: 5, message: 'Go' })
    );
    const result = await PlatformClient.initiateDeviceCode(BASE_URL, fetchFn as unknown as typeof fetch);
    expect(fetchFn).toHaveBeenCalledWith(`${BASE_URL}/api/v1/auth/device_code`, { method: 'POST' });
    expect(result.user_code).toBe('ABCD');
  });

  it('initiateDeviceCode throws on non-ok response', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 500 }));
    await expect(PlatformClient.initiateDeviceCode(BASE_URL, fetchFn as unknown as typeof fetch)).rejects.toThrow('500');
  });

  it('pollForToken sends POST with device_code', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ status: 'authenticated', access_token: 'at', refresh_token: 'rt' })
    );
    const result = await PlatformClient.pollForToken(BASE_URL, 'dc-1', fetchFn as unknown as typeof fetch);
    expect(fetchFn).toHaveBeenCalledWith(
      `${BASE_URL}/api/v1/auth/token`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ device_code: 'dc-1' }) })
    );
    expect(result.status).toBe('authenticated');
  });
});

// ---------------------------------------------------------------------------
// Instance methods
// ---------------------------------------------------------------------------

describe('PlatformClient instance', () => {
  let fetchFn: MockFetch;
  let client: PlatformClient;

  beforeEach(() => {
    fetchFn = vi.fn();
    client = new PlatformClient(makeConfig(), fetchFn as unknown as typeof globalThis.fetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('isConfigured returns true when url and accessToken present', () => {
    expect(client.isConfigured).toBe(true);
  });

  it('url returns the platform URL', () => {
    expect(client.url).toBe(BASE_URL);
  });

  // --- refreshAccessToken ---

  it('refreshAccessToken updates internal token and fires callback', async () => {
    fetchFn.mockResolvedValueOnce(jsonResponse({ access_token: 'new-token' }));
    const callback = vi.fn();
    client.onTokenRefresh = callback;

    const result = await client.refreshAccessToken();
    expect(result).toBe('new-token');
    expect(callback).toHaveBeenCalledWith('new-token');
  });

  it('refreshAccessToken throws on non-ok response', async () => {
    fetchFn.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(client.refreshAccessToken()).rejects.toThrow('401');
  });

  // --- getPolicy ---

  it('getPolicy sends GET with agent slug', async () => {
    fetchFn.mockResolvedValueOnce(jsonResponse({ sandbox_profiles: [] }));
    await client.getPolicy('omni-code');
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/policy/omni-code'),
      expect.objectContaining({ headers: expect.any(Headers) })
    );
  });

  it('getPolicy includes domain param when provided', async () => {
    fetchFn.mockResolvedValueOnce(jsonResponse({ sandbox_profiles: [] }));
    await client.getPolicy('omni-code', 'acme');
    const url = (fetchFn.mock.calls[0]![0] as string);
    expect(url).toContain('domain=acme');
  });

  // --- startSession ---

  it('startSession sends POST with agent and optional git repo', async () => {
    fetchFn.mockResolvedValueOnce(
      jsonResponse({ session_id: 's1', runtime_token: 'rt1', status: 'pending' })
    );
    const result = await client.startSession('omni-code', 'acme', { url: 'https://github.com/repo', branch: 'main' });
    expect(result.sessionId).toBe('s1');
    const body = JSON.parse(fetchFn.mock.calls[0]![1]!.body as string);
    expect(body.agent).toBe('omni-code');
    expect(body.domain).toBe('acme');
    expect(body.git_repo_url).toBe('https://github.com/repo');
    expect(body.git_branch).toBe('main');
  });

  // --- pollSessionStatus ---

  it('pollSessionStatus maps response fields', async () => {
    fetchFn.mockResolvedValueOnce(
      jsonResponse({
        session_id: 's1',
        status: 'active',
        websocket_url: 'ws://host',
        container_id: 'c1',
        auth_token: 'at',
      })
    );
    const result = await client.pollSessionStatus('s1');
    expect(result.status).toBe('active');
    expect(result.websocketUrl).toBe('ws://host');
    expect(result.containerId).toBe('c1');
    expect(result.authToken).toBe('at');
  });

  // --- waitForSession ---

  it('waitForSession resolves when session becomes active with websocketUrl', async () => {
    vi.useFakeTimers();
    fetchFn
      .mockResolvedValueOnce(jsonResponse({ session_id: 's1', status: 'pending' }))
      .mockResolvedValueOnce(jsonResponse({ session_id: 's1', status: 'active', websocket_url: 'ws://host' }));

    const promise = client.waitForSession('s1', 5);
    // Advance through setTimeout(2000) calls
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;
    expect(result.status).toBe('active');
    vi.useRealTimers();
  });

  it('waitForSession throws when session fails', async () => {
    fetchFn.mockResolvedValue(jsonResponse({ session_id: 's1', status: 'failed', error: 'OOM' }));
    // No fake timers needed — the first poll immediately hits 'failed' and throws
    await expect(client.waitForSession('s1', 5)).rejects.toThrow('OOM');
  });

  // --- stopSession ---

  it('stopSession does not throw on non-ok response', async () => {
    fetchFn.mockResolvedValueOnce(new Response(null, { status: 500 }));
    await expect(client.stopSession('s1')).resolves.toBeUndefined();
  });

  // --- execInSession ---

  it('execInSession maps response fields', async () => {
    fetchFn.mockResolvedValueOnce(
      jsonResponse({ success: true, exit_code: 0, stdout: 'ok', stderr: '' })
    );
    const result = await client.execInSession('s1', 'ls');
    expect(result).toEqual({ success: true, exitCode: 0, stdout: 'ok', stderr: '' });
  });

  // --- workspace ops ---

  it('getProjectWorkspace maps response fields', async () => {
    fetchFn.mockResolvedValueOnce(
      jsonResponse({ sas_url: 'https://sas', share_name: 'share1', expires_at: 9999 })
    );
    const result = await client.getProjectWorkspace('proj-1');
    expect(result).toEqual({ sasUrl: 'https://sas', shareName: 'share1', expiresAt: 9999 });
  });

  it('getProjectEncryptionKey returns Buffer from base64', async () => {
    const keyBase64 = Buffer.from('test-key-32-bytes-long-padding!!').toString('base64');
    fetchFn.mockResolvedValueOnce(jsonResponse({ key: keyBase64 }));
    const result = await client.getProjectEncryptionKey('proj-1');
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.toString()).toBe('test-key-32-bytes-long-padding!!');
  });

  // --- audit ---

  it('reportWorkspaceAuditEvents is a no-op for empty events', async () => {
    await client.reportWorkspaceAuditEvents([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  // --- 401 auto-refresh ---

  it('auto-refreshes token on 401 and retries', async () => {
    fetchFn
      // First call: 401
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      // Refresh call: success
      .mockResolvedValueOnce(jsonResponse({ access_token: 'refreshed-token' }))
      // Retry: success
      .mockResolvedValueOnce(jsonResponse({ sandbox_profiles: [] }));

    const result = await client.getPolicy('omni-code');
    expect(result).toBeDefined();
    // 3 calls: original, refresh, retry
    expect(fetchFn).toHaveBeenCalledTimes(3);
    // The retry should use the refreshed token
    const retryHeaders = fetchFn.mock.calls[2]![1]!.headers as Headers;
    expect(retryHeaders.get('Authorization')).toBe('Bearer refreshed-token');
  });

  it('returns original 401 when refresh fails', async () => {
    fetchFn
      // First call: 401
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      // Refresh: fails
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    await expect(client.getPolicy('omni-code')).rejects.toThrow('Policy fetch failed: 401');
  });
});
