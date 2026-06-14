/**
 * Microsoft Entra ID (AAD) device-code OAuth for the Electron app's cloud
 * link flow.
 *
 * Mirrors the shape of {@link import('./codex-auth.ts').loginWithDeviceFlow}
 * but talks to ``login.microsoftonline.com/<tenant>/oauth2/v2.0`` instead.
 * Two protocol differences worth flagging:
 *
 *   * AAD's poll response uses HTTP 400 with an ``error: authorization_pending``
 *     (or ``slow_down``, ``expired_token``, …) JSON body — not OpenAI's
 *     403/404. We decode the body to decide whether to keep polling.
 *   * AAD requires the app registration to allow public-client flows
 *     (``allowPublicClient: true`` / "Allow public client flows" in the
 *     portal) for device code to work. See infra/DEPLOY.md.
 *
 * The token bundle is persisted via {@link setOauthTokens} (encrypted via
 * Electron ``safeStorage``). It's read back by the renderer transport (over
 * a tiny preload IPC) to attach a Bearer header to ``/api/ws-token`` calls
 * against the cloud launcher.
 */

import { deleteOauthTokens, getOauthTokens, setOauthTokens } from '@/main/secret-store';

/** Persisted shape — keep stable; the renderer reads this via cloud:get-access-token. */
export type EntraTokens = {
  access: string;
  refresh: string;
  /** ms epoch */
  expires: number;
};

export type EntraDeviceCode = {
  userCode: string;
  verificationUri: string;
  /** Same as ``verificationUri`` but pre-filled with the user code. Some IdPs
   *  serve a friendlier UX at this URL; ours just renders the same page. */
  verificationUriComplete?: string;
};

export type EntraStatus =
  | { signedIn: false }
  | { signedIn: true; account: { oid: string; name?: string; email?: string } };

const STORE_ID = 'entra';
/** 60s skew matches our codex-auth client + standard practice for JWT clocks. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * Decode the (unverified) JWT payload. We trust the token because EasyAuth
 * verifies it server-side on every request; the launcher just pulls display
 * fields out of the id_token here.
 */
function decodeJwt(token: string): Record<string, unknown> | undefined {
  const payload = token.split('.')[1];
  if (!payload) {
    return undefined;
  }
  try {
    // Pad base64url for atob/Buffer.
    const b64 = payload
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '=');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
  } catch {
    return undefined;
  }
}

/** Pull the AAD object id + display fields out of a v2.0 id_token / access_token. */
export function extractAccount(tokens: {
  id_token?: string;
  access_token: string;
}): { oid: string; name?: string; email?: string } | undefined {
  const tryClaims = (raw: string | undefined) => {
    if (!raw) {
      return undefined;
    }
    const claims = decodeJwt(raw);
    if (!claims) {
      return undefined;
    }
    const oid = typeof claims['oid'] === 'string' ? (claims['oid'] as string) : undefined;
    if (!oid) {
      return undefined;
    }
    const name = typeof claims['name'] === 'string' ? (claims['name'] as string) : undefined;
    const email =
      typeof claims['email'] === 'string'
        ? (claims['email'] as string)
        : typeof claims['preferred_username'] === 'string'
          ? (claims['preferred_username'] as string)
          : undefined;
    return { oid, name, email };
  };
  return tryClaims(tokens.id_token) ?? tryClaims(tokens.access_token);
}

const deviceCodeUrl = (tenantId: string): string =>
  `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/devicecode`;
const tokenUrl = (tenantId: string): string =>
  `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;

/** Default scope set: an access token for the launcher (``<clientId>/.default``)
 *  with openid + profile so the id_token carries display claims, plus
 *  offline_access for the refresh token. ``.default`` returns a token whose
 *  ``aud`` is the resource (the launcher app's clientId), which is what
 *  EasyAuth's ``allowedAudiences`` is configured to accept. */
const defaultScope = (clientId: string): string => `${clientId}/.default openid profile offline_access`;

/** Refresh an access token using the refresh_token grant. AAD rotates the
 *  refresh token on each call; we always store the latest. */
export async function refreshTokens(tenantId: string, clientId: string, refreshToken: string): Promise<EntraTokens> {
  const resp = await fetch(tokenUrl(tenantId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      scope: defaultScope(clientId),
    }).toString(),
  });
  if (!resp.ok) {
    throw new Error(`Entra token refresh failed: ${resp.status} ${await resp.text().catch(() => '')}`);
  }
  const data = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  return {
    access: data.access_token,
    // AAD typically rotates the refresh token; fall back to the previous one
    // when the response omits it (rare but documented for some grant types).
    refresh: data.refresh_token ?? refreshToken,
    expires: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}

/** Returns *tokens* unchanged when the access token is still fresh, else
 *  refreshes and persists the rotated bundle. */
export async function ensureFreshTokens(tenantId: string, clientId: string, tokens: EntraTokens): Promise<EntraTokens> {
  if (tokens.expires - EXPIRY_SKEW_MS > Date.now()) {
    return tokens;
  }
  const refreshed = await refreshTokens(tenantId, clientId, tokens.refresh);
  setOauthTokens(STORE_ID, refreshed as unknown as Record<string, unknown>);
  return refreshed;
}

/** Fetch + persist a fresh access token. Throws if not signed in. */
export async function ensureFreshAccessToken(tenantId: string, clientId: string): Promise<string> {
  const stored = getOauthTokens(STORE_ID) as EntraTokens | undefined;
  if (!stored?.refresh) {
    throw new Error('Not signed in to cloud');
  }
  const fresh = await ensureFreshTokens(tenantId, clientId, stored);
  return fresh.access;
}

/** Current sign-in status — extracts account from the stored access token
 *  (id_token isn't kept). */
export function getStatus(): EntraStatus {
  const stored = getOauthTokens(STORE_ID) as EntraTokens | undefined;
  if (!stored?.access) {
    return { signedIn: false };
  }
  const account = extractAccount({ access_token: stored.access });
  return account ? { signedIn: true, account } : { signedIn: false };
}

/** Clear the stored token bundle. Caller is responsible for clearing the
 *  cloudMode flag in the store. */
export function logout(): void {
  deleteOauthTokens(STORE_ID);
}

/**
 * Run the AAD device-code flow against *tenantId* / *clientId*. ``onCode``
 * is called as soon as we have the user code so the renderer can render
 * the verification URL + code. On success the access + refresh tokens are
 * persisted via {@link setOauthTokens}.
 */
export async function loginWithDeviceFlow(opts: {
  tenantId: string;
  clientId: string;
  onCode: (code: EntraDeviceCode) => void;
  signal?: AbortSignal;
}): Promise<EntraStatus> {
  const { tenantId, clientId, onCode, signal } = opts;
  const scope = defaultScope(clientId);

  const startResp = await fetch(deviceCodeUrl(tenantId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope }).toString(),
    signal,
  });
  if (!startResp.ok) {
    throw new Error(`Failed to start AAD device auth: ${startResp.status}`);
  }
  const start = (await startResp.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
  };

  onCode({
    userCode: start.user_code,
    verificationUri: start.verification_uri,
    ...(start.verification_uri_complete ? { verificationUriComplete: start.verification_uri_complete } : {}),
  });

  // AAD's default interval is 5s; bump slightly to avoid ``slow_down``.
  let intervalMs = Math.max(Number(start.interval ?? 5), 1) * 1000 + 1000;
  const deadline = Date.now() + Math.max(Number(start.expires_in ?? 900), 60) * 1000;
  const sleep = (ms: number): Promise<void> =>
    new Promise((r) => {
      setTimeout(r, ms);
    });

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error('Cloud sign-in cancelled');
    }
    const poll = await fetch(tokenUrl(tenantId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: clientId,
        device_code: start.device_code,
      }).toString(),
      signal,
    });
    if (poll.status === 200) {
      const data = (await poll.json()) as {
        access_token: string;
        refresh_token: string;
        id_token?: string;
        expires_in?: number;
      };
      const tokens: EntraTokens = {
        access: data.access_token,
        refresh: data.refresh_token,
        expires: Date.now() + (data.expires_in ?? 3600) * 1000,
      };
      setOauthTokens(STORE_ID, tokens as unknown as Record<string, unknown>);
      const account = extractAccount({
        id_token: data.id_token,
        access_token: data.access_token,
      });
      if (!account) {
        // Tokens persisted but the JWT didn't carry an oid claim — surface
        // a clear error so the caller can decide whether to retry / clear.
        throw new Error('AAD returned a token with no oid claim');
      }
      return { signedIn: true, account };
    }
    // Non-200 path: decode the JSON error body. ``authorization_pending``
    // and ``slow_down`` mean "keep polling"; everything else is fatal.
    let body: { error?: string; error_description?: string } = {};
    try {
      body = (await poll.json()) as typeof body;
    } catch {
      throw new Error(`Cloud sign-in failed: ${poll.status} (no error body)`);
    }
    if (body.error === 'authorization_pending') {
      await sleep(intervalMs);
      continue;
    }
    if (body.error === 'slow_down') {
      intervalMs += 5_000;
      await sleep(intervalMs);
      continue;
    }
    if (body.error === 'expired_token') {
      throw new Error('Cloud sign-in code expired before approval');
    }
    if (body.error === 'authorization_declined') {
      throw new Error('Cloud sign-in declined');
    }
    throw new Error(`Cloud sign-in failed: ${body.error ?? 'unknown'} — ${body.error_description ?? ''}`);
  }
  throw new Error('Cloud sign-in timed out');
}
