/**
 * Minimal shim for Electron APIs when running in server (non-Electron) mode.
 * The server build aliases 'electron' to this module so manager imports don't crash.
 * Only the APIs actually used by managers at runtime are shimmed; desktop-only features are no-ops.
 */
import { homedir } from 'os';
import { join } from 'path';

// Stub ipcMain — cleanup functions call removeHandler, which is a no-op in server mode
export const ipcMain = {
  removeHandler: () => {},
  handle: () => {},
};

// Stub app
export const app = {
  getPath: (name: string): string => {
    switch (name) {
      case 'home':
        return homedir();
      case 'appData':
        return join(homedir(), '.config');
      case 'userData':
        return join(homedir(), '.config', 'omni-code-launcher');
      default:
        return join(homedir(), '.config', name);
    }
  },
  getVersion: () => '0.0.0',
  isPackaged: false,
};

// Stub shell
export const shell = {
  openPath: () => Promise.resolve(''),
  openExternal: () => Promise.resolve(),
};

// Stub dialog
export const dialog = {
  showOpenDialog: () => Promise.resolve({ filePaths: [] as string[], canceled: true }),
};

// Stub screen
export const screen = {
  getPrimaryDisplay: () => ({
    workAreaSize: { width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  }),
};

// Stub net
export const net = {
  fetch: globalThis.fetch,
};

// Stub protocol
export const protocol = {
  registerSchemesAsPrivileged: () => {},
  handle: () => {},
};

// Stub BrowserWindow (type-only in most cases, but fleet-manager may reference it)
export class BrowserWindow {}

export default {
  ipcMain,
  app,
  shell,
  dialog,
  screen,
  net,
  protocol,
  BrowserWindow,
};
