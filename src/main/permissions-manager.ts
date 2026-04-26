/**
 * PermissionsManager — routes Chromium permission requests (notifications,
 * camera, mic, geolocation, …) to an in-app prompt instead of silently
 * denying. Each pending request is held until the renderer sends a decision,
 * at which point we call the stored Electron callback.
 *
 * The manager watches sessions (default + every browser partition the
 * renderer registers) and attaches a single handler per session.
 */
import { session as sessionNS } from 'electron';
import type { Session } from 'electron';

import type { IIpcListener } from '@/shared/ipc-listener';
import type { PermissionName, PermissionRequest } from '@/shared/permissions-types';
import type { IpcRendererEvents } from '@/shared/types';

export type { PermissionName, PermissionRequest };

type Pending = {
  request: PermissionRequest;
  decide: (allow: boolean) => void;
};

type SendToWindow = <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;

let nextId = 1;

export class PermissionsManager {
  private readonly watched = new WeakSet<Session>();
  private readonly pending = new Map<string, Pending>();
  private readonly broadcast: (list: PermissionRequest[]) => void;

  constructor(broadcast: (list: PermissionRequest[]) => void) {
    this.broadcast = broadcast;
  }

  watchSession(session: Session, partition?: string): void {
    if (this.watched.has(session)) {
return;
}
    this.watched.add(session);
    session.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const id = `perm-${nextId++}`;
      const origin = (() => {
        try {
          return new URL(details.requestingUrl ?? webContents.getURL()).origin;
        } catch {
          return details.requestingUrl ?? webContents.getURL() ?? '<unknown>';
        }
      })();
      const request: PermissionRequest = {
        id,
        permission: permission as PermissionName,
        origin,
        requestedAt: Date.now(),
        ...(partition ? { partition } : {}),
      };
      this.pending.set(id, {
        request,
        decide: (allow) => {
          try {
            callback(allow);
          } catch {
            // Chromium may have already closed the requester — swallow.
          }
        },
      });
      this.broadcast(this.list());
    });
  }

  list(): PermissionRequest[] {
    return Array.from(this.pending.values()).map((p) => p.request);
  }

  decide(id: string, allow: boolean): void {
    const p = this.pending.get(id);
    if (!p) {
return;
}
    p.decide(allow);
    this.pending.delete(id);
    this.broadcast(this.list());
  }
}

export function createPermissionsManager(options: {
  ipc: IIpcListener;
  sendToWindow: SendToWindow;
}): [PermissionsManager, () => void] {
  const { ipc, sendToWindow } = options;
  const emit = (list: PermissionRequest[]) => sendToWindow('browser:permissions-changed', list);
  const manager = new PermissionsManager(emit);

  // NOTE: we deliberately do NOT install a handler on the default session.
  // The default session is used by the host BrowserWindow and by any webview
  // without a `partition` attribute (VS Code, VNC, custom apps, the main
  // React app itself). Intercepting those would stall any permission request
  // from the shell — notifications, clipboard, fullscreen, display-capture —
  // because only browser surfaces render the PermissionsBar UI. We only
  // intercept browser partitions, which renderers register explicitly via
  // `browser:permissions-watch-partition`.

  ipc.handle('browser:permissions-list', () => manager.list());
  ipc.handle('browser:permissions-decide', (_: unknown, id: string, allow: boolean) =>
    manager.decide(id, allow)
  );
  ipc.handle('browser:permissions-watch-partition', (_: unknown, partition: string) => {
    if (!partition) {
return;
}
    try {
      const s = sessionNS.fromPartition(partition);
      manager.watchSession(s, partition);
    } catch {
      // bad partition — ignore.
    }
  });

  queueMicrotask(() => emit(manager.list()));

  return [manager, () => { /* nothing to release — handlers live on Session */ }];
}
