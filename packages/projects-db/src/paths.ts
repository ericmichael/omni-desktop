import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the omni-code config directory. Mirrors the launcher's
 * getOmniConfigDir (src/main/util.ts) and omni_code/config.py:
 *   Windows: %APPDATA%/OmniCode
 *   Else:    $XDG_CONFIG_HOME/omni_code  OR  ~/.config/omni_code
 *
 * The launcher and the MCP server both call this so they always agree on
 * where projects.db and the pages dir live.
 */
export function getOmniConfigDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'OmniCode');
  }
  const xdgConfig = process.env['XDG_CONFIG_HOME'];
  if (xdgConfig) return join(xdgConfig, 'omni_code');
  return join(homedir(), '.config', 'omni_code');
}

/** Default SQLite database path: <config dir>/projects.db */
export function getDefaultDbPath(): string {
  return join(getOmniConfigDir(), 'projects.db');
}

/** Default pages directory: <config dir>/projects */
export function getDefaultPagesDir(): string {
  return join(getOmniConfigDir(), 'projects');
}
