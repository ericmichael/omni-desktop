/**
 * Build the human-readable label shown for the active sandbox profile.
 * Examples: "Host", "Devbox", "Platform", "Custom (dev)".
 *
 * The label is keyed off the profile *name*; unknown profile names render
 * as title-cased text so user-created profiles still display cleanly.
 */
const KNOWN_PROFILE_LABELS: Record<string, string> = {
  host: 'Host',
  devbox: 'Devbox',
  platform: 'Platform',
  aci: 'Cloud',
};

const titleCase = (s: string): string =>
  s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);

export const buildProfileLabel = (profileName: string): string => {
  const base = KNOWN_PROFILE_LABELS[profileName] ?? titleCase(profileName);
  return import.meta.env.MODE === 'development' ? `${base} (dev)` : base;
};
