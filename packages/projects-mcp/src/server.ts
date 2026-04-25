import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DatabaseSync } from 'node:sqlite';
import type { ProjectsRepo } from 'omni-projects-db';
import { registerCommentTools } from './tools/comments.js';
import { registerInboxTools } from './tools/inbox.js';
import { registerMilestoneTools } from './tools/milestones.js';
import { registerPageTools } from './tools/pages.js';
import { registerPipelineTools } from './tools/pipeline.js';
import { registerProjectTools } from './tools/projects.js';
import { registerTicketTools } from './tools/tickets.js';

export function createServer(db: DatabaseSync, repo: ProjectsRepo, pagesDir: string): McpServer {
  const server = new McpServer(
    { name: 'omni-projects', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  registerProjectTools(server, db, repo, pagesDir);
  registerTicketTools(server, db, repo);
  registerCommentTools(server, db, repo);
  registerMilestoneTools(server, db, repo);
  registerPageTools(server, db, repo, pagesDir);
  registerInboxTools(server, db, repo, pagesDir);
  registerPipelineTools(server, db, repo);

  return server;
}
