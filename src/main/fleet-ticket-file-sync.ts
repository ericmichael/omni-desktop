import fsSync from 'fs';
import fs from 'fs/promises';

import { getTicketDir, getTicketFilePath, parseTicketYaml, serializeTicketYaml } from '@/lib/fleet-plan-file';
import type { FleetPipeline, FleetTicket, FleetTicketId } from '@/shared/types';

type TicketFileSyncCallbacks = {
  onColumnChange: (ticketId: FleetTicketId, columnId: string) => void;
  onEscalation: (ticketId: FleetTicketId, message: string) => void;
};

type WatchedTicket = {
  ticketId: FleetTicketId;
  filePath: string;
  watcher: ReturnType<typeof import('fs').watch> | null;
  /** Ignore the next N file change events (caused by our own writes). */
  pendingIgnores: number;
  /** Track last seen escalation to avoid duplicate notifications. */
  lastEscalation: string | null;
};

/**
 * Writes TICKET.yaml files and watches for agent-initiated column changes and escalations.
 */
export class FleetTicketFileSync {
  private configDir: string;
  private callbacks: TicketFileSyncCallbacks;
  private watched = new Map<FleetTicketId, WatchedTicket>();

  constructor(configDir: string, callbacks: TicketFileSyncCallbacks) {
    this.configDir = configDir;
    this.callbacks = callbacks;
  }

  /**
   * Write TICKET.yaml for a ticket and start watching for changes.
   */
  async writeAndWatch(ticket: FleetTicket, pipeline: FleetPipeline): Promise<void> {
    const filePath = getTicketFilePath(this.configDir, ticket.id);
    const dir = getTicketDir(this.configDir, ticket.id);

    await fs.mkdir(dir, { recursive: true });

    const content = serializeTicketYaml(ticket, pipeline);
    await fs.writeFile(filePath, content, 'utf-8');

    if (!this.watched.has(ticket.id)) {
      // Start watching with an initial ignore to skip the fs.watch event
      // triggered by the file we just wrote
      this.startWatching(ticket.id, filePath, pipeline, { initialIgnores: 1 });
    } else {
      this.watched.get(ticket.id)!.pendingIgnores++;
    }
  }

  /**
   * Update TICKET.yaml when the column changes (from UI or orchestrator).
   */
  async updateColumn(ticket: FleetTicket, pipeline: FleetPipeline): Promise<void> {
    const filePath = getTicketFilePath(this.configDir, ticket.id);
    const dir = getTicketDir(this.configDir, ticket.id);
    const content = serializeTicketYaml(ticket, pipeline);
    const existing = this.watched.get(ticket.id);
    if (existing) {
      existing.pendingIgnores++;
      existing.lastEscalation = null;
    }
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
  }

  /**
   * Stop watching a ticket's file.
   */
  stopWatching(ticketId: FleetTicketId): void {
    const entry = this.watched.get(ticketId);
    if (entry?.watcher) {
      entry.watcher.close();
    }
    this.watched.delete(ticketId);
  }

  /**
   * Stop all watchers.
   */
  dispose(): void {
    for (const [, entry] of this.watched) {
      entry.watcher?.close();
    }
    this.watched.clear();
  }

  private startWatching(
    ticketId: FleetTicketId,
    filePath: string,
    pipeline: FleetPipeline,
    opts?: { initialIgnores?: number }
  ): void {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const entry: WatchedTicket = {
      ticketId,
      filePath,
      watcher: null,
      pendingIgnores: opts?.initialIgnores ?? 0,
      lastEscalation: null,
    };

    try {
      entry.watcher = fsSync.watch(filePath, () => {
        // Debounce rapid changes (editors often write multiple times)
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          void this.handleFileChange(ticketId, filePath, pipeline);
        }, 300);
      });
    } catch {
      // File might not exist yet — that's fine
    }

    this.watched.set(ticketId, entry);
  }

  /** Exposed for testing — called when fs.watch detects a change. */
  async handleFileChange(
    ticketId: FleetTicketId,
    filePath: string,
    pipeline: FleetPipeline
  ): Promise<void> {
    const entry = this.watched.get(ticketId);
    if (!entry) return;

    // Skip if this was our own write
    if (entry.pendingIgnores > 0) {
      entry.pendingIgnores--;
      return;
    }

    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      return;
    }

    const parsed = parseTicketYaml(content);

    // Handle column change
    if (parsed.column) {
      const column = pipeline.columns.find(
        (c) => c.label.toLowerCase() === parsed.column!.toLowerCase()
      );
      if (column) {
        this.callbacks.onColumnChange(ticketId, column.id);
      } else {
        console.warn(
          `[FleetTicketFileSync] Unknown column label "${parsed.column}" in TICKET.yaml for ${ticketId}`
        );
      }
    }

    // Handle escalation (only fire if it's new)
    if (parsed.escalation && parsed.escalation !== entry.lastEscalation) {
      entry.lastEscalation = parsed.escalation;
      this.callbacks.onEscalation(ticketId, parsed.escalation);
    }
  }
}
