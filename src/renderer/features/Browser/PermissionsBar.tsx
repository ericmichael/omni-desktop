/**
 * Permissions prompt bar — shown at the top of `BrowserView.body` whenever
 * a Chromium permission request is outstanding. One request at a time; if
 * more are queued they appear after the user clicks Allow / Deny.
 *
 * The atom is populated by a `browser:permissions-changed` event pushed
 * from the main-process `PermissionsManager`.
 */
import { useStore } from '@nanostores/react';
import { atom } from 'nanostores';
import { memo, useCallback } from 'react';

import { Alert, AlertDescription } from '@/renderer/ds/ui/alert';
import { Button } from '@/renderer/ds/ui/button';
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
    <Alert className="flex items-center gap-3 rounded-none border-x-0 border-t-0 bg-muted px-3 py-2">
      <AlertDescription className="min-w-0 flex-1 truncate text-xs text-foreground">
        <span className="font-semibold">{next.origin}</span> wants to {describe(next.permission)}.
      </AlertDescription>
      <Button type="button" variant="outline" size="sm" onClick={() => decide(next.id, false)}>
        Deny
      </Button>
      <Button type="button" size="sm" onClick={() => decide(next.id, true)}>
        Allow
      </Button>
    </Alert>
  );
});
PermissionsBar.displayName = 'PermissionsBar';
