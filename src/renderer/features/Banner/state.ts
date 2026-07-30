import { atom, onMount, task } from 'nanostores';

import { emitter, wsEmitter } from '@/renderer/services/ipc';
import type { ConnectionState } from '@/shared/lifecycle';

export const $launcherVersion = atom<string | null>(null);

onMount($launcherVersion, () => {
  task(async () => {
    const launcherVersion = await emitter.invoke('util:get-launcher-version');
    $launcherVersion.set(launcherVersion);
  });
});

/**
 * Lifecycle state of the backend WebSocket transport (browser server-mode or
 * remote-linked Electron). `null` in standalone Electron, which has no WS
 * transport. Drives {@link ConnectionStatusBanner}: `reconnecting` is the
 * retryable outage, `closed` with `permanent: true` is the terminal state
 * (auth rejection or exhausted retry budget — see `@/shared/lifecycle`).
 */
export const $wsConnectionState = atom<ConnectionState | null>(null);

onMount($wsConnectionState, () => wsEmitter?.onStateChange((state) => $wsConnectionState.set(state)));
