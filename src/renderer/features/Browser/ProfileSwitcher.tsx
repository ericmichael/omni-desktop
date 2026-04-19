/**
 * Profile switcher — toolbar dropdown showing the current browser profile
 * with options to switch, create, or delete. Creating an incognito profile
 * spawns a non-persistent partition; switching triggers a webview remount
 * (via the `key={partition}` in `Webview`) so session data is isolated.
 */
import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import {
  Checkmark16Regular,
  Delete16Regular,
  Person20Regular,
  PersonAdd16Regular,
  PersonProhibited16Regular,
} from '@fluentui/react-icons';
import { memo, useCallback } from 'react';

import { Menu, MenuDivider, MenuItem, MenuList, MenuPopover, MenuTrigger } from '@/renderer/ds';
import { browserApi } from '@/renderer/features/Browser/state';
import type { BrowserProfile, BrowserProfileId, BrowserTabsetId } from '@/shared/types';

const useStyles = makeStyles({
  trigger: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    height: '26px',
    paddingLeft: '8px',
    paddingRight: '8px',
    borderRadius: tokens.borderRadiusMedium,
    border: 'none',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground2,
    cursor: 'pointer',
    flexShrink: 0,
    fontSize: tokens.fontSizeBase200,
    maxWidth: '140px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover, color: tokens.colorNeutralForeground1 },
  },
  triggerIncognito: {
    backgroundColor: 'rgba(130, 110, 210, 0.18)',
    color: tokens.colorNeutralForeground1,
    ...shorthands.border('1px', 'solid', 'rgba(130, 110, 210, 0.4)'),
  },
  label: { maxWidth: '90px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
});

export const ProfileSwitcher = memo(
  ({
    tabsetId,
    profiles,
    currentProfileId,
  }: {
    tabsetId: BrowserTabsetId;
    profiles: BrowserProfile[];
    currentProfileId: BrowserProfileId;
  }) => {
    const styles = useStyles();
    const current = profiles.find((p) => p.id === currentProfileId) ?? profiles[0];

    const handleSwitch = useCallback(
      (id: BrowserProfileId) => {
        if (id === currentProfileId) return;
        void browserApi.setTabsetProfile(tabsetId, id).catch(() => {});
      },
      [currentProfileId, tabsetId]
    );

    const handleCreate = useCallback(
      async (incognito: boolean) => {
        const label = window.prompt(incognito ? 'New incognito profile name' : 'New profile name');
        if (!label) return;
        try {
          const profile = await browserApi.addProfile({ label, ...(incognito ? { incognito: true } : {}) });
          await browserApi.setTabsetProfile(tabsetId, profile.id);
        } catch {
          // ignore — fire-and-forget UX
        }
      },
      [tabsetId]
    );

    const handleDelete = useCallback(
      async (id: BrowserProfileId) => {
        if (!window.confirm('Delete this profile? Any tabsets using it will revert to the default profile.')) {
          return;
        }
        try {
          await browserApi.removeProfile(id);
        } catch {
          // ignore
        }
      },
      []
    );

    if (!current) return null;

    return (
      <Menu positioning={{ position: 'below', align: 'end' }}>
        <MenuTrigger>
          <button
            type="button"
            className={`${styles.trigger}${current.incognito ? ` ${styles.triggerIncognito}` : ''}`}
            aria-label={`Profile: ${current.label}`}
            title={`Profile: ${current.label}${current.incognito ? ' (incognito)' : ''}`}
          >
            {current.incognito ? (
              <PersonProhibited16Regular style={{ width: 14, height: 14 }} />
            ) : (
              <Person20Regular style={{ width: 14, height: 14 }} />
            )}
            <span className={styles.label}>{current.label}</span>
          </button>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            {profiles.map((p) => (
              <MenuItem
                key={p.id}
                icon={
                  p.id === currentProfileId ? (
                    <Checkmark16Regular />
                  ) : p.incognito ? (
                    <PersonProhibited16Regular />
                  ) : (
                    <Person20Regular style={{ width: 16, height: 16 }} />
                  )
                }
                onClick={() => handleSwitch(p.id)}
              >
                {p.label}
                {p.incognito ? ' (incognito)' : ''}
                {p.builtin ? ' · default' : ''}
              </MenuItem>
            ))}
            <MenuDivider />
            <MenuItem icon={<PersonAdd16Regular />} onClick={() => void handleCreate(false)}>
              New profile…
            </MenuItem>
            <MenuItem icon={<PersonProhibited16Regular />} onClick={() => void handleCreate(true)}>
              New incognito profile…
            </MenuItem>
            {!current.builtin && (
              <>
                <MenuDivider />
                <MenuItem icon={<Delete16Regular />} onClick={() => void handleDelete(current.id)}>
                  Delete “{current.label}”
                </MenuItem>
              </>
            )}
          </MenuList>
        </MenuPopover>
      </Menu>
    );
  }
);
ProfileSwitcher.displayName = 'ProfileSwitcher';
