/**
 * Pre-launch sandbox profile picker.
 *
 * Renders a compact pill labeled with the currently-selected profile;
 * clicking opens a menu of available profiles. Selection is per-launch
 * (the parent component holds the override state — picker is purely
 * controlled). Mirrors the workspace switcher pattern: change the choice
 * before launching, no persistence beyond this session.
 *
 * Profiles are grouped into "Cloud" (host/devbox/aci/platform) and "My
 * computers" (one entry per registered Electron). Each local entry shows
 * an online/offline indicator pulled from `$machines`.
 */

import { useStore } from '@nanostores/react';
import { Box, ChevronDown } from 'lucide-react';
import { memo } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/renderer/ds/ui/dropdown-menu';
import { $sandboxProfiles } from '@/renderer/features/Sandboxes/state';
import { $machines } from '@/renderer/services/machines';

import { getAvailableProfileNames, getProfileMenuLabel, isLocalProfile, type ProfileListContext } from './profile-list';

const COMPACT_PROFILE_LABELS: Record<string, string> = {
  host: 'Host',
  devbox: 'Devbox',
  platform: 'Platform',
  aci: 'Cloud',
  'aci-desktop': 'Desktop',
};

const getCompactProfileLabel = (name: string): string =>
  COMPACT_PROFILE_LABELS[name] ?? name.replace(/^local:/, 'Local ');

export type SandboxPickerProps = {
  /** Currently-chosen profile name. */
  value: string;
  /** Called when the user picks a different profile. */
  onChange: (profileName: string) => void;
  /** Build-time context for which profiles are available. */
  context: ProfileListContext;
  /** Disable the picker (e.g. when the agent is already launching). */
  disabled?: boolean;
  /** Use a shorter trigger for tight toolbar/action-bar placements. */
  compact?: boolean;
};

export const SandboxPicker = memo(({ value, onChange, context, disabled, compact = false }: SandboxPickerProps) => {
  const machines = useStore($machines);
  // Subscribe so the menu re-renders as discovery lands (and triggers the
  // atom's fetch-on-first-subscribe).
  const discovered = useStore($sandboxProfiles);
  const names = getAvailableProfileNames({ ...context, machines, discovered });

  // Two groups: cloud (everything that isn't `local:*`) and "My computers".
  // We keep ordering inside each group as supplied by `getAvailableProfileNames`.
  const cloudNames = names.filter((n) => !isLocalProfile(n));
  const localNames = names.filter(isLocalProfile);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          className={
            compact
              ? 'min-w-0 max-w-24 justify-between px-2 text-xs text-muted-foreground'
              : 'px-2 text-xs text-muted-foreground'
          }
        >
          <span className="inline-flex min-w-0 items-center gap-1">
            {!compact && <Box />}
            <span className="truncate">
              {compact ? getCompactProfileLabel(value) : getProfileMenuLabel(value, machines)}
            </span>
          </span>
          <ChevronDown className="shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {cloudNames.map((name) => (
            <DropdownMenuRadioItem key={name} value={name}>
              {getProfileMenuLabel(name, machines)}
            </DropdownMenuRadioItem>
          ))}
          {localNames.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>My computers</DropdownMenuLabel>
              {localNames.map((name) => (
                <DropdownMenuRadioItem key={name} value={name}>
                  {getProfileMenuLabel(name, machines)}
                </DropdownMenuRadioItem>
              ))}
            </>
          )}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

SandboxPicker.displayName = 'SandboxPicker';
