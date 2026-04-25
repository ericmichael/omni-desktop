/**
 * Cross-process change detection for the shared SQLite database.
 *
 * Polls the `_change_seq` table to detect writes from the MCP server
 * (or any other process sharing the database). When the sequence number
 * advances beyond what the launcher last wrote, the `onExternalChange`
 * callback fires so the UI can be refreshed.
 *
 * Local writes call `noteLocalWrite()` to update the known sequence,
 * preventing self-notification.
 */
import type { ProjectsRepo } from 'omni-projects-db';

export class DbChangeWatcher {
  private lastSeq: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private repo: ProjectsRepo,
    private onExternalChange: () => void,
    private intervalMs = 1000
  ) {
    this.lastSeq = repo.getChangeSeq();
  }

  /** Start polling for external changes. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        const currentSeq = this.repo.getChangeSeq();
        if (currentSeq !== this.lastSeq) {
          this.lastSeq = currentSeq;
          this.onExternalChange();
        }
      } catch {
        // DB may be closed during shutdown — ignore
      }
    }, this.intervalMs);
  }

  /**
   * Called after local writes to update the known sequence number.
   * Prevents the next poll tick from treating our own write as external.
   */
  noteLocalWrite(): void {
    try {
      this.lastSeq = this.repo.getChangeSeq();
    } catch {
      // ignore
    }
  }

  /** Stop polling. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
