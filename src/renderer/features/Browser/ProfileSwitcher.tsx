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
import { memo, useCallback, useState } from 'react';

import { ConfirmDialog, Menu, MenuDivider, MenuItem, MenuList, MenuPopover, MenuTrigger } from '@/renderer/ds';
import { NewProfileDialog } from '@/renderer/features/Browser/ProfileDialog';
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
  destructive: { color: tokens.colorPaletteRedForeground1 },
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

    const [createOpen, setCreateOpen] = useState(false);
    const [createIncognito, setCreateIncognito] = useState(false);
    const [deleteOpen, setDeleteOpen] = useState(false);

    const handleSwitch = useCallback(
      (id: BrowserProfileId) => {
        if (id === currentProfileId) return;
        void browserApi.setTabsetProfile(tabsetId, id).catch(() => {});
      },
      [currentProfileId, tabsetId]
    );

    const openCreate = useCallback((incognito: boolean) => {
      setCreateIncognito(incognito);
      setCreateOpen(true);
    }, []);

    const handleCreate = useCallback(
      async (input: { label: string; incognito: boolean }) => {
        try {
          const profile = await browserApi.addProfile(
            input.incognito ? { label: input.label, incognito: true } : { label: input.label }
          );
          await browserApi.setTabsetProfile(tabsetId, profile.id);
        } catch {
          // ignore — fire-and-forget UX
        }
      },
      [tabsetId]
    );

    const confirmDelete = useCallback(() => {
      if (!current || current.builtin) return;
      void browserApi.removeProfile(current.id).catch(() => {});
    }, [current]);

    if (!current) return null;

    return (
      <>
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
              <MenuItem icon={<PersonAdd16Regular />} onClick={() => openCreate(false)}>
                New profile…
              </MenuItem>
              <MenuItem icon={<PersonProhibited16Regular />} onClick={() => openCreate(true)}>
                New incognito profile…
              </MenuItem>
              {!current.builtin && (
                <>
                  <MenuDivider />
                  <MenuItem
                    icon={<Delete16Regular className={styles.destructive} />}
                    onClick={() => setDeleteOpen(true)}
                    className={styles.destructive}
                  >
                    Delete “{current.label}”
                  </MenuItem>
                </>
              )}
            </MenuList>
          </MenuPopover>
        </Menu>
        <NewProfileDialog
          open={createOpen}
          defaultIncognito={createIncognito}
          onClose={() => setCreateOpen(false)}
          onCreate={handleCreate}
        />
        <ConfirmDialog
          open={deleteOpen}
          onClose={() => setDeleteOpen(false)}
          onConfirm={confirmDelete}
          title={`Delete profile “${current.label}”?`}
          description="Any tabsets currently using this profile will switch back to the default. Persistent cookies and storage for this profile will be deleted the next time the app restarts."
          confirmLabel="Delete profile"
          destructive
        />
      </>
    );
  }
);
ProfileSwitcher.displayName = 'ProfileSwitcher';
