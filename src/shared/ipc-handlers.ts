/**
 * Shared IPC handler registration for channels that are identical across
 * the Electron main process and the browser-mode server. Both transports
 * accept an `IIpcListener` so they can share a single implementation for
 * config:*, util:*, and skills:* handlers. Electron-specific handlers
 * (dialog, shell, window references) remain in `src/main/index.ts`.
 */
import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { WebSocket as WsWebSocket } from 'ws';

import { installSkillFromFile, listSkills, setSkillEnabled, uninstallSkill } from '@/main/skills';
import type { SkillStore } from '@/main/skills';
import { fetchMarketplace, installMarketplacePlugin } from '@/main/skills-marketplace';
import {
  checkModelsConfigured,
  ensureDirectory,
  getCliSymlinkPath,
  getDefaultWorkspaceDir,
  getHomeDirectory,
  getOmniCliPath,
  getOmniRuntimeInfo,
  getOperatingSystem,
  installCliToPath,
  isCliInstalledInPath,
  isDirectory,
  isFile,
  pathExists,
  testModelConnection,
  validateConfigPath,
  validateUserPath,
} from '@/main/util';
import type { IIpcListener } from '@/shared/ipc-listener';

export interface UtilHandlerOptions {
  /**
   * Fetch implementation used for URL probing. Electron passes a thin wrapper
   * around `net.fetch`; server mode passes `globalThis.fetch`.
   */
  fetchFn: typeof globalThis.fetch;
  /**
   * Launcher version string. Electron reads `app.getVersion()`; server mode
   * reads the bundled package.json at startup. Both pass the resolved value
   * in so this module doesn't depend on Electron.
   */
  launcherVersion: string;
}

/**
 * Register `config:*` handlers. All file I/O goes through `validateConfigPath`
 * so callers cannot escape the config directory.
 */
export function registerConfigHandlers(ipc: IIpcListener, configDir: string): void {
  ipc.handle('config:get-omni-config-dir', () => configDir);
  ipc.handle('config:get-env-file-path', () => join(configDir, '.env'));

  ipc.handle('config:read-json-file', async (_: unknown, filePath: string) => {
    validateConfigPath(filePath, configDir);
    try {
      const content = await readFile(filePath, 'utf-8');
      return JSON.parse(content) as unknown;
    } catch {
      return null;
    }
  });

  ipc.handle('config:write-json-file', async (_: unknown, filePath: string, data: unknown) => {
    validateConfigPath(filePath, configDir);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  });

  ipc.handle('config:read-text-file', async (_: unknown, filePath: string) => {
    validateConfigPath(filePath, configDir);
    try {
      return await readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  });

  ipc.handle('config:write-text-file', async (_: unknown, filePath: string, content: string) => {
    validateConfigPath(filePath, configDir);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf-8');
  });
}

/**
 * Register the portable subset of `util:*` handlers. Electron-only handlers
 * (`util:select-directory`, `util:select-file`, `util:open-directory`) are
 * NOT registered here and must be wired separately by each transport.
 */
export function registerUtilHandlers(ipc: IIpcListener, opts: UtilHandlerOptions): void {
  const { fetchFn, launcherVersion } = opts;

  ipc.handle('util:get-default-install-dir', () => join(getHomeDirectory(), 'omni'));
  ipc.handle('util:get-default-workspace-dir', () => getDefaultWorkspaceDir());
  ipc.handle('util:ensure-directory', async (_: unknown, dirPath: string) => {
    // Cap depth on writes so a misbehaving (or hostile) client can't ask
    // the main process to mkdir thousands of nested directories. Fix 2.1
    // doesn't apply here — DirectoryBrowserDialog legitimately needs to
    // pick locations outside the config dir — so this is the cheap floor:
    // null bytes and depth, no path-prefix restriction.
    validateUserPath(dirPath, { checkDepth: true });
    return ensureDirectory(dirPath);
  });
  ipc.handle('util:list-directory', async (_: unknown, dirPath: string) => {
    validateUserPath(dirPath);
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      return entries
        .filter((e) => !e.name.startsWith('.'))
        .filter((e) => e.isDirectory())
        .map((e) => ({ name: e.name, path: join(dirPath, e.name), isDirectory: true }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  });
  ipc.handle('util:get-home-directory', () => getHomeDirectory());
  ipc.handle('util:get-is-directory', async (_: unknown, path: string) => {
    validateUserPath(path);
    return isDirectory(path);
  });
  ipc.handle('util:get-is-file', async (_: unknown, path: string) => {
    validateUserPath(path);
    return isFile(path);
  });
  ipc.handle('util:get-path-exists', async (_: unknown, path: string) => {
    validateUserPath(path);
    return pathExists(path);
  });
  ipc.handle('util:get-os', () => getOperatingSystem());
  ipc.handle('util:get-launcher-version', () => launcherVersion);
  ipc.handle('util:get-omni-runtime-info', () => getOmniRuntimeInfo());
  ipc.handle('util:install-cli-to-path', () => installCliToPath());
  ipc.handle('util:get-cli-in-path-status', async () => {
    const installed = await isCliInstalledInPath();
    return { installed, symlinkPath: getCliSymlinkPath() };
  });
  ipc.handle('util:check-models-configured', () => checkModelsConfigured());
  ipc.handle('util:test-model-connection', (_: unknown, modelRef?: string) => testModelConnection(modelRef));

  ipc.handle('util:rebuild-sandbox-image', async () => {
    // Sandbox Dockerfiles now live in omni-code. Trigger rebuild via the CLI.
    const omniPath = getOmniCliPath();
    try {
      const { execFile: execFileAsync } = await import('child_process');
      const { promisify } = await import('util');
      const execFilePromise = promisify(execFileAsync);
      await execFilePromise(omniPath, ['sandbox', '--rebuild', '--output', 'json'], { timeout: 600_000 });
      return { success: true };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  });

  ipc.handle('util:check-url', async (_: unknown, url: string) => {
    try {
      const response = await fetchFn(url, { method: 'GET' });
      return response.status < 500;
    } catch {
      return false;
    }
  });

  ipc.handle('util:check-ws', async (_: unknown, url: string) => {
    try {
      return await new Promise<boolean>((resolvePromise) => {
        let settled = false;

        const settle = (result: boolean, socket?: WsWebSocket, timer?: ReturnType<typeof setTimeout>) => {
          if (settled) {
            return;
          }
          settled = true;
          if (timer) {
            clearTimeout(timer);
          }
          if (socket) {
            try {
              socket.close();
            } catch {
              /* ignore */
            }
          }
          resolvePromise(result);
        };

        const socket = new WsWebSocket(url);
        const timer = setTimeout(() => settle(false, socket), 2000);

        socket.on('open', () => settle(true, socket, timer));
        socket.on('error', () => settle(false, socket, timer));
        socket.on('close', () => settle(false, socket, timer));
      });
    } catch {
      return false;
    }
  });
}

/**
 * Register `skills:*` handlers. Skills live under the config dir.
 */
export function registerSkillsHandlers(ipc: IIpcListener, configDir: string, store: SkillStore): void {
  ipc.handle('skills:list', () => listSkills(configDir, store));
  ipc.handle('skills:install', (_: unknown, filePath: string) => installSkillFromFile(configDir, filePath, store));
  ipc.handle('skills:uninstall', (_: unknown, name: string) => uninstallSkill(configDir, name, store));
  ipc.handle('skills:set-enabled', (_: unknown, name: string, enabled: boolean) =>
    setSkillEnabled(configDir, name, enabled)
  );
  ipc.handle('skills:fetch-marketplace', (_: unknown, repo: string) => fetchMarketplace(repo));
  ipc.handle('skills:install-marketplace-plugin', (_: unknown, repo: string, name: string) =>
    installMarketplacePlugin(configDir, repo, name, store)
  );
}
