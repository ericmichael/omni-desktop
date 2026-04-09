if (process.env.NODE_ENV === 'development') {
  require('dotenv/config');
}

import { app, dialog, net, protocol, shell } from 'electron';
import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { assert } from 'tsafe';
import { pathToFileURL } from 'url';

import { getArtifactsDir } from '@/lib/artifacts';
import { createProcessManager } from '@/main/process-manager';
import { createConsoleManager } from '@/main/console-manager';
import { createProjectManager } from '@/main/project-manager';
import { MainProcessManager } from '@/main/main-process-manager';
import { createOmniInstallManager } from '@/main/omni-install-manager';
import { registerPlatformIpc } from '@/main/platform-ipc';
import { createPlatformClient } from '@/main/platform-mode';
import { store } from '@/main/store';
import {
  checkModelsConfigured,
  ensureDirectory,
  getCliSymlinkPath,
  getDefaultWorkspaceDir,
  getHomeDirectory,
  getOmniCliPath,
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

// Register artifact: protocol as privileged before app is ready
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'artifact',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
    },
  },
]);

// Configure Chrome/Electron flags for better memory management

// Windows-specific, disables some fancy desktop window effects that can use a lot of memory
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// Prevent memory spikes from throttling when the app is in the background and moves to foreground
app.commandLine.appendSwitch('disable-background-timer-throttling');

// Keep renderer active when minimized to avoid memory spikes when restoring
app.commandLine.appendSwitch('disable-renderer-backgrounding');

// Remove limits on number of backing stores, which are per-window/tab. Theoretically, the launcher should only have two
// windows open at a time so this should have no effect. But just in case, we disable the limit.
app.commandLine.appendSwitch('disable-backing-store-limit');

const OMNI_CONFIG_DIR = getOmniConfigDir();
const main = new MainProcessManager({ store });
let isShuttingDown = false;

// Create ConsoleManager for terminal functionality
const [, cleanupConsole] = createConsoleManager({
  ipc: main.ipc,
  sendToWindow: main.sendToWindow,
});
const [omniInstall, cleanupOmniInstall] = createOmniInstallManager({
  ipc: main.ipc,
  sendToWindow: main.sendToWindow,
});
const [processManager, cleanupProcessManager] = createProcessManager({
  ipc: main.ipc,
  sendToWindow: main.sendToWindow,
  fetchFn: (input, init) => net.fetch(input as string, init),
  getStoreData: () => ({
    sandboxEnabled: store.get('sandboxEnabled') ?? false,
    sandboxBackend: store.get('sandboxBackend') ?? 'docker',
    sandboxVariant: store.get('sandboxVariant'),
  }),
});
const [, cleanupProject] = createProjectManager({
  ipc: main.ipc,
  sendToWindow: main.sendToWindow,
  store,
  processManager,
});
const cleanupPlatform = registerPlatformIpc({
  ipc: main.ipc,
  sendToWindow: main.sendToWindow,
  store,
  fetchFn: (input, init) => net.fetch(input as string, init),
});

// Keep ProcessManager's platform client in sync with auth state.
// On sign-in/sign-out, the platform client is updated so new sandboxes
// use the correct mode without requiring an app restart.
const platformFetchFn = (input: string | URL | Request, init?: RequestInit) =>
  net.fetch(input as string, init);

/** Attach onTokenRefresh so refreshed access tokens are persisted to the store. */
const withTokenPersistence = (client: ReturnType<typeof createPlatformClient>) => {
  if (client) {
    client.onTokenRefresh = (newAccessToken) => {
      const current = store.get('platform');
      if (current) {
        store.set('platform', { ...current, accessToken: newAccessToken });
      }
    };
  }
  return client;
};

const syncPlatformClients = (platform?: Parameters<typeof createPlatformClient>[0]) => {
  const client = withTokenPersistence(createPlatformClient(platform, platformFetchFn));
  processManager.platformClient = client;
};
syncPlatformClients(store.get('platform'));
store.onDidChange('platform', (newVal) => {
  syncPlatformClients(newVal);
});

main.ipc.handle('main-process:get-status', () => main.getStatus());
main.ipc.handle('omni-install-process:get-status', () => omniInstall.getStatus());

//#region App lifecycle

/**
 * Cleans up any running processes.
 */
async function cleanup() {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  cleanupPlatform();
  const results = await Promise.allSettled([
    cleanupConsole(),
    cleanupOmniInstall(),
    cleanupProcessManager(),
    cleanupProject(),
  ]);
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);

  if (errors.length > 0) {
    console.error('Error cleaning up processes:', errors);
  } else {
    console.debug('Successfully cleaned up all processes');
  }
  main.cleanup();
}

/**
 * This method will be called when Electron has finished initialization and is ready to create browser windows.
 * Some APIs can only be used after this event occurs.
 */
app.on('ready', () => {
  // Register artifact: protocol handler for serving ticket artifact files
  // URL format: artifact://file/{ticketId}/{relativePath}
  // We use a dummy hostname ("file") because URL spec lowercases hostnames,
  // which corrupts case-sensitive ticket IDs like nanoid.
  protocol.handle('artifact', async (request) => {
    try {
      const url = new URL(request.url);
      // pathname = /file/{ticketId}/{relativePath...}  or  /{ticketId}/{relativePath...}
      const segments = decodeURIComponent(url.pathname).split('/').filter(Boolean);
      // Skip the dummy hostname segment if present
      const startIdx = segments[0] === 'file' ? 1 : 0;
      const ticketId = segments[startIdx];
      const relativePath = segments.slice(startIdx + 1).join('/');
      if (!ticketId || !relativePath) {
        return new Response('Bad request', { status: 400 });
      }
      const artifactsRoot = getArtifactsDir(OMNI_CONFIG_DIR, ticketId);
      const fullPath = resolve(artifactsRoot, relativePath);
      // Path traversal protection
      if (!fullPath.startsWith(artifactsRoot)) {
        return new Response('Forbidden', { status: 403 });
      }
      return await net.fetch(pathToFileURL(fullPath).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  main.createWindow();

  void (async () => {
    const { cleanupOrphanedContainers, pruneDockerResources } = await import('@/main/docker-orphan-cleanup');
    const cleaned = await cleanupOrphanedContainers();
    if (cleaned > 0) {
      main.sendToWindow('toast:show', {
        level: 'info',
        title: 'Cleaned up orphaned containers',
        description: `Removed ${cleaned} Docker container${cleaned === 1 ? '' : 's'} from a previous session.`,
      });
    }

    const reclaimed = await pruneDockerResources();
    if (reclaimed && reclaimed !== '0B') {
      main.sendToWindow('toast:show', {
        level: 'info',
        title: 'Docker storage reclaimed',
        description: `Pruned unused Docker resources, reclaimed ${reclaimed}.`,
      });
    }
  })().catch((error) => {
    console.warn('Failed to clean up Docker resources:', error);
  });
});

/**
 * Quit when all windows are closed.
 */
app.on('window-all-closed', () => {
  if (!isShuttingDown) {
    app.quit();
  }
});

/**
 * When the launcher quits, cleanup any running processes.
 * We prevent the default quit, await all cleanup (which uses SIGTERM → SIGKILL internally),
 * then force-exit the app. A hard 15s timeout ensures the app never hangs indefinitely.
 */
app.on('before-quit', (event) => {
  if (isShuttingDown) {
    return;
  }

  event.preventDefault();

  // Hard timeout: if cleanup hangs, force-exit the process
  const forceExitTimer = setTimeout(() => {
    console.error('Cleanup timed out after 15s, forcing exit');
    app.exit(1);
  }, 15_000);

  cleanup().finally(() => {
    clearTimeout(forceExitTimer);
    app.exit(0);
  });
});

//#endregion

//#region Util API

main.ipc.handle('util:get-default-install-dir', () => join(getHomeDirectory(), 'omni'));
main.ipc.handle('util:get-default-workspace-dir', () => getDefaultWorkspaceDir());
main.ipc.handle('util:ensure-directory', (_, dirPath) => ensureDirectory(dirPath));
main.ipc.handle('util:select-directory', async (_, path) => {
  const mainWindow = main.getWindow();
  assert(mainWindow !== null, 'Main window is not initialized');

  const defaultPath = path && (await isDirectory(path)) ? path : app.getPath('home');

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath,
  });

  return result.filePaths[0] ?? null;
});
main.ipc.handle('util:select-file', async (_, path) => {
  const mainWindow = main.getWindow();
  assert(mainWindow !== null, 'Main window is not initialized');

  const defaultPath = path && (await isFile(path)) ? path : app.getPath('home');

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    defaultPath,
  });

  return result.filePaths[0] ?? null;
});
main.ipc.handle('util:list-directory', async (_, dirPath) => {
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
main.ipc.handle('util:get-home-directory', () => getHomeDirectory());
main.ipc.handle('util:get-is-directory', (_, path) => isDirectory(path));
main.ipc.handle('util:get-is-file', (_, path) => isFile(path));
main.ipc.handle('util:get-path-exists', (_, path) => pathExists(path));
main.ipc.handle('util:get-os', () => getOperatingSystem());
main.ipc.handle('util:open-directory', (_, path) => shell.openPath(path));
main.ipc.handle('util:get-launcher-version', () => app.getVersion());
main.ipc.handle('util:get-omni-runtime-info', () => getOmniRuntimeInfo());
main.ipc.handle('util:install-cli-to-path', () => installCliToPath());
main.ipc.handle('util:get-cli-in-path-status', async () => {
  const installed = await isCliInstalledInPath();
  return { installed, symlinkPath: getCliSymlinkPath() };
});
main.ipc.handle('util:check-models-configured', () => checkModelsConfigured());
main.ipc.handle('util:test-model-connection', (_, modelRef) => testModelConnection(modelRef));
main.ipc.handle('util:rebuild-sandbox-image', async () => {
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
main.ipc.handle('util:check-url', async (_, url) => {
  try {
    const response = await net.fetch(url, { method: 'GET' });
    return response.status < 500;
  } catch {
    return false;
  }
});
main.ipc.handle('util:check-ws', async (_, url) => {
  try {
    return await new Promise<boolean>((resolve) => {
      let settled = false;

      const settle = (result: boolean, socket?: WebSocket, timer?: ReturnType<typeof setTimeout>) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        if (socket) {
          socket.onopen = null;
          socket.onerror = null;
          socket.onclose = null;
          try {
            socket.close();
          } catch {
            // ignore
          }
        }
        resolve(result);
      };

      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        settle(false, socket);
      }, 2000);

      socket.onopen = () => {
        settle(true, socket, timer);
      };
      socket.onerror = () => {
        settle(false, socket, timer);
      };
      socket.onclose = () => {
        settle(false, socket, timer);
      };
    });
  } catch {
    return false;
  }
});
//#endregion

//#region Config file I/O API

main.ipc.handle('config:get-omni-config-dir', () => OMNI_CONFIG_DIR);
main.ipc.handle('config:get-env-file-path', () => join(OMNI_CONFIG_DIR, '.env'));

main.ipc.handle('config:read-json-file', async (_, filePath) => {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as unknown;
  } catch {
    return null;
  }
});

main.ipc.handle('config:write-json-file', async (_, filePath, data) => {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
});

main.ipc.handle('config:read-text-file', async (_, filePath) => {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
});

main.ipc.handle('config:write-text-file', async (_, filePath, content) => {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
});

//#endregion
