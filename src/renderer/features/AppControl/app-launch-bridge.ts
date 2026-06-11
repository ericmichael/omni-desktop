/**
 * Bridge between the `launch_app` client tool and the deck UI.
 *
 * Dock apps mount lazily — only the active non-chat app per column has a live
 * webview. The client-tool handler can't reach CodeDeck's local `activeApps`
 * React state directly, so it calls `requestAppLaunch(tabId, appId)`, which sets
 * an atom CodeDeck subscribes to and *opens* (not toggles) that app in the
 * column. Once the webview mounts it registers itself and becomes drivable.
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
