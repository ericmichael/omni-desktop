/**
 * Pure helpers for persisted plan snapshots (`Ticket.lastPlanSnapshot`) —
 * the `tasks_snapshot` summaries a running agent session reports, carried
 * across sessions per docs/agentic-workflow-enforcement-plan.md §F.
 *
 * Two concerns live here, both side-effect free so they are unit-testable:
 *   - classifying steps (incomplete, human gate)
 *   - diffing a snapshot's human-gate steps against existing inbox items
 *     ("agent is waiting on you: …") so the orchestrator creates/removes
 *     exactly the delta on every snapshot write.
 */
import type { InboxItem, InboxItemId, PlanSnapshotEntry, TicketId } from '@/shared/types';

/** True when the step still needs work (anything but `completed`). */
export const isIncompleteStep = (step: PlanSnapshotEntry): boolean => step.status !== 'completed';

/** True when at least one step of the snapshot still needs work. */
export const hasIncompleteSteps = (steps: readonly PlanSnapshotEntry[]): boolean => steps.some(isIncompleteStep);

/**
 * A human-owned gate: the step is blocked and assigned to a principal that
 * is not an agent (`agent:<id>`). These surface as inbox items.
 */
export const isHumanGateStep = (step: PlanSnapshotEntry): boolean =>
  step.status === 'blocked' && !!step.owner && !step.owner.startsWith('agent:');

/** Inbox item title for a human-gate step. */
export const humanGateInboxTitle = (step: PlanSnapshotEntry): string => `agent is waiting on you: ${step.subject}`;

/**
 * Stable dedupe marker embedded in the inbox item's note. The inbox schema
 * has no structured source field, so the marker is how a gate item is
 * recognized across snapshot writes (and across restarts).
 */
export const humanGateMarker = (ticketId: TicketId, stepId: string): string => `[plan-gate:${ticketId}:${stepId}]`;

/** Inbox item note for a human-gate step — human-readable body + marker. */
export const humanGateInboxNote = (ticketId: TicketId, step: PlanSnapshotEntry): string => {
  const criteria = step.exitCriteria?.trim() ? `\nDone when: ${step.exitCriteria.trim()}` : '';
  return `The agent's plan has a blocked step waiting on ${step.owner ?? 'you'}.${criteria}\n\n${humanGateMarker(ticketId, step.id)}`;
};

/** Prefix matching every gate marker for one ticket. */
const ticketMarkerPrefix = (ticketId: TicketId): string => `[plan-gate:${ticketId}:`;

/** Step id carried by an item's gate marker for this ticket, or null. */
const markedStepId = (item: InboxItem, ticketId: TicketId): string | null => {
  const note = item.note ?? '';
  const start = note.indexOf(ticketMarkerPrefix(ticketId));
  if (start === -1) {
    return null;
  }
  const rest = note.slice(start + ticketMarkerPrefix(ticketId).length);
  const end = rest.indexOf(']');
  return end === -1 ? null : rest.slice(0, end);
};

export type HumanGateDiff = {
  /** Gate steps with no existing open inbox item — create one each. */
  create: PlanSnapshotEntry[];
  /** Existing gate items whose step is no longer a blocked human gate — remove. */
  removeIds: InboxItemId[];
};

/**
 * Diff the snapshot's human-gate steps against existing inbox items for the
 * ticket. Pass an empty `steps` array to clear every gate item (settlement).
 * Promoted tombstones are left alone.
 */
export const diffHumanGateItems = (
  ticketId: TicketId,
  steps: readonly PlanSnapshotEntry[],
  items: readonly InboxItem[]
): HumanGateDiff => {
  const gateSteps = steps.filter(isHumanGateStep);
  const gateStepIds = new Set(gateSteps.map((s) => s.id));

  const existingByStepId = new Map<string, InboxItem>();
  const removeIds: InboxItemId[] = [];
  for (const item of items) {
    if (item.promotedTo) {
      continue;
    }
    const stepId = markedStepId(item, ticketId);
    if (stepId === null) {
      continue;
    }
    if (gateStepIds.has(stepId)) {
      existingByStepId.set(stepId, item);
    } else {
      removeIds.push(item.id);
    }
  }

  return {
    create: gateSteps.filter((s) => !existingByStepId.has(s.id)),
    removeIds,
  };
};
