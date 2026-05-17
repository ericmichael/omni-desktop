/**
 * Pre-launch sandbox profile picker.
 *
 * Renders a compact pill labeled with the currently-selected profile;
 * clicking opens a menu of available profiles. Selection is per-launch
 * (the parent component holds the override state — picker is purely
 * controlled). Mirrors the workspace switcher pattern: change the choice
 * before launching, no persistence beyond this session.
 */

import { Checkmark16Regular, ChevronDown16Regular, Cube16Regular } from '@fluentui/react-icons';
import { memo, useCallback } from 'react';

import { Menu, MenuItem, MenuList, MenuPopover, MenuTrigger } from '@/renderer/ds';

import {
  type ProfileListContext,
  getAvailableProfileNames,
  getProfileMenuLabel,
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
  const names = getAvailableProfileNames(context);

  const handleSelect = useCallback(
    (name: string) => {
      if (name !== value) {
        onChange(name);
      }
    },
    [onChange, value]
  );

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
            {getProfileMenuLabel(value)}
          </span>
          <ChevronDown16Regular />
        </button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          {names.map((name) => {
            const selected = name === value;
            return (
              <MenuItem
                key={name}
                onClick={() => handleSelect(name)}
                icon={
                  selected ? <Checkmark16Regular className="text-brand" /> : <span className="w-4" />
                }
              >
                {getProfileMenuLabel(name)}
              </MenuItem>
            );
          })}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
});

SandboxPicker.displayName = 'SandboxPicker';
