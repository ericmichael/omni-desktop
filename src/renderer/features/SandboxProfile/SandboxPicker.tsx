/**
 * Pre-launch sandbox profile picker.
 *
 * Renders a compact pill labeled with the currently-selected profile;
 * clicking opens a menu of available profiles. Selection is per-launch
 * (the parent component holds the override state — picker is purely
 * controlled). Mirrors the workspace switcher pattern: change the choice
 * before launching, no persistence beyond this session.
 *
 * Profiles are grouped into "Cloud" (host/devbox/platform) and "My
 * computers" (one entry per registered Electron). Each local entry shows
 * an online/offline indicator pulled from `$machines`.
 */

import { useStore } from '@nanostores/react';
import { Check, ChevronDown } from 'lucide-react';
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

import { getProfileIcon, isUnsandboxedProfile } from './profile-icons';
import {
  getAvailableProfileNames,
  getProfileDescription,
  getProfileTitle,
  isLocalProfile,
  type ProfileListContext,
} from './profile-list';

const profileIconClass = (name: string, extra = ''): string =>
  `size-3.5 shrink-0 ${isUnsandboxedProfile(name) ? 'text-warning' : 'text-muted-foreground'}${extra ? ` ${extra}` : ''}`;

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
  const TriggerIcon = getProfileIcon(value);

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
            {!compact && <TriggerIcon className={profileIconClass(value)} />}
            <span className="truncate">{getProfileTitle(value, machines)}</span>
          </span>
          <ChevronDown className="shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {cloudNames.map((name) => {
            const description = getProfileDescription(name);
            const ItemIcon = getProfileIcon(name);
            return (
              <DropdownMenuRadioItem key={name} value={name} indicator="none">
                <span className="flex min-w-0 flex-1 items-start gap-2">
                  <ItemIcon className={profileIconClass(name, 'mt-0.5')} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-2">
                      <span className="flex-1">{getProfileTitle(name, machines)}</span>
                      {name === value && <Check className="size-3.5 shrink-0" />}
                    </span>
                    {description && <span className="max-w-56 text-xs text-muted-foreground">{description}</span>}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            );
          })}
          {localNames.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>My computers</DropdownMenuLabel>
              {localNames.map((name) => {
                const ItemIcon = getProfileIcon(name);
                return (
                  <DropdownMenuRadioItem key={name} value={name} indicator="none">
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <ItemIcon className={profileIconClass(name)} />
                      <span className="flex-1 truncate">{getProfileTitle(name, machines)}</span>
                      {name === value && <Check className="size-3.5 shrink-0" />}
                    </span>
                  </DropdownMenuRadioItem>
                );
              })}
            </>
          )}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

SandboxPicker.displayName = 'SandboxPicker';
