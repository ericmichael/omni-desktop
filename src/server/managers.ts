import { readFileSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { WebSocket as WsWebSocket } from 'ws';

import { createChatManager } from '@/main/chat-manager';
import { createConsoleManager } from '@/main/console-manager';
import { createFleetManager } from '@/main/fleet-manager';
import { createOmniInstallManager } from '@/main/omni-install-manager';
import { createSandboxManager } from '@/main/sandbox-manager';
import {
  checkModelsConfigured,
  ensureDirectory,
  getCliSymlinkPath,
  getDefaultWorkspaceDir,
  getOmniConfigDir,
  getOmniRuntimeInfo,
  getOperatingSystem,
  installCliToPath,
  isCliInstalledInPath,
  isDirectory,
  isFile,
  pathExists,
  testModelConnection,
} from '@/main/util';
import type { ServerIpcAdapter } from '@/server/ipc-adapter';
import type { ServerStore } from '@/server/store';
import type { WsHandler } from '@/server/ws-handler';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Wire up all managers and IPC handlers for server mode.
 * Mirrors the handler registration in src/main/index.ts.
 */
export const wireManagers = (arg: { wsHandler: WsHandler; ipc: ServerIpcAdapter; store: ServerStore }) => {
  const { wsHandler, ipc, store } = arg;

  const sendToWindow: typeof wsHandler.sendToClient = wsHandler.sendToClient.bind(wsHandler);

  // Store change notifications
  store.onDidAnyChange((data) => {
    sendToWindow('store:changed', data);
  });

  // Store handlers
  ipc.handle('store:get-key', (_, key) => store.get(key));
  ipc.handle('store:set-key', (_, key, value) => store.set(key, value));
  ipc.handle('store:get', () => store.store);
  ipc.handle('store:set', (_, data) => {
    store.store = data;
  });
  ipc.handle('store:reset', () => {
    store.clear();
  });

  // Main process status (simplified for server)
  const mainStatus = { type: 'idle' as const, timestamp: Date.now() };
  ipc.handle('main-process:get-status', () => mainStatus);

  // Create managers — cast ipc to any since ServerIpcAdapter is duck-typed to match IpcListener
  const [, cleanupConsole] = createConsoleManager({
    ipc: ipc as any,
    sendToWindow,
  });

  const [omniInstall, cleanupOmniInstall] = createOmniInstallManager({
    ipc: ipc as any,
    sendToWindow,
  });

  const [sandbox, cleanupSandbox] = createSandboxManager({
    ipc: ipc as any,
    sendToWindow,
    getStoreData: () => ({
      workspaceDir: store.get('workspaceDir') ?? '',
      sandboxVariant: store.get('sandboxVariant'),
    }),
    fetchFn: globalThis.fetch,
  });

  const [chat, cleanupChat] = createChatManager({
    ipc: ipc as any,
    sendToWindow,
    fetchFn: globalThis.fetch,
  });

  const [, cleanupFleet] = createFleetManager({
    ipc: ipc as any,
    sendToWindow,
    store: store as any,
  });

  // Status getters
  ipc.handle('omni-install-process:get-status', () => omniInstall.getStatus());
  ipc.handle('sandbox-process:get-status', () => sandbox.getStatus());
  ipc.handle('chat-process:get-status', () => chat.getStatus());

  // Util handlers
  ipc.handle('util:get-default-install-dir', () => join(homedir(), 'omni'));
  ipc.handle('util:get-default-workspace-dir', () => getDefaultWorkspaceDir());
  ipc.handle('util:ensure-directory', (_, dirPath) => ensureDirectory(dirPath));

  // Desktop-only handlers — stubbed for browser mode
  ipc.handle('util:select-directory', () => null);
  ipc.handle('util:select-file', () => null);
  ipc.handle('util:open-directory', () => '');

  ipc.handle('util:get-home-directory', () => homedir());
  ipc.handle('util:get-is-directory', (_, path) => isDirectory(path));
  ipc.handle('util:get-is-file', (_, path) => isFile(path));
  ipc.handle('util:get-path-exists', (_, path) => pathExists(path));
  ipc.handle('util:get-os', () => getOperatingSystem());

  // Read version from package.json at startup
  let launcherVersion = '0.0.0';
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8'));
    launcherVersion = (pkg as { version?: string }).version ?? '0.0.0';
  } catch {
    // fallback
  }
  ipc.handle('util:get-launcher-version', () => launcherVersion);
  ipc.handle('util:get-omni-runtime-info', () => getOmniRuntimeInfo());
  ipc.handle('util:install-cli-to-path', () => installCliToPath());
  ipc.handle('util:get-cli-in-path-status', async () => {
    const installed = await isCliInstalledInPath();
    return { installed, symlinkPath: getCliSymlinkPath() };
  });
  ipc.handle('util:check-models-configured', () => checkModelsConfigured());
  ipc.handle('util:test-model-connection', (_, modelRef) => testModelConnection(modelRef));

  ipc.handle('util:check-url', async (_, url) => {
    try {
      const response = await globalThis.fetch(url, { method: 'GET' });
      return response.status < 500;
    } catch {
      return false;
    }
  });

  ipc.handle('util:check-ws', async (_, url) => {
    try {
      return await new Promise<boolean>((resolve) => {
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
          resolve(result);
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

  // main-process:exit is a no-op in server mode
  ipc.handle('main-process:exit', () => {});

  // Config file I/O
  const OMNI_CONFIG_DIR = getOmniConfigDir();
  ipc.handle('config:get-omni-config-dir', () => OMNI_CONFIG_DIR);
  ipc.handle('config:get-env-file-path', () => join(OMNI_CONFIG_DIR, '.env'));

  ipc.handle('config:read-json-file', async (_, filePath) => {
    try {
      const content = await readFile(filePath, 'utf-8');
      return JSON.parse(content) as unknown;
    } catch {
      return null;
    }
  });

  ipc.handle('config:write-json-file', async (_, filePath, data) => {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  });

  ipc.handle('config:read-text-file', async (_, filePath) => {
    try {
      return await readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  });

  ipc.handle('config:write-text-file', async (_, filePath, content) => {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf-8');
  });

  // Cleanup function
  const cleanup = async () => {
    const results = await Promise.allSettled([
      cleanupConsole(),
      cleanupOmniInstall(),
      cleanupSandbox(),
      cleanupChat(),
      cleanupFleet(),
    ]);
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason);
    if (errors.length > 0) {
      console.error('Error cleaning up processes:', errors);
    }
  };

  return cleanup;
};
