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

const OPEN_SOURCE_PROFILES = ['host', 'devbox'] as const;
const ENTERPRISE_EXTRA_PROFILES = ['platform'] as const;

const PROFILE_LABELS: Record<string, string> = {
  host: 'Host (no isolation)',
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

/**
 * Long-form label used in pickers and settings ("Host (no isolation)"). For
 * compact status chips (e.g. "Devbox", "Cloud") use ``buildProfileLabel``
 * from ``@/renderer/omniagents-ui/sandbox-label``.
 */
export const getProfileMenuLabel = (name: string): string =>
  PROFILE_LABELS[name] ?? titleCase(name);
