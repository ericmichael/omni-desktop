/**
 * Bridge between the imperative client tool handler and the React UI for plan approval.
 *
 * The handler calls `requestPlanApproval()` which returns a Promise that won't resolve
 * until the user clicks approve/reject in the UI. The React side reads `$pendingPlan`
 * and calls `resolvePlanApproval()` when the user decides.
 */
import { atom } from 'nanostores';

import type { PlanStep } from '@/shared/chat-types';

export type PendingPlan = {
  type: 'plan';
  id: string;
  title: string;
  description?: string;
  steps: PlanStep[];
};

let nextId = 0;
let pendingResolve: ((approved: boolean) => void) | null = null;

/** Reactive atom — the currently pending plan, or null. */
export const $pendingPlan = atom<PendingPlan | null>(null);

/** Called by the client tool handler. Blocks until the user decides. */
export function requestPlanApproval(plan: {
  title: string;
  description?: string;
  steps: PlanStep[];
}): Promise<boolean> {
  // If there's already a pending plan, reject it first
  if (pendingResolve) {
    pendingResolve(false);
    pendingResolve = null;
  }

  const id = `plan-${++nextId}`;
  $pendingPlan.set({ type: 'plan', id, ...plan });

  return new Promise<boolean>((resolve) => {
    pendingResolve = resolve;
  });
}

/** Called by the React UI when the user approves or rejects. */
export function resolvePlanApproval(approved: boolean): void {
  if (pendingResolve) {
    pendingResolve(approved);
    pendingResolve = null;
  }
  $pendingPlan.set(null);
}
