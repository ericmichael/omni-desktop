import type { FSWatcher } from 'fs';
import { watch } from 'fs';
import fs from 'fs/promises';
import path from 'path';

import {
  getArtifactsDir,
  getPlanDir,
  getPlanPath,
  parsePlanMd,
  serializePlanMd,
  updatePlanMdCheckboxes,
} from '@/lib/fleet-plan-file';
import { getOmniConfigDir } from '@/main/util';
import type { FleetChecklistItem, FleetPipeline, FleetTicket, FleetTicketId } from '@/shared/types';

type ParsedChecklist = Record<string, FleetChecklistItem[]>;

type PlanChangeEvent = {
  checklist: ParsedChecklist;
  /** Column label from frontmatter, if present. */
  column?: string;
};

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

  /** Write PLAN.md to disk, creating directories as needed.
   *  If the file already exists, performs an in-place checkbox update to preserve rich content. */
  async writePlan(ticket: FleetTicket, pipeline: FleetPipeline): Promise<void> {
    const dir = getPlanDir(this.configDir, ticket.id);
    const filePath = getPlanPath(this.configDir, ticket.id);

    // Set ignore flag before writing to prevent watcher feedback loop
    const entry = this.watchers.get(ticket.id);
    if (entry) {
      entry.ignoreNextChange = true;
    }

    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(getArtifactsDir(this.configDir, ticket.id), { recursive: true });

    // If the file already exists, update checkboxes in-place to preserve rich content
    let content: string;
    try {
      const existing = await fs.readFile(filePath, 'utf-8');
      content = updatePlanMdCheckboxes(existing, ticket, pipeline);
    } catch {
      // File doesn't exist yet — generate from scratch
      content = serializePlanMd(ticket, pipeline);
    }

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

  /** Read and parse PLAN.md, returning both checklist and column info. */
  async readPlanFull(ticketId: FleetTicketId, pipeline: FleetPipeline): Promise<PlanChangeEvent | null> {
    const filePath = getPlanPath(this.configDir, ticketId);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = parsePlanMd(content, pipeline);
      return { checklist: parsed.checklist, column: parsed.column };
    } catch {
      return null;
    }
  }

  /** Start watching a ticket's PLAN.md for external changes. */
  watchTicket(ticketId: FleetTicketId, onChange: (event: PlanChangeEvent) => void, pipeline: FleetPipeline): void {
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
          void this.readPlanFull(ticketId, pipeline).then((result) => {
            if (result) {
              onChange(result);
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
