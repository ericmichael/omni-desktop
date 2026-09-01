import type { PlanItem as RpcPlanItem } from '@/renderer/omniagents-ui/rpc/plans-and-diffs';
import type { MessageItem, PlanItem } from '@/shared/chat-types';
import type { PlanSnapshotEntry, SupervisorBridgeEvent, TicketId } from '@/shared/types';

/** One row of the session's plan, as the Tasks pill/popover renders it.
 *  Structurally compatible with `PlanSnapshotEntry` (shared/types). */
export type TaskSummary = {
  id: string;
  subject: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  owner?: string;
  blockedBy?: string[];
  /** Checkable definition-of-done. Absent = no semantic review. */
  exitCriteria?: string;
  /** Completion review: true verified, false unverified, null/absent unreviewed. */
  verified?: boolean | null;
  /** True when the criteria were edited while the step was in progress (ratchet stamp). */
  criteriaEdited?: boolean;
};

/**
 * Select the newest canonical main plan and project it into the compact task
 * panel. A null result means no canonical plan is present, which lets callers
 * distinguish an older runtime from an authoritative empty plan result.
 */
export function canonicalPlanTasks(items: readonly MessageItem[]): TaskSummary[] | null {
  const plans = items.filter(
    (item): item is PlanItem => item.type === 'plan' && item.canonical != null && (item.scope ?? 'main') === 'main'
  );
  const plan = plans.reduce<PlanItem | null>((latest, candidate) => {
    if (!latest) {
      return candidate;
    }
    const left = latest.canonical!;
    const right = candidate.canonical!;
    return right.seq > left.seq ||
      (right.seq === left.seq &&
        (right.revision > left.revision || (right.revision === left.revision && right.updated_at > left.updated_at)))
      ? candidate
      : latest;
  }, null);
  if (!plan) {
    return null;
  }
  return plan.steps.map((step, index) => ({
    id: step.id ?? String(index + 1),
    subject: step.title,
    activeForm: step.activeForm,
    status: step.status ?? 'pending',
    owner: step.owner,
    blockedBy: step.blockedBy,
    exitCriteria: step.exitCriteria,
    verified: step.verified,
    criteriaEdited: step.criteriaEdited,
  }));
}

/**
 * Project a ``get_plan`` RPC plan — another session's, e.g. a worker's own
 * plan read by its session id — into the same rows the Tasks popover
 * renders. The typed parser only guarantees the mechanical fields; the
 * review fields ride through as passthrough keys, so read them defensively
 * (mirroring the canonical-history projection): ``verified`` compact form or
 * persisted ``review.outcome``; ``criteria_edited`` flag or the stamped
 * ``original_exit_criteria``.
 */
export function rpcPlanTasks(plan: RpcPlanItem | null): TaskSummary[] | null {
  if (!plan) {
    return null;
  }
  return plan.steps.map((step) => {
    const review =
      step.review && typeof step.review === 'object' && !Array.isArray(step.review)
        ? (step.review as Record<string, unknown>)
        : undefined;
    const verified =
      typeof step.verified === 'boolean' || step.verified === null
        ? step.verified
        : review?.outcome === 'verified'
          ? true
          : review?.outcome === 'unverified'
            ? false
            : undefined;
    const originalCriteria = typeof step.original_exit_criteria === 'string' ? step.original_exit_criteria : '';
    return {
      id: step.id,
      subject: step.subject,
      activeForm: step.active_form || undefined,
      status: step.status,
      owner: step.owner || undefined,
      blockedBy: step.blocked_by,
      exitCriteria: (typeof step.exit_criteria === 'string' ? step.exit_criteria : '') || undefined,
      verified,
      criteriaEdited:
        step.criteria_edited === true || step.criteriaEdited === true || originalCriteria !== '' || undefined,
    };
  });
}

/** Select canonical tasks, retaining legacy snapshots only for older hosts. */
export function negotiatedPlanTasks(
  items: readonly MessageItem[],
  legacyTasks: readonly TaskSummary[],
  featureSupported: boolean
): TaskSummary[] {
  return canonicalPlanTasks(items) ?? (featureSupported ? [] : [...legacyTasks]);
}

/**
 * Project the panel's task list into the supervisor-bridge `plan-update`
 * event that persists `ticket.lastPlanSnapshot` in main
 * (docs/agentic-workflow-enforcement-plan.md §F). Null when the host has no
 * ticket context (plain chat columns have no persistence home) — the same
 * guard the `goal-update` forward uses. An empty task list forwards
 * `snapshot: null`; main ignores it (clearing happens at ticket settlement),
 * so a fresh session's empty panel never clobbers a stored snapshot.
 */
export function planUpdateForBridge(
  ticketId: TicketId | undefined,
  tasks: readonly TaskSummary[]
): Extract<SupervisorBridgeEvent, { kind: 'plan-update' }> | null {
  if (!ticketId) {
    return null;
  }
  const snapshot: PlanSnapshotEntry[] | null =
    tasks.length > 0
      ? tasks.map((t) => ({
          id: t.id,
          subject: t.subject,
          activeForm: t.activeForm,
          status: t.status,
          owner: t.owner,
          blockedBy: t.blockedBy,
          exitCriteria: t.exitCriteria,
          verified: t.verified,
          criteriaEdited: t.criteriaEdited,
        }))
      : null;
  return { kind: 'plan-update', ticketId, snapshot };
}
