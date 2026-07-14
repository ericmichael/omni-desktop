/**
 * Derived human-attention state for tickets.
 *
 * "Needs you" is an overlay, not a pipeline position: a ticket needs the
 * human when its agent errored, when it sits in a gate column (the pipeline's
 * human-review stop), or when the agent finished a run and nobody has
 * dispositioned the ticket. Global views (Home's Needs-you section, the
 * all-work list) group by this + the column's status category, never by raw
 * column ids.
 */
import { categoryOf } from '@/lib/pipeline-category';
import { isActivePhase } from '@/shared/ticket-phase';
import type { ColumnCategory, Pipeline, ProjectId, Ticket } from '@/shared/types';

export type AttentionReason = 'error' | 'gate' | 'agent_done';

export const ATTENTION_LABELS: Record<AttentionReason, string> = {
  error: 'Agent hit an error',
  gate: 'Waiting on your review',
  agent_done: 'Agent finished — review it',
};

/** Pipeline accessor — callers close over their project/pipeline source. */
export type PipelineLookup = (projectId: ProjectId) => Pipeline | null | undefined;

/**
 * Why this ticket needs the human right now, or null if it doesn't.
 * Resolved and shipped (done-column) tickets never need attention.
 */
export function needsAttention(ticket: Ticket, pipeline: Pipeline | null | undefined): AttentionReason | null {
  if (ticket.resolution || ticket.archivedAt) {
    return null;
  }
  const category = categoryOf(pipeline, ticket.columnId);
  if (category === 'done') {
    return null;
  }
  if (ticket.phase === 'error') {
    return 'error';
  }
  const column = pipeline?.columns.find((c) => c.id === ticket.columnId);
  if (column?.gate && !(ticket.phase !== undefined && isActivePhase(ticket.phase))) {
    return 'gate';
  }
  if (ticket.phase === 'completed') {
    return 'agent_done';
  }
  return null;
}

export type GroupedTasks = {
  /** Overlay group — tasks here do NOT repeat in their category group. */
  needsYou: { ticket: Ticket; reason: AttentionReason }[];
  doing: Ticket[];
  todo: Ticket[];
  done: Ticket[];
};

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Group tickets for an attention-first list: Needs you → Doing → To do →
 * Done. Archived tickets are excluded. Resolved tickets count as done even
 * if their column isn't (resolution is the stronger signal).
 *
 * Sorting: needs-you and doing by recency (active agents first in doing);
 * todo by priority then age; done by resolution recency.
 */
export function groupTasks(tickets: Ticket[], pipelineFor: PipelineLookup): GroupedTasks {
  const needsYou: GroupedTasks['needsYou'] = [];
  const doing: Ticket[] = [];
  const todo: Ticket[] = [];
  const done: Ticket[] = [];

  for (const ticket of tickets) {
    if (ticket.archivedAt) {
      continue;
    }
    const pipeline = pipelineFor(ticket.projectId);
    const reason = needsAttention(ticket, pipeline);
    if (reason) {
      needsYou.push({ ticket, reason });
      continue;
    }
    if (ticket.resolution) {
      done.push(ticket);
      continue;
    }
    const category: ColumnCategory = categoryOf(pipeline, ticket.columnId);
    if (category === 'done') {
      done.push(ticket);
    } else if (category === 'todo') {
      todo.push(ticket);
    } else {
      doing.push(ticket);
    }
  }

  needsYou.sort((a, b) => b.ticket.updatedAt - a.ticket.updatedAt);
  doing.sort((a, b) => {
    const aActive = a.phase !== undefined && isActivePhase(a.phase);
    const bActive = b.phase !== undefined && isActivePhase(b.phase);
    if (aActive !== bActive) {
      return aActive ? -1 : 1;
    }
    return b.updatedAt - a.updatedAt;
  });
  todo.sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 2;
    const pb = PRIORITY_ORDER[b.priority] ?? 2;
    if (pa !== pb) {
      return pa - pb;
    }
    return a.createdAt - b.createdAt;
  });
  done.sort((a, b) => (b.resolvedAt ?? b.updatedAt) - (a.resolvedAt ?? a.updatedAt));

  return { needsYou, doing, todo, done };
}
