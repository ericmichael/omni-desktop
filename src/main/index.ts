if (process.env.NODE_ENV === 'development') {
  require('dotenv/config');
}

import { app, dialog, net, protocol, shell } from 'electron';
import { resolve } from 'path';
import { assert } from 'tsafe';
import { pathToFileURL } from 'url';

import { getArtifactsDir } from '@/lib/artifacts';
import { createAppControlManager } from '@/main/app-control-manager';
import { createConsoleManager } from '@/main/console-manager';
import { createExtensionManager } from '@/main/extension-manager';
import { MainProcessManager } from '@/main/main-process-manager';
import { createOmniInstallManager } from '@/main/omni-install-manager';
import { registerPlatformIpc } from '@/main/platform-ipc';
import { createPlatformClient } from '@/main/platform-mode';
import { createProcessManager } from '@/main/process-manager';
import { createProjectManager } from '@/main/project-manager';
import { getStore } from '@/main/store';
import {
  ensureDirectory,
  getDefaultWorkspaceDir,
  getOmniConfigDir,
  getProjectsDir,
  isDirectory,
  isFile,
} from '@/main/util';
import { WorkspaceSyncManager } from '@/main/workspace-sync-manager';
import { registerConfigHandlers, registerSkillsHandlers, registerUtilHandlers } from '@/shared/ipc-handlers';

// Process-level crash visibility. Log only — do not exit. Killing the
// Electron main process from an unhandled rejection would take the whole
// UI down with it, which is worse than letting the rejection slip through.
// The goal here is leaving a stderr breadcrumb so we can debug instead of
// silently losing the failure.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err);
});

// Register artifact: protocol as privileged before app is ready.
// NOTE: `bypassCSP` is intentionally NOT set. Artifacts are agent-generated
// content (Omni Code writes them into ticket workspaces) — bypassing CSP
// would let a malicious or buggy artifact execute scripts with full renderer
// privileges. The `protocol.handle` callback below sets a strict CSP header
// on every artifact response that blocks script execution while still
// allowing images, styles, fonts, and media to render.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'artifact',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
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
const store = getStore();
const main = new MainProcessManager({ store });
let isShuttingDown = false;

// Create ConsoleManager for terminal functionality
const [, cleanupConsole] = createConsoleManager({
  ipc: main.ipc,
  sendToWindow: main.sendToWindow,
});
const [appControlManager, cleanupAppControl] = createAppControlManager({
  ipc: main.ipc,
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
    sandboxBackend: store.get('sandboxBackend') ?? 'none',
    sandboxProfiles: store.get('sandboxProfiles') ?? null,
    selectedMachineId: store.get('selectedMachineId') ?? null,
  }),
});
const [, cleanupProject] = createProjectManager({
  ipc: main.ipc,
  sendToWindow: main.sendToWindow,
  store,
  processManager,
  appControlManager,
});
const [, cleanupExtensions] = createExtensionManager({
  ipc: main.ipc,
  store,
  sendToWindow: main.sendToWindow,
});
const { cleanup: cleanupPlatform, refreshPolicy: refreshPlatformPolicy } = registerPlatformIpc({
  ipc: main.ipc,
  sendToWindow: main.sendToWindow,
  store,
  fetchFn: (input, init) => net.fetch(input as string, init),
});

// Keep ProcessManager's platform client in sync with auth state.
// On sign-in/sign-out, the platform client is updated so new sandboxes
// use the correct mode without requiring an app restart.
const platformFetchFn = (input: string | URL | Request, init?: RequestInit) => net.fetch(input as string, init);

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

// Background workspace sync manager — like OneDrive for project workspaces.
const syncManager = new WorkspaceSyncManager({
  fetchFn: platformFetchFn,
  platformClient: processManager.platformClient,
  manifestDir: OMNI_CONFIG_DIR,
  onStatusChange: (projectId, status) => {
    main.sendToWindow('workspace-sync:status-changed', projectId, status);
  },
});
store.onDidChange('platform', () => {
  syncManager.setPlatformClient(processManager.platformClient);
});

// On startup, refresh platform policy if already signed in.
// This ensures sandbox profiles are up-to-date with the latest entitlements.
void refreshPlatformPolicy();

main.ipc.handle('main-process:get-status', () => main.getStatus());

// Workspace sync IPC handlers
main.ipc.handle('workspace-sync:start', (_, projectId, workspaceDir) => {
  return syncManager.startSync(projectId, workspaceDir);
});
main.ipc.handle('workspace-sync:stop', (_, projectId) => {
  return syncManager.stopSync(projectId);
});
main.ipc.handle('workspace-sync:get-status', (_, projectId) => {
  return syncManager.getStatus(projectId);
});
main.ipc.handle('workspace-sync:get-share-name', (_, projectId) => {
  return syncManager.getShareName(projectId);
});
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
  await syncManager.dispose();
  const results = await Promise.allSettled([
    cleanupConsole(),
    cleanupAppControl(),
    cleanupOmniInstall(),
    cleanupProcessManager(),
    cleanupProject(),
    cleanupExtensions(),
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
      const upstream = await net.fetch(pathToFileURL(fullPath).toString());
      // Strict CSP: artifacts are agent-generated content, never trusted to
      // run scripts. `default-src 'none'` blocks script execution by default;
      // we explicitly re-enable images, styles, fonts, and media so typical
      // markdown/HTML artifacts still render.
      const headers = new Headers(upstream.headers);
      headers.set(
        'Content-Security-Policy',
        "default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:"
      );
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  main.createWindow();

  if (process.env.OMNI_CI_AUTOINSTALL) {
    void (async () => {
      console.log('[OMNI_CI] starting auto-install');
      try {
        await omniInstall.startInstall();
      } catch (err) {
        console.error('[OMNI_CI] startInstall threw:', err);
      }
      const status = omniInstall.getStatus();
      console.log(`[OMNI_CI] final status: ${status.type}`);
      app.exit(status.type === 'completed' ? 0 : 1);
    })();
  }

  // Ensure workspace and projects directories exist on startup
  void ensureDirectory(getDefaultWorkspaceDir())
    .then(() => ensureDirectory(getProjectsDir()))
    .catch((err) => console.warn('Failed to create workspace directories:', err));

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

//#region Shared IPC handlers (config:*, util:*, skills:*)

registerConfigHandlers(main.ipc, OMNI_CONFIG_DIR);
registerUtilHandlers(main.ipc, {
  fetchFn: ((input, init) => net.fetch(input as string, init)) as typeof globalThis.fetch,
  launcherVersion: app.getVersion(),
});
registerSkillsHandlers(main.ipc, OMNI_CONFIG_DIR, store);

//#endregion

//#region Electron-only util handlers (dialog, shell)

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
main.ipc.handle('util:select-file', async (_, path, filters) => {
  const mainWindow = main.getWindow();
  assert(mainWindow !== null, 'Main window is not initialized');

  const defaultPath = path && (await isFile(path)) ? path : app.getPath('home');

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    defaultPath,
    filters: filters ?? undefined,
  });

  return result.filePaths[0] ?? null;
});
main.ipc.handle('util:open-directory', (_, path) => shell.openPath(path));

//#endregion
