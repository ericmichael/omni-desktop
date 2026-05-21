import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IProjectsRepo } from 'omni-projects-db';

import { registerCommentTools } from './tools/comments.js';
import { registerInboxTools } from './tools/inbox.js';
import { registerMilestoneTools } from './tools/milestones.js';
import { registerPageTools } from './tools/pages.js';
import { registerPipelineTools } from './tools/pipeline.js';
import { registerProjectTools } from './tools/projects.js';
import { registerTicketTools } from './tools/tickets.js';

/**
 * Build the omni-projects MCP server over a backend-agnostic
 * {@link IProjectsRepo}. Two callers supply the repo:
 *   - the stdio `cli.ts`, with a `SqliteProjectsRepo` (local desktop / single
 *     tenant);
 *   - the launcher server's HTTP MCP route, with a tenant-scoped
 *     `PgProjectsRepo` (multi-tenant cloud).
 *
 * Page bodies live in the DB (`getPageContent`/`setPageContent`), so the
 * server no longer touches the filesystem.
 */
export function createServer(repo: IProjectsRepo): McpServer {
  const server = new McpServer({ name: 'omni-projects', version: '0.1.0' }, { capabilities: { tools: {} } });

  registerProjectTools(server, repo);
  registerTicketTools(server, repo);
  registerCommentTools(server, repo);
  registerMilestoneTools(server, repo);
  registerPageTools(server, repo);
  registerInboxTools(server, repo);
  registerPipelineTools(server, repo);

  return server;
}
