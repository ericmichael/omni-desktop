/**
 * Permissions prompt bar — shown at the top of `BrowserView.body` whenever
 * a Chromium permission request is outstanding. One request at a time; if
 * more are queued they appear after the user clicks Allow / Deny.
 *
 * The atom is populated by a `browser:permissions-changed` event pushed
 * from the main-process `PermissionsManager`.
 */
import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { atom } from 'nanostores';
import { memo, useCallback } from 'react';

import { emitter, ipc } from '@/renderer/services/ipc';
import type { PermissionRequest } from '@/shared/permissions-types';

export const $permissions = atom<PermissionRequest[]>([]);

ipc.on('browser:permissions-changed', (list) => {
  $permissions.set(list ?? []);
});

void emitter
  .invoke('browser:permissions-list')
  .then((list) => $permissions.set(list ?? []))
  .catch(() => {
    /* server mode — empty */
  });

const useStyles = makeStyles({
  root: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '8px 12px',
    backgroundColor: tokens.colorNeutralBackground3,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
  },
  message: {
    flex: '1 1 0',
    minWidth: 0,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  origin: { fontWeight: tokens.fontWeightSemibold },
  allow: {
    height: '26px',
    paddingLeft: '10px',
    paddingRight: '10px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    border: 'none',
    cursor: 'pointer',
    fontSize: tokens.fontSizeBase200,
    ':hover': { backgroundColor: tokens.colorBrandBackgroundHover },
  },
  deny: {
    height: '26px',
    paddingLeft: '10px',
    paddingRight: '10px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground1,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    cursor: 'pointer',
    fontSize: tokens.fontSizeBase200,
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
  },
});

const FRIENDLY: Record<string, string> = {
  notifications: 'show notifications',
  media: 'use your camera & microphone',
  'media-capture': 'use your camera & microphone',
  'display-capture': 'capture your screen',
  geolocation: 'know your location',
  midi: 'access MIDI devices',
  midiSysex: 'send MIDI system messages',
  pointerLock: 'lock your mouse pointer',
  fullscreen: 'enter full-screen',
  'clipboard-read': 'read your clipboard',
  'clipboard-sanitized-write': 'write to your clipboard',
  'idle-detection': 'know when you’re idle',
  bluetooth: 'use Bluetooth devices',
  hid: 'use HID devices',
  serial: 'use serial devices',
  usb: 'use USB devices',
};

function describe(permission: string): string {
  return FRIENDLY[permission] ?? `use a permission (${permission})`;
}

export const PermissionsBar = memo(({ partition }: { partition?: string }) => {
  const styles = useStyles();
  const all = useStore($permissions);

  // Scope visible requests to this surface's partition. The main-process
  // manager tags requests with `partition` when it can identify them.
  // Unknown-partition requests show in every browser surface (they come from
  // the default session — the shell itself) so the user always sees them.
  const scoped = all.filter((r) => !r.partition || r.partition === partition);

  const next = scoped[0];

  const decide = useCallback((id: string, allow: boolean) => {
    void emitter.invoke('browser:permissions-decide', id, allow).catch(() => {});
  }, []);

  if (!next) {
return null;
}

  return (
    <div className={styles.root} role="alertdialog" aria-label="Permission request">
      <span className={styles.message}>
        <span className={styles.origin}>{next.origin}</span> wants to {describe(next.permission)}.
      </span>
      <button type="button" className={styles.deny} onClick={() => decide(next.id, false)}>
        Deny
      </button>
      <button type="button" className={styles.allow} onClick={() => decide(next.id, true)}>
        Allow
      </button>
    </div>
  );
});
PermissionsBar.displayName = 'PermissionsBar';
