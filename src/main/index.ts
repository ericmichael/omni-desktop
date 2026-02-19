import { app, dialog, net, shell } from 'electron';
import { join } from 'path';
import { assert } from 'tsafe';

import { createConsoleManager } from '@/main/console-manager';
import { MainProcessManager } from '@/main/main-process-manager';
import { createOmniInstallManager } from '@/main/omni-install-manager';
import { createSandboxManager } from '@/main/sandbox-manager';
import { store } from '@/main/store';
import {
  ensureDirectory,
  getCliSymlinkPath,
  getDefaultEnvFilePath,
  getDefaultWorkspaceDir,
  getHomeDirectory,
  getOmniRuntimeInfo,
  getOperatingSystem,
  installCliToPath,
  isCliInstalledInPath,
  isDirectory,
  isFile,
  pathExists,
} from '@/main/util';

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
const [sandbox, cleanupSandbox] = createSandboxManager({
  ipc: main.ipc,
  sendToWindow: main.sendToWindow,
});

main.ipc.handle('main-process:get-status', () => main.getStatus());
main.ipc.handle('omni-install-process:get-status', () => omniInstall.getStatus());
main.ipc.handle('sandbox-process:get-status', () => sandbox.getStatus());

//#region App lifecycle

/**
 * Cleans up any running processes.
 */
async function cleanup() {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  const results = await Promise.allSettled([cleanupConsole(), cleanupOmniInstall(), cleanupSandbox()]);
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
app.on('ready', main.createWindow);

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
 * TODO(psyche): cleanupProcesses uses SIGTERM to kill the processes. This allows processes to handle the signal and
 * perform cleanup, but we aren't waiting for the processes to exit before we quit the host application. Could this
 * result in orphaned or improperly cleaned up processes?
 */
app.on('before-quit', cleanup);

//#endregion

//#region Util API

main.ipc.handle('util:get-default-install-dir', () => join(getHomeDirectory(), 'omni'));
main.ipc.handle('util:get-default-workspace-dir', () => getDefaultWorkspaceDir());
main.ipc.handle('util:get-default-env-file-path', async () => {
  const envPath = getDefaultEnvFilePath();
  return (await isFile(envPath)) ? envPath : null;
});
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
main.ipc.handle('util:get-home-directory', () => getHomeDirectory());
main.ipc.handle('util:get-is-directory', (_, path) => isDirectory(path));
main.ipc.handle('util:get-is-file', (_, path) => isFile(path));
main.ipc.handle('util:get-path-exists', (_, path) => pathExists(path));
main.ipc.handle('util:get-os', () => getOperatingSystem());
main.ipc.handle('util:open-directory', (_, path) => shell.openPath(path));
main.ipc.handle('util:get-launcher-version', () => app.getVersion());
main.ipc.handle('util:get-omni-runtime-info', async () => getOmniRuntimeInfo());
main.ipc.handle('util:install-cli-to-path', () => installCliToPath());
main.ipc.handle('util:get-cli-in-path-status', async () => {
  const installed = await isCliInstalledInPath();
  return { installed, symlinkPath: getCliSymlinkPath() };
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
