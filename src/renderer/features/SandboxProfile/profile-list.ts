/**
 * Single source of truth for which sandbox profiles the launcher offers
 * the user. Settings UI (default-profile picker) and the per-launch
 * SandboxPicker both consume this so they never drift.
 *
 * Currently the list is hard-coded against the launcher's bundled
 * profiles plus an opt-in `platform` entry when the build is enterprise.
 * A follow-up profile-manager UI will discover user-created profile YAMLs
 * under ``<config>/sandbox/`` and merge them in here.
 */

import { $machines } from '@/renderer/services/machines';
import type { MachineSummary } from '@/shared/types';

const OPEN_SOURCE_PROFILES = ['host', 'devbox'] as const;
const ENTERPRISE_EXTRA_PROFILES = ['platform'] as const;

const PROFILE_LABELS: Record<string, string> = {
  host: 'This computer (no sandbox)',
  devbox: 'Devbox (Docker)',
  platform: 'Cloud (managed)',
  aci: 'Cloud · Fast',
  'aci-desktop': 'Cloud · Desktop (IDE + VNC)',
};

export type ProfileListContext = {
  /** Build was compiled with ``OMNI_PLATFORM_URL`` set. */
  isEnterprise: boolean;
  /**
   * Backend-provided profile list (``StoreData.availableSandboxProfiles``).
   * When set, it's authoritative — e.g. a cloud/ACI deployment sends
   * ``['aci']`` to offer only that and hide host/devbox.
   */
  available?: string[];
  /**
   * Cloud-side machine registry for the signed-in principal. Used to render
   * friendly labels (`Local · Eric-MacBook (●)`) for `local:<id>` profile
   * names. Optional — when absent, `local:*` entries fall through to the
   * truncated id.
   */
  machines?: MachineSummary[];
};

export const getAvailableProfileNames = (ctx: ProfileListContext): string[] => {
  if (ctx.available && ctx.available.length > 0) {
    return [...ctx.available];
  }
  return ctx.isEnterprise
    ? [...OPEN_SOURCE_PROFILES, ...ENTERPRISE_EXTRA_PROFILES]
    : [...OPEN_SOURCE_PROFILES];
};

const titleCase = (s: string): string =>
  s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);

/** True for `local:<machineId>` profile names. */
export const isLocalProfile = (name: string): boolean => name.startsWith('local:');

/** Pull the machineId from a `local:<machineId>` profile name. */
export const machineIdFromProfile = (name: string): string | null =>
  isLocalProfile(name) ? name.slice('local:'.length) : null;

/**
 * Long-form label used in pickers and settings ("This computer (no sandbox)"). For
 * compact status chips (e.g. "Devbox", "Cloud") use ``buildProfileLabel``
 * from ``@/renderer/omniagents-ui/sandbox-label``.
 *
 * For `local:<machineId>` profiles the machine's friendly label + online status
 * come from the `machines` list; it defaults to the live `$machines` store so
 * EVERY caller resolves the computer name (not just those that thread it
 * through). Only when the id is genuinely unknown do we fall back to a short id.
 * Pass an explicit `machines` from a `useStore($machines)` subscription where
 * the label must re-render as the list loads / online status flips.
 */
export const getProfileMenuLabel = (
  name: string,
  machines: MachineSummary[] = $machines.get()
): string => {
  if (PROFILE_LABELS[name]) return PROFILE_LABELS[name];
  const machineId = machineIdFromProfile(name);
  if (machineId) {
    const machine = machines.find((m) => m.machineId === machineId);
    if (machine) {
      const dot = machine.online ? '●' : '○';
      return `Local · ${machine.label} (${dot})`;
    }
    return `Local · ${machineId.slice(0, 8)}`;
  }
  return PROFILE_LABELS[name] ?? titleCase(name);
};
