import { type FocusItem, rankFocus } from '@/lib/focus-ranker';
import type { RiskSignal } from '@/lib/risk-signals';
import type { ColumnId, Milestone, MilestoneId, Project, ProjectId, Ticket } from '@/shared/types';

/**
 * Pure rollup helpers for the Home view. Home is a list of pinned things
 * (projects or milestones), each surfacing its own next-up ticket plus the
 * risk signals attached to its tickets. A pin is durable state: it stays
 * set until the user unpins it, either via the sidebar icon or by
 * unchecking it in the weekly plan dialog.
 */

/** Returns true when the milestone is pinned. */
export function isMilestonePinned(milestone: Milestone): boolean {
  return milestone.pinnedAt != null;
}

/** Returns true when the project is pinned. */
export function isProjectPinned(project: Project): boolean {
  return project.pinnedAt != null;
}

/**
 * The single next-up ticket inside a milestone, or null when none qualifies.
 * Wraps the global `rankFocus` with `tickets` filtered to this milestone.
 */
export function rankFocusForMilestone(args: {
  milestone: Milestone;
  tickets: Ticket[];
  milestones: Record<string, Milestone>;
  terminalColumnIds?: ReadonlySet<ColumnId>;
  now: number;
}): FocusItem | null {
  const scoped = args.tickets.filter((t) => t.milestoneId === args.milestone.id);
  const ranked = rankFocus({
    tickets: scoped,
    milestones: args.milestones,
    terminalColumnIds: args.terminalColumnIds,
    now: args.now,
    limit: 1,
  });
  return ranked[0] ?? null;
}

/**
 * The single next-up ticket inside a project, or null when none qualifies.
 * Includes tickets that belong to milestones inside the project — a project
 * row is a project-wide focus, even when the user has also pinned one of
 * its milestones separately.
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

/**
 * Split risk signals onto their owners for the Home view:
 *  - `byProject` is keyed by every ticket's `projectId`.
 *  - `byMilestone` is keyed by every ticket's `milestoneId` (when present).
 *  - `inbox` collects `inbox_expiring` and `aging_inbox` signals.
 *
 * A ticket-scoped signal is routed to BOTH project and milestone buckets when
 * applicable, so a stalled ticket inside a milestone shows up on both rows if
 * the user has pinned both. Dedup is intentionally left to the UI — pinning
 * both project and milestone is an explicit user choice.
 *
 * `open_milestone` signals route only to `byMilestone`. `open_project` signals
 * route only to `byProject`. WIP overflow and other unscoped signals are
 * dropped — Home renders the WIP gauge separately.
 */
export function groupRiskSignalsForHome(args: { signals: RiskSignal[]; tickets: Ticket[] }): {
  byProject: Map<ProjectId, RiskSignal[]>;
  byMilestone: Map<MilestoneId, RiskSignal[]>;
  inbox: RiskSignal[];
} {
  const ticketOwner = new Map<string, { projectId: ProjectId; milestoneId?: MilestoneId }>();
  for (const ticket of args.tickets) {
    ticketOwner.set(ticket.id, { projectId: ticket.projectId, milestoneId: ticket.milestoneId });
  }

  const byProject = new Map<ProjectId, RiskSignal[]>();
  const byMilestone = new Map<MilestoneId, RiskSignal[]>();
  const inbox: RiskSignal[] = [];

  const pushProject = (id: ProjectId, signal: RiskSignal) => {
    const list = byProject.get(id) ?? [];
    list.push(signal);
    byProject.set(id, list);
  };
  const pushMilestone = (id: MilestoneId, signal: RiskSignal) => {
    const list = byMilestone.get(id) ?? [];
    list.push(signal);
    byMilestone.set(id, list);
  };

  for (const signal of args.signals) {
    const action = signal.action;
    switch (action.kind) {
      case 'open_ticket': {
        const owner = ticketOwner.get(action.ticketId);
        if (!owner) {
          break;
        }
        pushProject(owner.projectId, signal);
        if (owner.milestoneId) {
          pushMilestone(owner.milestoneId, signal);
        }
        break;
      }
      case 'open_milestone':
        pushMilestone(action.milestoneId, signal);
        break;
      case 'open_project':
        pushProject(action.projectId, signal);
        break;
      case 'open_inbox_item':
        inbox.push(signal);
        break;
      // open_wip_dialog: dropped — surfaced via the WIP gauge.
    }
  }

  return { byProject, byMilestone, inbox };
}

/**
 * Resolved / total / pct (0–1) for the milestone's tickets. Empty milestones
 * return `pct: 1` so they don't render as a 0% bar.
 */
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
