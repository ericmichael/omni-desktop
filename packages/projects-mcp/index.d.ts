import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DatabaseSync } from 'node:sqlite';
import type { ProjectsRepo } from 'omni-projects-db';

export declare function createServer(
  db: DatabaseSync,
  repo: ProjectsRepo,
  pagesDir: string
): McpServer;
