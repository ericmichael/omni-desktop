import { exposeElectronAPI } from '@electron-toolkit/preload';
import { contextBridge } from 'electron';

exposeElectronAPI();

// Remote-backend bootstrap data. ``main/main-process-manager.ts`` passes the
// current remoteBackend (or ``null``) via ``additionalArguments`` so the
// renderer can decide which transport to construct at boot — without
// needing an async pre-init step. Re-reading this requires a window
// reload, which is what the cloud:link / cloud:unlink / wsl:link IPC
// handlers prompt. ``platform`` lets the renderer gate OS-specific UI
// (the WSL backend card is Windows-only).
const REMOTE_BACKEND_ARG_PREFIX = '--omni-remote-backend=';
const backendArg = process.argv.find((a) => a.startsWith(REMOTE_BACKEND_ARG_PREFIX));
let bootstrap: unknown = null;
if (backendArg) {
  try {
    bootstrap = JSON.parse(backendArg.slice(REMOTE_BACKEND_ARG_PREFIX.length));
  } catch {
    // Malformed arg → behave as if remoteBackend is unset.
    bootstrap = null;
  }
}
contextBridge.exposeInMainWorld('__omniBootstrap', { remoteBackend: bootstrap, platform: process.platform });
