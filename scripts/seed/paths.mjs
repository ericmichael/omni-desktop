import os from 'node:os';
import path from 'node:path';

const PRODUCT_NAME = 'Omni Code';

/** Mirrors Electron's `app.getPath('userData')`. */
export function getUserDataDir() {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', PRODUCT_NAME);
    case 'win32':
      return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), PRODUCT_NAME);
    default:
      return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), PRODUCT_NAME);
  }
}

/** electron-store default config file name. */
export function getStoreFile() {
  return path.join(getUserDataDir(), 'config.json');
}

/** Seed manifest lives next to the store. */
export function getManifestFile() {
  return path.join(getUserDataDir(), 'seed-manifest.json');
}

/** Mirrors `getOmniConfigDir()` from src/main/util.ts — where skills live. */
export function getOmniConfigDir() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'OmniCode');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, 'omni_code');
  return path.join(home, '.config', 'omni_code');
}

export function getSkillsDir() {
  return path.join(getOmniConfigDir(), 'skills');
}

/** Mirrors `getProjectsDir()` — <home>/Omni/Workspace/Projects. */
export function getProjectsDir() {
  return path.join(os.homedir(), 'Omni', 'Workspace', 'Projects');
}

export function getProjectDir(slug) {
  return path.join(getProjectsDir(), slug);
}
