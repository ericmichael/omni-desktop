import { isActivePhase } from '@/shared/ticket-phase';
import type { ColumnId, Milestone, Ticket, TicketId, TicketPriority } from '@/shared/types';

/**
 * Pure ranker for the dashboard Focus section. Given the full ticket/milestone
 * state, returns a ranked short list of tickets the user should work on next,
 * each with a human-readable reason. Deterministic and side-effect-free.
 *
 * Tickets are excluded from ranking if either:
 *   - they carry a `resolution` (user explicitly closed), or
 *   - their `columnId` is in the caller-supplied `terminalColumnIds` set
 *     (user dragged the card into the Done column without setting a
 *     resolution — matches how the rest of the system treats "done").
 *
 * Ordering rules (applied in order):
 *   1. In-flight first — any ticket whose phase is active (not idle/error/completed).
 *   2. Self-blocked next — phase === 'awaiting_input', 'error', or 'completed'.
 *      The 'completed' phase here means the agent finished its last run and
 *      the user hasn't closed or re-dispatched the ticket — the user is now
 *      the bottleneck, same semantic as awaiting_input.
 *   3. Next-up candidates — unresolved, no active phase. Ranked by a composite
 *      score built from priority, milestone membership, unblocked status, and
 *      deadline proximity (milestone.dueDate). Tiebreaker: oldest
 *      columnChangedAt (closest to "stuck in place").
 *
 * The function is capped at `limit` results (default 5).
 */

const PRIORITY_WEIGHT: Record<TicketPriority, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const DAY_MS = 24 * 60 * 60 * 1000;

export type FocusRank = 'in_flight' | 'self_blocked' | 'next_up';

export type FocusItem = {
  ticket: Ticket;
  rank: FocusRank;
  /** Composite score (higher = better). Only meaningful within a rank tier. */
  score: number;
  /** Human-readable justification shown in the UI. */
  reason: string;
};

export type FocusInput = {
  tickets: Ticket[];
  milestones: Record<string, Milestone>;
  /** Column IDs treated as "done". Tickets in these columns are skipped. */
  terminalColumnIds?: ReadonlySet<ColumnId>;
  now: number;
  limit?: number;
};

export function rankFocus({
  tickets,
  milestones,
  terminalColumnIds,
  now,
  limit = 5,
}: FocusInput): FocusItem[] {
  const inFlight: FocusItem[] = [];
  const selfBlocked: FocusItem[] = [];
  const nextUp: FocusItem[] = [];

  const isDone = (t: Ticket): boolean =>
    t.resolution !== undefined || (terminalColumnIds?.has(t.columnId) ?? false);

  // Unblocked = every blocker is "done". Tickets in terminal columns count
  // as unblocking even without a resolution, mirroring project-manager's
  // isTerminalColumn blocker rule.
  const openTicketIds = new Set<TicketId>(tickets.filter((t) => !isDone(t)).map((t) => t.id));

  for (const ticket of tickets) {
    if (isDone(ticket)) {
continue;
}

    const phase = ticket.phase;

    if (phase === 'awaiting_input' || phase === 'error' || phase === 'completed') {
      const reason =
        phase === 'awaiting_input'
          ? 'Needs your input'
          : phase === 'error'
            ? 'Errored — retry or triage'
            : 'Agent finished — review';
      selfBlocked.push({
        ticket,
        rank: 'self_blocked',
        score: PRIORITY_WEIGHT[ticket.priority],
        reason,
      });
      continue;
    }

    if (phase !== undefined && isActivePhase(phase)) {
      inFlight.push({
        ticket,
        rank: 'in_flight',
        score: PRIORITY_WEIGHT[ticket.priority],
        reason: 'In progress',
      });
      continue;
    }

    // Next-up: compute composite score + reason parts.
    const milestone = ticket.milestoneId ? milestones[ticket.milestoneId] : undefined;
    const milestoneActive = milestone?.status === 'active';
    const blockerIds = ticket.blockedBy ?? [];
    const unblocked = blockerIds.every((id) => !openTicketIds.has(id));

    let score = PRIORITY_WEIGHT[ticket.priority];
    const reasonParts: string[] = [];
    reasonParts.push(priorityLabel(ticket.priority));

    if (milestoneActive) {
      score += 1;
      const due = milestone?.dueDate;
      if (due !== undefined) {
        const days = Math.ceil((due - now) / DAY_MS);
        if (days <= 0) {
          score += 3;
          reasonParts.push(`Milestone: ${milestone!.title} (overdue)`);
        } else if (days <= 3) {
          score += 2;
          reasonParts.push(`Milestone: ${milestone!.title} (due in ${days}d)`);
        } else if (days <= 7) {
          score += 1;
          reasonParts.push(`Milestone: ${milestone!.title} (due in ${days}d)`);
        } else {
          reasonParts.push(`Milestone: ${milestone!.title}`);
        }
      } else {
        reasonParts.push(`Milestone: ${milestone!.title}`);
      }
    }

    if (unblocked) {
      score += 1;
      reasonParts.push('unblocked');
    } else {
      reasonParts.push('blocked');
    }

    nextUp.push({
      ticket,
      rank: 'next_up',
      score,
      reason: reasonParts.join(' · '),
    });
  }

  // Sort each tier. Within a tier, higher score first; tiebreak by oldest
  // columnChangedAt (closer to "sitting still"), then oldest createdAt.
  const byScoreThenAge = (a: FocusItem, b: FocusItem): number => {
    if (b.score !== a.score) {
return b.score - a.score;
}
    const aAge = a.ticket.columnChangedAt ?? a.ticket.updatedAt;
    const bAge = b.ticket.columnChangedAt ?? b.ticket.updatedAt;
    if (aAge !== bAge) {
return aAge - bAge;
}
    return a.ticket.createdAt - b.ticket.createdAt;
  };

  inFlight.sort(byScoreThenAge);
  selfBlocked.sort(byScoreThenAge);
  nextUp.sort(byScoreThenAge);

  return [...inFlight, ...selfBlocked, ...nextUp].slice(0, limit);
}

function priorityLabel(p: TicketPriority): string {
  switch (p) {
    case 'critical':
      return 'Critical priority';
    case 'high':
      return 'High priority';
    case 'medium':
      return 'Medium priority';
    case 'low':
      return 'Low priority';
  }
}

export type FocusHeader =
  | { kind: 'in_flight'; activeCount: number }
  | { kind: 'start'; openSlots: number }
  | { kind: 'shape_inbox'; shapedCount: number }
  | { kind: 'empty' };

/**
 * Decide which framing line to show above the Focus list. Callers pass the
 * already-ranked result plus the WIP/inbox context.
 */
export function focusHeader(args: {
  ranked: FocusItem[];
  wipUsed: number;
  wipLimit: number;
  shapedInboxCount: number;
}): FocusHeader {
  const { ranked, wipUsed, wipLimit, shapedInboxCount } = args;
  if (wipUsed > 0) {
return { kind: 'in_flight', activeCount: wipUsed };
}
  if (ranked.length > 0) {
return { kind: 'start', openSlots: Math.max(0, wipLimit - wipUsed) };
}
  if (shapedInboxCount > 0) {
return { kind: 'shape_inbox', shapedCount: shapedInboxCount };
}
  return { kind: 'empty' };
}
