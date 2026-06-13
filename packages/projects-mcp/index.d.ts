import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IProjectsRepo } from 'omni-projects-db';

export interface ProjectsMcpContext {
  listSandboxProfiles?: () => Promise<Array<{ name: string; label?: string; available?: boolean; source?: string }>>;
  listTeamMembers?: () => Promise<Array<{ user_id: string; display_name?: string | null; email?: string | null; role?: string | null }>>;
  getCurrentPrincipal?: () => Promise<string | null>;
}

/**
 * Build the omni-projects MCP server over a backend-agnostic repo. The stdio
 * cli supplies a SqliteProjectsRepo; the launcher server's HTTP MCP route
 * supplies a tenant-scoped PgProjectsRepo.
 */
export declare function createServer(repo: IProjectsRepo, context?: ProjectsMcpContext): McpServer;
