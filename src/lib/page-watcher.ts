import chokidar, { type FSWatcher } from 'chokidar';
import { readFile } from 'fs/promises';

export interface PageWatcherEvents {
  /** Fired when a watched file changes on disk and the new content differs from what we last knew. */
  onExternalChange(filePath: string, content: string): void;
  /** Fired when a watched file is deleted on disk. */
  onExternalDelete(filePath: string): void;
}

export interface PageWatcherOptions {
  /** Override chokidar factory for testing. */
  createWatcher?: () => FSWatcher;
  /** Override file reader for testing. */
  readFile?: (filePath: string) => Promise<string>;
  /** Emit structured debug logs for every subscribe/unsubscribe/echo/change/delete. */
  debug?: boolean;
}

/** Internal counters exposed for telemetry and tests. */
export interface PageWatcherStats {
  subscribes: number;
  unsubscribes: number;
  activeFiles: number;
  echoesSuppressed: number;
  externalChanges: number;
  externalDeletes: number;
}

/**
 * Watches page markdown files for external edits.
 *
 * Invariants:
 * - One underlying chokidar instance per manager (lazy-created).
 * - Ref-counted subscriptions: multiple callers can subscribe to the same path;
 *   the file is only actually unwatched when the last subscriber leaves.
 * - Echo suppression: before we write a file ourselves, we call `notePendingWrite`
 *   with the content we're about to write. When chokidar then fires a `change`
 *   event for that path, the content will match what we stored and the event
 *   is dropped — so we never see our own writes reflected back as "external".
 */
export class PageWatcherManager {
  private watcher: FSWatcher | null = null;
  private refCounts = new Map<string, number>();
  private lastContent = new Map<string, string>();
  private closed = false;
  private readonly events: PageWatcherEvents;
  private readonly createWatcher: () => FSWatcher;
  private readonly readFileImpl: (filePath: string) => Promise<string>;
  private readonly debug: boolean;
  private readonly stats: PageWatcherStats = {
    subscribes: 0,
    unsubscribes: 0,
    activeFiles: 0,
    echoesSuppressed: 0,
    externalChanges: 0,
    externalDeletes: 0,
  };

  constructor(events: PageWatcherEvents, options: PageWatcherOptions = {}) {
    this.events = events;
    this.createWatcher =
      options.createWatcher ??
      (() =>
        chokidar.watch([], {
          ignoreInitial: true,
          awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 30 },
          persistent: true,
        }));
    this.readFileImpl = options.readFile ?? ((p) => readFile(p, 'utf-8'));
    this.debug = options.debug ?? false;
  }

  /** Snapshot of internal counters — safe to read at any time. */
  getStats(): Readonly<PageWatcherStats> {
    return { ...this.stats, activeFiles: this.refCounts.size };
  }

  private log(event: string, fields: Record<string, unknown> = {}): void {
    if (!this.debug) {
return;
}
    const parts = Object.entries(fields).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
    console.log(`[PageWatcher] ${event}${parts.length ? ` ${  parts.join(' ')}` : ''}`);
  }

  private ensureWatcher(): FSWatcher {
    if (!this.watcher) {
      const w = this.createWatcher();
      w.on('change', (p: string) => {
        void this.handleChange(p);
      });
      w.on('add', (p: string) => {
        void this.handleChange(p);
      });
      w.on('unlink', (p: string) => {
        this.handleUnlink(p);
      });
      w.on('error', (err: unknown) => {
        console.warn('[PageWatcher] chokidar error:', err);
      });
      this.watcher = w;
    }
    return this.watcher;
  }

  /** Subscribe to a file. Idempotent + ref-counted. */
  async subscribe(filePath: string): Promise<void> {
    if (this.closed) {
return;
}
    const count = this.refCounts.get(filePath) ?? 0;
    this.refCounts.set(filePath, count + 1);
    this.stats.subscribes++;
    if (count === 0) {
      this.ensureWatcher().add(filePath);
      // Seed with current disk content so the first legitimate external change
      // is compared against reality, not an empty string.
      try {
        const content = await this.readFileImpl(filePath);
        this.lastContent.set(filePath, content);
      } catch {
        this.lastContent.set(filePath, '');
      }
      this.log('subscribe', { filePath, refs: 1, activeFiles: this.refCounts.size });
    } else {
      this.log('subscribe-reused', { filePath, refs: count + 1 });
    }
  }

  /** Unsubscribe. When the last subscriber leaves, the file is actually unwatched. */
  unsubscribe(filePath: string): void {
    const count = this.refCounts.get(filePath) ?? 0;
    if (count === 0) {
return;
}
    this.stats.unsubscribes++;
    if (count <= 1) {
      this.refCounts.delete(filePath);
      this.lastContent.delete(filePath);
      this.watcher?.unwatch(filePath);
      this.log('unsubscribe', { filePath, refs: 0, activeFiles: this.refCounts.size });
    } else {
      this.refCounts.set(filePath, count - 1);
      this.log('unsubscribe-dec', { filePath, refs: count - 1 });
    }
  }

  /**
   * Record a pending write. MUST be called BEFORE fs.writeFile so the resulting
   * chokidar event compares equal and is dropped as an echo.
   */
  notePendingWrite(filePath: string, content: string): void {
    if (this.refCounts.has(filePath)) {
      this.lastContent.set(filePath, content);
    }
  }

  private async handleChange(filePath: string): Promise<void> {
    if (!this.refCounts.has(filePath)) {
return;
}
    let content: string;
    try {
      content = await this.readFileImpl(filePath);
    } catch {
      return;
    }
    if (this.lastContent.get(filePath) === content) {
      this.stats.echoesSuppressed++;
      this.log('echo-suppressed', { filePath, bytes: content.length });
      return;
    }
    this.lastContent.set(filePath, content);
    this.stats.externalChanges++;
    this.log('external-change', { filePath, bytes: content.length });
    this.events.onExternalChange(filePath, content);
  }

  private handleUnlink(filePath: string): void {
    if (!this.refCounts.has(filePath)) {
return;
}
    this.lastContent.set(filePath, '');
    this.stats.externalDeletes++;
    this.log('external-delete', { filePath });
    this.events.onExternalDelete(filePath);
  }

  async dispose(): Promise<void> {
    this.closed = true;
    this.refCounts.clear();
    this.lastContent.clear();
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
