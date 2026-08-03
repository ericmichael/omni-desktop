/**
 * Sandbox profile discovery for the Sandboxes tab (`sandbox:list-profiles` /
 * `sandbox:read-profile` / `sandbox:create-override`).
 *
 * Enumerates launcher-bundled `assets/profiles/*.yml` plus user
 * `<config>/sandbox/*.yml`, with user files shadowing bundled ones by name —
 * the same precedence `profile-resolver.ts` applies at launch. The implicit
 * `host` profile (omni serve's built-in default; no file anywhere) is always
 * included. Electron-free and dependency-injected so both shells register it.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

import { HOST_PROFILE_NAME } from '@/main/profile-resolver';
import type { IIpcListener } from '@/shared/ipc-listener';
import type { ProfileSummary } from '@/shared/types';

export type ProfileCatalogDeps = {
  /** Directory of launcher-bundled `*.yml` profiles. May not exist. */
  bundledDir: string;
  /** User override dir (`<config>/sandbox`). May not exist until create-override. */
  userDir: string;
  /**
   * Deployment restriction (`StoreData.availableSandboxProfiles`), read at
   * invoke time. When set (non-empty), the listing is filtered to exactly
   * these names — host included only if listed. The Electron event / server
   * HandlerContext is passed through so server mode can resolve per-tenant.
   */
  getAvailableProfileNames?: (event: unknown) => string[] | undefined;
};

/**
 * Long-form labels for the known profile names. Mirrors the renderer's
 * PROFILE_LABELS (`SandboxProfile/profile-list.ts`) and the server snapshot's
 * `sandboxProfileLabel` — main is the discovery source, so it carries a label
 * for names the renderer map doesn't know (user-created profiles).
 */
const PROFILE_LABELS: Record<string, string> = {
  host: 'This computer (no sandbox)',
  devbox: 'Devbox (Docker)',
  platform: 'Cloud (managed)',
  aci: 'Cloud · Fast',
  'aci-desktop': 'Cloud · Desktop (IDE + VNC)',
};

const labelFor = (name: string): string =>
  PROFILE_LABELS[name] ?? (name.length > 0 ? name[0]!.toUpperCase() + name.slice(1) : name);

/** The always-present implicit host entry — omni serve's bundled default, no YAML anywhere. */
const hostSummary = (): ProfileSummary => ({
  name: HOST_PROFILE_NAME,
  label: labelFor(HOST_PROFILE_NAME),
  clientType: 'host',
  builtin: true,
  path: null,
  origin: 'implicit',
});

/**
 * Pull the detail-pane highlights out of a parsed profile document. The image
 * lives under `options.image` in the launcher's bundled profiles (see
 * assets/profiles/devbox.yml) — `client.image` is checked as a fallback for
 * hand-written variants. Absent fields stay undefined ("simply unknown").
 */
const extractDetails = (doc: Record<string, unknown>): ProfileSummary['details'] => {
  const client = (doc['client'] ?? {}) as Record<string, unknown>;
  const options = (doc['options'] ?? {}) as Record<string, unknown>;
  const details: NonNullable<ProfileSummary['details']> = {};
  const image = options['image'] ?? client['image'];
  if (typeof image === 'string') {
    details.image = image;
  }
  const services = doc['services'];
  if (services && typeof services === 'object' && !Array.isArray(services)) {
    details.services = Object.keys(services);
  }
  const runAs = doc['run_as'];
  if (typeof runAs === 'string' || typeof runAs === 'number') {
    details.runAs = String(runAs);
  }
  const confine = doc['confine'] ?? client['confine'];
  if (typeof confine === 'boolean') {
    details.confine = confine;
  }
  return Object.keys(details).length > 0 ? details : undefined;
};

/** Names of `*.yml` files in *dir* (without extension); [] when the dir is unreadable. */
const ymlNames = (dir: string): string[] => {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.yml'))
      .map((f) => f.slice(0, -'.yml'.length));
  } catch {
    return [];
  }
};

/**
 * Parse one profile YAML into a summary. Returns null (with a console.warn)
 * on malformed YAML so a single broken file never breaks the whole listing.
 */
const summarize = (
  name: string,
  filePath: string,
  origin: 'builtin' | 'user-override',
  builtin: boolean
): ProfileSummary | null => {
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.warn(`[profile-catalog] skipping malformed profile ${filePath}:`, err);
    return null;
  }
  const record = doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>) : {};
  const client = (record['client'] ?? {}) as Record<string, unknown>;
  const clientType = typeof client['type'] === 'string' ? client['type'] : 'unknown';
  return {
    name,
    label: labelFor(name),
    clientType,
    builtin,
    path: filePath,
    origin,
    details: extractDetails(record),
  };
};

/**
 * Enumerate every profile the launcher can offer: implicit host first, then
 * disk profiles alphabetically. When *availableNames* is set, filter to it.
 */
export const listProfiles = (deps: ProfileCatalogDeps, event?: unknown): ProfileSummary[] => {
  const bundledNames = ymlNames(deps.bundledDir);
  const userNames = ymlNames(deps.userDir);
  const bundledSet = new Set(bundledNames);

  const names = [...new Set([...bundledNames, ...userNames])].filter((n) => n !== HOST_PROFILE_NAME).sort();
  const summaries: ProfileSummary[] = [hostSummary()];
  for (const name of names) {
    const isUser = userNames.includes(name);
    const filePath = isUser ? path.join(deps.userDir, `${name}.yml`) : path.join(deps.bundledDir, `${name}.yml`);
    // `builtin` = the launcher ships this name; a user override of a bundled
    // profile is still a builtin (the `origin` field carries the distinction).
    const summary = summarize(name, filePath, isUser ? 'user-override' : 'builtin', bundledSet.has(name));
    if (summary) {
      summaries.push(summary);
    }
  }

  const available = deps.getAvailableProfileNames?.(event);
  if (available && available.length > 0) {
    const allowed = new Set(available);
    return summaries.filter((s) => allowed.has(s.name));
  }
  return summaries;
};

/**
 * Raw YAML for the read-only detail view. Resolution matches the launch path:
 * user override wins over bundled. Null for the implicit host profile and for
 * names with no file.
 */
export const readProfileYaml = (deps: ProfileCatalogDeps, name: string): { yaml: string } | null => {
  if (name === HOST_PROFILE_NAME) {
    return null;
  }
  for (const dir of [deps.userDir, deps.bundledDir]) {
    const filePath = path.join(dir, `${name}.yml`);
    if (existsSync(filePath)) {
      return { yaml: readFileSync(filePath, 'utf8') };
    }
  }
  return null;
};

/**
 * Copy the bundled YAML for *name* into `<userDir>/<name>.yml` so the user
 * can edit it. Throws when the profile is implicit (host — nothing to copy),
 * when an override already exists, or when no bundled file backs the name.
 */
export const createOverride = (deps: ProfileCatalogDeps, name: string): { path: string } => {
  if (name === HOST_PROFILE_NAME) {
    throw new Error(`Profile "${name}" is built into omni serve and has no YAML to copy.`);
  }
  const target = path.join(deps.userDir, `${name}.yml`);
  if (existsSync(target)) {
    throw new Error(`An override for "${name}" already exists at ${target}.`);
  }
  const bundled = path.join(deps.bundledDir, `${name}.yml`);
  if (!existsSync(bundled)) {
    throw new Error(`Profile "${name}" has no bundled YAML to copy.`);
  }
  mkdirSync(deps.userDir, { recursive: true });
  copyFileSync(bundled, target);
  return { path: target };
};

/**
 * Overwrite a profile's user YAML (`sandbox:write-profile`). Only file-backed
 * profiles that resolve to the USER dir are writable — an existing override of
 * a bundled profile, or a purely user-created file. Builtin-origin without an
 * override throws (create the override first, so launch resolution actually
 * reads the edited file), as do the implicit host profile and unknown names.
 *
 * The YAML is parse-validated (mapping with a `client.type` string — the shape
 * the catalog parser and AgentHost provisioner expect) BEFORE any disk write;
 * invalid input throws with the file untouched. The write itself is atomic
 * (tmp + rename) so `omni serve` can never read a torn YAML mid-write.
 */
export const writeProfile = (deps: ProfileCatalogDeps, name: string, yaml: string): void => {
  if (name === HOST_PROFILE_NAME) {
    throw new Error(`Profile "${name}" is built into omni serve and cannot be edited.`);
  }
  // Name is renderer-supplied — reject anything that could escape userDir.
  if (name.length === 0 || name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`Invalid profile name: ${JSON.stringify(name)}`);
  }
  let doc: unknown;
  try {
    doc = parseYaml(yaml);
  } catch (err) {
    throw new Error(`Invalid profile YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  const record = doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
  const client = record?.['client'];
  const clientType =
    client && typeof client === 'object' && !Array.isArray(client)
      ? (client as Record<string, unknown>)['type']
      : undefined;
  if (!record || typeof clientType !== 'string' || clientType.length === 0) {
    throw new Error('Profile YAML must be a mapping with a `client.type` string.');
  }
  const target = path.join(deps.userDir, `${name}.yml`);
  if (!existsSync(target)) {
    if (existsSync(path.join(deps.bundledDir, `${name}.yml`))) {
      throw new Error(`"${name}" is a bundled profile — create an override first, then edit the override.`);
    }
    throw new Error(`Profile "${name}" has no user file to overwrite.`);
  }
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, yaml, 'utf8');
  renameSync(tmp, target);
};

/** Register the profile channels on either shell's IPC listener. */
export const registerProfileCatalogHandlers = (ipc: IIpcListener, deps: ProfileCatalogDeps): void => {
  ipc.handle('sandbox:list-profiles', (event) => listProfiles(deps, event));
  ipc.handle('sandbox:read-profile', (_, name: string) => readProfileYaml(deps, name));
  ipc.handle('sandbox:create-override', (_, name: string) => createOverride(deps, name));
  ipc.handle('sandbox:write-profile', (_, name: string, yaml: string) => writeProfile(deps, name, yaml));
};
