/**
 * Bridge between the `launch_app` client tool and the deck UI.
 *
 * The client-tool handler can't directly open a persisted sidecar tab, so it
 * calls `requestAppLaunch(tabId, appId)`. CodeDeck consumes that request and
 * opens or activates the app in the column's right-side tab strip. Once the
 * app mounts it registers itself and becomes drivable.
 *
 * Mirrors `preview-bridge` — non-blocking, the tool returns immediately.
 */
import { atom } from 'nanostores';

import type { AppId } from '@/shared/app-registry';

export type AppLaunchRequest = {
  id: string;
  tabId: string;
  appId: AppId;
};

let nextId = 0;

/** Reactive atom — the most recent app-launch request, or null. */
export const $appLaunchRequest = atom<AppLaunchRequest | null>(null);

/** Called by the client tool handler. Opens `appId` in column `tabId`. */
export function requestAppLaunch(tabId: string, appId: AppId): void {
  $appLaunchRequest.set({ id: `launch-${++nextId}`, tabId, appId });
}

/** Called by the deck UI after consuming the request. */
export function clearAppLaunchRequest(): void {
  $appLaunchRequest.set(null);
}
