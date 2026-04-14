/**
 * MilestoneManager — milestone lifecycle as pure, testable business logic.
 *
 * Extracted from `ProjectManager` (Sprint B of the project-manager decomposition).
 * Mirrors the narrow-store-adapter pattern established by `InboxManager` and
 * `PageManager` so tests can drop in an in-memory fake without bringing up
 * electron-store.
 *
 * Owns:
 *   - The `milestones` store slice (get/add/update/remove)
 *   - `completedAt` stamping on status transitions into/out of `completed`
 *   - Orphan-ticket clearing when a milestone is removed
 *   - `resolveTicketBranch` fallback from ticket → milestone
 *   - Project-cascade deletion helper
 *
 * Does NOT own:
 *   - Ticket CRUD (ProjectManager)
 *   - Project CRUD (ProjectManager)
 */
import type { Milestone, MilestoneId, ProjectId, Ticket } from '@/shared/types';

/**
 * Minimal store surface the MilestoneManager needs. Kept narrow so tests can
 * fake it with a plain object.
 */
export interface MilestoneManagerStore {
  getMilestones(): Milestone[];
  setMilestones(items: Milestone[]): void;
  getTickets(): Ticket[];
  setTickets(tickets: Ticket[]): void;
}

interface MilestoneManagerDeps {
  store: MilestoneManagerStore;
  /** Mint a unique id. Injected for deterministic tests. */
  newId: () => string;
  /** Current wall-clock time. Injected for deterministic tests. */
  now: () => number;
}

export class MilestoneManager {
  constructor(private readonly deps: MilestoneManagerDeps) {}

  getAll(): Milestone[] {
    return this.deps.store.getMilestones();
  }

  getByProject(projectId: ProjectId): Milestone[] {
    return this.getAll().filter((i) => i.projectId === projectId);
  }

  getById(id: MilestoneId): Milestone | undefined {
    return this.getAll().find((i) => i.id === id);
  }

  add(input: Omit<Milestone, 'id' | 'createdAt' | 'updatedAt'>): Milestone {
    const now = this.deps.now();
    const milestone: Milestone = { ...input, id: this.deps.newId(), createdAt: now, updatedAt: now };
    const milestones = this.getAll();
    milestones.push(milestone);
    this.deps.store.setMilestones(milestones);
    return milestone;
  }

  update(id: MilestoneId, patch: Partial<Omit<Milestone, 'id' | 'projectId' | 'createdAt'>>): void {
    const milestones = this.getAll();
    const index = milestones.findIndex((i) => i.id === id);
    if (index === -1) {
      return;
    }
    const prev = milestones[index]!;
    const next = { ...prev, ...patch, updatedAt: this.deps.now() };
    // Stamp completedAt on first transition into 'completed'; clear it on transition out.
    if (patch.status === 'completed' && prev.status !== 'completed' && next.completedAt === undefined) {
      next.completedAt = this.deps.now();
    } else if (patch.status !== undefined && patch.status !== 'completed' && prev.status === 'completed') {
      next.completedAt = undefined;
    }
    milestones[index] = next;
    this.deps.store.setMilestones(milestones);
  }

  remove(id: MilestoneId): void {
    const milestones = this.getAll();
    const target = milestones.find((i) => i.id === id);
    if (!target) {
      return;
    }
    // Clear milestoneId on orphaned tickets
    const tickets = this.deps.store.getTickets();
    let ticketsChanged = false;
    const now = this.deps.now();
    for (const ticket of tickets) {
      if (ticket.milestoneId === id) {
        ticket.milestoneId = undefined;
        ticket.updatedAt = now;
        ticketsChanged = true;
      }
    }
    if (ticketsChanged) {
      this.deps.store.setTickets(tickets);
    }
    this.deps.store.setMilestones(milestones.filter((i) => i.id !== id));
  }

  /**
   * Drop every milestone belonging to a project. Called from the project
   * cascade-delete path. Tickets are wiped separately by ProjectManager,
   * so no orphan-clearing is needed here.
   */
  removeAllForProject(projectId: ProjectId): void {
    const remaining = this.getAll().filter((i) => i.projectId !== projectId);
    this.deps.store.setMilestones(remaining);
  }

  /** Resolve the effective branch for a ticket (ticket.branch ?? milestone.branch ?? undefined). */
  resolveTicketBranch(ticket: Ticket): string | undefined {
    if (ticket.branch) {
      return ticket.branch;
    }
    if (!ticket.milestoneId) {
      return undefined;
    }
    return this.getById(ticket.milestoneId)?.branch;
  }
}
