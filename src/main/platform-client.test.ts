/**
 * Tests for PlatformClient — enterprise auth, compute lifecycle, workspace
 * operations, and 401 auto-refresh.
 *
 * PlatformClient already accepts `fetchFn` in its constructor — tests
 * provide a mock function, no vi.mock needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PlatformClient, type PlatformConfig, PlatformSessionContractError } from '@/main/platform-client';

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

const platformSession = (overrides: Record<string, unknown> = {}) => ({
  session_id: 's1',
  status: 'active',
  agent_host_id: 'agent-host-1',
  workspace_id: 'workspace-1',
  environment_id: 'environment-1',
  environment_generation: 3,
  workspace_root: '/workspace/project',
  default_cwd: '/workspace/project',
  services: { code_server: 'https://code.example.test' },
  consumer_credential: { token: 'consumer-token-1', scope: 'consumer', kind: 'ordinary' },
  websocket_url: 'wss://runtime.example.test/ws',
  container_id: 'c1',
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
      jsonResponse({
        device_code: 'dc-1',
        user_code: 'ABCD',
        verification_uri: 'https://auth',
        expires_in: 300,
        interval: 5,
        message: 'Go',
      })
    );
    const result = await PlatformClient.initiateDeviceCode(BASE_URL, fetchFn as unknown as typeof fetch);
    expect(fetchFn).toHaveBeenCalledWith(`${BASE_URL}/api/v1/auth/device_code`, { method: 'POST' });
    expect(result.user_code).toBe('ABCD');
  });

  it('initiateDeviceCode throws on non-ok response', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 500 }));
    await expect(PlatformClient.initiateDeviceCode(BASE_URL, fetchFn as unknown as typeof fetch)).rejects.toThrow(
      '500'
    );
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
    const url = fetchFn.mock.calls[0]![0] as string;
    expect(url).toContain('domain=acme');
  });

  // --- startSession ---

  it('startSession sends POST with agent and optional git repo', async () => {
    fetchFn.mockResolvedValueOnce(jsonResponse(platformSession({ status: 'pending', websocket_url: undefined })));
    const result = await client.startSession('omni-code', 'acme', { url: 'https://github.com/repo', branch: 'main' });
    expect(result.sessionId).toBe('s1');
    expect(result).toMatchObject({
      agentHostId: 'agent-host-1',
      workspaceId: 'workspace-1',
      environmentId: 'environment-1',
      environmentGeneration: 3,
      workspaceRoot: '/workspace/project',
      defaultCwd: '/workspace/project',
      services: { code_server: 'https://code.example.test' },
      consumerCredential: { token: 'consumer-token-1', scope: 'consumer', kind: 'ordinary' },
    });
    const body = JSON.parse(fetchFn.mock.calls[0]![1]!.body as string);
    expect(body.agent).toBe('omni-code');
    expect(body.domain).toBe('acme');
    expect(body.git_repo_url).toBe('https://github.com/repo');
    expect(body.git_branch).toBe('main');
  });

  // --- pollSessionStatus ---

  it('pollSessionStatus maps response fields', async () => {
    fetchFn.mockResolvedValueOnce(jsonResponse(platformSession({ websocket_url: 'wss://host.example.test/ws' })));
    const result = await client.pollSessionStatus('s1');
    expect(result.status).toBe('active');
    expect(result.websocketUrl).toBe('wss://host.example.test/ws');
    expect(result.containerId).toBe('c1');
    expect(result.consumerCredential.token).toBe('consumer-token-1');
  });

  it.each([
    'agent_host_id',
    'workspace_id',
    'environment_id',
    'environment_generation',
    'workspace_root',
    'default_cwd',
    'services',
    'consumer_credential',
  ])('fails closed when a remote session omits %s', async (field) => {
    const response = platformSession();
    delete response[field as keyof typeof response];
    fetchFn.mockResolvedValueOnce(jsonResponse(response));
    await expect(client.pollSessionStatus('s1')).rejects.toBeInstanceOf(PlatformSessionContractError);
  });

  it('rejects legacy, privileged, mismatched, or URL-embedded credentials', async () => {
    fetchFn.mockResolvedValueOnce(jsonResponse(platformSession({ auth_token: 'legacy-admin-like-token' })));
    await expect(client.pollSessionStatus('s1')).rejects.toThrow(/forbidden privileged or legacy credential/);

    fetchFn.mockResolvedValueOnce(
      jsonResponse(platformSession({ admin_credential: { token: 'must-never-cross-the-boundary' } }))
    );
    await expect(client.pollSessionStatus('s1')).rejects.toThrow(/forbidden privileged or legacy credential/);

    fetchFn.mockResolvedValueOnce(
      jsonResponse(
        platformSession({
          consumer_credential: { token: 'admin', scope: 'admin', kind: 'ordinary' },
        })
      )
    );
    await expect(client.pollSessionStatus('s1')).rejects.toThrow(/consumer scope and ordinary kind/);

    fetchFn.mockResolvedValueOnce(jsonResponse(platformSession({ session_id: 'another-session' })));
    await expect(client.pollSessionStatus('s1')).rejects.toThrow(/does not match/);

    fetchFn.mockResolvedValueOnce(
      jsonResponse(platformSession({ websocket_url: 'wss://runtime.example.test/ws?token=leak' }))
    );
    await expect(client.pollSessionStatus('s1')).rejects.toThrow(/must not contain credentials in its query/);
  });

  it.each([
    [{ environment_generation: 0 }, /positive safe integer/],
    [{ workspace_root: 'relative/workspace' }, /absolute normalized path/],
    [{ default_cwd: '/another/root' }, /inside workspace_root/],
    [{ services: { vnc: 'ftp://services.example.test' } }, /unsupported protocol/],
    [{ consumer_credential: { token: '', scope: 'consumer', kind: 'ordinary' } }, /must be a non-empty string/],
    [{ status: 'mystery' }, /unsupported value/],
  ])('rejects malformed routing metadata %#', async (overrides, error) => {
    fetchFn.mockResolvedValueOnce(jsonResponse(platformSession(overrides)));
    await expect(client.pollSessionStatus('s1')).rejects.toThrow(error as RegExp);
  });

  // --- waitForSession ---

  it('waitForSession resolves when session becomes active with websocketUrl', async () => {
    vi.useFakeTimers();
    fetchFn
      .mockResolvedValueOnce(jsonResponse(platformSession({ status: 'pending', websocket_url: undefined })))
      .mockResolvedValueOnce(jsonResponse(platformSession()));

    const promise = client.waitForSession('s1', 5);
    // Advance through setTimeout(2000) calls
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;
    expect(result.status).toBe('active');
    vi.useRealTimers();
  });

  it('waitForSession throws when session fails', async () => {
    fetchFn.mockResolvedValue(
      jsonResponse(platformSession({ status: 'failed', websocket_url: undefined, error: 'OOM' }))
    );
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
    fetchFn.mockResolvedValueOnce(jsonResponse({ success: true, exit_code: 0, stdout: 'ok', stderr: '' }));
    const result = await client.execInSession('s1', 'ls');
    expect(result).toEqual({ success: true, exitCode: 0, stdout: 'ok', stderr: '' });
  });

  // --- workspace ops ---

  it('getProjectWorkspace maps response fields', async () => {
    fetchFn.mockResolvedValueOnce(jsonResponse({ sas_url: 'https://sas', share_name: 'share1', expires_at: 9999 }));
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
