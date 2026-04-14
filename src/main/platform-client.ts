/**
 * Client for the omni-platform management plane API.
 *
 * When configured (platform URL + credentials), the launcher delegates
 * container lifecycle and policy to the platform instead of running
 * local Docker. When not configured, the launcher runs in open-source
 * mode with local Docker — this client is never instantiated.
 */

import { SimpleLogger } from '@/lib/simple-logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlatformConfig = {
  /** Platform URL — baked in at build time, not user-provided */
  url: string;
  accessToken: string;
  refreshToken: string;
};

export type PlatformSession = {
  sessionId: string;
  runtimeToken: string;
  status: 'pending' | 'active' | 'completed' | 'failed';
  websocketUrl?: string;
  containerId?: string;
  authToken?: string;
  error?: string;
};

export type PlatformPolicy = {
  project?: {
    name: string;
    framework?: string;
    framework_version?: string;
    allow_user_models?: boolean;
    allow_user_mcp_servers?: boolean;
    runtime?: { name: string; resource_id: number };
  };
  sandbox_profiles: Array<{
    resource_id: number;
    name: string;
    backend: string;
    variant?: string;
    image?: string;
    network_mode?: string;
    resource_limits?: Record<string, string | number>;
    volume_policy?: Record<string, unknown>;
  }>;
  network_allowlist: Array<{ hostname: string; port: number; protocol: string }>;
  skills: Array<{ resource_id: number; name: string; version?: string; content_url: string }>;
  mcp_servers: Array<{ resource_id: number; name: string; transport: string; config: Record<string, unknown> }>;
  dashboards: Array<{
    resource_id: number;
    name: string;
    dashboard_id: string;
    workspace_url: string;
    widget_count: number;
    embed_url: string;
  }>;
  data_access: Array<{ resource_id: number; name: string; fqn: string; phi: boolean }>;
  security: { safety_mode: string; mcp_require_allowlist: boolean };
  content_scanning: { enabled: boolean; provider: string; action: string };
};

export type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
  message: string;
};

export type AuthTokenResponse = {
  status: 'authenticated' | 'pending' | 'expired';
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  user?: {
    id: number;
    email: string;
    name: string;
    role: string;
    domains: Array<{ id: number; name: string; slug: string }>;
  };
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class PlatformClient {
  private config: PlatformConfig;
  private log: SimpleLogger;
  private fetchFn: typeof globalThis.fetch;

  /** Called when a token refresh succeeds, so callers can persist the new token. */
  onTokenRefresh?: (newAccessToken: string) => void;

  constructor(config: PlatformConfig, fetchFn?: typeof globalThis.fetch) {
    this.config = config;
    this.fetchFn = fetchFn ?? globalThis.fetch;
    this.log = new SimpleLogger((entry) => console[entry.level](`[Platform] ${entry.message}`));
  }

  get url(): string {
    return this.config.url;
  }

  get isConfigured(): boolean {
    return Boolean(this.config.url && this.config.accessToken);
  }

  // --- Auth ---

  static async initiateDeviceCode(platformUrl: string, fetchFn?: typeof fetch): Promise<DeviceCodeResponse> {
    const f = fetchFn ?? globalThis.fetch;
    const res = await f(`${platformUrl}/api/v1/auth/device_code`, { method: 'POST' });
    if (!res.ok) {
throw new Error(`Device code request failed: ${res.status}`);
}
    return res.json() as Promise<DeviceCodeResponse>;
  }

  static async pollForToken(
    platformUrl: string,
    deviceCode: string,
    fetchFn?: typeof fetch
  ): Promise<AuthTokenResponse> {
    const f = fetchFn ?? globalThis.fetch;
    const res = await f(`${platformUrl}/api/v1/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: deviceCode }),
    });
    return res.json() as Promise<AuthTokenResponse>;
  }

  async refreshAccessToken(): Promise<string> {
    const res = await this.fetchFn(`${this.config.url}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.refreshToken}` },
    });
    if (!res.ok) {
throw new Error(`Token refresh failed: ${res.status}`);
}
    const body = (await res.json()) as { access_token: string };
    this.config.accessToken = body.access_token;
    this.onTokenRefresh?.(body.access_token);
    return body.access_token;
  }

  // --- Policy ---

  async getPolicy(agentSlug: string, domain?: string): Promise<PlatformPolicy> {
    const url = new URL(`/api/v1/policy/${agentSlug}`, this.config.url);
    if (domain) {
url.searchParams.set('domain', domain);
}

    const res = await this.authedFetch(url.toString());
    if (!res.ok) {
throw new Error(`Policy fetch failed: ${res.status}`);
}
    return res.json() as Promise<PlatformPolicy>;
  }

  // --- Compute ---

  async startSession(
    agentSlug: string,
    domain?: string,
    gitRepo?: { url: string; branch?: string }
  ): Promise<PlatformSession> {
    const body: Record<string, unknown> = { agent: agentSlug };
    if (domain) {
body.domain = domain;
}
    if (gitRepo) {
      body.git_repo_url = gitRepo.url;
      if (gitRepo.branch) {
body.git_branch = gitRepo.branch;
}
    }

    const res = await this.authedFetch(`${this.config.url}/api/v1/compute/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
throw new Error(`Start session failed: ${res.status}`);
}
    const data = (await res.json()) as { session_id: string; runtime_token: string; status: string };
    return {
      sessionId: data.session_id,
      runtimeToken: data.runtime_token,
      status: data.status as PlatformSession['status'],
    };
  }

  async pollSessionStatus(sessionId: string): Promise<PlatformSession> {
    const res = await this.authedFetch(
      `${this.config.url}/api/v1/compute/status?session_id=${sessionId}`
    );
    if (!res.ok) {
throw new Error(`Status poll failed: ${res.status}`);
}
    const data = (await res.json()) as {
      session_id: string;
      status: string;
      container_id?: string;
      websocket_url?: string;
      auth_token?: string;
      ready?: boolean;
      error?: string;
    };
    return {
      sessionId: data.session_id,
      runtimeToken: '', // already issued at start
      status: data.status as PlatformSession['status'],
      websocketUrl: data.websocket_url,
      containerId: data.container_id,
      authToken: data.auth_token,
      error: data.error,
    };
  }

  async waitForSession(sessionId: string, maxAttempts = 120): Promise<PlatformSession> {
    for (let i = 0; i < maxAttempts; i++) {
      const session = await this.pollSessionStatus(sessionId);
      if (session.status === 'active' && session.websocketUrl) {
return session;
}
      if (session.status === 'failed') {
throw new Error(session.error || 'Session failed');
}
      await new Promise<void>((r) => setTimeout(r, 2000));
    }
    throw new Error('Session did not become ready in time');
  }

  async execInSession(
    sessionId: string,
    command: string,
    workdir?: string,
    timeout?: number
  ): Promise<{ success: boolean; exitCode: number; stdout: string; stderr: string }> {
    const body: Record<string, unknown> = { session_id: sessionId, command };
    if (workdir) {
body.workdir = workdir;
}
    if (timeout) {
body.timeout = timeout;
}

    const res = await this.authedFetch(`${this.config.url}/api/v1/compute/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
throw new Error(`Exec in session failed: ${res.status}`);
}
    const data = (await res.json()) as {
      success: boolean;
      exit_code: number;
      stdout: string;
      stderr: string;
    };
    return {
      success: data.success,
      exitCode: data.exit_code,
      stdout: data.stdout,
      stderr: data.stderr,
    };
  }

  async stopSession(sessionId: string): Promise<void> {
    const res = await this.authedFetch(`${this.config.url}/api/v1/compute/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    });
    if (!res.ok) {
      this.log.warn(`Stop session failed: ${res.status}`);
    }
  }

  // --- Project workspace (persistent per-project share for background sync) ---

  async getProjectWorkspace(projectId: string): Promise<{ sasUrl: string; shareName: string; expiresAt: number }> {
    const res = await this.authedFetch(`${this.config.url}/api/v1/compute/workspace/project-share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId }),
    });
    if (!res.ok) {
throw new Error(`Project workspace request failed: ${res.status}`);
}
    const data = (await res.json()) as { sas_url: string; share_name: string; expires_at: number };
    return { sasUrl: data.sas_url, shareName: data.share_name, expiresAt: data.expires_at };
  }

  // --- Encryption key (for client-side file encryption) ---

  async getProjectEncryptionKey(projectId: string): Promise<Buffer> {
    const res = await this.authedFetch(`${this.config.url}/api/v1/compute/workspace/encryption-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId }),
    });
    if (!res.ok) {
throw new Error(`Encryption key request failed: ${res.status}`);
}
    const data = (await res.json()) as { key: string };
    return Buffer.from(data.key, 'base64');
  }

  // --- Session workspace ---

  async prepareWorkspace(sessionId: string): Promise<{ uploadSasUrl: string; shareName: string }> {
    const res = await this.authedFetch(`${this.config.url}/api/v1/compute/workspace/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    });
    if (!res.ok) {
throw new Error(`Prepare workspace failed: ${res.status}`);
}
    const data = (await res.json()) as { session_id: string; upload_sas_url: string; share_name: string };
    return { uploadSasUrl: data.upload_sas_url, shareName: data.share_name };
  }

  async finalizeWorkspace(sessionId: string): Promise<{ downloadSasUrl: string }> {
    const res = await this.authedFetch(`${this.config.url}/api/v1/compute/workspace/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    });
    if (!res.ok) {
throw new Error(`Finalize workspace failed: ${res.status}`);
}
    const data = (await res.json()) as { session_id: string; download_sas_url: string };
    return { downloadSasUrl: data.download_sas_url };
  }

  // --- Workspace audit ---

  async reportWorkspaceAuditEvents(
    events: Array<{
      action: 'workspace_sync.upload' | 'workspace_sync.download' | 'workspace_sync.delete';
      share_name: string;
      file_path: string;
      file_size: number;
      timestamp: number;
    }>
  ): Promise<void> {
    if (events.length === 0) {
return;
}
    const res = await this.authedFetch(`${this.config.url}/api/v1/audit/workspace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
    });
    if (!res.ok) {
      this.log.warn(`Workspace audit report failed: ${res.status}`);
    }
  }

  // --- Internal ---

  private async authedFetch(url: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${this.config.accessToken}`);

    let res = await this.fetchFn(url, { ...init, headers });

    // Auto-refresh on 401
    if (res.status === 401 && this.config.refreshToken) {
      try {
        await this.refreshAccessToken();
        headers.set('Authorization', `Bearer ${this.config.accessToken}`);
        res = await this.fetchFn(url, { ...init, headers });
      } catch {
        // refresh failed, return the 401
      }
    }

    return res;
  }
}
