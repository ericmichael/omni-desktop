import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IProjectsRepo } from 'omni-projects-db';

/**
 * Build the omni-projects MCP server over a backend-agnostic repo. The stdio
 * cli supplies a SqliteProjectsRepo; the launcher server's HTTP MCP route
 * supplies a tenant-scoped PgProjectsRepo.
 */
export declare function createServer(repo: IProjectsRepo): McpServer;
