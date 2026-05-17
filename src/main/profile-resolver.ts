/**
 * Map a launcher profile name to a YAML file path on disk.
 *
 * Lookup order:
 *   1. User-edited override at `<omniConfigDir>/sandbox/<name>.yml`
 *   2. Launcher-bundled profile under `assets/profiles/<name>.yml`
 *
 * Returns `null` when the launcher relies on omni-code's built-in default
 * (currently only the `host` profile — omni serve's bundled default already
 * is unix_local with the workspace as the manifest root, so passing
 * `--profile` would be redundant).
 *
 * For any other name, returns the resolved path; the caller passes it as
 * `omni serve --profile <path>`. Returns `null` and the caller surfaces a
 * structured error when a non-host profile has no file.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { getBundledBinPath, getOmniConfigDir, isDevelopment } from '@/main/util';

export const HOST_PROFILE_NAME = 'host';

export type ResolvedProfile =
  | { kind: 'builtin-default' }
  | { kind: 'file'; path: string }
  | { kind: 'missing'; expected: string };

/**
 * Where the launcher ships bundled profile YAMLs. Sibling of the bundled bin
 * directory so the packaging story is symmetric.
 */
const getBundledProfilesDir = (): string => {
  if (isDevelopment()) {
    return path.resolve(path.join(__dirname, '..', '..', 'assets', 'profiles'));
  }
  return path.resolve(path.join(getBundledBinPath(), '..', 'profiles'));
};

export const resolveProfile = (profileName: string): ResolvedProfile => {
  if (profileName === HOST_PROFILE_NAME) {
    return { kind: 'builtin-default' };
  }
  const userOverride = path.join(getOmniConfigDir(), 'sandbox', `${profileName}.yml`);
  if (existsSync(userOverride)) {
    return { kind: 'file', path: userOverride };
  }
  const bundled = path.join(getBundledProfilesDir(), `${profileName}.yml`);
  if (existsSync(bundled)) {
    return { kind: 'file', path: bundled };
  }
  return { kind: 'missing', expected: userOverride };
};
