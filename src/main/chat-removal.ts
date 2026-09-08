import type { ChatCommand } from '@/shared/chat-commands';
import type { CodeTab } from '@/shared/types';

/** One executor per authority instance. Persistence owns retry state, not a
 * renderer promise or a timer. Failures leave the original job untouched. */
export class ChatCleanupRunner {
  private pending = new Map<string, Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  private draining?: Promise<void>;
  constructor(
    private readonly deps: {
      read: () => Promise<CodeTab[]> | CodeTab[];
      cleanup: (tab: CodeTab) => Promise<void>;
      acknowledge: (id: string) => Promise<void> | void;
    }
  ) {}
  runOne(tab: CodeTab): Promise<void> {
    const existing = this.pending.get(tab.id);
    if (existing) {
      return existing;
    }
    const task = Promise.resolve()
      .then(async () => {
        await this.deps.cleanup(tab);
        await this.deps.acknowledge(tab.id);
      })
      .finally(() => this.pending.delete(tab.id));
    this.pending.set(tab.id, task);
    return task;
  }
  drain(): Promise<void> {
    if (this.draining) {
      return this.draining;
    }
    const task = this.drainOnce().finally(() => {
      this.draining = undefined;
    });
    this.draining = task;
    return task;
  }
  private async drainOnce(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const jobs = await this.deps.read();
    for (const job of jobs) {
      if (this.disposed) {
        return;
      }
      // A failed job must not starve unrelated tiles. Next sweep retries it.
      await this.runOne(job).catch(() => undefined);
    }
  }
  start(): void {
    if (this.timer || this.disposed) {
      return;
    }
    const sweep = () => {
      void this.drain().catch(() => undefined);
    };
    this.timer = setInterval(sweep, 5_000);
    this.timer.unref?.();
    sweep();
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.timer);
    await Promise.allSettled(this.pending.values());
  }
}

/** Run at the authoritative command boundary, before replying to a renderer.
 * A lost reply or closing window must not skip runtime/workspace cleanup. */
export async function completeChatRemoval(
  command: ChatCommand,
  result: unknown,
  cleanup: (tab: CodeTab) => Promise<void>
) {
  if ((command.method === 'removeTab' || command.method === 'archiveTab') && result) {
    await cleanup(result as CodeTab);
  }
}

export async function cleanupRemovedChat(
  tab: CodeTab,
  deps: {
    disposeTerminals?: (id: string) => Promise<void>;
    stop: (id: string) => Promise<unknown>;
    deleteSnapshot: (ref: string) => Promise<unknown>;
    isSnapshotProtected: (ref: string) => boolean;
  }
) {
  let terminalFailure: unknown;
  try {
    await deps.disposeTerminals?.(tab.id);
  } catch (error) {
    terminalFailure = error;
  }
  // Terminal failure must not leave an invisible runtime running. Conversely,
  // failed shutdown must not destroy a workspace the runtime still owns.
  await deps.stop(tab.id);
  if (tab.snapshotRef && !deps.isSnapshotProtected(tab.snapshotRef)) {
    await deps.deleteSnapshot(tab.snapshotRef);
  }
  if (terminalFailure) {
    throw terminalFailure;
  }
}
