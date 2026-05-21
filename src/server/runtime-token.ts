/**
 * Runtime tokens — the credential a remote agent sandbox uses to call back into
 * the launcher server's tenant-scoped data API (the HTTP MCP route).
 *
 * The container only ever holds this token (injected as `OMNI_RUNTIME_TOKEN`)
 * and presents it as `Authorization: Bearer <token>`; the server verifies the
 * signature and resolves the tenant from the payload. It is therefore the trust
 * boundary between an untrusted sandbox and one tenant's data, so it must be
 * unforgeable — a plain `${tenantId}.${sessionId}` string would let a sandbox
 * pick any tenant by editing its own env.
 *
 * Format (compact, dependency-free): `<base64url(payload)>.<base64url(hmac)>`
 * where payload is `{ tid, sid, iat, exp }` and the MAC is HMAC-SHA256 over the
 * payload segment. Symmetric by design: the same server that mints also
 * verifies. Across replicas the secret must be shared (set the env var); a
 * per-process random secret only works single-replica.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_TTL_SEC = 12 * 60 * 60; // 12h — comfortably longer than a session.

export interface RuntimeTokenClaims {
  tenantId: string;
  sessionId: string;
}

interface TokenPayload {
  tid: string;
  sid: string;
  iat: number;
  exp: number;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function hmac(secret: string, data: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

/**
 * Resolve the signing secret. Prefer the explicit env var (required for
 * multi-replica deployments so every replica agrees); otherwise mint a random
 * per-process secret and warn — fine for local/single-replica, useless across
 * replicas because each would reject the others' tokens.
 */
export function resolveRuntimeTokenSecret(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['OMNI_RUNTIME_TOKEN_SECRET'];
  if (explicit && explicit.length >= 16) {
    return explicit;
  }
  if (explicit) {
    console.warn('[runtime-token] OMNI_RUNTIME_TOKEN_SECRET is too short (<16 chars); ignoring.');
  }
  const generated = crypto.randomUUID() + crypto.randomUUID();
  console.warn(
    '[runtime-token] OMNI_RUNTIME_TOKEN_SECRET not set — using a random per-process secret. ' +
      'Set it to a stable value for multi-replica deployments.'
  );
  return generated;
}

/** Mint a signed runtime token binding a sandbox session to its tenant. */
export function signRuntimeToken(
  secret: string,
  claims: RuntimeTokenClaims,
  ttlSec = DEFAULT_TTL_SEC,
  now = Date.now()
): string {
  const iat = Math.floor(now / 1000);
  const payload: TokenPayload = { tid: claims.tenantId, sid: claims.sessionId, iat, exp: iat + ttlSec };
  const segment = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(hmac(secret, segment));
  return `${segment}.${sig}`;
}

/**
 * Verify a runtime token and return its claims, or null if the signature is
 * invalid, the format is malformed, or it has expired.
 */
export function verifyRuntimeToken(
  secret: string,
  token: string,
  now = Date.now()
): RuntimeTokenClaims | null {
  const dot = token.indexOf('.');
  if (dot <= 0) {
    return null;
  }
  const segment = token.slice(0, dot);
  const provided = token.slice(dot + 1);

  const expected = b64url(hmac(secret, segment));
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return null;
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(segment, 'base64url').toString('utf-8')) as TokenPayload;
  } catch {
    return null;
  }
  if (!payload.tid || !payload.sid || typeof payload.exp !== 'number') {
    return null;
  }
  if (payload.exp * 1000 <= now) {
    return null;
  }
  return { tenantId: payload.tid, sessionId: payload.sid };
}
