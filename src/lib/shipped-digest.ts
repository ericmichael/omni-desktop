import type { Milestone, Ticket } from '@/shared/types';

/**
 * Pure aggregator for the dashboard "Shipped" section. Buckets resolved
 * tickets and completed milestones into "today" and "this week" windows,
 * using local-time boundaries supplied by the caller.
 *
 * Rationale for caller-supplied boundaries: deriving local midnight from a
 * raw epoch inside the lib would drag a timezone dependency into a file
 * that's otherwise trivially testable. Callers pass `startOfToday` and
 * `startOfWeek` computed from `new Date()` in the render layer.
 */

export type ShippedItem =
  | { kind: 'ticket'; ticket: Ticket; at: number }
  | { kind: 'milestone'; milestone: Milestone; at: number };

export type ShippedBucket = {
  items: ShippedItem[];
  ticketCount: number;
  milestoneCount: number;
};

export type ShippedDigest = {
  today: ShippedBucket;
  week: ShippedBucket;
  byProject: Record<string, { today: number; week: number }>;
};

export type ShippedInput = {
  tickets: Ticket[];
  milestones: Milestone[];
  startOfToday: number;
  startOfWeek: number;
};

export function computeShippedDigest(input: ShippedInput): ShippedDigest {
  const { tickets, milestones, startOfToday, startOfWeek } = input;

  const today: ShippedItem[] = [];
  const week: ShippedItem[] = [];
  const byProject: Record<string, { today: number; week: number }> = {};

  const bumpProject = (projectId: string, bucket: 'today' | 'week') => {
    const entry = byProject[projectId] ?? { today: 0, week: 0 };
    entry[bucket]++;
    byProject[projectId] = entry;
  };

  for (const ticket of tickets) {
    if (ticket.resolution === undefined) continue;
    const at = ticket.resolvedAt;
    if (at === undefined) continue;
    if (at < startOfWeek) continue;

    const item: ShippedItem = { kind: 'ticket', ticket, at };
    week.push(item);
    bumpProject(ticket.projectId, 'week');
    if (at >= startOfToday) {
      today.push(item);
      bumpProject(ticket.projectId, 'today');
    }
  }

  for (const milestone of milestones) {
    if (milestone.status !== 'completed') continue;
    const at = milestone.completedAt;
    if (at === undefined) continue;
    if (at < startOfWeek) continue;

    const item: ShippedItem = { kind: 'milestone', milestone, at };
    week.push(item);
    if (at >= startOfToday) today.push(item);
  }

  // Newest first.
  week.sort((a, b) => b.at - a.at);
  today.sort((a, b) => b.at - a.at);

  return {
    today: {
      items: today,
      ticketCount: today.filter((i) => i.kind === 'ticket').length,
      milestoneCount: today.filter((i) => i.kind === 'milestone').length,
    },
    week: {
      items: week,
      ticketCount: week.filter((i) => i.kind === 'ticket').length,
      milestoneCount: week.filter((i) => i.kind === 'milestone').length,
    },
    byProject,
  };
}

/**
 * Compute local-day and local-week boundaries (monday-start) from a Date.
 * Exported for the render layer; kept out of `computeShippedDigest` itself
 * so the core remains trivially testable with fixed numbers.
 */
export function localBoundaries(now: Date): { startOfToday: number; startOfWeek: number } {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const startOfWeek = new Date(startOfToday);
  // Monday = 1. getDay() returns 0 (Sun) … 6 (Sat). Treat Sunday as end of week.
  const day = startOfWeek.getDay();
  const diff = day === 0 ? 6 : day - 1;
  startOfWeek.setDate(startOfWeek.getDate() - diff);

  return { startOfToday: startOfToday.getTime(), startOfWeek: startOfWeek.getTime() };
}
