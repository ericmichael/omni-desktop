import { exposeElectronAPI } from '@electron-toolkit/preload';
import { contextBridge } from 'electron';

exposeElectronAPI();

// Cloud-link bootstrap data. ``main/main-process-manager.ts`` passes the
// current cloudMode (or ``null``) via ``additionalArguments`` so the
// renderer can decide which transport to construct at boot — without
// needing an async pre-init step. Re-reading this requires a window
// reload, which is what the cloud:link / cloud:unlink IPC handlers prompt.
const CLOUD_ARG_PREFIX = '--omni-cloud-mode=';
const cloudArg = process.argv.find((a) => a.startsWith(CLOUD_ARG_PREFIX));
let bootstrap: unknown = null;
if (cloudArg) {
  try {
    bootstrap = JSON.parse(cloudArg.slice(CLOUD_ARG_PREFIX.length));
  } catch {
    // Malformed arg → behave as if cloudMode is unset.
    bootstrap = null;
  }
}
contextBridge.exposeInMainWorld('__omniBootstrap', { cloudMode: bootstrap });
