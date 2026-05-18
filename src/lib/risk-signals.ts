import { daysRemaining as inboxDaysRemaining, INBOX_EXPIRY_MS } from '@/lib/inbox-expiry';
import type { ColumnId, InboxItem, Milestone, Ticket } from '@/shared/types';

/**
 * Pure risk-signal detector for the dashboard "At Risk" section. Given the
 * full ticket/milestone/inbox state, emits a sorted list of actionable
 * warnings. Side-effect-free; thresholds live as exported constants so they
 * can be tuned without chasing the call sites.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Threshold constants — start conservative, tune after dogfooding. */
export const RISK_THRESHOLDS = {
  stalledTicketDays: 5,
  milestoneQuietDays: 14,
  projectQuietDays: 30,
  inboxUrgentDaysLeft: 1,
} as const;

export type RiskSeverity = 'high' | 'medium' | 'low';

export type RiskSignalKind =
  | 'stalled_ticket'
  | 'wip_overflow'
  | 'milestone_overdue'
  | 'milestone_due_soon'
  | 'milestone_quiet'
  | 'aging_inbox'
  | 'inbox_expiring'
  | 'project_overdue'
  | 'project_due_soon'
  | 'quiet_project';

export type RiskAction =
  | { kind: 'open_ticket'; ticketId: string }
  | { kind: 'open_milestone'; milestoneId: string; projectId: string }
  | { kind: 'open_inbox_item'; inboxItemId: string }
  | { kind: 'open_wip_dialog' }
  | { kind: 'open_project'; projectId: string };

export type RiskSignal = {
  id: string;
  kind: RiskSignalKind;
  severity: RiskSeverity;
  title: string;
  detail?: string;
  action: RiskAction;
};

export type RiskInput = {
  tickets: Ticket[];
  milestones: Milestone[];
  inboxItems: InboxItem[];
  projects: Array<{ id: string; label: string; dueDate?: number }>;
  /** Column IDs treated as "done". Tickets in these columns are excluded from
   *  per-ticket signals (stalled, self-blocked, WIP count). */
  terminalColumnIds?: ReadonlySet<ColumnId>;
  wipLimit: number;
  now: number;
};

const SEVERITY_ORDER: Record<RiskSeverity, number> = { high: 0, medium: 1, low: 2 };

export function detectRisks(input: RiskInput): RiskSignal[] {
  const { tickets, milestones, inboxItems, projects, terminalColumnIds, wipLimit, now } = input;
  const out: RiskSignal[] = [];

  const isDone = (t: Ticket): boolean =>
    t.resolution !== undefined || (terminalColumnIds?.has(t.columnId) ?? false);

  // --- Per-ticket signals ---
  let activeCount = 0;
  for (const ticket of tickets) {
    if (isDone(ticket)) {
continue;
}

    const phase = ticket.phase;
    if (phase !== undefined && phase !== 'idle' && phase !== 'error' && phase !== 'completed') {
      activeCount++;
    }

    // Stalled — unresolved, no phase change (or column change) in N days.
    // Skip if actively running (already counted above).
    if (phase === undefined || phase === 'idle' || phase === 'error') {
      const lastMoved = Math.max(
        ticket.phaseChangedAt ?? 0,
        ticket.columnChangedAt ?? 0,
        ticket.updatedAt
      );
      const ageDays = (now - lastMoved) / DAY_MS;
      if (ageDays >= RISK_THRESHOLDS.stalledTicketDays) {
        out.push({
          id: `stalled:${ticket.id}`,
          kind: 'stalled_ticket',
          severity: 'medium',
          title: ticket.title,
          detail: `No activity in ${Math.floor(ageDays)}d`,
          action: { kind: 'open_ticket', ticketId: ticket.id },
        });
      }
    }
  }

  // --- WIP overflow ---
  if (activeCount >= wipLimit) {
    out.push({
      id: 'wip_overflow',
      kind: 'wip_overflow',
      severity: 'high',
      title: 'WIP limit reached',
      detail: `${activeCount} of ${wipLimit} slots used — finish or stop something before starting new work`,
      action: { kind: 'open_wip_dialog' },
    });
  }

  // --- Milestone signals ---
  // Group tickets by milestone for completion calc.
  const ticketsByMilestone = new Map<string, Ticket[]>();
  for (const t of tickets) {
    if (!t.milestoneId) {
continue;
}
    const arr = ticketsByMilestone.get(t.milestoneId) ?? [];
    arr.push(t);
    ticketsByMilestone.set(t.milestoneId, arr);
  }

  for (const milestone of milestones) {
    if (milestone.status !== 'active') {
continue;
}

    const msTickets = ticketsByMilestone.get(milestone.id) ?? [];
    const resolvedCount = msTickets.filter((t) => t.resolution !== undefined).length;
    const completion = msTickets.length === 0 ? 1 : resolvedCount / msTickets.length;

    // Deadline pressure
    if (milestone.dueDate !== undefined) {
      const daysLeft = Math.ceil((milestone.dueDate - now) / DAY_MS);
      const hasUnresolved = msTickets.some((t) => t.resolution === undefined);

      if (daysLeft <= 0 && hasUnresolved) {
        out.push({
          id: `milestone_overdue:${milestone.id}`,
          kind: 'milestone_overdue',
          severity: 'high',
          title: milestone.title,
          detail: `Overdue by ${Math.abs(daysLeft)}d · ${Math.round(completion * 100)}% complete`,
          action: { kind: 'open_milestone', milestoneId: milestone.id, projectId: milestone.projectId },
        });
        continue;
      }
      if (daysLeft > 0 && daysLeft <= 3 && completion < 0.5) {
        out.push({
          id: `milestone_due_soon:${milestone.id}`,
          kind: 'milestone_due_soon',
          severity: 'high',
          title: milestone.title,
          detail: `Due in ${daysLeft}d · ${Math.round(completion * 100)}% complete`,
          action: { kind: 'open_milestone', milestoneId: milestone.id, projectId: milestone.projectId },
        });
        continue;
      }
      if (daysLeft > 3 && daysLeft <= 7 && completion < 0.75) {
        out.push({
          id: `milestone_due_soon:${milestone.id}`,
          kind: 'milestone_due_soon',
          severity: 'medium',
          title: milestone.title,
          detail: `Due in ${daysLeft}d · ${Math.round(completion * 100)}% complete`,
          action: { kind: 'open_milestone', milestoneId: milestone.id, projectId: milestone.projectId },
        });
        continue;
      }
    }

    // Quiet milestone — no ticket activity in N days (and not already flagged as overdue/due-soon)
    const lastActivity = msTickets.reduce((max, t) => Math.max(max, t.updatedAt), milestone.updatedAt);
    const quietDays = (now - lastActivity) / DAY_MS;
    if (quietDays >= RISK_THRESHOLDS.milestoneQuietDays) {
      out.push({
        id: `milestone_quiet:${milestone.id}`,
        kind: 'milestone_quiet',
        severity: 'low',
        title: milestone.title,
        detail: `No activity in ${Math.floor(quietDays)}d`,
        action: { kind: 'open_milestone', milestoneId: milestone.id, projectId: milestone.projectId },
      });
    }
  }

  // --- Inbox signals ---
  for (const item of inboxItems) {
    if (item.status !== 'new' && item.status !== 'shaped') {
continue;
}
    if (item.promotedTo !== undefined) {
continue;
}
    if (item.status === 'shaped') {
continue;
} // shaped items don't expire, only unshaped

    const daysLeft = inboxDaysRemaining(item.createdAt, now);
    if (daysLeft <= RISK_THRESHOLDS.inboxUrgentDaysLeft) {
      out.push({
        id: `inbox_expiring:${item.id}`,
        kind: 'inbox_expiring',
        severity: 'high',
        title: item.title || 'Untitled',
        detail: daysLeft <= 0 ? 'Expiring today' : `${daysLeft}d left — shape or defer`,
        action: { kind: 'open_inbox_item', inboxItemId: item.id },
      });
      continue;
    }
    const elapsed = now - item.createdAt;
    if (elapsed >= INBOX_EXPIRY_MS / 2) {
      out.push({
        id: `aging_inbox:${item.id}`,
        kind: 'aging_inbox',
        severity: 'medium',
        title: item.title || 'Untitled',
        detail: `${daysLeft}d left — needs shaping`,
        action: { kind: 'open_inbox_item', inboxItemId: item.id },
      });
    }
  }

  // --- Per-project signals ---
  // Last activity = max(ticket.updatedAt, inbox.updatedAt) across the project.
  for (const project of projects) {
    const projectTickets = tickets.filter((t) => t.projectId === project.id);
    const projectInbox = inboxItems.filter((i) => i.projectId === project.id);

    // Deadline pressure. Requires at least one unresolved, non-terminal ticket
    // — a deadline on an empty or fully-done project isn't actionable.
    if (project.dueDate !== undefined) {
      const hasUnresolved = projectTickets.some(
        (t) => t.resolution === undefined && !(terminalColumnIds?.has(t.columnId) ?? false)
      );
      if (hasUnresolved) {
        const daysLeft = Math.ceil((project.dueDate - now) / DAY_MS);
        if (daysLeft <= 0) {
          out.push({
            id: `project_overdue:${project.id}`,
            kind: 'project_overdue',
            severity: 'high',
            title: project.label,
            detail: `Overdue by ${Math.abs(daysLeft)}d`,
            action: { kind: 'open_project', projectId: project.id },
          });
        } else if (daysLeft <= 3) {
          out.push({
            id: `project_due_soon:${project.id}`,
            kind: 'project_due_soon',
            severity: 'high',
            title: project.label,
            detail: `Due in ${daysLeft}d`,
            action: { kind: 'open_project', projectId: project.id },
          });
        } else if (daysLeft <= 7) {
          out.push({
            id: `project_due_soon:${project.id}`,
            kind: 'project_due_soon',
            severity: 'medium',
            title: project.label,
            detail: `Due in ${daysLeft}d`,
            action: { kind: 'open_project', projectId: project.id },
          });
        }
      }
    }

    // Quiet project — last activity older than threshold.
    if (projectTickets.length === 0 && projectInbox.length === 0) {
      continue;
    }
    const lastActivity = Math.max(
      ...projectTickets.map((t) => t.updatedAt),
      ...projectInbox.map((i) => i.updatedAt),
      0
    );
    const quietDays = (now - lastActivity) / DAY_MS;
    if (quietDays >= RISK_THRESHOLDS.projectQuietDays) {
      out.push({
        id: `quiet_project:${project.id}`,
        kind: 'quiet_project',
        severity: 'low',
        title: project.label,
        detail: `No activity in ${Math.floor(quietDays)}d`,
        action: { kind: 'open_project', projectId: project.id },
      });
    }
  }

  // Sort: severity first, then stable-ish by id.
  out.sort((a, b) => {
    const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sev !== 0) {
return sev;
}
    return a.id.localeCompare(b.id);
  });

  return out;
}
