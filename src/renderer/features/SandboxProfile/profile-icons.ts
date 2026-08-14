/**
 * Per-profile icons for the sandbox pickers and composer pill. Kept
 * store-free (unlike `profile-list.ts`, which pulls in the discovery and
 * machines atoms) so omniagents-ui components can import it directly.
 *
 * The icon answers "what kind of computer is this?" — the same question
 * the display name answers. Risk is a separate accent: unsandboxed
 * profiles keep their identity icon and get a `text-warning` tint via
 * `isUnsandboxedProfile`, never a different glyph.
 */
import { Box, Cloud, Laptop, type LucideIcon, Monitor } from 'lucide-react';

const PROFILE_ICONS: Record<string, LucideIcon> = {
  host: Laptop,
  devbox: Monitor,
  wasmbox: Box,
  platform: Cloud,
};

export const getProfileIcon = (name: string): LucideIcon => {
  const known = PROFILE_ICONS[name];
  if (known) {
    return known;
  }
  // Computer-as-sandbox entries are someone's real machine.
  if (name.startsWith('local:')) {
    return Laptop;
  }
  // User-created profiles: the generic sandbox glyph.
  return Box;
};

/**
 * True for profiles that execute directly on a real machine with no
 * containment boundary — `host`, and `local:<machineId>` (host-bridge runs
 * raw processes on the target computer). Consumers render the icon with a
 * warning tint; the description text still carries the words.
 */
export const isUnsandboxedProfile = (name: string): boolean => name === 'host' || name.startsWith('local:');
