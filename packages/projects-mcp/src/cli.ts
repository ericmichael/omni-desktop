import { parseArgs } from 'node:util';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { closeDatabase, getDefaultDbPath, openDatabase, ProjectsRepo, SqliteProjectsRepo } from 'omni-projects-db';

import { createServer } from './server.js';

const { values } = parseArgs({
  options: {
    'db-path': { type: 'string' },
    // Accepted for backward compatibility; page bodies now live in the DB.
    'pages-dir': { type: 'string' },
  },
  strict: false,
});

const dbPath = (values['db-path'] as string) || getDefaultDbPath();

const db = openDatabase(dbPath);
const repo = new SqliteProjectsRepo(new ProjectsRepo(db));
const server = createServer(repo);

const transport = new StdioServerTransport();
await server.connect(transport);

// Clean shutdown
const shutdown = () => {
  closeDatabase(db);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
