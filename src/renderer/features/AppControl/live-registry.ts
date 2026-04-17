/**
 * Renderer-side registry of live `<Webview>` instances.
 *
 * Each webview mounts, figures out its `webContents.id`, and calls
 * `registerApp()` so the main process can drive it via the `app:*` IPC
 * surface. Handles are keyed by a stable `AppHandleId` — see
 * `src/shared/app-control-types.ts`.
 *
 * This module does NOT store the `WebviewHandle` ref — main process owns
 * all webview driving via Electron APIs, not the renderer. Renderer only
 * tracks navigation metadata (url, title) for fast lookups and `list_apps`.
 */
import { atom } from 'nanostores';

import { emitter } from '@/renderer/services/ipc';
import type {
  AppHandleId,
  AppRegistrationPayload,
  LiveAppSnapshot,
} from '@/shared/app-control-types';
import { isControllableKind } from '@/shared/app-control-types';

const isElectron = typeof window !== 'undefined' && 'electron' in window;

/**
 * Live entries indexed by `handleId`. The shape matches what main keeps in
 * sync, so `list_apps` can be served locally without a main round-trip.
 */
export const $liveApps = atom<Record<AppHandleId, LiveAppSnapshot>>({});

function toSnapshot(payload: AppRegistrationPayload): LiveAppSnapshot {
  return {
    handleId: payload.handleId,
    appId: payload.appId,
    kind: payload.kind,
    scope: payload.scope,
    tabId: payload.tabId,
    label: payload.label,
    url: payload.url,
    title: payload.title,
    controllable: payload.controllable && isControllableKind(payload.kind),
  };
}

/**
 * Register a live app handle. Safe to call multiple times — updates replace
 * the previous entry. In browser/iframe mode the renderer still tracks local
 * state so `list_apps` keeps working; only the main-process driver is gated.
 */
export function registerApp(payload: AppRegistrationPayload): void {
  const snapshot = toSnapshot(payload);
  $liveApps.set({ ...$liveApps.get(), [payload.handleId]: snapshot });
  if (isElectron) {
    void emitter.invoke('app:register', payload);
  }
}

/** Apply a partial update — typically url/title/webContentsId after load. */
export function updateApp(handleId: AppHandleId, patch: Partial<AppRegistrationPayload>): void {
  const current = $liveApps.get()[handleId];
  if (!current) {
    return;
  }
  const merged: LiveAppSnapshot = {
    ...current,
    url: patch.url ?? current.url,
    title: patch.title ?? current.title,
    label: patch.label ?? current.label,
    controllable:
      patch.controllable !== undefined
        ? patch.controllable && isControllableKind(patch.kind ?? current.kind)
        : current.controllable,
  };
  $liveApps.set({ ...$liveApps.get(), [handleId]: merged });
  if (isElectron) {
    void emitter.invoke('app:update', handleId, patch);
  }
}

/** Remove a handle — typically called on `<Webview>` unmount. */
export function unregisterApp(handleId: AppHandleId): void {
  const next = { ...$liveApps.get() };
  delete next[handleId];
  $liveApps.set(next);
  if (isElectron) {
    void emitter.invoke('app:unregister', handleId);
  }
}

/**
 * Filter apps based on scope + tab context. Matches the rules used by the
 * client-tool handler: column-scoped callers see their own tab's apps, and
 * optionally the global dock.
 */
export function listLiveApps(filter: { tabId?: string; allowGlobal: boolean }): LiveAppSnapshot[] {
  const entries = Object.values($liveApps.get());
  return entries.filter((entry) => {
    if (entry.scope === 'global') {
      return filter.allowGlobal;
    }
    return entry.tabId === filter.tabId;
  });
}

/**
 * Resolve a user-facing `app_id` (e.g. "browser") to the best-matching live
 * `handleId` given the caller's scope. Prefers column scope over global.
 * Returns null when no match exists (agent passed a bad id or the app isn't
 * mounted right now).
 */
export function resolveAppHandle(
  appId: string,
  filter: { tabId?: string; allowGlobal: boolean }
): LiveAppSnapshot | null {
  const entries = Object.values($liveApps.get());
  if (filter.tabId) {
    const column = entries.find(
      (e) => e.scope === 'column' && e.tabId === filter.tabId && e.appId === appId
    );
    if (column) {
      return column;
    }
  }
  if (filter.allowGlobal) {
    const global = entries.find((e) => e.scope === 'global' && e.appId === appId);
    if (global) {
      return global;
    }
  }
  return null;
}
