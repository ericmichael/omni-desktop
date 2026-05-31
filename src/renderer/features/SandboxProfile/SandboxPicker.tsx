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

import { Checkmark16Regular, ChevronDown16Regular, Cube16Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback } from 'react';

import { Menu, MenuItem, MenuList, MenuPopover, MenuTrigger } from '@/renderer/ds';
import { $machines } from '@/renderer/services/machines';

import {
  type ProfileListContext,
  getAvailableProfileNames,
  getProfileMenuLabel,
  isLocalProfile,
} from './profile-list';

export type SandboxPickerProps = {
  /** Currently-chosen profile name. */
  value: string;
  /** Called when the user picks a different profile. */
  onChange: (profileName: string) => void;
  /** Build-time context for which profiles are available. */
  context: ProfileListContext;
  /** Disable the picker (e.g. when the agent is already launching). */
  disabled?: boolean;
};

export const SandboxPicker = memo(({ value, onChange, context, disabled }: SandboxPickerProps) => {
  const machines = useStore($machines);
  const names = getAvailableProfileNames({ ...context, machines });

  const handleSelect = useCallback(
    (name: string) => {
      if (name !== value) {
        onChange(name);
      }
    },
    [onChange, value]
  );

  // Two groups: cloud (everything that isn't `local:*`) and "My computers".
  // We keep ordering inside each group as supplied by `getAvailableProfileNames`.
  const cloudNames = names.filter((n) => !isLocalProfile(n));
  const localNames = names.filter(isLocalProfile);

  return (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-stroke-1 bg-bgCard text-fg-muted text-xs font-medium hover:bg-bgHover hover:border-stroke-2 disabled:opacity-50"
        >
          <span className="inline-flex items-center gap-1">
            <Cube16Regular />
            {getProfileMenuLabel(value, machines)}
          </span>
          <ChevronDown16Regular />
        </button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          {cloudNames.map((name) => {
            const selected = name === value;
            return (
              <MenuItem
                key={name}
                onClick={() => handleSelect(name)}
                icon={
                  selected ? <Checkmark16Regular className="text-brand" /> : <span className="w-4" />
                }
              >
                {getProfileMenuLabel(name, machines)}
              </MenuItem>
            );
          })}
          {localNames.length > 0 && (
            <>
              <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-fg-subtle border-t border-stroke-1 mt-1 pt-2">
                My computers
              </div>
              {localNames.map((name) => {
                const selected = name === value;
                return (
                  <MenuItem
                    key={name}
                    onClick={() => handleSelect(name)}
                    icon={
                      selected ? <Checkmark16Regular className="text-brand" /> : <span className="w-4" />
                    }
                  >
                    {getProfileMenuLabel(name, machines)}
                  </MenuItem>
                );
              })}
            </>
          )}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
});

SandboxPicker.displayName = 'SandboxPicker';
