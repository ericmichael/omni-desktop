/**
 * Resolves the bundled `omni-projects-mcp` cli, used to build the managed
 * `omni-projects` stdio entry for local/desktop `mcp.json`.
 *
 * The entry itself is no longer written here — `config-materializer.ts` merges
 * it into the (per-tenant, in cloud) `mcp.json` it materializes from the store,
 * so a single writer owns the file and the user's own MCP servers and the
 * managed entry can't fight over it.
 */
import { join, resolve } from 'node:path';

import { app } from 'electron';

import { isDevelopment } from '@/main/util';

/**
 * Resolve the absolute path to the bundled `omni-projects-mcp` cli.js.
 *
 * Dev:  <repo>/packages/projects-mcp/dist/cli.js (workspace path)
 * Prod: <app-resources>/app.asar.unpacked/packages/projects-mcp/dist/cli.js
 *
 * The `packages/projects-mcp/dist/**` glob is added to electron-builder's
 * `asarUnpack` so the file is reachable by `node` (asar contents aren't
 * readable by raw fs).
 */
export function getMcpBinPath(): string {
  if (isDevelopment() || !app.isPackaged) {
    return resolve(__dirname, '..', '..', 'packages', 'projects-mcp', 'dist', 'cli.js');
  }
  const appPath = app.getAppPath();
  const unpacked = appPath.endsWith('.asar') ? `${appPath}.unpacked` : appPath;
  return join(unpacked, 'packages', 'projects-mcp', 'dist', 'cli.js');
}
