/**
 * Build the human-readable label shown for the active sandbox profile (the
 * compact "pill"). Examples: "Host", "Devbox", "Cloud · Fast", "Custom (dev)".
 *
 * The label is keyed off the profile *name*; unknown profile names render as
 * title-cased text so user-created profiles still display cleanly. For
 * `local:<machineId>` (computer-as-sandbox) the machineId is an opaque UUID, so
 * we resolve the machine's friendly label from the `machines` list — defaulting
 * to the live `$machines` store so the pill shows the computer name, not the
 * raw UUID. Pass an explicit `machines` from `useStore($machines)` where the
 * pill must re-render as the list loads.
 */
import { $machines } from '@/renderer/services/machines';
import type { MachineSummary } from '@/shared/types';

const KNOWN_PROFILE_LABELS: Record<string, string> = {
  host: 'Host',
  devbox: 'Devbox',
  platform: 'Platform',
  aci: 'Cloud · Fast',
  'aci-desktop': 'Cloud · Desktop',
};

const titleCase = (s: string): string => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1));

const resolveBase = (profileName: string, machines: MachineSummary[]): string => {
  const known = KNOWN_PROFILE_LABELS[profileName];
  if (known) {
    return known;
  }
  if (profileName.startsWith('local:')) {
    const machineId = profileName.slice('local:'.length);
    const machine = machines.find((m) => m.machineId === machineId);
    return machine ? `Local · ${machine.label}` : `Local · ${machineId.slice(0, 8)}`;
  }
  return titleCase(profileName);
};

export const buildProfileLabel = (profileName: string, machines: MachineSummary[] = $machines.get()): string => {
  const base = resolveBase(profileName, machines);
  return import.meta.env.MODE === 'development' ? `${base} (dev)` : base;
};
