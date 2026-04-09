import { readFileSync } from 'fs';
import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { WebSocket as WsWebSocket } from 'ws';

import { rebuildSandboxImage } from '@/lib/rebuild-sandbox-image';
import { createProcessManager } from '@/main/process-manager';
import { createConsoleManager } from '@/main/console-manager';
import { createProjectManager } from '@/main/project-manager';
import { createOmniInstallManager } from '@/main/omni-install-manager';
import { isEnterpriseBuild, PLATFORM_URL, createPlatformClient } from '@/main/platform-mode';
import { PlatformClient } from '@/main/platform-client';
import {
  checkModelsConfigured,
  ensureDirectory,
  getCliSymlinkPath,
  getDefaultWorkspaceDir,
  getOmniConfigDir,
  getOmniRuntimeInfo,
  getOperatingSystem,
  getSandboxAssetsPath,
  getSandboxDockerfilePath,
  installCliToPath,
  isCliInstalledInPath,
  isDirectory,
  isFile,
  pathExists,
  testModelConnection,
} from '@/main/util';
import { ServerIpcAdapter } from '@/server/ipc-adapter';
import type { ServerStore } from '@/server/store';
import type { WsHandler } from '@/server/ws-handler';
import type { IpcRendererEvents } from '@/shared/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

type SendToWindow = <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
type HandleFn = (channel: string, handler: (...args: unknown[]) => unknown | Promise<unknown>) => void;

/**
 * Wire up global (shared) IPC handlers — store, util, config, project, process, main-process.
 * These are stateless or shared, safe for all clients to use.
 *
 * ProcessManager is global so that containers/processes survive WebSocket
 * reconnections and React re-renders. Each WS session reattaching to the same server
 * gets the existing running container status instead of spawning duplicates.
 */
export const wireGlobalHandlers = (arg: { wsHandler: WsHandler; store: ServerStore }) => {
  const { wsHandler, store } = arg;
  const ipc = new ServerIpcAdapter(wsHandler.handle.bind(wsHandler));

  // Project manager — shared across all clients so machines/sandboxes survive reconnections
  const sendToAll: typeof wsHandler.sendToAll = wsHandler.sendToAll.bind(wsHandler);
  const [, cleanupProject] = createProjectManager({
    ipc: ipc as any,
    sendToWindow: sendToAll,
    store: store as any,
  });

  // --- Global managers (survive WS reconnections) ---

  const [omniInstall, cleanupOmniInstall] = createOmniInstallManager({
    ipc: ipc as any,
    sendToWindow: sendToAll,
  });

  const [processManager, cleanupProcessManager] = createProcessManager({
    ipc: ipc as any,
    sendToWindow: sendToAll,
    fetchFn: globalThis.fetch,
    getStoreData: () => ({
      sandboxEnabled: store.get('sandboxEnabled') ?? false,
      sandboxBackend: store.get('sandboxBackend') ?? 'docker',
      sandboxVariant: store.get('sandboxVariant'),
    }),
  });

  // Wire platform client for enterprise mode
  const updatePlatformClients = () => {
    const platform = store.get('platform');
    const client = createPlatformClient(platform, globalThis.fetch);
    processManager.platformClient = client;
  };
  updatePlatformClients();
  const unsubPlatform = store.onDidAnyChange(() => updatePlatformClients());

  // Global status getters
  ipc.handle('omni-install-process:get-status', () => omniInstall.getStatus());

  // Store change notifications — broadcast to all clients
  store.onDidAnyChange((data) => {
    wsHandler.sendToAll('store:changed', data);
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
  ipc.handle('main-process:exit', () => {});

  // Util handlers
  ipc.handle('util:get-default-install-dir', () => join(homedir(), 'omni'));
  ipc.handle('util:get-default-workspace-dir', () => getDefaultWorkspaceDir());
  ipc.handle('util:ensure-directory', (_, dirPath) => ensureDirectory(dirPath));

  // Desktop-only handlers — stubbed for browser mode
  ipc.handle('util:select-directory', () => null);
  ipc.handle('util:select-file', () => null);
  ipc.handle('util:open-directory', () => '');

  ipc.handle('util:list-directory', async (_, dirPath) => {
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
  ipc.handle('util:rebuild-sandbox-image', async () => {
    const variant = (store.get('sandboxVariant') ?? 'work') as 'work' | 'standard';
    const backend = (store.get('sandboxBackend') ?? 'docker') as 'docker' | 'podman';
    return rebuildSandboxImage({
      backend,
      dockerfilePath: getSandboxDockerfilePath(variant),
      contextDir: getSandboxAssetsPath(),
    });
  });

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

  // Platform handlers
  ipc.handle('platform:is-enterprise', () => isEnterpriseBuild());
  ipc.handle('platform:get-auth', () => store.get('platform') ?? null);
  ipc.handle('platform:sign-in', async () => {
    if (!isEnterpriseBuild()) {
      throw new Error('Not an enterprise build');
    }
    const deviceCode = await PlatformClient.initiateDeviceCode(PLATFORM_URL, globalThis.fetch);

    // Poll in background
    void (async () => {
      const maxAttempts = Math.floor(deviceCode.expires_in / deviceCode.interval);
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise<void>((r) => setTimeout(r, deviceCode.interval * 1000));
        try {
          const result = await PlatformClient.pollForToken(PLATFORM_URL, deviceCode.device_code, globalThis.fetch);
          if (result.status === 'authenticated' && result.access_token && result.refresh_token) {
            const credentials = {
              accessToken: result.access_token,
              refreshToken: result.refresh_token,
              userEmail: result.user?.email,
              userName: result.user?.name,
              userRole: result.user?.role,
              domains: result.user?.domains,
            };
            store.set('platform', credentials);
            wsHandler.sendToAll('platform:auth-changed', credentials);
            return;
          }
          if (result.status === 'expired') return;
        } catch {
          // keep polling
        }
      }
    })();

    return {
      userCode: deviceCode.user_code,
      verificationUri: deviceCode.verification_uri,
      message: deviceCode.message,
    };
  });
  ipc.handle('platform:sign-out', () => {
    store.delete('platform');
    wsHandler.sendToAll('platform:auth-changed', null);
  });

  const cleanupGlobalManagers = async () => {
    unsubPlatform();
    const results = await Promise.allSettled([
      cleanupProject(),
      cleanupOmniInstall(),
      cleanupProcessManager(),
    ]);
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason);
    if (errors.length > 0) {
      console.error('Error cleaning up global managers:', errors);
    }
  };

  return { cleanupGlobalManagers };
};

/**
 * Wire up per-client managers — only truly session-scoped resources (PTY console).
 *
 * ProcessManager and OmniInstallManager are ALL global (created in
 * wireGlobalHandlers) so that containers/processes survive WebSocket reconnections
 * and React re-renders. Per-session handlers would shadow the global ones and get
 * destroyed on WS disconnect, killing running containers.
 *
 * Returns a cleanup function for when the client disconnects.
 */
export const wireClientManagers = (arg: {
  handle: HandleFn;
  sendToWindow: SendToWindow;
  store: ServerStore;
}): (() => Promise<void>) => {
  const { handle, sendToWindow } = arg;
  const ipc = new ServerIpcAdapter(handle);

  // Console (PTY) is truly per-session — each browser tab gets its own terminal
  const [, cleanupConsole] = createConsoleManager({
    ipc: ipc as any,
    sendToWindow,
  });

  // Cleanup function — only per-session resources (console PTY)
  const cleanup = async () => {
    const results = await Promise.allSettled([cleanupConsole()]);
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason);
    if (errors.length > 0) {
      console.error('Error cleaning up client session processes:', errors);
    }
  };

  return cleanup;
};
