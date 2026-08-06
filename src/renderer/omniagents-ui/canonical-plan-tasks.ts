import type { MessageItem, PlanItem } from '@/shared/chat-types';

import type { TaskSummary } from './components/Tasks';

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
  }));
}

/** Select canonical tasks, retaining legacy snapshots only for older hosts. */
export function negotiatedPlanTasks(
  items: readonly MessageItem[],
  legacyTasks: readonly TaskSummary[],
  featureSupported: boolean
): TaskSummary[] {
  return canonicalPlanTasks(items) ?? (featureSupported ? [] : [...legacyTasks]);
}
