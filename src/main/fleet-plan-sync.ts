import type { FSWatcher } from 'fs';
import { watch } from 'fs';
import fs from 'fs/promises';
import path from 'path';

import { getPlanDir, getPlanPath, parsePlanMd, serializePlanMd } from '@/lib/fleet-plan-file';
import { getOmniConfigDir } from '@/main/util';
import type { FleetChecklistItem, FleetPipeline, FleetTicket, FleetTicketId } from '@/shared/types';

type ParsedChecklist = Record<string, FleetChecklistItem[]>;

type WatcherEntry = {
  watcher: FSWatcher;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  ignoreNextChange: boolean;
};

const DEBOUNCE_MS = 500;

export class FleetPlanSync {
  private watchers = new Map<FleetTicketId, WatcherEntry>();
  private configDir: string;

  constructor() {
    this.configDir = getOmniConfigDir();
  }

  /** Write PLAN.md to disk, creating directories as needed. */
  async writePlan(ticket: FleetTicket, pipeline: FleetPipeline): Promise<void> {
    const dir = getPlanDir(this.configDir, ticket.id);
    const filePath = getPlanPath(this.configDir, ticket.id);
    const content = serializePlanMd(ticket, pipeline);

    // Set ignore flag before writing to prevent watcher feedback loop
    const entry = this.watchers.get(ticket.id);
    if (entry) {
      entry.ignoreNextChange = true;
    }

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
  }

  /** Read and parse PLAN.md from disk. Returns null if the file doesn't exist. */
  async readPlan(ticketId: FleetTicketId, pipeline: FleetPipeline): Promise<ParsedChecklist | null> {
    const filePath = getPlanPath(this.configDir, ticketId);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = parsePlanMd(content, pipeline);
      return parsed.checklist;
    } catch {
      return null;
    }
  }

  /** Start watching a ticket's PLAN.md for external changes. */
  watchTicket(ticketId: FleetTicketId, onChange: (checklist: ParsedChecklist) => void, pipeline: FleetPipeline): void {
    // Don't double-watch
    if (this.watchers.has(ticketId)) {
      return;
    }

    const filePath = getPlanPath(this.configDir, ticketId);
    const dir = path.dirname(filePath);

    // Ensure directory exists before watching
    fs.mkdir(dir, { recursive: true }).then(() => {
      let watcher: FSWatcher;
      try {
        watcher = watch(filePath, { persistent: false });
      } catch {
        // File may not exist yet — watch the directory instead for file creation
        try {
          watcher = watch(dir, { persistent: false });
        } catch {
          return; // Can't watch at all
        }
      }

      const entry: WatcherEntry = {
        watcher,
        debounceTimer: null,
        ignoreNextChange: false,
      };

      watcher.on('change', () => {
        // Skip if this change was triggered by our own write
        if (entry.ignoreNextChange) {
          entry.ignoreNextChange = false;
          return;
        }

        // Debounce rapid changes
        if (entry.debounceTimer) {
          clearTimeout(entry.debounceTimer);
        }

        entry.debounceTimer = setTimeout(() => {
          entry.debounceTimer = null;
          void this.readPlan(ticketId, pipeline).then((checklist) => {
            if (checklist) {
              onChange(checklist);
            }
          });
        }, DEBOUNCE_MS);
      });

      watcher.on('error', () => {
        // Silently ignore watch errors — file may have been deleted
      });

      this.watchers.set(ticketId, entry);
    });
  }

  /** Stop watching a ticket's PLAN.md. */
  unwatchTicket(ticketId: FleetTicketId): void {
    const entry = this.watchers.get(ticketId);
    if (!entry) {
      return;
    }

    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
    }
    entry.watcher.close();
    this.watchers.delete(ticketId);
  }

  /** Remove PLAN.md directory for a ticket. */
  async removePlan(ticketId: FleetTicketId): Promise<void> {
    this.unwatchTicket(ticketId);
    const dir = getPlanDir(this.configDir, ticketId);
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // Ignore — directory may not exist
    }
  }

  /** Clean up all watchers. */
  dispose(): void {
    for (const [ticketId] of this.watchers) {
      this.unwatchTicket(ticketId);
    }
  }
}
