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
// Session identity carrier for the local/stdio path: the launcher sets
// OMNI_PROJECTS_PRINCIPAL=agent:<id> in a resident process's env (the managed
// mcp.json is global, so identity can't ride a CLI flag), and the env
// propagates from `omni serve` to this child. User sessions have no principal
// locally — get_current_principal stays null for them.
const principal = process.env['OMNI_PROJECTS_PRINCIPAL'] || null;
const server = createServer(repo, principal ? { getCurrentPrincipal: async () => principal } : {});

const transport = new StdioServerTransport();
await server.connect(transport);

// Clean shutdown
const shutdown = () => {
  closeDatabase(db);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
