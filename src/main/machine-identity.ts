/**
 * Stable per-install identity for the cloud-linked Electron's "computer-as-
 * sandbox" registration.
 *
 * The cloud uses ``machineId`` to dispatch reverse-RPC sandbox lifecycle calls
 * to one specific Electron, so the id must:
 *
 *   - be generated once and never rotated (rotating would orphan every cloud
 *     session anchored to "this laptop"),
 *   - survive app upgrades (lives in ``<configDir>/machine.json``, NOT
 *     electron-store / userData, so a "clear my settings" doesn't break the
 *     binding),
 *   - be the SAME across every Electron window on this machine (single file
 *     on disk; concurrent Electrons all read it).
 *
 * The ``label`` is editable by the user from Settings → Machines and is what
 * shows up in the sandbox picker ("Local · Eric-MacBook"); it defaults to
 * ``os.hostname()`` and is persisted in the same file so a rename survives
 * restarts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, platform as osPlatform } from 'node:os';
import { join } from 'node:path';

import { uuidv4 } from '@/lib/uuid';

export type MachineIdentity = {
  machineId: string;
  label: string;
  platform: string;
};

const FILENAME = 'machine.json';

const cleanHostname = (raw: string): string => {
  // Trim the ".local" / ".lan" / ".home" mDNS suffixes most Macs/Linux
  // hosts pick up; keep the rest verbatim.
  const m = raw.replace(/\.(local|lan|home|localdomain)\.?$/i, '').trim();
  return m.length > 0 ? m : raw;
};

const generateId = (): string => {
  // Crypto.randomUUID is available in every supported Node + Electron version.
  // Bare uuid v4 — opaque, no embedded info.
  return uuidv4();
};

const readFile = (configDir: string): Partial<MachineIdentity> | null => {
  const path = join(configDir, FILENAME);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<MachineIdentity>;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

const writeFile = (configDir: string, identity: MachineIdentity): void => {
  mkdirSync(configDir, { recursive: true });
  const path = join(configDir, FILENAME);
  writeFileSync(path, `${JSON.stringify(identity, null, 2)}\n`, 'utf-8');
};

/**
 * Read the persisted identity, generating + writing one on first call.
 * Idempotent — subsequent calls return the same id; only `label` is allowed
 * to change (via {@link renameMachine}).
 */
export const getOrCreateMachineIdentity = (configDir: string): MachineIdentity => {
  const existing = readFile(configDir);
  if (existing?.machineId && existing?.label && existing?.platform) {
    return {
      machineId: existing.machineId,
      label: existing.label,
      platform: existing.platform,
    };
  }
  const identity: MachineIdentity = {
    // Preserve a pre-existing id if the file was partially-written (label
    // missing, etc.) so we don't orphan the cloud binding on a botched edit.
    machineId: existing?.machineId ?? generateId(),
    label: existing?.label ?? cleanHostname(hostname()) ?? 'Unnamed machine',
    platform: existing?.platform ?? osPlatform(),
  };
  writeFile(configDir, identity);
  return identity;
};

/**
 * Rewrite the persisted label. The `machineId` is preserved as-is; if the
 * file is missing for any reason a fresh one is minted with the new label.
 */
export const renameMachine = (configDir: string, label: string): MachineIdentity => {
  const current = getOrCreateMachineIdentity(configDir);
  const next: MachineIdentity = { ...current, label };
  writeFile(configDir, next);
  return next;
};
