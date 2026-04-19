/**
 * DownloadsManager — tracks in-progress and completed downloads across every
 * browser partition the app registers. Backed by Electron's
 * `session.on('will-download')` hook; emits a snapshot on every state
 * transition so the renderer's downloads tray can stay in sync without
 * polling.
 *
 * Scope: the manager watches every `Session` we ever see, so agent-driven
 * browsers, dock browsers, and standalone browser columns all share the same
 * tray. Items are identified by a short id the manager mints — Electron's
 * `DownloadItem.getSavePath()` isn't stable during the download and we want
 * renderer references that survive IPC serialization.
 *
 * Nothing is persisted to the store: the list lives in-memory and resets
 * each app start, like Chrome's "today" chip in chrome://downloads.
 */
import type { Session } from 'electron';
import { app, session as sessionNS, shell } from 'electron';

import type { IIpcListener } from '@/shared/ipc-listener';
import type { IpcRendererEvents } from '@/shared/types';

export type DownloadState = 'progressing' | 'interrupted' | 'paused' | 'completed' | 'cancelled';

export type DownloadEntry = {
  id: string;
  url: string;
  filename: string;
  savePath?: string;
  mimeType?: string;
  totalBytes: number;
  receivedBytes: number;
  state: DownloadState;
  startedAt: number;
  endedAt?: number;
  /** Partition the download originated in (for future filtering). */
  partition?: string;
};

type SendToWindow = <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;

let nextId = 1;

export class DownloadsManager {
  private readonly entries: DownloadEntry[] = [];
  private readonly watched = new WeakSet<Session>();
  private readonly onChange: () => void;

  constructor(onChange: () => void) {
    this.onChange = onChange;
  }

  /**
   * Attach the `will-download` listener to a session. Idempotent — tracked via
   * WeakSet so repeated calls (e.g. from multiple `<webview partition="...">`
   * mounts on the same profile) don't stack listeners.
   */
  watchSession(session: Session, partition?: string): void {
    if (this.watched.has(session)) {
return;
}
    this.watched.add(session);
    session.on('will-download', (_event, item) => {
      const id = `dl-${nextId++}`;
      const entry: DownloadEntry = {
        id,
        url: item.getURL(),
        filename: item.getFilename(),
        mimeType: item.getMimeType(),
        totalBytes: item.getTotalBytes(),
        receivedBytes: item.getReceivedBytes(),
        state: 'progressing',
        startedAt: Date.now(),
        ...(partition ? { partition } : {}),
      };
      this.entries.unshift(entry);
      this.onChange();

      item.on('updated', (_e, state) => {
        entry.receivedBytes = item.getReceivedBytes();
        entry.totalBytes = item.getTotalBytes();
        entry.state = state === 'interrupted' ? 'interrupted' : 'progressing';
        if (state === 'progressing' && item.isPaused()) {
          entry.state = 'paused';
        }
        this.onChange();
      });
      item.on('done', (_e, state) => {
        entry.state = state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted';
        entry.endedAt = Date.now();
        entry.receivedBytes = item.getReceivedBytes();
        entry.savePath = item.getSavePath();
        this.onChange();
      });
    });
  }

  list(): DownloadEntry[] {
    return [...this.entries];
  }

  clearCompleted(): number {
    const before = this.entries.length;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (e.state === 'completed' || e.state === 'cancelled' || e.state === 'interrupted') {
        this.entries.splice(i, 1);
      }
    }
    this.onChange();
    return before - this.entries.length;
  }

  remove(id: string): void {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx >= 0) {
      this.entries.splice(idx, 1);
      this.onChange();
    }
  }
}

export interface CreateDownloadsManagerOptions {
  ipc: IIpcListener;
  sendToWindow: SendToWindow;
}

export function createDownloadsManager(
  options: CreateDownloadsManagerOptions
): [DownloadsManager, () => void] {
  const { ipc, sendToWindow } = options;
  const broadcast = () => sendToWindow('browser:downloads-changed', manager.list());
  const manager = new DownloadsManager(broadcast);

  // Watch the default session + every partition we know about. `fromPartition`
  // creates the session lazily; we call it for every known browser profile
  // and also again whenever the renderer asks for state (cheap).
  const watchAll = () => {
    if (!app.isReady()) {
return;
}
    try {
      manager.watchSession(sessionNS.defaultSession);
    } catch {
      /* session not yet constructed — safe to skip */
    }
  };
  if (app.isReady()) {
watchAll();
} else {
app.once('ready', watchAll);
}

  ipc.handle('browser:downloads-list', () => manager.list());
  ipc.handle('browser:downloads-clear', () => manager.clearCompleted());
  ipc.handle('browser:downloads-remove', (_: unknown, id: string) => manager.remove(id));
  ipc.handle('browser:downloads-open-file', (_: unknown, id: string) => {
    const entry = manager.list().find((e) => e.id === id);
    if (!entry?.savePath) {
throw new Error('Download has no path yet');
}
    return shell.openPath(entry.savePath);
  });
  ipc.handle('browser:downloads-show-in-folder', (_: unknown, id: string) => {
    const entry = manager.list().find((e) => e.id === id);
    if (!entry?.savePath) {
throw new Error('Download has no path yet');
}
    shell.showItemInFolder(entry.savePath);
  });
  /**
   * Renderer signals "I just opened a webview with this partition" — use it
   * to subscribe the session lazily. Profiles only become real `Session`s
   * once something mounts them.
   */
  ipc.handle('browser:downloads-watch-partition', (_: unknown, partition: string) => {
    if (!partition) {
return;
}
    try {
      const s = sessionNS.fromPartition(partition);
      manager.watchSession(s, partition);
    } catch {
      // partition name invalid — swallow.
    }
  });

  // Seed broadcast so renderers get [] on startup.
  queueMicrotask(broadcast);

  const cleanup = () => {
    // Listeners are attached to long-lived sessions; Electron tears those
    // down on app exit. Nothing further required.
  };
  return [manager, cleanup];
}
