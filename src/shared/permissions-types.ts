/**
 * Shared types for the in-app permissions prompt. Split out from
 * `main/permissions-manager.ts` so the renderer can reference them without
 * crossing the main/renderer import boundary.
 */

export type PermissionName =
  | 'notifications'
  | 'media'
  | 'mediaKeySystem'
  | 'geolocation'
  | 'midi'
  | 'midiSysex'
  | 'pointerLock'
  | 'fullscreen'
  | 'openExternal'
  | 'unknown'
  | 'clipboard-read'
  | 'clipboard-sanitized-write'
  | 'display-capture'
  | 'window-management'
  | 'top-level-storage-access'
  | 'idle-detection'
  | 'bluetooth'
  | 'hid'
  | 'serial'
  | 'usb';

export type PermissionRequest = {
  id: string;
  permission: PermissionName;
  origin: string;
  /** Partition the request came from (for future per-profile policies). */
  partition?: string;
  requestedAt: number;
};
