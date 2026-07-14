import { type FocusItem, rankFocus } from '@/lib/focus-ranker';
import type { ColumnId, Milestone, Project, Ticket } from '@/shared/types';

/**
 * Pure rollup helpers for the Home view. Home surfaces pinned projects, each
 * with its own next-up ticket. A pin is durable state: it stays set until
 * the user unpins it via the pin icon on Home, the Work sidebar, or the
 * project page.
 */

/** Returns true when the project is pinned. */
export function isProjectPinned(project: Project): boolean {
  return project.pinnedAt != null;
}

/**
 * The single next-up ticket inside a project, or null when none qualifies.
 * Wraps the global `rankFocus` with `tickets` filtered to this project.
 */
export function rankFocusForProject(args: {
  project: Project;
  tickets: Ticket[];
  milestones: Record<string, Milestone>;
  terminalColumnIds?: ReadonlySet<ColumnId>;
  now: number;
}): FocusItem | null {
  const scoped = args.tickets.filter((t) => t.projectId === args.project.id);
  const ranked = rankFocus({
    tickets: scoped,
    milestones: args.milestones,
    terminalColumnIds: args.terminalColumnIds,
    now: args.now,
    limit: 1,
  });
  return ranked[0] ?? null;
}

export function milestoneProgress(
  milestone: Milestone,
  tickets: Ticket[]
): { resolved: number; total: number; pct: number } {
  let resolved = 0;
  let total = 0;
  for (const ticket of tickets) {
    if (ticket.milestoneId !== milestone.id) {
      continue;
    }
    total++;
    if (ticket.resolution !== undefined) {
      resolved++;
    }
  }
  const pct = total === 0 ? 1 : resolved / total;
  return { resolved, total, pct };
}

/** Count of unresolved, non-terminal tickets belonging to a project. */
export function projectOpenTicketCount(args: {
  project: Project;
  tickets: Ticket[];
  terminalColumnIds?: ReadonlySet<ColumnId>;
}): number {
  let count = 0;
  for (const ticket of args.tickets) {
    if (ticket.projectId !== args.project.id) {
      continue;
    }
    if (ticket.resolution !== undefined) {
      continue;
    }
    if (args.terminalColumnIds?.has(ticket.columnId)) {
      continue;
    }
    count++;
  }
  return count;
}
