import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  closeDatabase,
  getDefaultDbPath,
  getDefaultPagesDir,
  openDatabase,
  ProjectsRepo,
} from 'omni-projects-db';
import { createServer } from './server.js';

const { values } = parseArgs({
  options: {
    'db-path': { type: 'string' },
    'pages-dir': { type: 'string' },
  },
  strict: false,
});

const dbPath = (values['db-path'] as string) || getDefaultDbPath();
const pagesDir = (values['pages-dir'] as string) || getDefaultPagesDir();

const db = openDatabase(dbPath);
const repo = new ProjectsRepo(db);
const server = createServer(db, repo, pagesDir);

const transport = new StdioServerTransport();
await server.connect(transport);

// Clean shutdown
const shutdown = () => {
  closeDatabase(db);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
