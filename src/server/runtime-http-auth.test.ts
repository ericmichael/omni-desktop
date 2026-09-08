import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';

import { registerCodexRefreshRoute } from '@/server/codex-refresh-http';
import { registerMcpHttpRoute } from '@/server/mcp-http';
import type { PgSecretStore } from '@/server/pg-secret-store';
import { signRuntimeToken } from '@/server/runtime-token';

it.each(['/mcp/projects', '/api/codex/refresh'])(
  '%s rejects revoked runtime and launcher credentials before side effects',
  async (url) => {
    const app = Fastify();
    const authorize = vi.fn(async () => false);
    const getTenantRepo = vi.fn();
    const setUserCodexTokens = vi.fn();
    registerMcpHttpRoute(app, { runtimeTokenSecret: 'secret', authorize, getTenantRepo });
    registerCodexRefreshRoute(app, {
      runtimeTokenSecret: 'secret',
      authorize,
      pgSecret: { setUserCodexTokens } as unknown as PgSecretStore,
    });
    try {
      for (const purpose of ['runtime', 'launcher'] as const) {
        const token = signRuntimeToken('secret', { purpose, tenantId: 'team', principalId: 'human', sessionId: 's' });
        const response = await app.inject({
          method: 'POST',
          url,
          headers: { authorization: `Bearer ${token}` },
          payload: { refresh: 'test', access: 'test', expires: 1 },
        });
        expect(response.statusCode).toBe(purpose === 'runtime' ? 403 : 401);
      }
      expect(getTenantRepo).not.toHaveBeenCalled();
      expect(setUserCodexTokens).not.toHaveBeenCalled();
      authorize.mockRejectedValueOnce(new Error('database unavailable'));
      const token = signRuntimeToken('secret', { tenantId: 'team', principalId: 'human', sessionId: 's' });
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(response.statusCode).toBe(500);
      expect(getTenantRepo).not.toHaveBeenCalled();
      expect(setUserCodexTokens).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  }
);
