/**
 * HTTP transport for the `omni-projects` MCP server — the network counterpart
 * of the stdio `cli.js` the Electron app spawns locally.
 *
 * A remote agent sandbox (Azure Container App) can't read a local `projects.db`,
 * so in cloud mode it talks to this route instead: `streamable_http` MCP over
 * `POST /mcp/projects`, authenticated by the signed runtime token. The token
 * resolves to a tenant, the tenant to a (RLS-scoped) repo, and the very same
 * `createServer(repo)` tool set runs — so SQLite/stdio and Postgres/HTTP share
 * one implementation.
 *
 * Stateless: a fresh transport + server per request (`sessionIdGenerator:
 * undefined`). The MCP client is configured with `cache_tools_list`, so the
 * per-request `tools/list` cost is paid once.
 *
 * POST-only by design. The projects tools never push server-initiated messages
 * (no subscriptions, no progress notifications), so the spec's optional
 * standalone server→client `GET` SSE stream is pure overhead — and a long-lived
 * GET stream racing with per-request teardown is the one place an intermittent
 * "Connection closed" could come from. We answer GET/DELETE with 405; spec-
 * compliant clients then use plain request/response, which is fully
 * deterministic and replica-safe.
 */
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import type { IProjectsRepo } from 'omni-projects-db';
import { createServer } from 'omni-projects-mcp';

import { verifyRuntimeToken } from '@/server/runtime-token';

export interface McpHttpDeps {
  /** Secret the runtime token was signed with (see runtime-token.ts). */
  runtimeTokenSecret: string;
  /** Resolve a tenant-scoped repo from the verified token's tenant. */
  getTenantRepo: (tenantId: string) => IProjectsRepo;
}

export const MCP_PROJECTS_PATH = '/mcp/projects';

function bearer(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !value.startsWith('Bearer ')) {
    return undefined;
  }
  const token = value.slice('Bearer '.length).trim();
  return token || undefined;
}

export function registerMcpHttpRoute(fastify: FastifyInstance, deps: McpHttpDeps): void {
  // `all` so we can answer GET/DELETE ourselves; only POST carries JSON-RPC.
  fastify.all(MCP_PROJECTS_PATH, async (request, reply) => {
    // No standalone server→client stream and no sessions to tear down → 405.
    if (request.method !== 'POST') {
      reply
        .code(405)
        .header('Allow', 'POST')
        .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
      return;
    }

    const token = bearer(request.headers['authorization']);
    const claims = token ? verifyRuntimeToken(deps.runtimeTokenSecret, token) : null;
    if (!claims) {
      reply.code(401).send({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized: missing or invalid runtime token' },
        id: null,
      });
      return;
    }

    const repo = deps.getTenantRepo(claims.tenantId);
    const server = createServer(repo);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    // Hand the raw Node req/res to the transport; Fastify must not also try to
    // serialize a reply.
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (err) {
      request.log.error({ err }, '[mcp-http] request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
        reply.raw.end(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null })
        );
      }
      void transport.close();
      void server.close();
    }
  });
}
