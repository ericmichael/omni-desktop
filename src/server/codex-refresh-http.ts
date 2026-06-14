/**
 * Callback endpoint for the in-runtime Codex token refresh.
 *
 * When the runtime's `_CodexTokenManager` refreshes the access token (and
 * possibly rotates the refresh token), it must persist the new bundle to the
 * launcher's durable store — otherwise the next spawn pre-materializes a
 * stale (and possibly invalidated) refresh token from the database and the
 * user gets silently logged out. The runtime POSTs here right after a
 * successful refresh; the route authenticates via the same `OMNI_RUNTIME_TOKEN`
 * the runtime already carries for HTTP MCP calls.
 *
 * Cloud-only. Local SQLite mode doesn't redirect `XDG_CONFIG_HOME`, so the
 * runtime's file-based persistence already updates the same file the launcher
 * reads — no callback needed.
 */
import type { FastifyInstance } from 'fastify';

import type { PgSecretStore } from '@/server/pg-secret-store';
import { verifyRuntimeToken } from '@/server/runtime-token';

export const CODEX_REFRESH_PATH = '/api/codex/refresh';

export interface CodexRefreshDeps {
  /** Secret the runtime token was signed with (see runtime-token.ts). */
  runtimeTokenSecret: string;
  /** Durable per-principal token store. */
  pgSecret: PgSecretStore;
}

function bearer(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !value.startsWith('Bearer ')) {
    return undefined;
  }
  const token = value.slice('Bearer '.length).trim();
  return token || undefined;
}

type RefreshBody = {
  refresh?: unknown;
  access?: unknown;
  expires?: unknown;
  account_id?: unknown;
};

export function registerCodexRefreshRoute(fastify: FastifyInstance, deps: CodexRefreshDeps): void {
  fastify.post(CODEX_REFRESH_PATH, async (request, reply) => {
    const token = bearer(request.headers['authorization']);
    const claims = token ? verifyRuntimeToken(deps.runtimeTokenSecret, token) : null;
    if (!claims || !claims.principalId) {
      reply.code(401).send({ error: 'Unauthorized: missing or invalid runtime token' });
      return;
    }
    const body = (request.body ?? {}) as RefreshBody;
    if (typeof body.refresh !== 'string' || typeof body.access !== 'string' || typeof body.expires !== 'number') {
      reply.code(400).send({ error: 'Invalid body: expected { refresh, access, expires (ms), account_id? }' });
      return;
    }
    const tokens: Record<string, unknown> = {
      refresh: body.refresh,
      access: body.access,
      expires: body.expires,
    };
    if (typeof body.account_id === 'string') {
      tokens.account_id = body.account_id;
    }
    try {
      await deps.pgSecret.setUserCodexTokens(claims.principalId, tokens);
      reply.code(204).send();
    } catch (err) {
      request.log.error({ err }, '[codex-refresh] failed to persist refreshed tokens');
      reply.code(500).send({ error: 'Failed to persist tokens' });
    }
  });
}
