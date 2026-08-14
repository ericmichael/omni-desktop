/**
 * Single source of truth for which sandbox profiles the launcher offers
 * the user. Settings UI (default-profile picker) and the per-launch
 * SandboxPicker both consume this so they never drift.
 *
 * Options come from backend discovery (`$sandboxProfiles`, filled by
 * `sandbox:list-profiles`) so user-created YAMLs under ``<config>/sandbox/``
 * appear everywhere. The hard-coded list survives only as the fallback
 * while the atom is empty (pre-first-fetch / fetch error), so no picker
 * regresses to an empty menu.
 */

import { $sandboxProfiles } from '@/renderer/features/Sandboxes/state';
import { $machines } from '@/renderer/services/machines';
import type { MachineSummary, ProfileSummary } from '@/shared/types';

const OPEN_SOURCE_PROFILES = ['host', 'devbox'] as const;
const ENTERPRISE_EXTRA_PROFILES = ['platform'] as const;

const PROFILE_LABELS: Record<string, string> = {
  host: 'My computer (no sandbox)',
  devbox: 'Workstation (desktop + tools)',
  wasmbox: 'Mini computer (instant, sealed)',
  platform: 'Cloud (managed)',
};

/** First line in two-line pickers and the compact pill: just the name. */
const PROFILE_TITLES: Record<string, string> = {
  host: 'My computer',
  devbox: 'Workstation',
  wasmbox: 'Mini computer',
  platform: 'Cloud',
};

/**
 * Second line in two-line pickers (SandboxPicker menu). Deliberately lay
 * language — this line carries the safety tradeoff, so no Docker/wasm/
 * container vocabulary.
 */
const PROFILE_DESCRIPTIONS: Record<string, string> = {
  host: 'Full access to your files and programs. No sandbox.',
  devbox: 'A full separate computer with a desktop and tools installed.',
  wasmbox: 'Starts instantly, safely sealed off. Limited features.',
  platform: 'A managed sandbox in the cloud.',
};

export type ProfileListContext = {
  /** Build was compiled with ``OMNI_PLATFORM_URL`` set. */
  isEnterprise: boolean;
  /**
   * Backend-provided profile list (``StoreData.availableSandboxProfiles``).
   * When set, it's authoritative — a deployment can restrict the picker to
   * a subset and hide host/devbox.
   */
  available?: string[];
  /**
   * Cloud-side machine registry for the signed-in principal. Used to render
   * friendly labels (`Local · Eric-MacBook (●)`) for `local:<id>` profile
   * names. Optional — when absent, `local:*` entries fall through to the
   * truncated id.
   */
  machines?: MachineSummary[];
  /**
   * Discovered profile catalog. Defaults to a non-reactive `$sandboxProfiles`
   * read (same idiom as `machines`/`$machines` below); pass a
   * `useStore($sandboxProfiles)` value where the options must re-render as
   * discovery lands.
   */
  discovered?: ProfileSummary[];
};

/**
 * Safety-first display rank: sealed → contained → managed cloud →
 * user-created (unknown containment) → unsandboxed (this machine, then
 * other machines). Every picker sorts by this so the safe choices lead
 * and "no sandbox" always sits at the bottom — order is part of the risk
 * signaling, alongside the warning tint and the description line.
 */
const profileSafetyRank = (name: string): number => {
  if (name === 'wasmbox') {
    return 0;
  }
  if (name === 'devbox') {
    return 1;
  }
  if (name === 'platform') {
    return 2;
  }
  if (name === 'host') {
    return 4;
  }
  if (isLocalProfile(name)) {
    return 5;
  }
  return 3;
};

export const getAvailableProfileNames = (ctx: ProfileListContext): string[] => {
  // Deployment restriction stays authoritative for MEMBERSHIP — it can carry
  // names discovery can't know (cloud appends `local:<machineId>`
  // computer-as-sandbox entries). Presentation order is ours: safest first.
  // Array.prototype.sort is stable, so same-rank entries keep their
  // discovered/declared relative order.
  if (ctx.available && ctx.available.length > 0) {
    return [...ctx.available].sort((a, b) => profileSafetyRank(a) - profileSafetyRank(b));
  }
  const discovered = ctx.discovered ?? $sandboxProfiles.get();
  if (discovered.length > 0) {
    return discovered.map((p) => p.name).sort((a, b) => profileSafetyRank(a) - profileSafetyRank(b));
  }
  const fallback = ctx.isEnterprise ? [...OPEN_SOURCE_PROFILES, ...ENTERPRISE_EXTRA_PROFILES] : [...OPEN_SOURCE_PROFILES];
  return fallback.sort((a, b) => profileSafetyRank(a) - profileSafetyRank(b));
};

const titleCase = (s: string): string => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1));

/** True for `local:<machineId>` profile names. */
export const isLocalProfile = (name: string): boolean => name.startsWith('local:');

/** Pull the machineId from a `local:<machineId>` profile name. */
export const machineIdFromProfile = (name: string): string | null =>
  isLocalProfile(name) ? name.slice('local:'.length) : null;

/**
 * Long-form label used in pickers and settings ("My computer (no sandbox)"). For
 * compact status chips (e.g. "Workstation", "Cloud") use ``buildProfileLabel``
 * from ``@/renderer/omniagents-ui/sandbox-label``.
 *
 * For `local:<machineId>` profiles the machine's friendly label + online status
 * come from the `machines` list; it defaults to the live `$machines` store so
 * EVERY caller resolves the computer name (not just those that thread it
 * through). Only when the id is genuinely unknown do we fall back to a short id.
 * Pass an explicit `machines` from a `useStore($machines)` subscription where
 * the label must re-render as the list loads / online status flips.
 */
export const getProfileMenuLabel = (name: string, machines: MachineSummary[] = $machines.get()): string => {
  if (PROFILE_LABELS[name]) {
    return PROFILE_LABELS[name];
  }
  return resolveDynamicLabel(name, machines);
};

/**
 * Title-only label ("Workstation") for two-line menu items and compact
 * pills; pair with ``getProfileDescription`` for the explanatory line.
 * Unknown / `local:*` names resolve exactly like ``getProfileMenuLabel``.
 */
export const getProfileTitle = (name: string, machines: MachineSummary[] = $machines.get()): string => {
  if (PROFILE_TITLES[name]) {
    return PROFILE_TITLES[name];
  }
  return resolveDynamicLabel(name, machines);
};

/** Explanatory second line for known profiles; null for user-created and `local:*` names. */
export const getProfileDescription = (name: string): string | null => PROFILE_DESCRIPTIONS[name] ?? null;

const resolveDynamicLabel = (name: string, machines: MachineSummary[]): string => {
  const machineId = machineIdFromProfile(name);
  if (machineId) {
    const machine = machines.find((m) => m.machineId === machineId);
    if (machine) {
      const dot = machine.online ? '●' : '○';
      return `Local · ${machine.label} (${dot})`;
    }
    return `Local · ${machineId.slice(0, 8)}`;
  }
  // Names outside the hard-coded map (user-created profiles) get their
  // catalog label from discovery before the title-case fallback.
  const discovered = $sandboxProfiles.get().find((p) => p.name === name);
  return discovered?.label ?? titleCase(name);
};
