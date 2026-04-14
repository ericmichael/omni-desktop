import { mkdir,mkdtemp, rm, unlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PageWatcherManager } from '@/lib/page-watcher';

/**
 * Collect events emitted by a PageWatcherManager and expose promises
 * that resolve on the next event of each kind.
 */
function createCollector() {
  const changes: Array<{ filePath: string; content: string }> = [];
  const deletes: string[] = [];
  const changeWaiters: Array<() => void> = [];
  const deleteWaiters: Array<() => void> = [];

  return {
    changes,
    deletes,
    events: {
      onExternalChange(filePath: string, content: string) {
        changes.push({ filePath, content });
        changeWaiters.splice(0).forEach((fn) => fn());
      },
      onExternalDelete(filePath: string) {
        deletes.push(filePath);
        deleteWaiters.splice(0).forEach((fn) => fn());
      },
    },
    waitForChange(timeoutMs = 2000): Promise<void> {
      return new Promise((resolve, reject) => {
        const startCount = changes.length;
        const timer = setTimeout(() => reject(new Error('timeout waiting for change')), timeoutMs);
        const check = () => {
          if (changes.length > startCount) {
            clearTimeout(timer);
            resolve();
          } else {
            changeWaiters.push(check);
          }
        };
        check();
      });
    },
    waitForDelete(timeoutMs = 2000): Promise<void> {
      return new Promise((resolve, reject) => {
        const startCount = deletes.length;
        const timer = setTimeout(() => reject(new Error('timeout waiting for delete')), timeoutMs);
        const check = () => {
          if (deletes.length > startCount) {
            clearTimeout(timer);
            resolve();
          } else {
            deleteWaiters.push(check);
          }
        };
        check();
      });
    },
    /** Resolve after `ms` of no change events — used to assert echo suppression. */
    expectNoChangeFor(ms: number): Promise<void> {
      const startCount = changes.length;
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          if (changes.length === startCount) {
resolve();
} else {
reject(new Error(`expected no change events, got ${changes.length - startCount}`));
}
        }, ms);
      });
    },
  };
}

describe('PageWatcherManager', () => {
  let dir: string;
  let manager: PageWatcherManager | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'page-watcher-test-'));
  });

  afterEach(async () => {
    if (manager) {
      await manager.dispose();
      manager = null;
    }
    await rm(dir, { recursive: true, force: true });
  });

  it('emits onExternalChange when a watched file is modified externally', async () => {
    const file = path.join(dir, 'context.md');
    await writeFile(file, 'initial', 'utf-8');

    const collector = createCollector();
    manager = new PageWatcherManager(collector.events);
    await manager.subscribe(file);

    await writeFile(file, 'updated from outside', 'utf-8');
    await collector.waitForChange();

    expect(collector.changes).toHaveLength(1);
    expect(collector.changes[0]!.filePath).toBe(file);
    expect(collector.changes[0]!.content).toBe('updated from outside');
  });

  it('suppresses echo events after notePendingWrite', async () => {
    const file = path.join(dir, 'context.md');
    await writeFile(file, 'initial', 'utf-8');

    const collector = createCollector();
    manager = new PageWatcherManager(collector.events);
    await manager.subscribe(file);

    manager.notePendingWrite(file, 'our own write');
    await writeFile(file, 'our own write', 'utf-8');

    // awaitWriteFinish stabilityThreshold is 150ms; wait longer than that.
    await collector.expectNoChangeFor(400);
    expect(collector.changes).toHaveLength(0);
  });

  it('still fires on subsequent external change after our own write', async () => {
    const file = path.join(dir, 'context.md');
    await writeFile(file, 'initial', 'utf-8');

    const collector = createCollector();
    manager = new PageWatcherManager(collector.events);
    await manager.subscribe(file);

    // Our write
    manager.notePendingWrite(file, 'ours');
    await writeFile(file, 'ours', 'utf-8');
    await collector.expectNoChangeFor(250);

    // External write
    await writeFile(file, 'theirs', 'utf-8');
    await collector.waitForChange();
    expect(collector.changes.map((c) => c.content)).toEqual(['theirs']);
  });

  it('ref-counts subscriptions', async () => {
    const file = path.join(dir, 'context.md');
    await writeFile(file, 'initial', 'utf-8');

    const collector = createCollector();
    manager = new PageWatcherManager(collector.events);

    await manager.subscribe(file);
    await manager.subscribe(file);
    manager.unsubscribe(file); // still one subscriber left

    await writeFile(file, 'v2', 'utf-8');
    await collector.waitForChange();
    expect(collector.changes).toHaveLength(1);

    manager.unsubscribe(file); // zero subscribers; watcher stops tracking this file

    await writeFile(file, 'v3', 'utf-8');
    await collector.expectNoChangeFor(400);
    expect(collector.changes).toHaveLength(1);
  });

  it('emits onExternalDelete when a watched file is unlinked', async () => {
    const file = path.join(dir, 'context.md');
    await writeFile(file, 'initial', 'utf-8');

    const collector = createCollector();
    manager = new PageWatcherManager(collector.events);
    await manager.subscribe(file);

    await unlink(file);
    await collector.waitForDelete();

    expect(collector.deletes).toEqual([file]);
  });

  it('handles atomic save (write to temp + rename) as a single change event', async () => {
    const file = path.join(dir, 'context.md');
    await writeFile(file, 'initial', 'utf-8');

    const collector = createCollector();
    manager = new PageWatcherManager(collector.events);
    await manager.subscribe(file);

    // Simulate an editor doing rapid multi-step writes.
    await writeFile(file, 'step 1', 'utf-8');
    await writeFile(file, 'step 2', 'utf-8');
    await writeFile(file, 'final', 'utf-8');

    await collector.waitForChange();
    // awaitWriteFinish should have collapsed these into one event.
    // Wait a bit more to confirm no trailing events.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(collector.changes).toHaveLength(1);
    expect(collector.changes[0]!.content).toBe('final');
  });

  it('unsubscribe below zero is a no-op (safe to call from removePage even when renderer never subscribed)', async () => {
    const file = path.join(dir, 'context.md');
    await writeFile(file, 'initial', 'utf-8');

    const collector = createCollector();
    manager = new PageWatcherManager(collector.events);

    // No subscribe — unsubscribe should not throw or go negative.
    expect(() => manager!.unsubscribe(file)).not.toThrow();
    expect(manager.getStats().unsubscribes).toBe(0);

    // After a real subscribe/unsubscribe pair, a second unsubscribe is still a no-op.
    await manager.subscribe(file);
    manager.unsubscribe(file);
    manager.unsubscribe(file);
    expect(manager.getStats().unsubscribes).toBe(1);
  });

  it('tracks stats for subscribe, unsubscribe, external change, and echo suppression', async () => {
    const file = path.join(dir, 'context.md');
    await writeFile(file, 'initial', 'utf-8');

    const collector = createCollector();
    manager = new PageWatcherManager(collector.events);

    await manager.subscribe(file);
    expect(manager.getStats()).toMatchObject({ subscribes: 1, activeFiles: 1 });

    // Echo: our own write
    manager.notePendingWrite(file, 'ours');
    await writeFile(file, 'ours', 'utf-8');
    await collector.expectNoChangeFor(250);
    expect(manager.getStats().echoesSuppressed).toBeGreaterThanOrEqual(1);
    expect(manager.getStats().externalChanges).toBe(0);

    // External write
    await writeFile(file, 'theirs', 'utf-8');
    await collector.waitForChange();
    expect(manager.getStats().externalChanges).toBe(1);

    manager.unsubscribe(file);
    expect(manager.getStats()).toMatchObject({ unsubscribes: 1, activeFiles: 0 });
  });

  it('survives subscribe for a file in a nested directory', async () => {
    const pagesDir = path.join(dir, 'pages');
    await mkdir(pagesDir, { recursive: true });
    const file = path.join(pagesDir, 'abc.md');
    await writeFile(file, 'initial', 'utf-8');

    const collector = createCollector();
    manager = new PageWatcherManager(collector.events);
    await manager.subscribe(file);

    await writeFile(file, 'changed', 'utf-8');
    await collector.waitForChange();
    expect(collector.changes[0]!.content).toBe('changed');
  });
});
