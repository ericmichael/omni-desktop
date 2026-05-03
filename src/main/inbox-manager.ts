/**
 * InboxManager — GTD-style inbox lifecycle as pure, testable business logic.
 *
 * Owns inbox-item CRUD, status transitions (new → shaped, shape → defer,
 * defer → reactivate), and promotion to tickets/projects. Promotion leaves
 * a tombstone on the inbox item (`promotedTo`) rather than hard-deleting,
 * so the user can undo and the weekly review can show what shipped.
 *
 * This class deliberately depends on a narrow store-shape interface rather
 * than electron-store directly so it can be tested with an in-memory fake.
 * Wiring to the real store + IPC happens in project-manager.ts (step 5).
 */
import { sweepInbox } from '@/lib/inbox-expiry';
import { DEFAULT_PIPELINE, SIMPLE_PIPELINE } from '@/shared/pipeline-defaults';
import type {
  InboxItem,
  InboxItemId,
  InboxItemStatus,
  InboxShaping,
  MilestoneId,
  Pipeline,
  Project,
  ProjectId,
  ShapingData,
  Ticket,
  TicketId,
} from '@/shared/types';

/**
 * 30 days — how long a promoted tombstone sticks around before GC. Long
 * enough for a weekly review to still see it, short enough that the store
 * doesn't grow unbounded.
 */
export const PROMOTED_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Minimal store surface the InboxManager needs. Kept narrow so tests can
 * fake it with a plain object.
 */
export interface InboxManagerStore {
  getInboxItems(): InboxItem[];
  setInboxItems(items: InboxItem[]): void;
  getTickets(): Ticket[];
  setTickets(tickets: Ticket[]): void;
  getProjects(): Project[];
  setProjects(projects: Project[]): void;
  /**
   * Resolve the pipeline for a project. SQLite is the source of truth in
   * production, but tests may pass a fake that reads from the project
   * record directly.
   */
  getPipeline(projectId: ProjectId): Pipeline | null;
}

export interface InboxManagerDeps {
  store: InboxManagerStore;
  /** Mint a unique id. Injected for deterministic tests. */
  newId: () => string;
  /** Current wall-clock time. Injected for deterministic tests. */
  now: () => number;
}

export class InboxItemNotFoundError extends Error {
  constructor(id: InboxItemId) {
    super(`Inbox item ${id} not found`);
  }
}

export class InboxPromotionError extends Error {}

export class InboxManager {
  constructor(private readonly deps: InboxManagerDeps) {}

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /** All items, including promoted tombstones. */
  getAll(): InboxItem[] {
    return this.deps.store.getInboxItems();
  }

  /** Active view: excludes `later` and promoted items. */
  getActive(): InboxItem[] {
    return this.getAll().filter((i) => i.status !== 'later' && !i.promotedTo);
  }

  /** Deferred items only (hides promoted). */
  getLater(): InboxItem[] {
    return this.getAll().filter((i) => i.status === 'later' && !i.promotedTo);
  }

  /** Promoted tombstones. */
  getPromoted(): InboxItem[] {
    return this.getAll().filter((i) => !!i.promotedTo);
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  add(input: {
    title: string;
    note?: string;
    projectId?: ProjectId | null;
    attachments?: string[];
  }): InboxItem {
    const now = this.deps.now();
    const item: InboxItem = {
      id: this.deps.newId(),
      title: input.title.trim() || 'Untitled',
      status: 'new',
      projectId: input.projectId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    if (input.note && input.note.trim()) {
item.note = input.note.trim();
}
    if (input.attachments && input.attachments.length > 0) {
item.attachments = input.attachments;
}

    const items = [...this.deps.store.getInboxItems(), item];
    this.deps.store.setInboxItems(items);
    return item;
  }

  update(
    id: InboxItemId,
    patch: Partial<Pick<InboxItem, 'title' | 'note' | 'projectId' | 'attachments'>>
  ): void {
    this.patchItem(id, (item) => {
      const next: InboxItem = { ...item, updatedAt: this.deps.now() };
      if (patch.title !== undefined) {
next.title = patch.title.trim() || 'Untitled';
}
      if (patch.note !== undefined) {
next.note = patch.note.trim() || undefined;
}
      if (patch.projectId !== undefined) {
next.projectId = patch.projectId;
}
      if (patch.attachments !== undefined) {
next.attachments = patch.attachments;
}
      return next;
    });
  }

  remove(id: InboxItemId): void {
    const items = this.deps.store.getInboxItems();
    const filtered = items.filter((i) => i.id !== id);
    if (filtered.length === items.length) {
throw new InboxItemNotFoundError(id);
}
    this.deps.store.setInboxItems(filtered);
  }

  /**
   * Attach shaping. If the item is currently `later`, it stays later (the
   * user can shape a deferred item without auto-reactivating it). Otherwise
   * it flips to `shaped`.
   */
  shape(id: InboxItemId, shaping: InboxShaping): void {
    this.patchItem(id, (item) => {
      if (item.promotedTo) {
        throw new InboxPromotionError(`Cannot shape promoted inbox item ${id}`);
      }
      const next: InboxItem = {
        ...item,
        shaping: { ...shaping, outcome: shaping.outcome.trim() },
        updatedAt: this.deps.now(),
      };
      if (item.status !== 'later') {
next.status = 'shaped';
}
      return next;
    });
  }

  /** Move to `later`. No-op if already later. */
  defer(id: InboxItemId): void {
    this.patchItem(id, (item) => {
      if (item.promotedTo) {
throw new InboxPromotionError(`Cannot defer promoted item ${id}`);
}
      const now = this.deps.now();
      return { ...item, status: 'later', laterAt: now, updatedAt: now };
    });
  }

  /**
   * Move out of `later`. Returns to `shaped` if the item has shaping,
   * otherwise `new`. Clears `laterAt`.
   */
  reactivate(id: InboxItemId): void {
    this.patchItem(id, (item) => {
      if (item.promotedTo) {
throw new InboxPromotionError(`Cannot reactivate promoted item ${id}`);
}
      const nextStatus: InboxItemStatus = item.shaping ? 'shaped' : 'new';
      const next: InboxItem = { ...item, status: nextStatus, updatedAt: this.deps.now() };
      delete next.laterAt;
      return next;
    });
  }

  /**
   * Promote to a ticket. The inbox item is stamped with `promotedTo` rather
   * than deleted, so it remains visible in the tombstone/archive view.
   *
   * Requires: the target project exists. Seeds the ticket title/description/
   * shaping from the inbox item. columnId defaults to 'backlog' if unset,
   * or the first column in the project's pipeline if 'backlog' is absent.
   */
  promoteToTicket(
    id: InboxItemId,
    opts: { projectId: ProjectId; milestoneId?: MilestoneId; columnId?: string }
  ): Ticket {
    const item = this.requireItem(id);
    if (item.promotedTo) {
      throw new InboxPromotionError(`Inbox item ${id} is already promoted`);
    }

    const project = this.deps.store.getProjects().find((p) => p.id === opts.projectId);
    if (!project) {
      throw new InboxPromotionError(`Project ${opts.projectId} not found`);
    }

    const pipeline: Pipeline =
      this.deps.store.getPipeline(opts.projectId) ??
      project.pipeline ??
      (project.source ? DEFAULT_PIPELINE : SIMPLE_PIPELINE);
    const columnId =
      opts.columnId ??
      pipeline.columns.find((c) => c.id.endsWith('__backlog') || c.id === 'backlog')?.id ??
      pipeline.columns[0]?.id ??
      'backlog';

    const now = this.deps.now();
    const ticket: Ticket = {
      id: this.deps.newId(),
      projectId: opts.projectId,
      milestoneId: opts.milestoneId,
      title: item.title,
      description: item.note ?? '',
      priority: 'medium',
      blockedBy: [],
      createdAt: now,
      updatedAt: now,
      columnId,
    };
    if (item.shaping) {
      ticket.shaping = toTicketShaping(item.shaping);
    }

    this.deps.store.setTickets([...this.deps.store.getTickets(), ticket]);
    this.stampPromotion(id, { kind: 'ticket', id: ticket.id, at: now });
    return ticket;
  }

  /**
   * Promote to a new project. Seeds project label from input.label (falling
   * back to item.title). Uses slugged label for the folder name.
   */
  promoteToProject(id: InboxItemId, opts: { label: string }): Project {
    const item = this.requireItem(id);
    if (item.promotedTo) {
      throw new InboxPromotionError(`Inbox item ${id} is already promoted`);
    }

    const now = this.deps.now();
    const label = opts.label.trim() || item.title;
    const project: Project = {
      id: this.deps.newId(),
      label,
      slug: slugify(label),
      createdAt: now,
    };

    this.deps.store.setProjects([...this.deps.store.getProjects(), project]);
    this.stampPromotion(id, { kind: 'project', id: project.id, at: now });
    return project;
  }

  // ---------------------------------------------------------------------------
  // Sweeps
  // ---------------------------------------------------------------------------

  /** Flip expired `new` items to `later`. Returns number changed. */
  sweepExpired(): number {
    const items = this.deps.store.getInboxItems();
    const swept = sweepInbox(items, this.deps.now());
    let changed = 0;
    for (let i = 0; i < items.length; i++) {
      if (swept[i] !== items[i]) {
changed++;
}
    }
    if (changed > 0) {
this.deps.store.setInboxItems(swept);
}
    return changed;
  }

  /** Remove promoted tombstones older than `PROMOTED_TOMBSTONE_TTL_MS`. */
  gcPromoted(): number {
    const now = this.deps.now();
    const items = this.deps.store.getInboxItems();
    const kept = items.filter(
      (i) => !i.promotedTo || now - i.promotedTo.at < PROMOTED_TOMBSTONE_TTL_MS
    );
    const removed = items.length - kept.length;
    if (removed > 0) {
this.deps.store.setInboxItems(kept);
}
    return removed;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private requireItem(id: InboxItemId): InboxItem {
    const item = this.deps.store.getInboxItems().find((i) => i.id === id);
    if (!item) {
throw new InboxItemNotFoundError(id);
}
    return item;
  }

  private patchItem(id: InboxItemId, fn: (item: InboxItem) => InboxItem): void {
    const items = this.deps.store.getInboxItems();
    let found = false;
    const next = items.map((item) => {
      if (item.id !== id) {
return item;
}
      found = true;
      return fn(item);
    });
    if (!found) {
throw new InboxItemNotFoundError(id);
}
    this.deps.store.setInboxItems(next);
  }

  private stampPromotion(
    id: InboxItemId,
    promotion: NonNullable<InboxItem['promotedTo']>
  ): void {
    this.patchItem(id, (item) => ({ ...item, promotedTo: promotion, updatedAt: promotion.at }));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map `InboxShaping` → `ShapingData` for ticket creation. `xl` (which only
 * exists on the inbox side) collapses to `large` since tickets don't model
 * an extra-large appetite bucket.
 */
function toTicketShaping(shaping: InboxShaping): ShapingData {
  return {
    doneLooksLike: shaping.outcome,
    appetite: shaping.appetite === 'xl' ? 'large' : shaping.appetite,
    outOfScope: shaping.notDoing ?? '',
  };
}

/** Lowercase + kebab a label for use as a folder-safe slug. */
function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  );
}

/** Re-exported for code that needs the raw map without the class. */
export { toTicketShaping };

// Unused-in-module import guard: TicketId is re-exported via the Ticket type.
export type { TicketId };
