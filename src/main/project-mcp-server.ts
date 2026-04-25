/**
 * In-process HTTP MCP server.
 *
 * Runs alongside the launcher's main process and exposes project-management
 * tools to any agent (or Claude Code session) over Streamable HTTP. Uses the
 * launcher's existing `ProjectsRepo` so reads/writes go through a single
 * SQLite handle — no cross-process write coordination needed.
 *
 * Reachability:
 *   - bwrap / none / server modes: `http://127.0.0.1:<port>/mcp`
 *   - Docker mode:                 `http://host.docker.internal:<port>/mcp`
 *
 * Auth: a Bearer token persisted in `~/.config/omni_code/.mcp-token` so the
 * URL stays stable across launcher restarts (Claude Code's MCP config can
 * use a hard-coded URL + token without re-registration).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ProjectsRepo } from 'omni-projects-db';
import { createServer as createMcpServer } from 'omni-projects-mcp';

import { getOmniConfigDir } from '@/main/util';

/** Hard-pinned port. If something else is using it, the server fails to start. */
export const MCP_PORT = 39071;

const TOKEN_FILE = '.mcp-token';

/**
 * Read the launcher's MCP bearer token, creating it on first call. Persisted
 * under `~/.config/omni_code/.mcp-token` so it survives launcher restarts and
 * Claude Code can rely on it being stable.
 */
export function getMcpToken(): string {
  const path = join(getOmniConfigDir(), TOKEN_FILE);
  if (existsSync(path)) {
    const token = readFileSync(path, 'utf-8').trim();
    if (token.length >= 32) {
return token;
}
  }
  const token = randomBytes(32).toString('hex');
  writeFileSync(path, `${token  }\n`, { mode: 0o600 });
  return token;
}

/**
 * Build the MCP URL for the agent's perspective. Docker containers reach the
 * host via `host.docker.internal`; everywhere else (bwrap, none, server mode)
 * sees `127.0.0.1`.
 */
export function getMcpUrl(perspective: 'host' | 'docker'): string {
  const host = perspective === 'docker' ? 'host.docker.internal' : '127.0.0.1';
  return `http://${host}:${MCP_PORT}/mcp`;
}

export class ProjectMcpServer {
  private httpServer: HttpServer | null = null;
  private transport: StreamableHTTPServerTransport | null = null;
  private _token: string;

  constructor(
    private db: DatabaseSync,
    private repo: ProjectsRepo,
    private pagesDir: string
  ) {
    this._token = getMcpToken();
  }

  get port(): number {
    return MCP_PORT;
  }

  get token(): string {
    return this._token;
  }

  async start(): Promise<void> {
    if (this.httpServer) {
return;
}

    const mcp = createMcpServer(this.db, this.repo, this.pagesDir);
    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    await mcp.connect(this.transport);

    this.httpServer = createHttpServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname !== '/mcp') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const auth = req.headers['authorization'];
      const expected = `Bearer ${this._token}`;
      if (auth !== expected) {
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) {
chunks.push(chunk as Buffer);
}
      const body = Buffer.concat(chunks).toString('utf-8');
      let parsed: unknown;
      try {
        parsed = body ? JSON.parse(body) : undefined;
      } catch {
        parsed = undefined;
      }
      await this.transport!.handleRequest(req, res, parsed);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(
            new Error(
              `MCP port ${MCP_PORT} is already in use. Another launcher instance may be running.`
            )
          );
        } else {
          reject(err);
        }
      };
      this.httpServer!.once('error', onError);
      this.httpServer!.listen(MCP_PORT, '0.0.0.0', () => {
        this.httpServer!.off('error', onError);
        console.log(`[ProjectMcp] Listening on 0.0.0.0:${MCP_PORT}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.transport) {
      try {
        await this.transport.close();
      } catch {
        // ignore
      }
      this.transport = null;
    }
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }
  }
}
